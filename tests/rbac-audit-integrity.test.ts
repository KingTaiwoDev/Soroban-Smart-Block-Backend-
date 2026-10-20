import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  findMany: vi.fn(),
  findFirst: vi.fn(),
}));

vi.mock('../src/db', () => ({
  prismaRead: { auditLog: { findMany: db.findMany, findFirst: db.findFirst } },
  prismaWrite: {},
}));
vi.mock('../src/middleware/adminAuth', () => ({
  adminAuth: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

import {
  AUDIT_INTEGRITY_VERSION,
  type AuditLogRecordLike,
  canonicalize,
  computeAuditRecordChecksum,
  findMissingPredecessors,
  isSecuritySensitiveAction,
  verifyAuditChain,
  verifyStoredAuditIntegrity,
} from '../src/rbac/audit-integrity';
import { auditIntegrityAdminRouter } from '../src/api/admin/audit-integrity';

const SECRET = 'test-audit-secret';

/** Build a chain the same way RbacAuditLogger persists it. */
function buildChain(
  rows: Array<Pick<AuditLogRecordLike, 'action'> & Partial<AuditLogRecordLike>>,
  previous?: string,
  secret = SECRET,
): AuditLogRecordLike[] {
  let prev = previous;
  return rows.map((row, i) => {
    const base: AuditLogRecordLike = {
      id: `rec-${i}`,
      actor: 'admin-1',
      target: `target-${i}`,
      previousState: null,
      reason: null,
      createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, i)),
      ...row,
      newState: { severity: 'info', source: 'rbac.admin', ...(row.newState as object) },
    };
    const checksum = computeAuditRecordChecksum(base, prev, secret);
    const record = {
      ...base,
      newState: {
        ...(base.newState as object),
        checksum,
        previousChecksum: prev,
        integrityVersion: AUDIT_INTEGRITY_VERSION,
      },
    };
    prev = checksum;
    return record;
  });
}

/** Simulate a JSON column round-trip (key order lost, undefined dropped, Dates → strings). */
function roundTrip(records: AuditLogRecordLike[]): AuditLogRecordLike[] {
  return records.map((r) => {
    const json = JSON.parse(JSON.stringify(r));
    const ns = json.newState;
    json.newState = Object.fromEntries(Object.keys(ns).reverse().map((k) => [k, ns[k]]));
    json.createdAt = new Date(json.createdAt);
    return json;
  });
}

describe('audit integrity (#1244)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('classifies security-sensitive actions', () => {
    expect(isSecuritySensitiveAction('rbac.role.assigned')).toBe(true);
    expect(isSecuritySensitiveAction('api_key.revoked')).toBe(true);
    expect(isSecuritySensitiveAction('security.ip_blocked')).toBe(true);
    expect(isSecuritySensitiveAction('rbac.permission.check')).toBe(false);
  });

  it('canonicalizes independent of key order and undefined values', () => {
    expect(canonicalize({ b: 1, a: { d: undefined, c: [1, 'x'] } })).toBe(
      canonicalize({ a: { c: [1, 'x'] }, b: 1 }),
    );
  });

  it('uses HMAC when a secret is configured', () => {
    const [rec] = buildChain([{ action: 'rbac.role.assigned' }]);
    expect(computeAuditRecordChecksum(rec, undefined, SECRET)).not.toBe(
      computeAuditRecordChecksum(rec, undefined, undefined),
    );
  });

  it('verifies an intact chain after a database round-trip', () => {
    const chain = roundTrip(
      buildChain([
        { action: 'rbac.role.assigned', newState: { roleId: 'admin', expiresAt: new Date(0) } },
        { action: 'rbac.permission.granted' },
        { action: 'api_key.revoked', reason: 'compromised' },
      ]),
    );
    const report = verifyAuditChain(chain, { secret: SECRET });
    expect(report).toMatchObject({ valid: true, checked: 3, securitySensitiveChecked: 2 });
    expect(report.failures).toEqual([]);
  });

  it('detects a tampered security-sensitive record', () => {
    const chain = buildChain([{ action: 'rbac.role.assigned', newState: { roleId: 'viewer' } }]);
    (chain[0].newState as Record<string, unknown>).roleId = 'super_admin';
    const report = verifyAuditChain(chain, { secret: SECRET });
    expect(report.valid).toBe(false);
    expect(report.failures).toEqual([
      { id: 'rec-0', action: 'rbac.role.assigned', reason: 'checksum_mismatch', securitySensitive: true },
    ]);
  });

  it('detects a checksum recomputed without the secret', () => {
    const chain = buildChain([{ action: 'system.config.changed' }], undefined, 'attacker-guess');
    expect(verifyAuditChain(chain, { secret: SECRET }).failures[0].reason).toBe('checksum_mismatch');
  });

  it('detects a deleted record as a broken chain', () => {
    const chain = buildChain([
      { action: 'rbac.role.assigned' },
      { action: 'rbac.role.revoked' },
      { action: 'tenant.deleted' },
    ]);
    const report = verifyAuditChain([chain[0], chain[2]], { secret: SECRET });
    expect(report.failures).toEqual([
      { id: 'rec-2', action: 'tenant.deleted', reason: 'chain_broken', securitySensitive: true },
    ]);
  });

  it('accepts predecessors outside the window when known', () => {
    const chain = buildChain([{ action: 'rbac.role.assigned' }], 'outside-window-checksum');
    expect(findMissingPredecessors(chain)).toEqual(['outside-window-checksum']);
    expect(verifyAuditChain(chain, { secret: SECRET }).valid).toBe(false);
    expect(
      verifyAuditChain(chain, { secret: SECRET, knownChecksums: ['outside-window-checksum'] }).valid,
    ).toBe(true);
  });

  it('flags sensitive records without checksums, tolerates legacy and unchained rows', () => {
    const records: AuditLogRecordLike[] = [
      { id: 'a', actor: 'x', action: 'api_key.created', target: 't', newState: {}, createdAt: new Date() },
      { id: 'b', actor: 'x', action: 'permission_check', target: 't', newState: {}, createdAt: new Date() },
      {
        id: 'c',
        actor: 'x',
        action: 'rbac.role.created',
        target: 't',
        newState: { checksum: 'legacy-hash' },
        createdAt: new Date(),
      },
    ];
    const report = verifyAuditChain(records, { secret: SECRET });
    expect(report).toMatchObject({ valid: false, checked: 0, legacy: 1, unchained: 1 });
    expect(report.failures.map((f) => [f.id, f.reason])).toEqual([['a', 'missing_checksum']]);
  });

  it('resolves out-of-window predecessors from the database', async () => {
    const chain = buildChain([{ action: 'rbac.role.assigned' }], 'older');
    db.findMany.mockResolvedValue(chain);
    db.findFirst.mockResolvedValue({ id: 'older-rec' });
    process.env.AUDIT_INTEGRITY_SECRET = SECRET;
    try {
      const report = await verifyStoredAuditIntegrity({ from: new Date(0), limit: 50 });
      expect(report.valid).toBe(true);
      expect(db.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: { createdAt: 'asc' }, take: 50 }),
      );
      expect(db.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { newState: { path: ['checksum'], equals: 'older' } } }),
      );
    } finally {
      delete process.env.AUDIT_INTEGRITY_SECRET;
    }
  });

  describe('GET /admin/audit-integrity', () => {
    const app = express().use('/admin/audit-integrity', auditIntegrityAdminRouter);

    it('returns 200 for a valid window', async () => {
      db.findMany.mockResolvedValue(buildChain([{ action: 'rbac.role.assigned' }], undefined, ''));
      const res = await request(app).get('/admin/audit-integrity');
      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(true);
    });

    it('returns 409 when tampering is detected', async () => {
      const chain = buildChain([{ action: 'rbac.role.assigned' }], undefined, '');
      chain[0].actor = 'someone-else';
      db.findMany.mockResolvedValue(chain);
      const res = await request(app).get('/admin/audit-integrity');
      expect(res.status).toBe(409);
      expect(res.body.failures[0].reason).toBe('checksum_mismatch');
    });

    it('rejects invalid query parameters', async () => {
      expect((await request(app).get('/admin/audit-integrity?from=nope')).status).toBe(400);
      expect((await request(app).get('/admin/audit-integrity?limit=0')).status).toBe(400);
      expect(db.findMany).not.toHaveBeenCalled();
    });
  });
});
