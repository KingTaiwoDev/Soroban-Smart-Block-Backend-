/**
 * Audit logging for security-sensitive administrative actions (#1232).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';

const mocks = vi.hoisted(() => ({
  auditCreate: vi.fn(),
  findUnique: vi.fn(),
  findFirst: vi.fn(),
  keyCreate: vi.fn(),
  keyUpdate: vi.fn(),
  setIndexerPaused: vi.fn(),
}));

vi.mock('../src/db', () => ({
  prismaWrite: {
    auditLog: { create: mocks.auditCreate },
    devApiKey: { create: mocks.keyCreate, update: mocks.keyUpdate },
  },
  prismaRead: {
    developer: { findUnique: mocks.findUnique },
    devApiKey: { findFirst: mocks.findFirst },
  },
}));

vi.mock('../src/middleware/apiKeyAuth', () => ({ invalidateKeyCache: vi.fn() }));

vi.mock('../src/middleware/adminAuth', () => ({
  adminAuth: (req: Request, _res: Response, next: NextFunction) => {
    req.actor = 'admin';
    next();
  },
}));

vi.mock('../src/indexer/worker-control', () => ({
  getIndexerPauseState: vi.fn(),
  setIndexerPaused: mocks.setIndexerPaused,
}));

import { recordAdminAudit, auditActor } from '../src/lib/admin-audit';
import { keysRouter } from '../src/api/developer/keys';
import { adminRouter } from '../src/api/admin';
import { organizationsRouter, resetOrganizations } from '../src/api/organizations';

/** Let fire-and-forget audit writes settle. */
const flush = () => new Promise((r) => setImmediate(r));

const auditedActions = () => mocks.auditCreate.mock.calls.map((c) => c[0].data.action);

function app(mount: string, router: express.Router, developerId?: string) {
  const a = express();
  a.use(express.json());
  if (developerId) {
    a.use((req, _res, next) => {
      req.apiKey = { id: `key-${developerId}`, developerId } as Request['apiKey'];
      next();
    });
  }
  a.use(mount, router);
  return a;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auditCreate.mockResolvedValue({});
});

describe('recordAdminAudit', () => {
  it('persists actor, action, target and state to the audit log', async () => {
    await recordAdminAudit({
      actor: 'admin',
      action: 'api_key.revoked',
      target: 'key-1',
      newState: { status: 'revoked' },
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actor: 'admin',
        action: 'api_key.revoked',
        target: 'key-1',
        newState: { status: 'revoked' },
      }),
    });
  });

  it('never throws when the audit store is unavailable', async () => {
    mocks.auditCreate.mockRejectedValue(new Error('db down'));
    await expect(
      recordAdminAudit({ actor: 'a', action: 'x', target: 't' }),
    ).resolves.toBeUndefined();
  });

  it('resolves the actor from admin token, session user, then API key', () => {
    expect(auditActor({ actor: 'admin' } as Request)).toBe('admin');
    expect(auditActor({ user: { id: 'u1' } } as Request)).toBe('u1');
    expect(auditActor({ apiKey: { developerId: 'd1' } } as Request)).toBe('d1');
    expect(auditActor({} as Request, 'fallback')).toBe('fallback');
  });
});

describe('admin indexer control', () => {
  it('audits pause with the resulting network state', async () => {
    mocks.setIndexerPaused.mockResolvedValue({ network: 'testnet', paused: true });
    const res = await request(app('/admin', adminRouter)).post('/admin/indexer/pause');
    expect(res.status).toBe(200);
    await flush();
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actor: 'admin',
        action: 'admin.indexer.pause',
        newState: { network: 'testnet', paused: true },
      }),
    });
  });

  it('does not audit when the state change fails', async () => {
    mocks.setIndexerPaused.mockRejectedValue(new Error('db down'));
    const res = await request(app('/admin', adminRouter)).post('/admin/indexer/resume');
    expect(res.status).toBe(500);
    await flush();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });
});

describe('developer API key lifecycle', () => {
  const keys = () => app('/keys', keysRouter);

  it('audits key creation without persisting the raw key', async () => {
    mocks.findUnique.mockResolvedValue({ id: 'dev-1' });
    mocks.keyCreate.mockResolvedValue({ id: 'key-1', keyPrefix: 'sk_abcde' });
    const res = await request(keys()).post('/keys').send({ developerId: 'dev-1', name: 'ci' });
    expect(res.status).toBe(201);
    await flush();
    const row = mocks.auditCreate.mock.calls[0][0].data;
    expect(row).toMatchObject({ actor: 'dev-1', action: 'api_key.created', target: 'key-1' });
    expect(JSON.stringify(row)).not.toContain(res.body.key);
  });

  it('audits revocation', async () => {
    mocks.findFirst.mockResolvedValue({ id: 'key-1', keyHash: 'h' });
    mocks.keyUpdate.mockResolvedValue({});
    const res = await request(keys()).delete('/keys/key-1?developerId=dev-1');
    expect(res.status).toBe(204);
    await flush();
    expect(auditedActions()).toEqual(['api_key.revoked']);
  });

  it('does not audit a revocation of an unknown key', async () => {
    mocks.findFirst.mockResolvedValue(null);
    const res = await request(keys()).delete('/keys/nope?developerId=dev-1');
    expect(res.status).toBe(404);
    await flush();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });
});

describe('organization membership', () => {
  beforeEach(() => resetOrganizations());

  it('persists membership and role changes to the durable audit log', async () => {
    const owner = app('/orgs', organizationsRouter, 'owner-1');
    const created = await request(owner).post('/orgs').send({ name: 'Acme' });
    const orgId = created.body.id;
    await request(owner).post(`/orgs/${orgId}/members`).send({ developerId: 'dev-2' });
    await request(owner).patch(`/orgs/${orgId}/members/dev-2`).send({ role: 'admin' });
    await request(owner).delete(`/orgs/${orgId}/members/dev-2`);
    await flush();
    expect(auditedActions()).toEqual([
      'org.created',
      'org.member.added',
      'org.member.role_changed',
      'org.member.removed',
    ]);
    expect(mocks.auditCreate.mock.calls[2][0].data).toMatchObject({
      actor: 'owner-1',
      target: orgId,
      newState: { developerId: 'dev-2', from: 'member', to: 'admin' },
    });
  });

  it('does not audit a forbidden role change', async () => {
    const owner = app('/orgs', organizationsRouter, 'owner-1');
    const orgId = (await request(owner).post('/orgs').send({ name: 'Acme' })).body.id;
    await request(owner).post(`/orgs/${orgId}/members`).send({ developerId: 'dev-2' });
    await flush();
    mocks.auditCreate.mockClear();

    const member = app('/orgs', organizationsRouter, 'dev-2');
    const res = await request(member).patch(`/orgs/${orgId}/members/dev-2`).send({ role: 'owner' });
    expect(res.status).toBe(403);
    await flush();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });
});
