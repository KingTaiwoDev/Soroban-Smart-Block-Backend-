/**
 * Durable audit trail for security-sensitive administrative actions (#1232).
 *
 * Writes one row to `_audit_logs` (the same table used by the freeze router
 * and RBAC audit logger) for actions such as role/membership changes, API key
 * create/update/revoke, feature-flag changes and indexer pause/resume.
 *
 * Writes are fire-and-forget via `background()`: an audit-store outage is
 * logged and counted (`background_operation_errors_total{operation="audit.admin_action"}`)
 * but never fails or delays the administrative request itself.
 */
import type { Request } from 'express';
import type { Prisma } from '@prisma/client';
import { prismaWrite } from '../db';
import { background } from '../utils/background';
import { uuidv7 } from '../utils/uuidv7';

export interface AdminAuditEntry {
  actor: string;
  action: string;
  target: string;
  previousState?: Record<string, unknown>;
  newState?: Record<string, unknown>;
  reason?: string;
}

/** Best-effort identity of the caller across the auth mechanisms in use. */
export function auditActor(req: Request, fallback = 'unknown'): string {
  return req.actor ?? req.user?.id ?? req.apiKey?.developerId ?? fallback;
}

export function recordAdminAudit(entry: AdminAuditEntry): Promise<void> {
  return background(
    'audit.admin_action',
    async () => {
      await prismaWrite.auditLog.create({
        data: {
          id: uuidv7(),
          actor: entry.actor,
          action: entry.action,
          target: entry.target,
          previousState: entry.previousState as Prisma.InputJsonValue | undefined,
          newState: entry.newState as Prisma.InputJsonValue | undefined,
          reason: entry.reason,
        },
      });
    },
    { action: entry.action, target: entry.target },
  );
}
