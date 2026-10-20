/**
 * Organization and tenant data isolation (#1242).
 *
 * Exercises the real organizations router over HTTP and the RBAC tenant
 * isolation layer (TenantIsolationService + TenantAwarePrismaClient) with two
 * independent orgs/tenants, asserting that neither can read, modify or
 * enumerate the other's data. No database is required: the Prisma clients are
 * replaced with in-memory fakes that record which tenant filter was applied.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';

const { tenants } = vi.hoisted(() => ({
  tenants: {
    'tenant-a': { id: 'tenant-a', isolationLevel: 'strict' },
    'tenant-b': { id: 'tenant-b', isolationLevel: 'strict' },
  } as Record<string, { id: string; isolationLevel: string }>,
}));

vi.mock('../../src/db', () => {
  const client: Record<string, unknown> = {
    tenant: { findUnique: vi.fn(async ({ where }: any) => tenants[where.id] ?? null) },
    auditLog: { create: vi.fn() },
  };
  client.$extends = () => client;
  return { prismaRead: client, prismaWrite: client };
});

import { organizationsRouter, resetOrganizations } from '../../src/api/organizations';
import {
  GLOBAL_SHARED_MODELS,
  TenantIsolationService,
  createTenantContext,
  createTenantContextMiddleware,
} from '../../src/rbac/tenant-isolation';
import { TenantAwarePrismaClient } from '../../src/db/tenant-aware-db';
import { TenantIsolationError, type AuthPrincipal } from '../../src/rbac/types';

// ── Organizations over HTTP ──────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use((req: Request, _res: Response, next: NextFunction) => {
  const dev = req.header('x-test-developer');
  if (dev) {
    (req as any).apiKey = { id: req.header('x-test-key') ?? `key-${dev}`, developerId: dev };
  }
  next();
});
app.use('/api/v1/orgs', organizationsRouter);

const as = (dev: string, key = `key-${dev}`) => ({ 'x-test-developer': dev, 'x-test-key': key });

async function createOrg(dev: string, name: string): Promise<string> {
  const res = await request(app).post('/api/v1/orgs').set(as(dev)).send({ name });
  expect(res.status).toBe(201);
  return res.body.id;
}

describe('organization data isolation', () => {
  let orgA: string;
  let orgB: string;

  beforeEach(async () => {
    resetOrganizations();
    orgA = await createOrg('alice', 'Org A');
    orgB = await createOrg('bob', 'Org B');
  });

  it('lists only organizations the caller belongs to', async () => {
    const res = await request(app).get('/api/v1/orgs').set(as('alice'));
    expect(res.status).toBe(200);
    expect(res.body.organizations.map((o: { id: string }) => o.id)).toEqual([orgA]);
  });

  it.each([
    ['read details', 'get', ''],
    ['read audit log', 'get', '/audit'],
    ['update the org', 'patch', ''],
    ['add a member', 'post', '/members'],
    ['scope a key', 'post', '/keys'],
  ] as const)('returns 404 (not 403) when a non-member tries to %s', async (_n, method, suffix) => {
    const body = method === 'patch' ? { name: 'Hijacked' } : { developerId: 'mallory' };
    const res = await request(app)
      [method](`/api/v1/orgs/${orgB}${suffix}`)
      .set(as('alice'))
      .send(body);
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('Org B');
  });

  it('does not let a non-member change or remove members of another org', async () => {
    const patch = await request(app)
      .patch(`/api/v1/orgs/${orgB}/members/bob`)
      .set(as('alice'))
      .send({ role: 'member' });
    expect(patch.status).toBe(404);

    const del = await request(app).delete(`/api/v1/orgs/${orgB}/members/bob`).set(as('alice'));
    expect(del.status).toBe(404);

    const org = await request(app).get(`/api/v1/orgs/${orgB}`).set(as('bob'));
    expect(org.body.members).toEqual({ bob: 'owner' });
  });

  it('keeps unrelated orgs unchanged after a rejected cross-org update', async () => {
    await request(app).patch(`/api/v1/orgs/${orgB}`).set(as('alice')).send({ name: 'Hijacked' });
    const res = await request(app).get(`/api/v1/orgs/${orgB}`).set(as('bob'));
    expect(res.body.name).toBe('Org B');
  });

  it('does not let a member below admin read the audit log of their own org', async () => {
    await request(app)
      .post(`/api/v1/orgs/${orgA}/members`)
      .set(as('alice'))
      .send({ developerId: 'carol', role: 'member' });
    const res = await request(app).get(`/api/v1/orgs/${orgA}/audit`).set(as('carol'));
    expect(res.status).toBe(403);
  });

  it('only records audit entries in the org that was acted on', async () => {
    await request(app).patch(`/api/v1/orgs/${orgA}`).set(as('alice')).send({ name: 'Org A2' });
    const auditB = await request(app).get(`/api/v1/orgs/${orgB}/audit`).set(as('bob'));
    expect(auditB.body.entries.map((e: { action: string }) => e.action)).toEqual(['org.created']);
    expect(JSON.stringify(auditB.body)).not.toContain('alice');
  });

  it('revokes access once a member is removed', async () => {
    await request(app)
      .post(`/api/v1/orgs/${orgA}/members`)
      .set(as('alice'))
      .send({ developerId: 'carol' });
    expect((await request(app).get(`/api/v1/orgs/${orgA}`).set(as('carol'))).status).toBe(200);

    await request(app).delete(`/api/v1/orgs/${orgA}/members/carol`).set(as('alice'));
    expect((await request(app).get(`/api/v1/orgs/${orgA}`).set(as('carol'))).status).toBe(404);
  });

  describe('API key scoping', () => {
    it('refuses to move a key into an org where the caller is not admin', async () => {
      await request(app).post(`/api/v1/orgs/${orgA}/keys`).set(as('alice', 'key-a1')).send();
      const res = await request(app)
        .post(`/api/v1/orgs/${orgA}/keys/key-a1/transfer`)
        .set(as('alice', 'key-a1'))
        .send({ targetOrgId: orgB });
      expect(res.status).toBe(404);

      const b = await request(app).get(`/api/v1/orgs/${orgB}`).set(as('bob'));
      expect(b.body.keyIds).toEqual([]);
    });

    it("refuses to transfer another org's key through an org the caller administers", async () => {
      await request(app).post(`/api/v1/orgs/${orgB}/keys`).set(as('bob', 'key-b1')).send();
      const res = await request(app)
        .post(`/api/v1/orgs/${orgA}/keys/key-b1/transfer`)
        .set(as('alice', 'key-a1'))
        .send({ targetOrgId: orgA });
      expect(res.status).toBe(404);

      const b = await request(app).get(`/api/v1/orgs/${orgB}`).set(as('bob'));
      expect(b.body.keyIds).toEqual(['key-b1']);
    });

    it('refuses to scope a key that already belongs to another org', async () => {
      await request(app).post(`/api/v1/orgs/${orgB}/keys`).set(as('bob', 'shared-key')).send();
      await request(app)
        .post(`/api/v1/orgs/${orgA}/members`)
        .set(as('alice'))
        .send({ developerId: 'bob', role: 'admin' });
      const res = await request(app)
        .post(`/api/v1/orgs/${orgA}/keys`)
        .set(as('bob', 'shared-key'))
        .send();
      expect(res.status).toBe(409);
    });
  });

  it('rejects unauthenticated requests', async () => {
    expect((await request(app).get('/api/v1/orgs')).status).toBe(401);
    expect((await request(app).get(`/api/v1/orgs/${orgA}`)).status).toBe(401);
  });
});

// ── Tenant isolation layer ───────────────────────────────────────────────────

const principalA: AuthPrincipal = { type: 'api_key', apiKeyId: 'key-a', tenantId: 'tenant-a' };
const principalB: AuthPrincipal = { type: 'api_key', apiKeyId: 'key-b', tenantId: 'tenant-b' };
const tenantless: AuthPrincipal = { type: 'api_key', apiKeyId: 'key-x' };
const admin: AuthPrincipal = { type: 'admin', userId: 'root' };

describe('tenant data isolation', () => {
  const service = new TenantIsolationService();

  it('allows a principal to access its own tenant', async () => {
    const res = await service.validateTenantAccess(principalA, 'tenant-a');
    expect(res).toMatchObject({ allowed: true, tenantId: 'tenant-a', isolationLevel: 'strict' });
  });

  it('denies a principal access to another tenant', async () => {
    const res = await service.validateTenantAccess(principalA, 'tenant-b');
    expect(res.allowed).toBe(false);
  });

  it('denies a tenantless non-admin principal selecting a tenant', async () => {
    const res = await service.validateTenantAccess(tenantless, 'tenant-b');
    expect(res.allowed).toBe(false);
  });

  it('allows admins across tenants', async () => {
    expect((await service.validateTenantAccess(admin, 'tenant-b')).allowed).toBe(true);
  });

  it("scopes isolated-model queries to the principal's tenant", () => {
    const ctx = createTenantContext(principalA);
    const where = service.applyTenantFilter('DevApiKey', { revoked: false }, ctx);
    expect(where).toEqual({ revoked: false, tenantId: 'tenant-a' });
  });

  it('cannot widen the tenant filter by supplying a tenantId in the where clause', () => {
    const where = service.applyTenantFilter(
      'WalletUser',
      { tenantId: 'tenant-b' },
      createTenantContext(principalA),
    );
    expect(where.tenantId).toBe('tenant-a');
  });

  it('leaves global shared models unfiltered', () => {
    for (const model of GLOBAL_SHARED_MODELS) {
      expect(service.applyTenantFilter(model, {}, createTenantContext(principalA))).toEqual({});
    }
  });

  it('only honours bypassIsolation for admins', () => {
    const ctx = createTenantContext(principalA, { bypassIsolation: true });
    expect(service.applyTenantFilter('AuditLog', {}, ctx)).toEqual({ tenantId: 'tenant-a' });
    const adminCtx = createTenantContext(admin, { bypassIsolation: true });
    expect(service.applyTenantFilter('AuditLog', {}, adminCtx)).toEqual({});
  });

  it('rejects query results that belong to another tenant', async () => {
    const ctx = createTenantContext(principalA);
    await expect(
      service.validateQueryResult(
        'WalletUser',
        [
          { id: 1, tenantId: 'tenant-a' },
          { id: 2, tenantId: 'tenant-b' },
        ],
        ctx,
      ),
    ).rejects.toBeInstanceOf(TenantIsolationError);
    await expect(
      service.validateQueryResult('WalletUser', [{ id: 1, tenantId: 'tenant-a' }], ctx),
    ).resolves.toBeUndefined();
  });

  it('builds tenant context from the request but ignores bypass for non-admins', () => {
    const mw = createTenantContextMiddleware();
    const req: any = {
      rbacPrincipal: principalA,
      params: {},
      query: { bypassIsolation: 'true' },
      get: (h: string) => (h === 'X-Tenant-ID' ? 'tenant-b' : undefined),
    };
    mw(req, {}, () => undefined);
    expect(req.tenantContext.requestedTenantId).toBe('tenant-b');
    expect(req.tenantContext.bypassIsolation).toBe(false);
  });

  describe('TenantAwarePrismaClient', () => {
    const db = new TenantAwarePrismaClient({} as any, { auditAccess: false });

    it.each([
      ['another tenant', principalA, 'tenant-b'],
      ['a tenant from a tenantless key', tenantless, 'tenant-a'],
    ])('blocks reads of %s before the query runs', async (_name, principal, requested) => {
      const op = vi.fn();
      const ctx = createTenantContext(principal, { requestedTenantId: requested });
      await expect(db.executeWithTenantContext(ctx, op)).rejects.toBeInstanceOf(
        TenantIsolationError,
      );
      expect(op).not.toHaveBeenCalled();
    });

    it('blocks cross-tenant writes before the mutation runs', async () => {
      const op = vi.fn();
      const ctx = createTenantContext(principalB, { requestedTenantId: 'tenant-a' });
      await expect(db.executeWriteWithTenantContext(ctx, op)).rejects.toBeInstanceOf(
        TenantIsolationError,
      );
      expect(op).not.toHaveBeenCalled();
    });

    it('runs same-tenant operations', async () => {
      const ctx = createTenantContext(principalA, { requestedTenantId: 'tenant-a' });
      await expect(db.executeWithTenantContext(ctx, async () => 'ok')).resolves.toBe('ok');
    });
  });
});
