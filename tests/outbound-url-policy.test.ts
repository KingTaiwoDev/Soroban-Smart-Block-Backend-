/**
 * Central outbound URL-fetch policy (#1237).
 *
 * DNS and HTTP are fully mocked so every case runs offline: `dns.resolve4/6`
 * are callback-style (ssrf-guard promisifies them) and `axios.create` returns a
 * scripted client so redirect hops can be asserted one by one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type DnsCallback = (err: Error | null, addrs?: string[]) => void;

const mocks = vi.hoisted(() => ({
  records: new Map<string, { v4?: string[]; v6?: string[] }>(),
  post: vi.fn(),
  get: vi.fn(),
}));

vi.mock('dns', () => {
  const resolver = (family: 'v4' | 'v6') => (host: string, cb: DnsCallback) => {
    const addrs = mocks.records.get(host)?.[family];
    if (addrs?.length) cb(null, addrs);
    else cb(Object.assign(new Error(`ENODATA ${host}`), { code: 'ENODATA' }));
  };
  const dns = { resolve4: resolver('v4'), resolve6: resolver('v6'), lookup: vi.fn() };
  return { default: dns, ...dns };
});

vi.mock('axios', () => {
  const axios = { create: vi.fn(() => ({ post: mocks.post, get: mocks.get })) };
  return { default: axios, ...axios };
});

vi.mock('../src/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  assertSafeUrl,
  checkOutboundUrl,
  isBlockedIp,
  isOutboundUrlAllowed,
  safeGet,
  safePost,
  SsrfBlockedError,
} from '../src/webhooks/ssrf-guard';
import {
  registerWebhook,
  triggerComplianceWebhooks,
} from '../src/services/compliance/webhook-alert';

let hostSeq = 0;
/** Unique hostname per call — ssrf-guard caches validated resolutions for 5s. */
function host(v4?: string[], v6?: string[]): string {
  const name = `h${++hostSeq}.policy-test.example`;
  mocks.records.set(name, { v4, v6 });
  return name;
}

const ORIGINAL_PROFILE = process.env.NETWORK_PROFILE;

beforeEach(() => {
  // Production-like profile: plain HTTP is not permitted.
  process.env.NETWORK_PROFILE = 'mainnet';
  mocks.post.mockReset();
  mocks.get.mockReset();
});

afterEach(() => {
  if (ORIGINAL_PROFILE === undefined) delete process.env.NETWORK_PROFILE;
  else process.env.NETWORK_PROFILE = ORIGINAL_PROFILE;
});

describe('isBlockedIp', () => {
  it.each([
    '127.0.0.1',
    '127.255.255.254',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.0.10',
    '100.64.0.1',
    '169.254.169.254',
    '169.254.1.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
  ])('blocks private / loopback / link-local IPv4 %s', (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  it.each([
    '::',
    '::1',
    '[::1]',
    'fe80::1',
    'fe80::1%eth0',
    'febf::1',
    'fc00::1',
    'fd12:3456::1',
    'fd00:ec2::254',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:a9fe:a9fe',
    '::ffff:10.0.0.1',
    '::127.0.0.1',
  ])('blocks private / loopback / link-local / mapped IPv6 %s', (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111', '::ffff:808:808'])(
    'allows public address %s',
    (ip) => {
      expect(isBlockedIp(ip)).toBe(false);
    },
  );
});

describe('checkOutboundUrl (synchronous policy)', () => {
  it('accepts public https URLs', () => {
    const result = checkOutboundUrl('https://hooks.example.com/webhook?x=1');
    expect(result.ok).toBe(true);
    expect(isOutboundUrlAllowed('https://hooks.example.com/webhook')).toBe(true);
  });

  it.each([
    ['malformed', 'not a url'],
    ['plain http outside dev profiles', 'http://hooks.example.com/'],
    ['file scheme', 'file:///etc/passwd'],
    ['ftp scheme', 'ftp://hooks.example.com/'],
    ['gopher scheme', 'gopher://hooks.example.com/'],
    ['embedded credentials', 'https://user:pass@hooks.example.com/'],
    ['IPv4 loopback', 'https://127.0.0.1/hook'],
    ['decimal-encoded loopback', 'https://2130706433/hook'],
    ['hex/short-form loopback', 'https://0x7f.1/hook'],
    ['cloud metadata', 'https://169.254.169.254/latest/meta-data/'],
    ['private IPv4', 'https://10.0.0.8:8443/hook'],
    ['IPv6 loopback', 'https://[::1]/hook'],
    ['IPv6 link-local', 'https://[fe80::1]/hook'],
    ['IPv6 unique-local', 'https://[fd00::1]/hook'],
    ['IPv4-mapped IPv6 loopback', 'https://[::ffff:127.0.0.1]/hook'],
    ['localhost', 'https://localhost/hook'],
    ['localhost with trailing dot', 'https://LOCALHOST./hook'],
    ['*.localhost', 'https://api.localhost/hook'],
    ['*.internal', 'https://metadata.google.internal/'],
    ['*.local', 'https://printer.local/'],
  ])('rejects %s', (_label, url) => {
    const result = checkOutboundUrl(url);
    expect(result.ok).toBe(false);
    expect(isOutboundUrlAllowed(url)).toBe(false);
  });

  it('permits plain http only in explicit dev/local profiles', () => {
    process.env.NETWORK_PROFILE = 'local';
    expect(isOutboundUrlAllowed('http://hooks.example.com/')).toBe(true);
    // ...but still never to private destinations.
    expect(isOutboundUrlAllowed('http://127.0.0.1:3000/')).toBe(false);
  });
});

describe('assertSafeUrl (DNS pre-flight)', () => {
  it('returns the validated public IPs for pinning', async () => {
    const name = host(['93.184.216.34'], ['2606:2800:220:1::1']);
    await expect(assertSafeUrl(`https://${name}/hook`)).resolves.toEqual([
      '93.184.216.34',
      '2606:2800:220:1::1',
    ]);
  });

  it.each([
    ['private A record', ['10.0.0.5'], undefined],
    ['loopback A record', ['127.0.0.1'], undefined],
    ['link-local metadata A record', ['169.254.169.254'], undefined],
    ['loopback AAAA record', undefined, ['::1']],
    ['link-local AAAA record', undefined, ['fe80::abcd']],
    ['one private record among public ones', ['93.184.216.34', '192.168.1.1'], undefined],
  ])('rejects a hostname with a %s', async (_label, v4, v6) => {
    const name = host(v4, v6);
    await expect(assertSafeUrl(`https://${name}/`)).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it('rejects hostnames that do not resolve', async () => {
    const name = host();
    await expect(assertSafeUrl(`https://${name}/`)).rejects.toThrow(/did not resolve/);
  });

  it('rejects literal private IPs without a DNS lookup', async () => {
    await expect(assertSafeUrl('https://[::ffff:7f00:1]/')).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
  });
});

describe('redirect handling', () => {
  const redirect = (location?: string) => ({
    status: 302,
    data: '',
    headers: location ? { location } : {},
  });

  it('follows a redirect to another public host', async () => {
    const first = host(['93.184.216.34']);
    const second = host(['93.184.216.35']);
    mocks.post
      .mockResolvedValueOnce(redirect(`https://${second}/final`))
      .mockResolvedValueOnce({ status: 200, data: 'ok', headers: {} });

    const res = await safePost(`https://${first}/start`, '{}', {}, 1000);
    expect(res.status).toBe(200);
    expect(mocks.post).toHaveBeenCalledTimes(2);
    expect(mocks.post.mock.calls[1][0]).toBe(`https://${second}/final`);
  });

  it('blocks a redirect to the cloud metadata endpoint', async () => {
    const first = host(['93.184.216.34']);
    mocks.post.mockResolvedValueOnce(redirect('https://169.254.169.254/latest/meta-data/'));

    await expect(safePost(`https://${first}/`, '{}', {}, 1000)).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
    expect(mocks.post).toHaveBeenCalledTimes(1);
  });

  it('blocks a redirect to a hostname resolving to a private address', async () => {
    const first = host(['93.184.216.34']);
    const internal = host(['10.0.0.7']);
    mocks.get.mockResolvedValueOnce(redirect(`https://${internal}/admin`));

    await expect(safeGet(`https://${first}/`)).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(mocks.get).toHaveBeenCalledTimes(1);
  });

  it('blocks a redirect downgraded to plain http', async () => {
    const first = host(['93.184.216.34']);
    mocks.get.mockResolvedValueOnce(redirect(`http://${first}/insecure`));

    await expect(safeGet(`https://${first}/`)).rejects.toThrow(/Plain HTTP/);
  });

  it('rejects redirects without a Location header', async () => {
    const first = host(['93.184.216.34']);
    mocks.post.mockResolvedValueOnce(redirect());

    await expect(safePost(`https://${first}/`, '{}', {}, 1000)).rejects.toThrow(/Location/);
  });

  it('stops after the maximum number of redirects', async () => {
    const first = host(['93.184.216.34']);
    mocks.post.mockResolvedValue(redirect(`https://${first}/loop`));

    await expect(safePost(`https://${first}/`, '{}', {}, 1000)).rejects.toThrow(/maximum redirect/);
    expect(mocks.post).toHaveBeenCalledTimes(6);
  });
});

describe('callers reuse the central policy', () => {
  it('compliance webhooks never send to private destinations and do not retry blocks', async () => {
    registerWebhook('https://127.0.0.1/hook', ['match.found']);

    await triggerComplianceWebhooks('match.found', { address: 'GABC' });

    expect(mocks.post).not.toHaveBeenCalled();
  });
});
