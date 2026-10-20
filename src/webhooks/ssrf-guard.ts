/**
 * Central outbound URL-fetch policy (SSRF protection) — #1237.
 *
 * Every server-side request to a user- or operator-supplied URL (webhook
 * deliveries, alert sinks, notification channels, metadata fetches) must go
 * through this module: `safePost` / `safeGet` for the request itself, and
 * `checkOutboundUrl` / `isOutboundUrlAllowed` for synchronous validation at
 * input time (e.g. zod schemas). See docs/outbound-url-policy.md.
 *
 * Protects against:
 *   - DNS rebinding attacks (TOCTOU via malicious nameservers)
 *   - Redirect-based SSRF bypasses
 *   - Loopback          127.0.0.0/8, ::1
 *   - Private networks  10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
 *   - Link-local        169.254.0.0/16 (AWS/GCP/Azure metadata), fe80::/10
 *   - Unique-local IPv6 fc00::/7
 *   - Cloud metadata    169.254.169.254, fd00:ec2::254
 *   - Unspecified       0.0.0.0/8, ::
 *   - Plain HTTP in non-dev environments
 *
 * DNS Rebinding Protection:
 *   - Caches and pins DNS resolutions (5-second TTL)
 *   - Forces HTTP client to use pinned IP addresses
 *   - Validates IPs at both check-time and use-time
 *
 * Usage:
 *   await assertSafeUrl(url);          // throws SsrfBlockedError if unsafe
 *   const safeAxios = buildSafeAgent() // axios instance that re-checks on redirect
 */

import dns from 'dns';
import net from 'net';
import { promisify } from 'util';

const resolve4 = promisify(dns.resolve4);
const resolve6 = promisify(dns.resolve6);

// ---------------------------------------------------------------------------
// DNS pinning cache to prevent rebinding attacks
// ---------------------------------------------------------------------------

interface DnsCacheEntry {
  ips: string[];
  expiresAt: number;
}

/**
 * DNS cache to prevent rebinding attacks. Maps hostname -> validated IPs.
 * Short 5-second TTL forces re-validation while preventing immediate rebinding.
 */
const dnsCache = new Map<string, DnsCacheEntry>();
const DNS_CACHE_TTL_MS = 5000; // 5 seconds - balance between security and staleness

/**
 * Clean expired DNS cache entries periodically.
 */
setInterval(() => {
  const now = Date.now();
  for (const [hostname, entry] of dnsCache.entries()) {
    if (entry.expiresAt < now) {
      dnsCache.delete(hostname);
    }
  }
}, 10000); // Run every 10 seconds

// ---------------------------------------------------------------------------
// Custom error
// ---------------------------------------------------------------------------

export class SsrfBlockedError extends Error {
  constructor(reason: string) {
    super(`SSRF blocked: ${reason}`);
    this.name = 'SsrfBlockedError';
  }
}

// ---------------------------------------------------------------------------
// IP range matchers
// ---------------------------------------------------------------------------

/** Convert a dotted-decimal IPv4 string to a 32-bit integer. */
function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, octet) => (acc << 8) | parseInt(octet, 10), 0) >>> 0;
}

interface Ipv4Range {
  base: number;
  mask: number;
}

function makeRange(cidr: string): Ipv4Range {
  const [addr, bits] = cidr.split('/');
  const mask = bits ? (~0 << (32 - parseInt(bits, 10))) >>> 0 : 0xffffffff;
  return { base: ipv4ToInt(addr) & mask, mask };
}

const BLOCKED_IPV4_RANGES: Ipv4Range[] = [
  makeRange('0.0.0.0/8'), // unspecified / "this" network
  makeRange('10.0.0.0/8'), // private
  makeRange('100.64.0.0/10'), // shared address space (RFC 6598)
  makeRange('127.0.0.0/8'), // loopback
  makeRange('169.254.0.0/16'), // link-local / AWS metadata
  makeRange('172.16.0.0/12'), // private
  makeRange('192.0.0.0/24'), // IETF protocol assignments
  makeRange('192.168.0.0/16'), // private
  makeRange('198.18.0.0/15'), // benchmarking
  makeRange('198.51.100.0/24'), // TEST-NET-2 (documentation)
  makeRange('203.0.113.0/24'), // TEST-NET-3 (documentation)
  makeRange('224.0.0.0/4'), // multicast
  makeRange('240.0.0.0/4'), // reserved
  makeRange('255.255.255.255/32'), // broadcast
];

function isBlockedIpv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  return BLOCKED_IPV4_RANGES.some((r) => (n & r.mask) === r.base);
}

/** Strip URL brackets and any zone ID (`fe80::1%eth0`) from an IPv6 literal. */
function normaliseIpv6(ip: string): string {
  return ip
    .replace(/^\[|\]$/g, '')
    .replace(/%.*$/, '')
    .toLowerCase();
}

function isBlockedIpv6(ip: string): boolean {
  const addr = normaliseIpv6(ip);

  // Unspecified :: and loopback ::1
  if (addr === '::' || addr === '::1') return true;

  // IPv4-mapped (::ffff:a.b.c.d) and deprecated IPv4-compatible (::a.b.c.d)
  const ipv4Embedded = addr.match(/^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
  if (ipv4Embedded) return isBlockedIpv4(ipv4Embedded[1]);

  // Same addresses in hex form, as produced by WHATWG URL parsing
  // (e.g. http://[::ffff:127.0.0.1]/ → hostname "[::ffff:7f00:1]").
  const ipv4MappedHex = addr.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (ipv4MappedHex) {
    const hi = parseInt(ipv4MappedHex[1], 16);
    const lo = parseInt(ipv4MappedHex[2], 16);
    return isBlockedIpv4(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
  }

  // Link-local fe80::/10
  if (/^fe[89ab][0-9a-f]:/i.test(addr)) return true;

  // Unique-local fc00::/7
  if (/^f[cd][0-9a-f]{2}:/i.test(addr)) return true;

  // AWS IPv6 metadata fd00:ec2::254
  if (addr === 'fd00:ec2::254') return true;

  // Multicast ff00::/8
  if (/^ff/i.test(addr)) return true;

  return false;
}

/** Returns true if the given IP string (v4 or v6) should be blocked. */
export function isBlockedIp(ip: string): boolean {
  if (net.isIPv4(ip)) return isBlockedIpv4(ip);
  const v6 = normaliseIpv6(ip);
  if (net.isIPv6(v6)) return isBlockedIpv6(v6);
  return false; // not a recognised IP format — let DNS resolution handle it
}

// ---------------------------------------------------------------------------
// URL-level checks
// ---------------------------------------------------------------------------

const ALLOWED_PROTOCOLS = new Set(['https:']);
// Allow plain HTTP only in explicit dev/local profiles
const HTTP_ALLOWED_PROFILES = new Set(['local', 'devnet', 'test']);

function isHttpAllowed(): boolean {
  const profile = (process.env.NETWORK_PROFILE ?? process.env.NODE_ENV ?? '').toLowerCase();
  return HTTP_ALLOWED_PROFILES.has(profile);
}

/** Hostnames that always point at internal infrastructure. */
function isReservedHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  );
}

export type OutboundUrlCheck =
  | { ok: true; url: URL; hostname: string }
  | { ok: false; reason: string };

/**
 * Synchronous part of the outbound URL policy: URL syntax, protocol,
 * embedded credentials, literal private/loopback/link-local IPs and reserved
 * hostnames. No DNS lookup — `assertSafeUrl` performs that on top of this.
 */
export function checkOutboundUrl(rawUrl: string): OutboundUrlCheck {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: `Malformed URL: ${rawUrl}` };
  }

  const proto = parsed.protocol;
  if (proto === 'http:' && !isHttpAllowed()) {
    return {
      ok: false,
      reason: 'Plain HTTP is not permitted for webhook destinations outside dev/local profiles',
    };
  }
  if (!ALLOWED_PROTOCOLS.has(proto) && proto !== 'http:') {
    return { ok: false, reason: `Protocol "${proto}" is not allowed for webhook destinations` };
  }

  if (parsed.username || parsed.password) {
    return { ok: false, reason: 'URLs with embedded credentials are not allowed' };
  }

  // Strip IPv6 brackets and a trailing root dot ("localhost." === "localhost").
  const hostname = parsed.hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();

  if (!hostname) {
    return { ok: false, reason: 'URL has no hostname' };
  }
  if (net.isIP(hostname) && isBlockedIp(hostname)) {
    return { ok: false, reason: `IP address ${hostname} is in a blocked range` };
  }
  if (isReservedHostname(hostname)) {
    return { ok: false, reason: `Hostname "${hostname}" is reserved for internal use` };
  }

  return { ok: true, url: parsed, hostname };
}

/** Boolean form of `checkOutboundUrl`, convenient for zod `.refine()`. */
export function isOutboundUrlAllowed(rawUrl: string): boolean {
  return checkOutboundUrl(rawUrl).ok;
}

/**
 * Resolve all A/AAAA records for `hostname` and throw if any is in a
 * blocked range. Caches results to prevent DNS rebinding attacks.
 */
async function assertHostnameResolvesToPublicIp(hostname: string): Promise<string[]> {
  // Short-circuit for bare IPs — no DNS lookup needed
  if (net.isIPv4(hostname) || net.isIPv6(hostname)) {
    if (isBlockedIp(hostname)) {
      throw new SsrfBlockedError(`IP address ${hostname} is in a blocked range`);
    }
    return [hostname];
  }

  // Reject raw hostnames that look like internal names
  if (isReservedHostname(hostname)) {
    throw new SsrfBlockedError(`Hostname "${hostname}" is reserved for internal use`);
  }

  // Check cache first to prevent DNS rebinding TOCTOU attacks
  const now = Date.now();
  const cached = dnsCache.get(hostname);
  if (cached && cached.expiresAt > now) {
    return cached.ips;
  }

  // Resolve DNS with both IPv4 and IPv6
  const results: string[] = [];
  const [v4, v6] = await Promise.allSettled([resolve4(hostname), resolve6(hostname)]);

  if (v4.status === 'fulfilled') results.push(...v4.value);
  if (v6.status === 'fulfilled') results.push(...v6.value);

  if (results.length === 0) {
    throw new SsrfBlockedError(`Hostname "${hostname}" did not resolve to any IP address`);
  }

  // Validate all resolved IPs
  for (const ip of results) {
    if (isBlockedIp(ip)) {
      throw new SsrfBlockedError(`Hostname "${hostname}" resolves to blocked IP ${ip}`);
    }
  }

  // Cache the validated IPs to prevent rebinding attacks
  dnsCache.set(hostname, {
    ips: results,
    expiresAt: now + DNS_CACHE_TTL_MS,
  });

  return results;
}

/**
 * Validate a webhook URL string and perform DNS pre-flight checks.
 *
 * Returns the validated IPs that should be used for the connection.
 *
 * Throws `SsrfBlockedError` if:
 *   - The protocol is not https (outside dev profiles)
 *   - The hostname resolves to a private/loopback/metadata IP
 *   - The URL is otherwise malformed
 */
export async function assertSafeUrl(rawUrl: string): Promise<string[]> {
  const check = checkOutboundUrl(rawUrl);
  if (!check.ok) throw new SsrfBlockedError(check.reason);
  return await assertHostnameResolvesToPublicIp(check.hostname);
}

// ---------------------------------------------------------------------------
// Axios transport with per-redirect re-validation and DNS pinning
// ---------------------------------------------------------------------------

import axios, { AxiosInstance } from 'axios';
import { Agent as HttpAgent } from 'http';
import { Agent as HttpsAgent } from 'https';
import type { LookupFunction } from 'net';

/**
 * Custom DNS lookup function that uses pinned IPs from our cache.
 * This prevents DNS rebinding between the pre-flight check and actual connection.
 */
function createPinnedLookup(hostname: string, pinnedIps: string[]): LookupFunction {
  const pinnedHost = hostname.replace(/\.$/, '').toLowerCase();
  return (lookupHostname, options, callback) => {
    // Only pin the specific hostname we validated
    if (lookupHostname.replace(/\.$/, '').toLowerCase() !== pinnedHost) {
      // For other hostnames (shouldn't happen), fall back to default DNS
      return dns.lookup(lookupHostname, options, callback);
    }

    // Use the first pinned IP (prefer IPv4 for compatibility)
    const ipv4 = pinnedIps.find((ip) => net.isIPv4(ip));
    const ip = ipv4 || pinnedIps[0];
    const family = net.isIPv4(ip) ? 4 : 6;

    // Return the pinned IP immediately (synchronous callback)
    callback(null, ip, family);
  };
}

/**
 * Return an Axios instance that:
 *   1. Uses pinned DNS resolution to prevent rebinding attacks
 *   2. Disables automatic redirects so we can validate each hop
 *   3. Follows redirects manually, re-checking the destination URL each time
 *   4. Resolves the final IP before the actual POST and blocks if private
 *
 * The caller should pass `REQUEST_TIMEOUT_MS` as the timeout.
 */
export function buildSafeAxios(
  timeoutMs: number,
  hostname: string,
  pinnedIps: string[],
): AxiosInstance {
  const lookup = createPinnedLookup(hostname, pinnedIps);

  return axios.create({
    timeout: timeoutMs,
    maxRedirects: 0, // we follow manually below
    validateStatus: () => true,
    // Dedicated agents with pinned DNS lookup
    httpAgent: new HttpAgent({
      keepAlive: false,
      lookup: lookup as unknown as typeof import('dns').lookup, // Node's types are slightly different but compatible
    }),
    httpsAgent: new HttpsAgent({
      keepAlive: false,
      lookup: lookup as unknown as typeof import('dns').lookup,
    }),
  });
}

/**
 * GET `url` with SSRF protection on every hop.
 *
 * - Validates the initial URL before the first request.
 * - On a 3xx response, validates the redirect target before following.
 * - Maximum 5 redirects.
 *
 * @param params  - Optional query-string parameters (merged into the URL).
 * @param headers - Optional request headers.
 * @param timeoutMs - Per-request timeout in milliseconds (default: 15s).
 *
 * Returns the final Axios response.
 */
export async function safeGet(
  url: string,
  params?: Record<string, unknown>,
  headers?: Record<string, string>,
  timeoutMs = 15_000,
): Promise<{ status: number; data: unknown; headers: Record<string, string> }> {
  const MAX_REDIRECTS = 5;

  // Merge params into URL if provided
  let currentUrl = url;
  if (params && Object.keys(params).length > 0) {
    const u = new URL(url);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) {
        u.searchParams.set(k, String(v));
      }
    }
    currentUrl = u.toString();
  }

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    // Re-validate URL and DNS on every hop (catches redirect-based bypasses).
    const parsed = new URL(currentUrl);
    const pinnedIps = await assertSafeUrl(currentUrl);

    // Build a fresh axios instance pinned to the validated IPs for this hop.
    const client = buildSafeAxios(timeoutMs, parsed.hostname, pinnedIps);

    const response = await client.get(currentUrl, { headers });

    if (response.status >= 300 && response.status < 400) {
      const location = (response.headers as Record<string, string>)['location'];
      if (!location) {
        throw new SsrfBlockedError('Redirect response missing Location header');
      }
      // Resolve relative redirects
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }

    return {
      status: response.status,
      data: response.data,
      headers: response.headers as Record<string, string>,
    };
  }

  throw new SsrfBlockedError(`Exceeded maximum redirect limit (${MAX_REDIRECTS})`);
}

/**
 * POST `body` to `url` with SSRF protection on every hop.
 *
 * - Validates the initial URL before the first request.
 * - On a 3xx response, validates the redirect target before following.
 * - Maximum 5 redirects.
 *
 * Returns the final Axios response.
 */
export async function safePost(
  url: string,
  body: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<{ status: number; data: unknown }> {
  const MAX_REDIRECTS = 5;

  let currentUrl = url;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    // Re-validate URL and DNS on every hop (catches redirect-based bypasses).
    // assertSafeUrl returns the validated IPs so we can pin them to the axios instance.
    const parsed = new URL(currentUrl);
    const pinnedIps = await assertSafeUrl(currentUrl);

    // Build a fresh axios instance pinned to the validated IPs for this hop.
    const client = buildSafeAxios(timeoutMs, parsed.hostname, pinnedIps);

    const response = await client.post(currentUrl, body, { headers });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers['location'];
      if (!location) {
        throw new SsrfBlockedError('Redirect response missing Location header');
      }
      // Resolve relative redirects
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }

    return { status: response.status, data: response.data };
  }

  throw new SsrfBlockedError(`Exceeded maximum redirect limit (${MAX_REDIRECTS})`);
}
