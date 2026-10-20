/**
 * Admin audit-integrity API (#1244)
 *
 * GET /api/v1/admin/audit-integrity?from=&to=&limit=
 *   Recomputes the hash chain of `_audit_logs` records in the window and
 *   reports tampered, unlinked, or unchecksummed security-sensitive records.
 *   Responds 200 when the window verifies and 409 when it does not.
 */

import { Router } from 'express';
import { adminAuth } from '../../middleware/adminAuth';
import { asyncHandler } from '../../middleware/asyncHandler';
import { verifyStoredAuditIntegrity } from '../../rbac/audit-integrity';

export const auditIntegrityAdminRouter = Router();

auditIntegrityAdminRouter.use(adminAuth);

function parseDate(value: unknown): Date | undefined | null {
  if (value === undefined) return undefined;
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d;
}

auditIntegrityAdminRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const from = parseDate(req.query.from);
    const to = parseDate(req.query.to);
    if (from === null || to === null) {
      res.status(400).json({ error: 'from/to must be valid ISO-8601 timestamps' });
      return;
    }
    const limit = req.query.limit === undefined ? undefined : Number(req.query.limit);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      res.status(400).json({ error: 'limit must be a positive integer' });
      return;
    }

    const report = await verifyStoredAuditIntegrity({ from, to, limit });
    res.status(report.valid ? 200 : 409).json(report);
  }),
);
