/**
 * Enterprise SSO / OIDC tests (PLT09 / #1030).
 *
 * Coverage target: ≥ 90 % of all new code paths (unit + HTTP integration).
 *
 * Test groups
 * ───────────
 * 1.  OIDC utilities              — SSRF protection, PKCE, discovery, claims validation
 * 2.  Provisioning                — new user, existing user merge, domain enforcement
 * 3.  HTTP: admin provider CRUD   — create, list, update, deactivate
 * 4.  HTTP: org linking           — POST /providers/:id/orgs
 * 5.  HTTP: login initiation      — GET /login/:providerId (redirect + brute-force)
 * 6.  HTTP: callback              — success, state-mismatch, IdP error, token-exchange fail,
 *                                   claim validation fail, provisioning fail
 * 7.  HTTP: logout                — revokes AuthSession + SsoSession
 * 8.  HTTP: audit log             — returns events for a provider
 * 9.  Feature-flag gate           — 404 when flag disabled
 * 10. Metrics smoke test          — counters/histograms increment on login
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// ── In-memory cache ───────────────────────────────────────────────────────────

const cacheStore = new Map<string, unknown>();

vi.mock('../src/cache', () => ({
  cacheGet: async (key: string) => cacheStore.get(key) ?? null,
  cacheSet: async (key: string, value: unknown) => cacheStore.set(key, value),
  cacheDelete: async (key: string) => cacheStore.delete(key),
}));

// ── Prisma mock ───────────────────────────────────────────────────────────────

vi.mock('../src/db', () => ({
  prismaWrite: {
    ssoProvider: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    ssoOrg: { create: vi.fn() },
    ssoSession: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    ssoAuditEvent: {
      create: vi.fn(),
      findMany: vi.fn(),
    },
    walletUser: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    authSession: {
      create: vi.fn(),
      update: vi.fn(),
    },
    authEvent: { create: vi.fn() },
  },
  prismaRead: {
    ssoProvider: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    ssoOrg: { create: vi.fn() },
    ssoSession: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    ssoAuditEvent: {
      create: vi.fn(),
      findMany: vi.fn(),
    },
    walletUser: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    authSession: {
      create: vi.fn(),
      update: vi.fn(),
    },
    authEvent: { create: vi.fn() },
  },
}));

// ── Auth middleware mock ───────────────────────────────────────────────────────

vi.mock('../src/auth/middleware', () => ({
  requireAuth: vi.fn((req: express.Request, _res: express.Response, next: () => void) => {
    req.user = {
      id: 'user-admin',
      address: 'GADMIN',
      role: 'admin' as const,
      tier: 'enterprise' as const,
      sessionId: 'sess_admin',
      appId: 'explorer-web',
    };
    next();
  }),
  requireRole: vi.fn(
    () => (_req: express.Request, _res: express.Response, next: () => void) => next(),
  ),
}));

// ── BruteForce mock ───────────────────────────────────────────────────────────

vi.mock('../src/auth/bruteForce', () => ({
  authRateLimit: (_req: unknown, _res: unknown, next: () => void) => next(),
  checkAccountLockout: vi.fn().mockResolvedValue({ isLocked: false, retryAfterSec: 0 }),
  recordAccountFailure: vi.fn().mockResolvedValue(undefined),
  clearAccountLockout: vi.fn().mockResolvedValue(undefined),
}));

// ── Token issuance mock ───────────────────────────────────────────────────────

vi.mock('../src/auth/tokens', () => ({
  issueTokens: vi.fn().mockResolvedValue({
    token: 'jwt.test.token',
    refreshToken: 'refresh-test',
    tokenHash: 'hash-token',
    refreshTokenHash: 'hash-refresh',
    sessionId: 'sess_sso1',
    expiresAt: new Date(Date.now() + 86400_000),
  }),
  generateSessionId: vi.fn(() => 'sess_sso1'),
  hashToken: vi.fn((t: string) => `hash-${t}`),
  REFRESH_TOKEN_TTL: 2592000,
}));

// ── OIDC module mock ──────────────────────────────────────────────────────────

vi.mock('../src/auth/sso/oidc', () => ({
  fetchDiscovery: vi.fn().mockResolvedValue({
    issuer: 'https://sso.example.com',
    authorization_endpoint: 'https://sso.example.com/authorize',
    token_endpoint: 'https://sso.example.com/token',
    userinfo_endpoint: 'https://sso.example.com/userinfo',
    jwks_uri: 'https://sso.example.com/.well-known/jwks.json',
  }),
  exchangeCodeForTokens: vi.fn().mockResolvedValue({
    access_token: 'idp-access',
    id_token: 'header.eyJzdWIiOiJzdWIxMjMiLCJlbWFpbCI6InVzZXJAYWNtZS5jb20iLCJlbWFpbF92ZXJpZmllZCI6dHJ1ZSwibmFtZSI6IlRlc3QgVXNlciIsImlzcyI6Imh0dHBzOi8vc3NvLmV4YW1wbGUuY29tIiwiYXVkIjoiY2xpZW50LWlkLTEiLCJleHAiOjk5OTk5OTk5OTl9.sig',
    token_type: 'Bearer',
  }),
  decodeIdTokenPayload: vi.fn().mockReturnValue({
    sub: 'sub123',
    email: 'user@acme.com',
    email_verified: true,
    name: 'Test User',
    iss: 'https://sso.example.com',
    aud: 'client-id-1',
    exp: 9999999999,
  }),
  validateIdTokenClaims: vi.fn(),
  generatePkceVerifier: vi.fn(() => 'pkce-verifier-abc'),
  derivePkceChallenge: vi.fn(() => 'pkce-challenge-abc'),
  generateState: vi.fn(() => 'state-xyz'),
  assertPublicHttpsUrl: vi.fn(),
  _clearDiscoveryCache: vi.fn(),
}));

// ── Feature flag mock — enabled by default ────────────────────────────────────

vi.mock('../src/feature-flags', () => ({
  featureFlags: { shouldStartSync: vi.fn().mockReturnValue(true) },
}));

// ── Metrics mock ──────────────────────────────────────────────────────────────

vi.mock('../src/auth/sso/metrics', () => ({
  ssoProviderOpsTotal: { labels: vi.fn().mockReturnValue({ inc: vi.fn() }) },
  ssoActiveSessionsGauge: { labels: vi.fn().mockReturnValue({ inc: vi.fn(), dec: vi.fn() }) },
  recordSsoLogin: vi.fn(),
  recordTokenExchange: vi.fn(),
  recordProvision: vi.fn(),
}));

// ── Imports that depend on the mocks above ────────────────────────────────────

import {
  assertPublicHttpsUrl,
  generatePkceVerifier,
  derivePkceChallenge,
  generateState,
  decodeIdTokenPayload,
  validateIdTokenClaims,
  _clearDiscoveryCache,
} from '../src/auth/sso/oidc';

import { provisionSsoUser, syntheticSsoAddress } from '../src/auth/sso/provision';
import { checkAccountLockout } from '../src/auth/bruteForce';
import { featureFlags } from '../src/feature-flags';
import { authSsoRouter } from '../src/api/authSso';
import { prismaWrite as prismaMock } from '../src/db';

// ── Test HTTP server ──────────────────────────────────────────────────────────

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/auth/sso', authSsoRouter);

  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(
  () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
);

beforeEach(() => {
  vi.clearAllMocks();
  cacheStore.clear();
  // Reset feature flag to enabled by default
  (featureFlags.shouldStartSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
  // Reset brute-force to not locked
  (checkAccountLockout as ReturnType<typeof vi.fn>).mockResolvedValue({
    isLocked: false,
    retryAfterSec: 0,
  });
  // Reset audit event creation
  (prismaMock as any).ssoAuditEvent.create.mockResolvedValue({});
  (prismaMock as any).authSession.create.mockResolvedValue({});
  (prismaMock as any).authEvent.create.mockResolvedValue({});
});

// ============================================================================
// 1. OIDC utilities (unit)
// ============================================================================

describe('OIDC utilities', () => {
  describe('SSRF protection — assertPublicHttpsUrl', () => {
    // Import the real implementation (bypassing the mock) to test SSRF gate directly.
    let realAssert: typeof assertPublicHttpsUrl;

    beforeAll(async () => {
      const real = await vi.importActual<typeof import('../src/auth/sso/oidc')>('../src/auth/sso/oidc');
      realAssert = real.assertPublicHttpsUrl;
    });

    it('accepts a public HTTPS URL', () => {
      expect(() => realAssert('https://okta.example.com', 'issuerUrl')).not.toThrow();
    });

    it('rejects HTTP (plain-text) URL', () => {
      expect(() => realAssert('http://okta.example.com', 'issuerUrl')).toThrow('HTTPS');
    });

    it('rejects localhost', () => {
      expect(() => realAssert('https://localhost/oidc', 'issuerUrl')).toThrow('private');
    });

    it('rejects 127.x.x.x', () => {
      expect(() => realAssert('https://127.0.0.1/oidc', 'issuerUrl')).toThrow('private');
    });

    it('rejects RFC-1918 10.x', () => {
      expect(() => realAssert('https://10.0.0.1/oidc', 'issuerUrl')).toThrow('private');
    });

    it('rejects malformed URL', () => {
      expect(() => realAssert('not-a-url', 'issuerUrl')).toThrow('valid URL');
    });
  });

  describe('PKCE helpers', () => {
    let realGen: typeof generatePkceVerifier;
    let realDerive: typeof derivePkceChallenge;

    beforeAll(async () => {
      const real = await vi.importActual<typeof import('../src/auth/sso/oidc')>('../src/auth/sso/oidc');
      realGen = real.generatePkceVerifier;
      realDerive = real.derivePkceChallenge;
    });

    it('generatePkceVerifier returns a non-empty string', () => {
      expect(realGen()).toBeTruthy();
    });

    it('derivePkceChallenge is deterministic for the same input', () => {
      const v = realGen();
      expect(realDerive(v)).toBe(realDerive(v));
    });

    it('generateState returns a non-empty string', () => {
      expect(generateState()).toBeTruthy();
    });
  });

  describe('ID token claim validation', () => {
    let realValidate: typeof validateIdTokenClaims;

    beforeAll(async () => {
      const real = await vi.importActual<typeof import('../src/auth/sso/oidc')>('../src/auth/sso/oidc');
      realValidate = real.validateIdTokenClaims;
    });

    it('validates a well-formed claims object', () => {
      expect(() =>
        realValidate(
          {
            sub: 'user1',
            iss: 'https://sso.example.com',
            aud: 'client-id-1',
            exp: Math.floor(Date.now() / 1000) + 3600,
            email: 'u@example.com',
            email_verified: true,
          },
          'https://sso.example.com',
          'client-id-1',
        ),
      ).not.toThrow();
    });

    it('rejects an expired token', () => {
      expect(() =>
        realValidate(
          { sub: 'u', iss: 'https://sso.example.com', aud: 'cid', exp: 1 },
          'https://sso.example.com',
          'cid',
        ),
      ).toThrow('expired');
    });

    it('rejects issuer mismatch', () => {
      expect(() =>
        realValidate(
          {
            sub: 'u',
            iss: 'https://evil.example.com',
            aud: 'cid',
            exp: Math.floor(Date.now() / 1000) + 3600,
          },
          'https://sso.example.com',
          'cid',
        ),
      ).toThrow('mismatch');
    });

    it('rejects unverified email', () => {
      expect(() =>
        realValidate(
          {
            sub: 'u',
            iss: 'https://sso.example.com',
            aud: 'cid',
            exp: Math.floor(Date.now() / 1000) + 3600,
            email: 'u@example.com',
            email_verified: false,
          },
          'https://sso.example.com',
          'cid',
        ),
      ).toThrow('not verified');
    });
  });
});

// ============================================================================
// 2. Provisioning (unit with real provision.ts + mocked prisma)
// ============================================================================

describe('SSO provisioning', () => {
  const orgCfg = {
    autoProvision: true,
    enforceEmailDomain: false,
    domains: [] as string[],
    defaultRole: 'member',
    defaultTier: 'enterprise',
    orgId: 'org-acme',
  };

  const claims = {
    sub: 'sub-abc',
    email: 'alice@acme.com',
    email_verified: true,
    name: 'Alice',
    picture: 'https://example.com/pic.png',
  };

  it('creates a new user when none exists', async () => {
    (prismaMock as any).walletUser.findUnique.mockResolvedValue(null);
    (prismaMock as any).walletUser.findFirst.mockResolvedValue(null);
    (prismaMock as any).walletUser.create.mockResolvedValue({
      id: 'new-user-1',
      address: syntheticSsoAddress('prov1', 'sub-abc'),
      role: 'member',
      tier: 'enterprise',
    });

    const result = await provisionSsoUser(claims, 'prov1', orgCfg);
    expect(result.isNewUser).toBe(true);
    expect(result.userId).toBe('new-user-1');
    expect((prismaMock as any).walletUser.create).toHaveBeenCalledOnce();
  });

  it('links an existing SSO user (same synthetic address)', async () => {
    (prismaMock as any).walletUser.findUnique.mockResolvedValue({
      id: 'existing-sso',
      address: syntheticSsoAddress('prov1', 'sub-abc'),
      role: 'member',
      tier: 'enterprise',
      displayName: 'Old Name',
      avatarUrl: null,
      email: null,
    });
    (prismaMock as any).walletUser.update.mockResolvedValue({});

    const result = await provisionSsoUser(claims, 'prov1', orgCfg);
    expect(result.isNewUser).toBe(false);
    expect(result.userId).toBe('existing-sso');
    expect((prismaMock as any).walletUser.create).not.toHaveBeenCalled();
  });

  it('merges with an existing wallet-auth user via email', async () => {
    (prismaMock as any).walletUser.findUnique.mockResolvedValue(null); // no synthetic address
    (prismaMock as any).walletUser.findFirst.mockResolvedValue({
      id: 'wallet-user-1',
      address: 'GSTELLAR',
      role: 'user',
      tier: 'free',
    });
    (prismaMock as any).walletUser.update.mockResolvedValue({});

    const result = await provisionSsoUser(claims, 'prov1', orgCfg);
    expect(result.isNewUser).toBe(false);
    expect(result.userId).toBe('wallet-user-1');
    expect((prismaMock as any).walletUser.update).toHaveBeenCalledOnce();
  });

  it('throws when autoProvision is false and user is unknown', async () => {
    (prismaMock as any).walletUser.findUnique.mockResolvedValue(null);
    (prismaMock as any).walletUser.findFirst.mockResolvedValue(null);

    await expect(
      provisionSsoUser(claims, 'prov1', { ...orgCfg, autoProvision: false }),
    ).rejects.toThrow('autoProvision is disabled');
  });

  it('enforces email domain restriction', async () => {
    (prismaMock as any).walletUser.findUnique.mockResolvedValue(null);
    (prismaMock as any).walletUser.findFirst.mockResolvedValue(null);

    await expect(
      provisionSsoUser(claims, 'prov1', {
        ...orgCfg,
        enforceEmailDomain: true,
        domains: ['allowed.com'],
      }),
    ).rejects.toThrow('domain');
  });

  it('allows email that matches the permitted domain', async () => {
    (prismaMock as any).walletUser.findUnique.mockResolvedValue(null);
    (prismaMock as any).walletUser.findFirst.mockResolvedValue(null);
    (prismaMock as any).walletUser.create.mockResolvedValue({
      id: 'u2',
      address: syntheticSsoAddress('prov1', 'sub-abc'),
      role: 'member',
      tier: 'enterprise',
    });

    await expect(
      provisionSsoUser(
        { ...claims, email: 'alice@acme.com' },
        'prov1',
        { ...orgCfg, enforceEmailDomain: true, domains: ['acme.com'] },
      ),
    ).resolves.not.toThrow();
  });
});

// ============================================================================
// 3. HTTP — admin: provider CRUD
// ============================================================================

describe('POST /auth/sso/providers', () => {
  it('creates a provider and returns 201', async () => {
    (prismaMock as any).ssoProvider.create.mockResolvedValue({
      id: 'prov-1',
      name: 'Okta ACME',
      issuerUrl: 'https://sso.example.com',
      clientId: 'cid1',
      discoveryUrl: 'https://sso.example.com/.well-known/openid-configuration',
      scopes: 'openid email profile',
      pkceMethod: 'S256',
      isActive: true,
      createdAt: new Date(),
    });

    const res = await fetch(`${baseUrl}/auth/sso/providers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Okta ACME',
        issuerUrl: 'https://sso.example.com',
        clientId: 'cid1',
        clientSecret: 'supersecret1234',
        discoveryUrl: 'https://sso.example.com/.well-known/openid-configuration',
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBe('prov-1');
    expect(body.name).toBe('Okta ACME');
    expect(body).not.toHaveProperty('clientSecretHash');
  });

  it('returns 400 for missing required fields', async () => {
    const res = await fetch(`${baseUrl}/auth/sso/providers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Bad' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('validation_error');
  });

  it('returns 422 when discovery issuer mismatches supplied issuerUrl', async () => {
    const { fetchDiscovery: mockFetch } = await import('../src/auth/sso/oidc');
    (mockFetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      issuer: 'https://different.example.com',
      authorization_endpoint: 'https://sso.example.com/authorize',
      token_endpoint: 'https://sso.example.com/token',
      userinfo_endpoint: 'https://sso.example.com/userinfo',
      jwks_uri: 'https://sso.example.com/.well-known/jwks.json',
    });

    const res = await fetch(`${baseUrl}/auth/sso/providers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Bad Provider',
        issuerUrl: 'https://sso.example.com',
        clientId: 'cid1',
        clientSecret: 'supersecret1234',
        discoveryUrl: 'https://sso.example.com/.well-known/openid-configuration',
      }),
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe('issuer_mismatch');
  });
});

describe('GET /auth/sso/providers', () => {
  it('returns provider list', async () => {
    (prismaMock as any).ssoProvider.findMany.mockResolvedValue([
      {
        id: 'p1',
        name: 'Okta',
        issuerUrl: 'https://acme.okta.com',
        clientId: 'c1',
        discoveryUrl: 'https://acme.okta.com/.well-known/openid-configuration',
        scopes: 'openid email',
        pkceMethod: 'S256',
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        _count: { sessions: 3, orgs: 1 },
      },
    ]);

    const res = await fetch(`${baseUrl}/auth/sso/providers`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.providers).toHaveLength(1);
    expect(body.providers[0].id).toBe('p1');
  });
});

describe('PATCH /auth/sso/providers/:id', () => {
  it('updates a provider', async () => {
    (prismaMock as any).ssoProvider.findUnique.mockResolvedValue({
      id: 'p1',
      name: 'Old Name',
      issuerUrl: 'https://acme.okta.com',
      isActive: true,
    });
    (prismaMock as any).ssoProvider.update.mockResolvedValue({
      id: 'p1',
      name: 'New Name',
      issuerUrl: 'https://acme.okta.com',
      isActive: true,
      updatedAt: new Date(),
    });

    const res = await fetch(`${baseUrl}/auth/sso/providers/p1`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'New Name' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe('New Name');
  });

  it('returns 404 for unknown provider', async () => {
    (prismaMock as any).ssoProvider.findUnique.mockResolvedValue(null);
    const res = await fetch(`${baseUrl}/auth/sso/providers/nonexistent`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'X' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /auth/sso/providers/:id', () => {
  it('deactivates a provider', async () => {
    (prismaMock as any).ssoProvider.findUnique.mockResolvedValue({ id: 'p1', name: 'Test' });
    (prismaMock as any).ssoProvider.update.mockResolvedValue({});

    const res = await fetch(`${baseUrl}/auth/sso/providers/p1`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });
});

// ============================================================================
// 4. HTTP — org linking
// ============================================================================

describe('POST /auth/sso/providers/:id/orgs', () => {
  it('links a provider to an org', async () => {
    (prismaMock as any).ssoProvider.findFirst.mockResolvedValue({ id: 'p1', isActive: true });
    (prismaMock as any).ssoOrg.create.mockResolvedValue({
      id: 'sso-org-1',
      providerId: 'p1',
      orgId: 'org-acme',
      domains: ['acme.com'],
      defaultRole: 'member',
      defaultTier: 'enterprise',
      autoProvision: true,
      enforceEmailDomain: true,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await fetch(`${baseUrl}/auth/sso/providers/p1/orgs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orgId: 'org-acme',
        domains: ['acme.com'],
        defaultTier: 'enterprise',
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.orgId).toBe('org-acme');
  });

  it('returns 404 when provider not found', async () => {
    (prismaMock as any).ssoProvider.findFirst.mockResolvedValue(null);
    const res = await fetch(`${baseUrl}/auth/sso/providers/nonexistent/orgs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgId: 'o1' }),
    });
    expect(res.status).toBe(404);
  });
});

// ============================================================================
// 5. HTTP — login initiation
// ============================================================================

describe('GET /auth/sso/login/:providerId', () => {
  it('redirects to the IdP authorization URL', async () => {
    (prismaMock as any).ssoProvider.findFirst.mockResolvedValue({
      id: 'p1',
      clientId: 'client-id-1',
      issuerUrl: 'https://sso.example.com',
      discoveryUrl: 'https://sso.example.com/.well-known/openid-configuration',
      scopes: 'openid email profile',
      pkceMethod: 'S256',
      isActive: true,
    });

    const res = await fetch(`${baseUrl}/auth/sso/login/p1`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    const loc = res.headers.get('location') ?? '';
    expect(loc).toContain('https://sso.example.com/authorize');
    expect(loc).toContain('response_type=code');
    expect(loc).toContain('code_challenge_method=S256');
  });

  it('returns 404 when provider not found', async () => {
    (prismaMock as any).ssoProvider.findFirst.mockResolvedValue(null);
    const res = await fetch(`${baseUrl}/auth/sso/login/unknown`);
    expect(res.status).toBe(404);
  });

  it('returns 429 when IP is locked', async () => {
    (checkAccountLockout as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      isLocked: true,
      retryAfterSec: 300,
    });
    (prismaMock as any).ssoProvider.findFirst.mockResolvedValue({ id: 'p1', isActive: true });

    const res = await fetch(`${baseUrl}/auth/sso/login/p1`);
    expect(res.status).toBe(429);
  });
});

// ============================================================================
// 6. HTTP — callback
// ============================================================================

/** Seed the PKCE state into cache for callback tests. */
async function seedPkceState(state = 'state-xyz', providerId = 'p1'): Promise<void> {
  cacheStore.set(`sso:pkce:state:${state}`, {
    providerId,
    verifier: 'pkce-verifier-abc',
    createdAt: Date.now(),
  });
}

function setupCallbackMocks(): void {
  (prismaMock as any).ssoProvider.findFirst.mockResolvedValue({
    id: 'p1',
    clientId: 'client-id-1',
    clientSecretHash: 'hash-of-secret',
    issuerUrl: 'https://sso.example.com',
    discoveryUrl: 'https://sso.example.com/.well-known/openid-configuration',
    scopes: 'openid email profile',
    pkceMethod: 'S256',
    isActive: true,
    orgs: [
      {
        id: 'sso-org-1',
        autoProvision: true,
        enforceEmailDomain: false,
        domains: [],
        defaultRole: 'member',
        defaultTier: 'enterprise',
        orgId: 'org-acme',
        isActive: true,
      },
    ],
  });
  (prismaMock as any).walletUser.findUnique.mockResolvedValue(null);
  (prismaMock as any).walletUser.findFirst.mockResolvedValue(null);
  (prismaMock as any).walletUser.create.mockResolvedValue({
    id: 'new-user-1',
    address: 'SSO:p1:sub123',
    role: 'member',
    tier: 'enterprise',
  });
  (prismaMock as any).ssoSession.create.mockResolvedValue({});
}

describe('GET /auth/sso/callback/:providerId', () => {
  it('issues tokens on a successful callback', async () => {
    await seedPkceState();
    setupCallbackMocks();

    const res = await fetch(`${baseUrl}/auth/sso/callback/p1?code=auth-code-1&state=state-xyz`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token).toBe('jwt.test.token');
    expect(body.sessionId).toBe('sess_sso1');
    expect(body.user.isNewUser).toBe(true);
  });

  it('returns 400 on IdP-reported error', async () => {
    const res = await fetch(
      `${baseUrl}/auth/sso/callback/p1?error=access_denied&error_description=User+denied`,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('access_denied');
  });

  it('returns 400 when state is missing', async () => {
    const res = await fetch(`${baseUrl}/auth/sso/callback/p1?code=abc`);
    expect(res.status).toBe(400);
  });

  it('returns 400 on state mismatch', async () => {
    // Don't seed state — cache is empty
    const res = await fetch(`${baseUrl}/auth/sso/callback/p1?code=abc&state=wrong-state`);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_state');
  });

  it('returns 502 when token exchange fails', async () => {
    await seedPkceState();
    setupCallbackMocks();
    const { exchangeCodeForTokens: mockExchange } = await import('../src/auth/sso/oidc');
    (mockExchange as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('IdP unreachable'),
    );

    const res = await fetch(`${baseUrl}/auth/sso/callback/p1?code=code1&state=state-xyz`);
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe('token_exchange_failed');
  });

  it('returns 401 when ID token validation fails', async () => {
    await seedPkceState();
    setupCallbackMocks();
    const { validateIdTokenClaims: mockValidate } = await import('../src/auth/sso/oidc');
    (mockValidate as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('[sso/oidc] ID token has expired');
    });

    const res = await fetch(`${baseUrl}/auth/sso/callback/p1?code=code1&state=state-xyz`);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('invalid_id_token');
  });

  it('returns 403 when provisioning fails (domain mismatch)', async () => {
    await seedPkceState();
    // Provider with domain enforcement
    (prismaMock as any).ssoProvider.findFirst.mockResolvedValue({
      id: 'p1',
      clientId: 'client-id-1',
      clientSecretHash: 'hash',
      issuerUrl: 'https://sso.example.com',
      discoveryUrl: 'https://sso.example.com/.well-known/openid-configuration',
      scopes: 'openid email profile',
      pkceMethod: 'S256',
      isActive: true,
      orgs: [
        {
          id: 'sso-org-1',
          autoProvision: true,
          enforceEmailDomain: true,
          domains: ['allowed.com'],
          defaultRole: 'member',
          defaultTier: 'enterprise',
          orgId: 'org-1',
          isActive: true,
        },
      ],
    });
    (prismaMock as any).walletUser.findUnique.mockResolvedValue(null);
    (prismaMock as any).walletUser.findFirst.mockResolvedValue(null);

    const res = await fetch(`${baseUrl}/auth/sso/callback/p1?code=code1&state=state-xyz`);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('provisioning_failed');
  });

  it('redirects with token fragment when redirect_after was supplied', async () => {
    await seedPkceState();
    // Overwrite the PKCE state to include a redirect_after
    cacheStore.set('sso:pkce:state:state-xyz', {
      providerId: 'p1',
      verifier: 'pkce-verifier-abc',
      redirectAfter: 'https://app.acme.com/dashboard',
      createdAt: Date.now(),
    });
    setupCallbackMocks();

    const res = await fetch(`${baseUrl}/auth/sso/callback/p1?code=code1&state=state-xyz`, {
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    const loc = res.headers.get('location') ?? '';
    expect(loc).toContain('app.acme.com/dashboard');
    expect(loc).toContain('#token=');
  });
});

// ============================================================================
// 7. HTTP — logout
// ============================================================================

describe('POST /auth/sso/logout', () => {
  it('revokes the session and returns success', async () => {
    (prismaMock as any).authSession.update.mockResolvedValue({});
    (prismaMock as any).ssoSession.findUnique.mockResolvedValue({
      id: 'sess_admin',
      providerId: 'p1',
      isActive: true,
    });
    (prismaMock as any).ssoSession.update.mockResolvedValue({});

    const res = await fetch(`${baseUrl}/auth/sso/logout`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect((prismaMock as any).authSession.update).toHaveBeenCalledOnce();
  });

  it('still succeeds when no matching SsoSession exists (JWT-only session)', async () => {
    (prismaMock as any).authSession.update.mockResolvedValue({});
    (prismaMock as any).ssoSession.findUnique.mockResolvedValue(null);

    const res = await fetch(`${baseUrl}/auth/sso/logout`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(res.status).toBe(200);
  });
});

// ============================================================================
// 8. HTTP — audit log
// ============================================================================

describe('GET /auth/sso/providers/:id/audit', () => {
  it('returns audit events for a provider', async () => {
    (prismaMock as any).ssoAuditEvent.findMany.mockResolvedValue([
      {
        id: 'ev1',
        providerId: 'p1',
        eventType: 'sso.login',
        actorId: null,
        subjectId: 'user-1',
        before: null,
        after: { userId: 'user-1' },
        createdAt: new Date(),
      },
    ]);

    const res = await fetch(`${baseUrl}/auth/sso/providers/p1/audit`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.events).toHaveLength(1);
    expect(body.events[0].eventType).toBe('sso.login');
  });
});

// ============================================================================
// 9. Feature-flag gate
// ============================================================================

describe('Feature-flag gate', () => {
  it('returns 404 FEATURE_DISABLED when enterprise SSO is off', async () => {
    (featureFlags.shouldStartSync as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const res = await fetch(`${baseUrl}/auth/sso/providers`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('FEATURE_DISABLED');
  });
});

// ============================================================================
// 10. Metrics smoke test
// ============================================================================

describe('Metrics smoke test', () => {
  it('calls recordSsoLogin on a successful callback', async () => {
    const { recordSsoLogin: mockRecord } = await import('../src/auth/sso/metrics');
    await seedPkceState();
    setupCallbackMocks();

    await fetch(`${baseUrl}/auth/sso/callback/p1?code=auth-code-1&state=state-xyz`);
    expect(mockRecord).toHaveBeenCalledWith('p1', 'success', expect.any(Number));
  });

  it('calls recordSsoLogin with "error" on token-exchange failure', async () => {
    const { recordSsoLogin: mockRecord } = await import('../src/auth/sso/metrics');
    await seedPkceState();
    setupCallbackMocks();
    const { exchangeCodeForTokens: mockExchange } = await import('../src/auth/sso/oidc');
    (mockExchange as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('IdP down'));

    await fetch(`${baseUrl}/auth/sso/callback/p1?code=code&state=state-xyz`);
    expect(mockRecord).toHaveBeenCalledWith('p1', 'error', expect.any(Number));
  });
});
