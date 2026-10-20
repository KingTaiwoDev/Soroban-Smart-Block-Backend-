/**
 * POST /api/v1/admin/consistency-check
 *
 * Scans the last N ledgers and verifies hash chain continuity (previousLedgerHash matches previous ledger hash).
 * Output a report of any inconsistencies found.
 */

import { Router, Request, Response } from 'express';
import { asyncHandler } from '../middleware/asyncHandler';
import { adminAuth } from '../middleware/adminAuth';
import { adminService } from '../services/admin.service';
import { getIndexerPauseState, setIndexerPaused } from '../indexer/worker-control';
import { auditActor, recordAdminAudit } from '../lib/admin-audit';

export const adminRouter = Router();

adminRouter.get(
  '/indexer/control',
  adminAuth,
  asyncHandler(async (_req: Request, res: Response) => {
    res.json(await getIndexerPauseState());
  }),
);

adminRouter.post(
  '/indexer/pause',
  adminAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const state = await setIndexerPaused(true);
    void recordAdminAudit({
      actor: auditActor(req, 'admin'),
      action: 'admin.indexer.pause',
      target: 'indexer',
      newState: { ...state },
    });
    res.json(state);
  }),
);

adminRouter.post(
  '/indexer/resume',
  adminAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const state = await setIndexerPaused(false);
    void recordAdminAudit({
      actor: auditActor(req, 'admin'),
      action: 'admin.indexer.resume',
      target: 'indexer',
      newState: { ...state },
    });
    res.json(state);
  }),
);

adminRouter.post(
  '/consistency-check',
  asyncHandler(async (req: Request, res: Response) => {
    const limit = Number(req.body.limit ?? req.body.count ?? 100);
    const report = await adminService.runConsistencyCheck(limit);
    res.json(report);
  }),
);
