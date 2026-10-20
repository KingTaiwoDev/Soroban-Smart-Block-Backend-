/**
 * Audit record integrity checks (#1244).
 *
 * `RbacAuditLogger` hash-chains every record it writes to `_audit_logs`: the
 * checksum covers the *persisted* columns (id, actor, action, target,
 * previousState, newState, reason, createdAt) plus the previous record's
 * checksum, and is stored inside `newState` next to `previousChecksum` and
 * `integrityVersion`. Because the hash is computed over what is stored, it can
 * be recomputed from the database alone — no schema migration is needed.
 *
 * When `AUDIT_INTEGRITY_SECRET` is set the checksum is an HMAC-SHA256, so an
 * actor with database write access cannot forge a valid chain without the key.
 */

import crypto from 'crypto';
import { prismaRead } from '../db';

export const AUDIT_INTEGRITY_VERSION = 2;

const INTEGRITY_KEYS = new Set(['checksum', 'previousChecksum', 'integrityVersion']);

/** Audit actions whose records describe security-sensitive changes. */
export const SECURITY_SENSITIVE_ACTIONS: ReadonlySet<string> = new Set([
  'auth.session.revoked',
  'rbac.role.assigned',
  'rbac.role.revoked',
  'rbac.role.created',
  'rbac.role.updated',
  'rbac.role.deleted',
  'rbac.permission.created',
  'rbac.permission.updated',
  'rbac.permission.deleted',
  'rbac.direct_permission.granted',
  'rbac.direct_permission.revoked',
  'tenant.created',
  'tenant.updated',
  'tenant.deleted',
  'api_key.created',
  'api_key.revoked',
  'api_key.scope.updated',
  'admin.action',
  'system.config.changed',
  'compliance.freeze.applied',
  'compliance.freeze.removed',
  'data.deletion',
]);

export function isSecuritySensitiveAction(action: string): boolean {
  return SECURITY_SENSITIVE_ACTIONS.has(action) || action.startsWith('security.');
}

/** Shape of an `_audit_logs` row as written and read by Prisma. */
export interface AuditLogRecordLike {
  id: string;
  actor: string;
  action: string;
  target: string;
  previousState?: unknown;
  newState?: unknown;
  reason?: string | null;
  createdAt: Date | string;
}

export type AuditIntegrityFailureReason = 'checksum_mismatch' | 'chain_broken' | 'missing_checksum';

export interface AuditIntegrityFailure {
  id: string;
  action: string;
  reason: AuditIntegrityFailureReason;
  securitySensitive: boolean;
}

export interface AuditIntegrityReport {
  valid: boolean;
  /** Records whose checksum was recomputed and compared. */
  checked: number;
  /** Of `checked`, records describing security-sensitive changes. */
  securitySensitiveChecked: number;
  /** Records chained by the pre-#1244 scheme, which cannot be recomputed from stored columns. */
  legacy: number;
  /** Non-sensitive records written without a checksum (e.g. request-level audit writers). */
  unchained: number;
  failures: AuditIntegrityFailure[];
}

/** Deterministic JSON: sorted keys, undefined dropped, Dates as ISO strings (matches JSON storage). */
export function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalize(v)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const parts = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`);
    return `{${parts.join(',')}}`;
  }
  return JSON.stringify(value);
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stripIntegrityKeys(newState: unknown): unknown {
  const obj = asObject(newState);
  if (!obj) return newState ?? null;
  return Object.fromEntries(Object.entries(obj).filter(([k]) => !INTEGRITY_KEYS.has(k)));
}

export function computeAuditRecordChecksum(
  record: AuditLogRecordLike,
  previousChecksum: string | undefined,
  secret: string | undefined = process.env.AUDIT_INTEGRITY_SECRET,
): string {
  const payload = canonicalize({
    id: record.id,
    actor: record.actor,
    action: record.action,
    target: record.target,
    previousState: record.previousState ?? null,
    newState: stripIntegrityKeys(record.newState),
    reason: record.reason ?? null,
    createdAt: new Date(record.createdAt),
    previousChecksum: previousChecksum ?? null,
  });
  return secret
    ? crypto.createHmac('sha256', secret).update(payload).digest('hex')
    : crypto.createHash('sha256').update(payload).digest('hex');
}

function integrityFields(record: AuditLogRecordLike) {
  const ns = asObject(record.newState);
  return {
    checksum: typeof ns?.checksum === 'string' ? ns.checksum : undefined,
    previousChecksum: typeof ns?.previousChecksum === 'string' ? ns.previousChecksum : undefined,
    version: typeof ns?.integrityVersion === 'number' ? ns.integrityVersion : undefined,
  };
}

/** Predecessor checksums referenced by `records` that are not themselves in `records`. */
export function findMissingPredecessors(records: AuditLogRecordLike[]): string[] {
  const present = new Set<string>();
  const referenced = new Set<string>();
  for (const r of records) {
    const f = integrityFields(r);
    if (f.checksum) present.add(f.checksum);
    if (f.version === AUDIT_INTEGRITY_VERSION && f.previousChecksum) referenced.add(f.previousChecksum);
  }
  return [...referenced].filter((c) => !present.has(c));
}

/**
 * Verify a set of audit records. Each chained record's checksum is recomputed
 * from its stored columns, and its `previousChecksum` must reference a record
 * in the set or in `knownChecksums` (predecessors outside the queried window).
 * Chains are link-based, so concurrent writers (one chain per process) are fine.
 */
export function verifyAuditChain(
  records: AuditLogRecordLike[],
  opts: { secret?: string; knownChecksums?: Iterable<string> } = {},
): AuditIntegrityReport {
  const secret = 'secret' in opts ? opts.secret : process.env.AUDIT_INTEGRITY_SECRET;
  const known = new Set(opts.knownChecksums ?? []);
  for (const r of records) {
    const { checksum } = integrityFields(r);
    if (checksum) known.add(checksum);
  }

  const report: AuditIntegrityReport = {
    valid: true,
    checked: 0,
    securitySensitiveChecked: 0,
    legacy: 0,
    unchained: 0,
    failures: [],
  };
  const fail = (r: AuditLogRecordLike, reason: AuditIntegrityFailureReason, sensitive: boolean) =>
    report.failures.push({ id: r.id, action: r.action, reason, securitySensitive: sensitive });

  for (const r of records) {
    const sensitive = isSecuritySensitiveAction(r.action);
    const f = integrityFields(r);

    if (!f.checksum) {
      if (sensitive) fail(r, 'missing_checksum', true);
      else report.unchained++;
      continue;
    }
    if (f.version !== AUDIT_INTEGRITY_VERSION) {
      report.legacy++;
      continue;
    }

    report.checked++;
    if (sensitive) report.securitySensitiveChecked++;

    if (computeAuditRecordChecksum(r, f.previousChecksum, secret) !== f.checksum) {
      fail(r, 'checksum_mismatch', sensitive);
    } else if (f.previousChecksum && !known.has(f.previousChecksum)) {
      fail(r, 'chain_broken', sensitive);
    }
  }

  report.valid = report.failures.length === 0;
  return report;
}

const MAX_PREDECESSOR_LOOKUPS = 100;

/** Load a window of `_audit_logs` and verify it, resolving predecessors outside the window. */
export async function verifyStoredAuditIntegrity(
  opts: { from?: Date; to?: Date; limit?: number } = {},
): Promise<AuditIntegrityReport> {
  const where: Record<string, unknown> = {};
  if (opts.from || opts.to) {
    where.createdAt = {
      ...(opts.from ? { gte: opts.from } : {}),
      ...(opts.to ? { lte: opts.to } : {}),
    };
  }
  const take = Math.min(Math.max(opts.limit ?? 1000, 1), 10_000);
  const records: AuditLogRecordLike[] = await prismaRead.auditLog.findMany({
    where,
    orderBy: { createdAt: 'asc' },
    take,
  });

  const knownChecksums: string[] = [];
  for (const checksum of findMissingPredecessors(records).slice(0, MAX_PREDECESSOR_LOOKUPS)) {
    const found = await prismaRead.auditLog.findFirst({
      where: { newState: { path: ['checksum'], equals: checksum } },
      select: { id: true },
    });
    if (found) knownChecksums.push(checksum);
  }

  return verifyAuditChain(records, { knownChecksums });
}
