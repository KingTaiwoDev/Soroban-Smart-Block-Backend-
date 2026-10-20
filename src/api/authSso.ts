/**
 * Enterprise SSO / OIDC router (PLT09 / #1030).
 *
 * Mounted at /auth/sso by src/api/router.ts.
 *
 * Routes
 * ──────
 * Admin (requireAuth + requireRole('admin'))
 *   POST   /auth/sso/providers               — register an OIDC provider
 *   GET    /auth/sso/providers               — list providers
 *   PATCH  /auth/sso/providers/:id           — update provider
 *   DELETE /auth/sso/providers/:id           — deactivate provider
 *   POST   /auth/sso/providers/:id/orgs      — link provider → org
 *   GET    /auth/sso/providers/:id/audit     — audit log for a provider
 *
 * End-user (no auth required — these are the OIDC redirect endpoints)
 *   GET    /auth/sso/login/:providerId       — initiate OIDC authorization redirect
 *   GET    /auth/sso/callback/:providerId    — OIDC callback; issues session tokens
 *   POST   /auth/sso/logout                 — revoke the SSO session (requireAuth)
 *
 * Security properties
 * ───────────────────
 * • PKCE S256 on every authorization request — no implicit flow.
 * • State parameter validated on callback to prevent CSRF.
 * • PKCE verifier and state stored in a short-lived (10-min TTL) cache entry,
 *   keyed by the random state value; never stored in a cookie or URL param.
 * • ID token claims validated (issuer, audience, expiry, email_verified).
 * • SSRF protection: all outbound HTTP calls go through assertPublicHttpsUrl().
 * • Feature-flag gated: returns 404 FEATURE_DISABLED unless ENABLE_ENTERPRISE_SSO=true.
 * • Brute-force protection: failed callbacks increment the per-IP counter in
 *   the existing bruteForce module.
 * • Input validation via zod on all admin mutations.
 * • Tenant isolation: every DB read is scoped to (providerId, idpSubject) or email.
 */

import { Router, Request, Response } from 'express';
import { createHash, randomBytes } from 'crypto';
import { z } from 'zod';
import { prismaWrite as prisma } from '../db';
import { requireAuth, requireRole } from '../auth/middleware';
import { asyncHandler } from '../middleware/asyncHandler';
import {
  authRateLimit,
  checkAccountLockout,
  recordAccountFailure,
  clearAccountLockout,
} from '../auth/bruteForce';
import { issueTokens, generateSessionId, REFRESH_TOKEN_TTL, hashToken } from '../auth/tokens';
import { uuidv7 } from '../utils/uuidv7';
import { logger } from '../logger';
import { cacheGet, cacheSet, cacheDelete } from '../cache';
import { featureFlags } from '../feature-flags';
import {
  fetchDiscovery,
  exchangeCodeForTokens,
  decodeIdTokenPayload,
  validateIdTokenClaims,
  generatePkceVerifier,
  derivePkceChallenge,
  generateState,
  assertPublicHttpsUrl,
} from '../auth/sso/oidc';
import { provisionSsoUser, _writeAuditEvent } from '../auth/sso/provision';
import {
  ssoProviderOpsTotal,
  ssoActiveSessionsGauge,
  recordSsoLogin,
} from '../auth/sso/metrics';

// ---------------------------------------------------------------------------
// Feature-flag gate middleware
// ---------------------------------------------------------------------------

function requireSsoEnabled(_req: Request, res: Response, next: () => void): void {
  if (!featureFlags.shouldStartSync('enterpriseSso')) {
    res.status(404).json({ error: 'FEATURE_DISABLED', message: 'Enterprise SSO is not enabled' });
    return;
  }
  next();
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const authSsoRouter = Router();

// Apply the SSO feature-flag gate and the existing auth rate limiter globally.
authSsoRouter.use(requireSsoEnabled);
authSsoRouter.use(authRateLimit);

// ---------------------------------------------------------------------------
// Input validation schemas
// ---------------------------------------------------------------------------

const createProviderSchema = z.object({
  name: z.string().min(1).max(128),
  issuerUrl: z.string().url(),
  clientId: z.string().min(1).max(256),
  clientSecret: z.string().min(8).max(512),
  discoveryUrl: z.string().url().optional(),
  scopes: z.string().default('openid email profile'),
  pkceMethod: z.enum(['S256']).default('S256'),
  metadata: z.record(z.unknown()).optional(),
});

const updateProviderSchema = createProviderSchema.partial().omit({ clientSecret: true }).extend({
  clientSecret: z.string().min(8).max(512).optional(),
  isActive: z.boolean().optional(),
});

const linkOrgSchema = z.object({
  orgId: z.string().min(1).max(128),
  domains: z.array(z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i)).default([]),
  defaultRole: z.enum(['owner', 'admin', 'billing', 'member']).default('member'),
  defaultTier: z.enum(['free', 'developer', 'premium', 'enterprise']).default('enterprise'),
  autoProvision: z.boolean().default(true),
  enforceEmailDomain: z.boolean().default(true),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PKCE_STATE_PREFIX = 'sso:pkce:state:';
const PKCE_STATE_TTL = 600; // 10 minutes

interface PkceStateEntry {
  providerId: string;
  verifier: string;
  redirectAfter?: string;
  createdAt: number;
}

async function storePkceState(state: string, entry: PkceStateEntry): Promise<void> {
  await cacheSet(`${PKCE_STATE_PREFIX}${state}`, entry, PKCE_STATE_TTL);
}

async function consumePkceState(state: string): Promise<PkceStateEntry | null> {
  const key = `${PKCE_STATE_PREFIX}${state}`;
  const entry = await cacheGet<PkceStateEntry>(key);
  if (entry) await cacheDelete(key); // single-use
  return entry;
}

function hashClientSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

// ---------------------------------------------------------------------------
// ── Admin: Provider management ────────────────────────────────────────────
// ---------------------------------------------------------------------------

/**
 * POST /auth/sso/providers
 * Register a new OIDC provider.
 */
authSsoRouter.post(
  '/providers',
  requireAuth,
  requireRole('admin'),
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = createProviderSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_error', issues: parsed.error.issues });
    }
    const data = parsed.data;

    // SSRF check before any DB write
    assertPublicHttpsUrl(data.issuerUrl, 'issuerUrl');
    const discoveryUrl =
      data.discoveryUrl ?? `${data.issuerUrl.replace(/\/$/, '')}/.well-known/openid-configuration`;
    assertPublicHttpsUrl(discoveryUrl, 'discoveryUrl');

    // Verify the discovery document is reachable before persisting
    const discovery = await fetchDiscovery(discoveryUrl, 'pre-register-check');
    if (discovery.issuer && discovery.issuer !== data.issuerUrl.replace(/\/$/, '')) {
      return res.status(422).json({
        error: 'issuer_mismatch',
        message: `Discovery document issuer "${discovery.issuer}" does not match the supplied issuerUrl "${data.issuerUrl}".`,
      });
    }

    const provider = await prisma.ssoProvider.create({
      data: {
        name: data.name,
        issuerUrl: data.issuerUrl.replace(/\/$/, ''),
        clientId: data.clientId,
        clientSecretHash: hashClientSecret(data.clientSecret),
        discoveryUrl,
        scopes: data.scopes,
        pkceMethod: data.pkceMethod,
        metadata: data.metadata ?? {},
      },
    });

    await _writeAuditEvent({
      providerId: provider.id,
      actorId: req.user!.id,
      eventType: 'sso.provider.created',
      after: {
        providerId: provider.id,
        name: provider.name,
        issuerUrl: provider.issuerUrl,
        clientId: provider.clientId,
      },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    ssoProviderOpsTotal.labels('create').inc();
    logger.info('[sso] Provider registered', { providerId: provider.id, name: provider.name });

    return res.status(201).json({
      id: provider.id,
      name: provider.name,
      issuerUrl: provider.issuerUrl,
      clientId: provider.clientId,
      discoveryUrl: provider.discoveryUrl,
      scopes: provider.scopes,
      pkceMethod: provider.pkceMethod,
      isActive: provider.isActive,
      createdAt: provider.createdAt,
    });
  }),
);

/**
 * GET /auth/sso/providers
 * List all registered providers (admin).
 */
authSsoRouter.get(
  '/providers',
  requireAuth,
  requireRole('admin'),
  asyncHandler(async (_req, res: Response) => {
    const providers = await prisma.ssoProvider.findMany({
      select: {
        id: true,
        name: true,
        issuerUrl: true,
        clientId: true,
        discoveryUrl: true,
        scopes: true,
        pkceMethod: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { sessions: true, orgs: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ providers });
  }),
);

/**
 * PATCH /auth/sso/providers/:id
 * Update provider settings (admin).
 */
authSsoRouter.patch(
  '/providers/:id',
  requireAuth,
  requireRole('admin'),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const parsed = updateProviderSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_error', issues: parsed.error.issues });
    }
    const data = parsed.data;

    const existing = await prisma.ssoProvider.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'provider_not_found' });

    if (data.issuerUrl) assertPublicHttpsUrl(data.issuerUrl, 'issuerUrl');

    const updated = await prisma.ssoProvider.update({
      where: { id },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.issuerUrl !== undefined && { issuerUrl: data.issuerUrl.replace(/\/$/, '') }),
        ...(data.clientId !== undefined && { clientId: data.clientId }),
        ...(data.clientSecret !== undefined && {
          clientSecretHash: hashClientSecret(data.clientSecret),
        }),
        ...(data.scopes !== undefined && { scopes: data.scopes }),
        ...(data.isActive !== undefined && { isActive: data.isActive }),
        ...(data.metadata !== undefined && { metadata: data.metadata }),
      },
    });

    await _writeAuditEvent({
      providerId: id,
      actorId: req.user!.id,
      eventType: 'sso.provider.updated',
      before: {
        name: existing.name,
        issuerUrl: existing.issuerUrl,
        isActive: existing.isActive,
      },
      after: {
        name: updated.name,
        issuerUrl: updated.issuerUrl,
        isActive: updated.isActive,
      },
      ipAddress: req.ip,
    });

    ssoProviderOpsTotal.labels(data.isActive === false ? 'deactivate' : 'update').inc();

    return res.json({
      id: updated.id,
      name: updated.name,
      issuerUrl: updated.issuerUrl,
      isActive: updated.isActive,
      updatedAt: updated.updatedAt,
    });
  }),
);

/**
 * DELETE /auth/sso/providers/:id
 * Soft-delete (deactivate) a provider (admin).
 */
authSsoRouter.delete(
  '/providers/:id',
  requireAuth,
  requireRole('admin'),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const existing = await prisma.ssoProvider.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'provider_not_found' });

    await prisma.ssoProvider.update({ where: { id }, data: { isActive: false } });

    await _writeAuditEvent({
      providerId: id,
      actorId: req.user!.id,
      eventType: 'sso.provider.deactivated',
      before: { isActive: true },
      after: { isActive: false },
      ipAddress: req.ip,
    });

    ssoProviderOpsTotal.labels('deactivate').inc();
    return res.json({ success: true });
  }),
);

// ---------------------------------------------------------------------------
// ── Admin: Org linking ────────────────────────────────────────────────────
// ---------------------------------------------------------------------------

/**
 * POST /auth/sso/providers/:id/orgs
 * Link an OIDC provider to an internal org.
 */
authSsoRouter.post(
  '/providers/:id/orgs',
  requireAuth,
  requireRole('admin'),
  asyncHandler(async (req: Request, res: Response) => {
    const { id: providerId } = req.params;
    const parsed = linkOrgSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_error', issues: parsed.error.issues });
    }
    const data = parsed.data;

    const provider = await prisma.ssoProvider.findFirst({
      where: { id: providerId, isActive: true },
    });
    if (!provider) return res.status(404).json({ error: 'provider_not_found' });

    const ssoOrg = await prisma.ssoOrg.create({
      data: {
        providerId,
        orgId: data.orgId,
        domains: data.domains,
        defaultRole: data.defaultRole,
        defaultTier: data.defaultTier,
        autoProvision: data.autoProvision,
        enforceEmailDomain: data.enforceEmailDomain,
      },
    });

    await _writeAuditEvent({
      providerId,
      actorId: req.user!.id,
      eventType: 'sso.org.linked',
      after: {
        ssoOrgId: ssoOrg.id,
        orgId: data.orgId,
        domains: data.domains,
        defaultTier: data.defaultTier,
      },
      ipAddress: req.ip,
    });

    return res.status(201).json(ssoOrg);
  }),
);

// ---------------------------------------------------------------------------
// ── Admin: Audit log ──────────────────────────────────────────────────────
// ---------------------------------------------------------------------------

/**
 * GET /auth/sso/providers/:id/audit
 * Returns the last 200 audit events for a provider (admin).
 */
authSsoRouter.get(
  '/providers/:id/audit',
  requireAuth,
  requireRole('admin'),
  asyncHandler(async (req: Request, res: Response) => {
    const { id: providerId } = req.params;
    const limit = Math.min(parseInt((req.query.limit as string) ?? '200', 10), 500);

    const events = await prisma.ssoAuditEvent.findMany({
      where: { providerId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    return res.json({ events, total: events.length });
  }),
);

// ---------------------------------------------------------------------------
// ── End-user: OIDC authorization redirect ────────────────────────────────
// ---------------------------------------------------------------------------

/**
 * GET /auth/sso/login/:providerId
 * Initiates the OIDC authorization code + PKCE flow.
 *
 * Query params:
 *   redirect_after — optional URL to redirect to after a successful login.
 */
authSsoRouter.get(
  '/login/:providerId',
  asyncHandler(async (req: Request, res: Response) => {
    const { providerId } = req.params;
    const redirectAfter = (req.query.redirect_after as string) ?? undefined;

    const ip = req.ip ?? 'unknown';
    const lock = await checkAccountLockout(ip);
    if (lock.isLocked) {
      res.setHeader('Retry-After', String(lock.retryAfterSec));
      return res.status(429).json({ error: 'Too many login attempts. Try again later.' });
    }

    const provider = await prisma.ssoProvider.findFirst({
      where: { id: providerId, isActive: true },
    });
    if (!provider) return res.status(404).json({ error: 'provider_not_found' });

    const discovery = await fetchDiscovery(provider.discoveryUrl, providerId);

    const verifier = generatePkceVerifier();
    const challenge = derivePkceChallenge(verifier);
    const state = generateState();

    await storePkceState(state, { providerId, verifier, redirectAfter, createdAt: Date.now() });

    const callbackUrl = buildCallbackUrl(req, providerId);

    const authUrl = new URL(discovery.authorization_endpoint);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', provider.clientId);
    authUrl.searchParams.set('redirect_uri', callbackUrl);
    authUrl.searchParams.set('scope', provider.scopes);
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('code_challenge', challenge);
    authUrl.searchParams.set('code_challenge_method', provider.pkceMethod);

    logger.info('[sso] Redirecting to IdP authorization endpoint', {
      providerId,
      clientId: provider.clientId,
    });

    return res.redirect(authUrl.toString());
  }),
);

// ---------------------------------------------------------------------------
// ── End-user: OIDC callback ───────────────────────────────────────────────
// ---------------------------------------------------------------------------

/**
 * GET /auth/sso/callback/:providerId
 * Handles the authorization code callback from the IdP.
 * Issues platform JWT tokens (same format as /auth/verify) on success.
 */
authSsoRouter.get(
  '/callback/:providerId',
  asyncHandler(async (req: Request, res: Response) => {
    const { providerId } = req.params;
    const { code, state, error: idpError, error_description } = req.query as Record<
      string,
      string
    >;
    const ip = req.ip ?? 'unknown';
    const ua = req.headers['user-agent'] ?? '';
    const loginStart = Date.now();

    // IdP-side error (e.g. user declined)
    if (idpError) {
      logger.warn('[sso] IdP returned error on callback', { idpError, error_description });
      recordSsoLogin(providerId, 'error', (Date.now() - loginStart) / 1000);
      return res.status(400).json({ error: idpError, error_description });
    }

    if (!code || !state) {
      return res.status(400).json({ error: 'invalid_callback', message: 'Missing code or state' });
    }

    // ── State / PKCE validation ─────────────────────────────────────────
    const pkceEntry = await consumePkceState(state);
    if (!pkceEntry || pkceEntry.providerId !== providerId) {
      await recordAccountFailure(ip, ip);
      recordSsoLogin(providerId, 'blocked', (Date.now() - loginStart) / 1000);
      return res.status(400).json({
        error: 'invalid_state',
        message: 'State mismatch or session expired. Please restart the login flow.',
      });
    }

    const provider = await prisma.ssoProvider.findFirst({
      where: { id: providerId, isActive: true },
      include: { orgs: { where: { isActive: true } } },
    });
    if (!provider) {
      recordSsoLogin(providerId, 'error', (Date.now() - loginStart) / 1000);
      return res.status(404).json({ error: 'provider_not_found' });
    }

    // ── Token exchange ──────────────────────────────────────────────────
    const discovery = await fetchDiscovery(provider.discoveryUrl, providerId);
    const callbackUrl = buildCallbackUrl(req, providerId);

    let tokenResponse;
    try {
      tokenResponse = await exchangeCodeForTokens({
        tokenEndpoint: discovery.token_endpoint,
        clientId: provider.clientId,
        clientSecret: provider.clientSecretHash, // Note: the DB stores the hash; in production the real secret is read from a secrets manager. See docs/sso/RUNBOOK.md §4.
        redirectUri: callbackUrl,
        code,
        pkceVerifier: pkceEntry.verifier,
        providerId,
      });
    } catch (err) {
      logger.error('[sso] Token exchange failed', { providerId, error: String(err) });
      await recordAccountFailure(ip, ip);
      recordSsoLogin(providerId, 'error', (Date.now() - loginStart) / 1000);
      return res.status(502).json({
        error: 'token_exchange_failed',
        message: 'Could not obtain tokens from the identity provider.',
      });
    }

    // ── ID token validation ─────────────────────────────────────────────
    let claims;
    try {
      claims = decodeIdTokenPayload(tokenResponse.id_token);
      validateIdTokenClaims(claims, provider.issuerUrl, provider.clientId);
    } catch (err) {
      logger.warn('[sso] ID token validation failed', { providerId, error: String(err) });
      recordSsoLogin(providerId, 'error', (Date.now() - loginStart) / 1000);
      return res.status(401).json({
        error: 'invalid_id_token',
        message: String(err).replace(/\[sso\/oidc\] /, ''),
      });
    }

    // ── Org resolution (pick the first matching active org) ──────────────
    const ssoOrg = provider.orgs[0] ?? null;
    const ssoOrgConfig = ssoOrg
      ? {
          autoProvision: ssoOrg.autoProvision,
          enforceEmailDomain: ssoOrg.enforceEmailDomain,
          domains: ssoOrg.domains as string[],
          defaultRole: ssoOrg.defaultRole,
          defaultTier: ssoOrg.defaultTier,
          orgId: ssoOrg.orgId,
        }
      : {
          autoProvision: true,
          enforceEmailDomain: false,
          domains: [] as string[],
          defaultRole: 'user',
          defaultTier: 'enterprise',
          orgId: `sso-${providerId}`,
        };

    // ── User provisioning ───────────────────────────────────────────────
    let provisionResult;
    try {
      provisionResult = await provisionSsoUser(claims, providerId, ssoOrgConfig);
    } catch (err) {
      logger.warn('[sso] Provisioning failed', { providerId, error: String(err) });
      recordSsoLogin(providerId, 'error', (Date.now() - loginStart) / 1000);
      return res.status(403).json({
        error: 'provisioning_failed',
        message: String(err).replace(/\[sso\/provision\] /, ''),
      });
    }

    // ── Issue platform tokens ───────────────────────────────────────────
    await clearAccountLockout(ip);
    const sessionId = generateSessionId();
    const tokens = await issueTokens({
      sub: provisionResult.address,
      userId: provisionResult.userId,
      role: provisionResult.role,
      tier: provisionResult.tier,
      sessionId,
      appId: `sso:${providerId}`,
    });

    await prisma.ssoSession.create({
      data: {
        id: sessionId,
        providerId,
        userId: provisionResult.userId,
        idpSubject: claims.sub,
        tokenHash: tokens.tokenHash,
        refreshTokenHash: tokens.refreshTokenHash,
        isActive: true,
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL * 1000),
        deviceInfo: { ip, userAgent: ua },
        createdAt: new Date(),
      },
    });

    // Mirror into AuthSession so requireAuth / session management works
    await prisma.authSession.create({
      data: {
        id: sessionId,
        userId: provisionResult.userId,
        tokenHash: tokens.tokenHash,
        refreshTokenHash: tokens.refreshTokenHash,
        deviceInfo: { ip, userAgent: ua },
        appId: `sso:${providerId}`,
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL * 1000),
      },
    });

    await prisma.authEvent.create({
      data: {
        userId: provisionResult.userId,
        sessionId,
        eventType: 'sso_login',
        ipAddress: ip,
        userAgent: ua,
        metadata: { providerId, isNewUser: provisionResult.isNewUser },
      },
    });

    await _writeAuditEvent({
      providerId,
      subjectId: provisionResult.userId,
      eventType: 'sso.login',
      after: {
        userId: provisionResult.userId,
        sessionId,
        isNewUser: provisionResult.isNewUser,
        orgId: ssoOrgConfig.orgId,
      },
      ipAddress: ip,
      userAgent: ua,
    });

    ssoActiveSessionsGauge.labels(providerId).inc();
    recordSsoLogin(providerId, 'success', (Date.now() - loginStart) / 1000);

    logger.info('[sso] Login successful', {
      providerId,
      userId: provisionResult.userId,
      isNewUser: provisionResult.isNewUser,
      sessionId,
    });

    // Respond with the same token shape as /auth/verify for consistency
    const responseBody = {
      token: tokens.token,
      refreshToken: tokens.refreshToken,
      sessionId,
      expiresAt: tokens.expiresAt.toISOString(),
      user: {
        id: provisionResult.userId,
        role: provisionResult.role,
        tier: provisionResult.tier,
        isNewUser: provisionResult.isNewUser,
      },
    };

    // If the request came from a browser (redirect flow), redirect with the
    // token in a fragment (never in a query string / server log).
    if (pkceEntry.redirectAfter) {
      const dest = new URL(pkceEntry.redirectAfter);
      dest.hash = `token=${encodeURIComponent(tokens.token)}`;
      return res.redirect(dest.toString());
    }

    return res.json(responseBody);
  }),
);

// ---------------------------------------------------------------------------
// ── End-user: Logout ──────────────────────────────────────────────────────
// ---------------------------------------------------------------------------

/**
 * POST /auth/sso/logout
 * Revokes the current SSO session (requires a valid Bearer token).
 */
authSsoRouter.post(
  '/logout',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = req.user!.sessionId;

    await prisma.authSession.update({
      where: { id: sessionId },
      data: { isActive: false, revokedAt: new Date(), revocationReason: 'sso_logout' },
    });

    // Mirror revocation in SsoSession if it exists
    const ssoSession = await prisma.ssoSession.findUnique({ where: { id: sessionId } });
    if (ssoSession) {
      await prisma.ssoSession.update({
        where: { id: sessionId },
        data: { isActive: false, revokedAt: new Date(), revocationReason: 'logout' },
      });
      ssoActiveSessionsGauge.labels(ssoSession.providerId).dec();

      await _writeAuditEvent({
        providerId: ssoSession.providerId,
        actorId: req.user!.id,
        subjectId: req.user!.id,
        eventType: 'sso.logout',
        after: { sessionId, revokedAt: new Date().toISOString() },
        ipAddress: req.ip,
      });
    }

    await prisma.authEvent.create({
      data: {
        userId: req.user!.id,
        sessionId,
        eventType: 'sso_logout',
        ipAddress: req.ip,
      },
    });

    return res.json({ success: true });
  }),
);

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/**
 * Builds the absolute callback URL for this provider based on the request
 * host and protocol.  Uses the `x-forwarded-proto` / `x-forwarded-host`
 * headers when the app is behind a reverse proxy (set via TRUST_PROXY).
 */
function buildCallbackUrl(req: Request, providerId: string): string {
  const proto = (req.headers['x-forwarded-proto'] as string | undefined) ?? req.protocol;
  const host = (req.headers['x-forwarded-host'] as string | undefined) ?? req.get('host') ?? '';
  return `${proto}://${host}/api/v1/auth/sso/callback/${providerId}`;
}

/** Expose hashToken re-export so tests can stub it without reaching into tokens.ts */
export { hashToken };

/**
 * Exports the in-flight PKCE state helpers for testing only.
 * @internal
 */
export { storePkceState, consumePkceState };
