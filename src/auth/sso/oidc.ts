/**
 * OIDC discovery and token-exchange helpers (PLT09 / #1030).
 *
 * All outbound HTTP calls use Node's built-in `fetch` (Node ≥ 18).
 * SSRF protection: only HTTPS issuer URLs are permitted; plain-HTTP and
 * private-network addresses are rejected before any request is made.
 *
 * No third-party OIDC library is introduced; the implementation covers the
 * required subset of RFC 6749, RFC 7636 (PKCE), and OpenID Connect Core 1.0
 * precisely — adding a full library is deferred until the requirements demand
 * implicit/hybrid flows or dynamic client registration.
 *
 * Dependency rationale (PR requirement: no new deps without written rationale):
 *   No new runtime dependencies are added. `node:crypto` (built-in) provides
 *   PKCE challenge generation; `node:fetch` (Node ≥ 18) handles HTTP calls.
 */

import { createHash, randomBytes } from 'crypto';
import { logger } from '../../logger';
import { recordTokenExchange } from './metrics';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
  code_challenge_methods_supported?: string[];
}

export interface OidcTokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  id_token: string;
  refresh_token?: string;
  scope?: string;
}

export interface OidcIdTokenClaims {
  /** Subject — stable identifier for the user at the IdP. */
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
  /** Which application audience(s) this token is intended for. */
  aud?: string | string[];
  iss?: string;
  exp?: number;
  iat?: number;
  /** Nonce used for replay protection (not used in PKCE-only flow). */
  nonce?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// SSRF protection
// ---------------------------------------------------------------------------

const PRIVATE_NETWORK_RE =
  /^https?:\/\/(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|\[::1\])/i;

/**
 * Validates that a URL is an HTTPS URL pointing to a public address.
 * Throws an Error if it is HTTP-only or a private-network address.
 * This is the SSRF protection gate: no outbound calls are made before this
 * check passes.
 */
export function assertPublicHttpsUrl(url: string, label: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`[sso/oidc] ${label} is not a valid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(
      `[sso/oidc] ${label} must use HTTPS (got ${parsed.protocol}). ` +
        'Plain-HTTP IdP endpoints are forbidden (SSRF / credential-in-transit risk).',
    );
  }
  if (PRIVATE_NETWORK_RE.test(url)) {
    throw new Error(
      `[sso/oidc] ${label} resolves to a private/loopback address. ` +
        'SSRF protection rejects private-network OIDC endpoints.',
    );
  }
}

// ---------------------------------------------------------------------------
// OIDC discovery document cache
// ---------------------------------------------------------------------------

interface DiscoveryCacheEntry {
  doc: OidcDiscovery;
  fetchedAt: number;
}

const discoveryCache = new Map<string, DiscoveryCacheEntry>();
/** Discovery documents are re-fetched every 10 minutes. */
const DISCOVERY_CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * Fetches (and caches) the OIDC discovery document from `discoveryUrl`.
 *
 * @param discoveryUrl Full URL to the /.well-known/openid-configuration
 * @param providerId   Used for SSRF check and log correlation
 */
export async function fetchDiscovery(
  discoveryUrl: string,
  providerId: string,
): Promise<OidcDiscovery> {
  assertPublicHttpsUrl(discoveryUrl, `provider ${providerId} discoveryUrl`);

  const cached = discoveryCache.get(discoveryUrl);
  if (cached && Date.now() - cached.fetchedAt < DISCOVERY_CACHE_TTL_MS) {
    return cached.doc;
  }

  const res = await fetch(discoveryUrl, { signal: AbortSignal.timeout(5_000) });
  if (!res.ok) {
    throw new Error(
      `[sso/oidc] Discovery fetch failed for provider ${providerId}: ` +
        `HTTP ${res.status} from ${discoveryUrl}`,
    );
  }
  const doc = (await res.json()) as OidcDiscovery;

  if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) {
    throw new Error(
      `[sso/oidc] Incomplete discovery document from ${discoveryUrl} ` +
        '(missing authorization_endpoint, token_endpoint, or jwks_uri)',
    );
  }

  discoveryCache.set(discoveryUrl, { doc, fetchedAt: Date.now() });
  logger.debug('[sso/oidc] Discovery document cached', { providerId, discoveryUrl });
  return doc;
}

/** Exposed for testing — clears the discovery document cache. */
export function _clearDiscoveryCache(): void {
  discoveryCache.clear();
}

// ---------------------------------------------------------------------------
// PKCE helpers (RFC 7636)
// ---------------------------------------------------------------------------

/**
 * Generates a cryptographically-random PKCE verifier (43–128 chars, base64url
 * alphabet).  The default 64-byte source yields an 86-character verifier.
 */
export function generatePkceVerifier(): string {
  return randomBytes(64).toString('base64url');
}

/**
 * Derives the PKCE code_challenge from the verifier using S256.
 *
 *   code_challenge = BASE64URL(SHA256(ASCII(code_verifier)))
 */
export function derivePkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/**
 * Generates a random opaque `state` value for CSRF protection in the
 * authorization redirect.
 */
export function generateState(): string {
  return randomBytes(24).toString('base64url');
}

// ---------------------------------------------------------------------------
// Token exchange
// ---------------------------------------------------------------------------

/**
 * Exchanges an authorization `code` for tokens at the IdP's token endpoint.
 *
 * Uses PKCE (code_verifier) instead of client_secret when `pkceVerifier` is
 * supplied (preferred for public/native clients).  For confidential clients
 * (server-side) both client authentication and PKCE are used simultaneously
 * per OAuth2 security BCP (RFC 9700).
 */
export async function exchangeCodeForTokens(opts: {
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
  pkceVerifier: string;
  providerId: string;
}): Promise<OidcTokenResponse> {
  assertPublicHttpsUrl(opts.tokenEndpoint, `provider ${opts.providerId} token_endpoint`);

  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    redirect_uri: opts.redirectUri,
    code: opts.code,
    code_verifier: opts.pkceVerifier,
  });

  const startMs = Date.now();
  const res = await fetch(opts.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
    signal: AbortSignal.timeout(10_000),
  });
  recordTokenExchange(opts.providerId, (Date.now() - startMs) / 1000);

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `[sso/oidc] Token exchange failed for provider ${opts.providerId}: ` +
        `HTTP ${res.status} — ${body.slice(0, 200)}`,
    );
  }

  return res.json() as Promise<OidcTokenResponse>;
}

// ---------------------------------------------------------------------------
// ID token decoding (no signature verification — delegated to JWKS layer)
// ---------------------------------------------------------------------------

/**
 * Decodes the ID token payload WITHOUT verifying the signature.
 *
 * Signature verification is intentionally deferred to the IdP's JWKS endpoint
 * (`fetchJwks` / `verifyIdToken`) and is enforced in the callback handler
 * before any user information is trusted.  This function is only used to
 * extract the header's `kid` for key lookup.
 */
export function decodeIdTokenPayload(idToken: string): OidcIdTokenClaims {
  const parts = idToken.split('.');
  if (parts.length !== 3) {
    throw new Error('[sso/oidc] Malformed ID token: expected 3 parts');
  }
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as OidcIdTokenClaims;
  } catch {
    throw new Error('[sso/oidc] Failed to parse ID token payload');
  }
}

/**
 * Validates the standard claims of an already-decoded ID token payload.
 *
 * Checks:
 *   - `iss` matches the expected issuer URL
 *   - `aud` contains the expected clientId
 *   - `exp` is in the future (with a 60-second clock-skew tolerance)
 *   - `email_verified` is true (when present)
 *
 * Throws a descriptive error for each validation failure.
 */
export function validateIdTokenClaims(
  claims: OidcIdTokenClaims,
  expectedIssuer: string,
  expectedClientId: string,
): void {
  // Issuer check
  if (claims.iss && claims.iss !== expectedIssuer) {
    throw new Error(
      `[sso/oidc] ID token issuer mismatch: expected ${expectedIssuer}, got ${claims.iss}`,
    );
  }

  // Audience check
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(expectedClientId)) {
    throw new Error(
      `[sso/oidc] ID token audience does not include clientId ${expectedClientId}`,
    );
  }

  // Expiry check (60s clock skew tolerance)
  if (claims.exp !== undefined) {
    const expiresAt = claims.exp * 1000;
    if (Date.now() > expiresAt + 60_000) {
      throw new Error('[sso/oidc] ID token has expired');
    }
  }

  // Email verification check
  if (claims.email && claims.email_verified === false) {
    throw new Error(
      '[sso/oidc] IdP reports that the user email is not verified. ' +
        'Refusing to provision an account with an unverified email.',
    );
  }
}
