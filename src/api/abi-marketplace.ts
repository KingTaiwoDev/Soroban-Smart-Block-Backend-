/**
 * src/api/abi-marketplace.ts
 *
 * REST API router for the Community-Driven ABI Marketplace & Smart Contract Registry.
 * Mounts under /api/v1/abi-marketplace.
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler';
import { isValidStellarAddress } from '../middleware/sanitize';
import { AppError } from '../middleware/errorHandler';
import {
  submitAbi,
  listSubmissions,
  getSubmission,
  simulateSubmission,
  getSimulationResults,
  getCoverageReport,
  castVote,
  getSubmissionVotes,
  getReviewerLeaderboard,
  createBounty,
  listBounties,
  getBounty,
  claimBounty,
  refundBounty,
  getBountyLeaderboard,
  getBountyStats,
  getContractQuality,
  getMarketplaceBestAbi,
  diffSubmissions,
  diffAbis,
  flagSubmission,
  discoverInterface,
  exportAbi,
  getMarketplaceStats,
  getSubmissionFlowVisualization,
  getQualityDistributionVisualization,
  getBountyHeatmapVisualization,
  getNotifications,
  setNotificationPreferences,
  type SubmissionStatus,
  type BountyStatus,
} from '../services/abi-marketplace';

export const abiMarketplaceRouter = Router();

// ── Validation Schemas ────────────────────────────────────────────────────────

const stellarAddress = z.string().refine(isValidStellarAddress, {
  message: 'Invalid Stellar address',
});

const abiFunctionParamSchema = z.object({
  name: z.string().min(1).max(128),
  type: z.string().min(1).max(128),
});

const abiFunctionSchema = z.object({
  name: z.string().min(1).max(128),
  inputs: z.array(abiFunctionParamSchema).default([]),
  outputs: z.array(z.object({ type: z.string().min(1).max(128) })).optional(),
  stateMutability: z.enum(['nonpayable', 'view', 'payable']).optional(),
  doc: z.string().max(2048).optional(),
});

const abiEventSchema = z.object({
  name: z.string().min(1).max(128),
  inputs: z.array(z.object({ name: z.string(), type: z.string(), indexed: z.boolean().optional() })).optional(),
  doc: z.string().max(2048).optional(),
});

const abiErrorSchema = z.object({
  name: z.string().min(1).max(128),
  code: z.number().int().optional(),
  message: z.string().max(1024).optional(),
});

const submissionPayloadSchema = z.object({
  contractAddress: stellarAddress,
  version: z.string().max(32).optional(),
  abi: z.object({
    version: z.string().max(32).optional(),
    functions: z.array(abiFunctionSchema).min(1, 'At least one function is required in the ABI'),
    events: z.array(abiEventSchema).optional(),
    errors: z.array(abiErrorSchema).optional(),
  }),
  evidence: z.object({
    sourceType: z.enum(['manual', 'decompiled', 'github', 'official', 'tx_analysis']),
    sources: z.array(
      z.object({
        type: z.enum(['url', 'tx_hash', 'decompilation_output']),
        value: z.string().min(1),
      }),
    ),
    confidence: z.enum(['high', 'medium', 'low']),
    notes: z.string().max(2048).optional(),
  }),
});

const voteSchema = z.object({
  voterAddress: stellarAddress,
  vote: z.boolean(),
  reason: z.string().max(2048).optional(),
});

const bountyCreateSchema = z.object({
  contractAddress: stellarAddress,
  creatorAddress: stellarAddress,
  rewardAmount: z.string().regex(/^\d+(\.\d+)?$/, 'Reward amount must be a positive numeric string'),
  rewardToken: z.string().min(1).max(16).default('XLM'),
  description: z.string().max(2048).optional(),
  expiresInDays: z.number().int().positive().max(365).default(30),
});

const flagSchema = z.object({
  submissionId: z.string().uuid(),
  reason: z.string().min(3).max(2048),
  evidence: z.string().max(2048).optional(),
});

// ── 1. Submission Endpoints ───────────────────────────────────────────────────

/**
 * POST /api/v1/abi-marketplace/submissions
 * Submit an ABI with verification evidence and wallet identification.
 */
abiMarketplaceRouter.post(
  '/submissions',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = submissionPayloadSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    }

    const submitterAddress =
      (req.headers['x-wallet-address'] as string | undefined) ||
      (req.body.submitterAddress as string | undefined);

    if (!submitterAddress || !isValidStellarAddress(submitterAddress)) {
      return res.status(401).json({
        error: 'Wallet authentication required. Provide a valid Stellar wallet address via x-wallet-address header or submitterAddress body field.',
      });
    }

    const submission = await submitAbi({
      ...parsed.data,
      submitterAddress,
    });

    res.status(201).json(submission);
  }),
);

/**
 * GET /api/v1/abi-marketplace/submissions
 * List submissions with filtering.
 */
abiMarketplaceRouter.get(
  '/submissions',
  asyncHandler(async (req: Request, res: Response) => {
    const contractAddress = req.query.contractAddress as string | undefined;
    const status = req.query.status as SubmissionStatus | undefined;
    const page = req.query.page ? parseInt(req.query.page as string, 10) : 1;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 25;

    const result = listSubmissions({ contractAddress, status, page, limit });
    res.json(result);
  }),
);

/**
 * GET /api/v1/abi-marketplace/submissions/:id
 * Retrieve submission detail with vote summary and quality breakdown.
 */
abiMarketplaceRouter.get(
  '/submissions/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const submission = getSubmission(req.params.id);
    const votesSummary = getSubmissionVotes(req.params.id);
    res.json({
      ...submission,
      votesSummary: votesSummary.summary,
    });
  }),
);

// ── 2. Simulation & Auto-Verification Endpoints ────────────────────────────────

/**
 * POST /api/v1/abi-marketplace/submissions/:id/simulate
 * Trigger re-simulation against historical transactions.
 */
abiMarketplaceRouter.post(
  '/submissions/:id/simulate',
  asyncHandler(async (req: Request, res: Response) => {
    const report = await simulateSubmission(req.params.id);
    res.json(report);
  }),
);

/**
 * GET /api/v1/abi-marketplace/submissions/:id/simulation-results
 * View raw simulation results.
 */
abiMarketplaceRouter.get(
  '/submissions/:id/simulation-results',
  asyncHandler(async (req: Request, res: Response) => {
    const results = getSimulationResults(req.params.id);
    res.json({ submissionId: req.params.id, results });
  }),
);

/**
 * GET /api/v1/abi-marketplace/submissions/:id/coverage-report
 * View detailed transaction coverage report.
 */
abiMarketplaceRouter.get(
  '/submissions/:id/coverage-report',
  asyncHandler(async (req: Request, res: Response) => {
    const report = getCoverageReport(req.params.id);
    res.json(report);
  }),
);

// ── 3. Voting & Reviewer Endpoints ────────────────────────────────────────────

/**
 * POST /api/v1/abi-marketplace/submissions/:id/vote
 * Cast an upvote or downvote with reputation weighting.
 */
abiMarketplaceRouter.post(
  '/submissions/:id/vote',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = voteSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    }

    const result = await castVote({
      submissionId: req.params.id,
      ...parsed.data,
    });

    res.json(result);
  }),
);

/**
 * GET /api/v1/abi-marketplace/submissions/:id/votes
 * View vote breakdown and weighted aggregates.
 */
abiMarketplaceRouter.get(
  '/submissions/:id/votes',
  asyncHandler(async (req: Request, res: Response) => {
    const votesData = getSubmissionVotes(req.params.id);
    res.json(votesData);
  }),
);

/**
 * GET /api/v1/abi-marketplace/reviewers/leaderboard
 * Top reviewers ranked by accuracy and reviewer score.
 */
abiMarketplaceRouter.get(
  '/reviewers/leaderboard',
  asyncHandler(async (_req: Request, res: Response) => {
    const leaderboard = getReviewerLeaderboard();
    res.json({ reviewers: leaderboard });
  }),
);

// ── 4. Escrow Bounty Endpoints ────────────────────────────────────────────────

/**
 * POST /api/v1/abi-marketplace/bounties
 * Create a new escrow bounty for an unregistered contract.
 */
abiMarketplaceRouter.post(
  '/bounties',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = bountyCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    }

    const bounty = createBounty(parsed.data);
    res.status(201).json(bounty);
  }),
);

/**
 * GET /api/v1/abi-marketplace/bounties
 * List open bounties with optional filters.
 */
abiMarketplaceRouter.get(
  '/bounties',
  asyncHandler(async (req: Request, res: Response) => {
    const contractAddress = req.query.contractAddress as string | undefined;
    const rewardToken = req.query.rewardToken as string | undefined;
    const status = req.query.status as BountyStatus | undefined;

    const list = listBounties({ contractAddress, rewardToken, status });
    res.json({ bounties: list });
  }),
);

/**
 * GET /api/v1/abi-marketplace/bounties/leaderboard
 * Top bounty earners.
 */
abiMarketplaceRouter.get(
  '/bounties/leaderboard',
  asyncHandler(async (_req: Request, res: Response) => {
    const earners = getBountyLeaderboard();
    res.json({ leaderboard: earners });
  }),
);

/**
 * GET /api/v1/abi-marketplace/bounties/stats
 * Aggregate bounty statistics.
 */
abiMarketplaceRouter.get(
  '/bounties/stats',
  asyncHandler(async (_req: Request, res: Response) => {
    const stats = getBountyStats();
    res.json(stats);
  }),
);

/**
 * GET /api/v1/abi-marketplace/bounties/:id
 * Retrieve bounty detail with candidate submissions.
 */
abiMarketplaceRouter.get(
  '/bounties/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const result = getBounty(req.params.id);
    res.json(result);
  }),
);

/**
 * POST /api/v1/abi-marketplace/bounties/:id/claim
 * Claim a funded bounty with an accepted ABI submission.
 */
abiMarketplaceRouter.post(
  '/bounties/:id/claim',
  asyncHandler(async (req: Request, res: Response) => {
    const submissionId = req.body.submissionId as string;
    if (!submissionId) {
      return res.status(400).json({ error: 'submissionId is required to claim a bounty' });
    }

    const bounty = claimBounty(req.params.id, submissionId);
    res.json(bounty);
  }),
);

/**
 * POST /api/v1/abi-marketplace/bounties/:id/refund
 * Refund an expired bounty to the creator.
 */
abiMarketplaceRouter.post(
  '/bounties/:id/refund',
  asyncHandler(async (req: Request, res: Response) => {
    const requesterAddress =
      (req.headers['x-wallet-address'] as string | undefined) ||
      (req.body.creatorAddress as string | undefined);

    if (!requesterAddress) {
      return res.status(400).json({ error: 'creatorAddress or x-wallet-address header is required for refunds' });
    }

    const bounty = refundBounty(req.params.id, requesterAddress);
    res.json(bounty);
  }),
);

// ── 5. Quality & Contract-Specific Endpoints ──────────────────────────────────

/**
 * GET /api/v1/abi-marketplace/contracts/:address/quality
 * Retrieve composite quality score and dimension breakdown.
 */
abiMarketplaceRouter.get(
  '/contracts/:address/quality',
  asyncHandler(async (req: Request, res: Response) => {
    const quality = getContractQuality(req.params.address);
    res.json(quality);
  }),
);

/**
 * GET /api/v1/abi-marketplace/contracts/:address/submissions
 * Retrieve all submissions for a contract.
 */
abiMarketplaceRouter.get(
  '/contracts/:address/submissions',
  asyncHandler(async (req: Request, res: Response) => {
    const submissionsList = listSubmissions({ contractAddress: req.params.address, limit: 100 });
    res.json(submissionsList);
  }),
);

/**
 * GET /api/v1/abi-marketplace/contracts/:address/submissions/diff/:id1/:id2
 * Semantic diff between two submissions.
 */
abiMarketplaceRouter.get(
  '/contracts/:address/submissions/diff/:id1/:id2',
  asyncHandler(async (req: Request, res: Response) => {
    const diff = diffSubmissions(req.params.id1, req.params.id2);
    res.json(diff);
  }),
);

/**
 * GET /api/v1/abi-marketplace/contracts/:address/submissions/history
 * Timeline of ABI changes for a contract.
 */
abiMarketplaceRouter.get(
  '/contracts/:address/submissions/history',
  asyncHandler(async (req: Request, res: Response) => {
    const list = listSubmissions({ contractAddress: req.params.address, limit: 100 });
    const timeline = list.items.map((s) => ({
      id: s.id,
      version: s.version,
      status: s.status,
      qualityScore: s.qualityScore,
      submitterAddress: s.submitterAddress,
      createdAt: s.createdAt,
    }));
    res.json({ contractAddress: req.params.address, history: timeline });
  }),
);

/**
 * GET /api/v1/abi-marketplace/contracts/:address/versions
 * Version history for a contract.
 */
abiMarketplaceRouter.get(
  '/contracts/:address/versions',
  asyncHandler(async (req: Request, res: Response) => {
    const list = listSubmissions({ contractAddress: req.params.address, limit: 100 });
    const versions = list.items.map((s) => ({
      versionId: s.id,
      version: s.version,
      status: s.status,
      qualityScore: s.qualityScore,
      createdAt: s.createdAt,
    }));
    res.json({ contractAddress: req.params.address, versions });
  }),
);

/**
 * GET /api/v1/abi-marketplace/contracts/:address/versions/diff
 * Semantic diff between two versions via query params (?from=v1&to=v2).
 */
abiMarketplaceRouter.get(
  '/contracts/:address/versions/diff',
  asyncHandler(async (req: Request, res: Response) => {
    const fromId = req.query.from as string;
    const toId = req.query.to as string;

    if (!fromId || !toId) {
      return res.status(400).json({ error: 'Both "from" and "to" query parameters are required' });
    }

    const diff = diffSubmissions(fromId, toId);
    res.json(diff);
  }),
);

/**
 * GET /api/v1/abi-marketplace/contracts/:address/discover
 * Automated interface discovery for unregistered contracts.
 */
abiMarketplaceRouter.get(
  '/contracts/:address/discover',
  asyncHandler(async (req: Request, res: Response) => {
    const discovery = discoverInterface(req.params.address);
    res.json(discovery);
  }),
);

/**
 * POST /api/v1/abi-marketplace/contracts/:address/discover/accept
 * Accept discovered interface as a new submission.
 */
abiMarketplaceRouter.post(
  '/contracts/:address/discover/accept',
  asyncHandler(async (req: Request, res: Response) => {
    const submitterAddress =
      (req.headers['x-wallet-address'] as string | undefined) ||
      (req.body.submitterAddress as string | undefined);

    if (!submitterAddress || !isValidStellarAddress(submitterAddress)) {
      return res.status(401).json({ error: 'Wallet authentication required' });
    }

    const discovery = discoverInterface(req.params.address);
    const submission = await submitAbi({
      contractAddress: req.params.address,
      abi: discovery.proposedABI,
      evidence: {
        sourceType: 'decompiled',
        sources: [{ type: 'decompilation_output', value: 'auto_discovery_heuristic' }],
        confidence: 'medium',
        notes: 'Accepted via automated interface discovery heuristic',
      },
      submitterAddress,
    });

    res.status(201).json(submission);
  }),
);

/**
 * GET /api/v1/abi-marketplace/contracts/:address/abi/export
 * Export contract ABI in multiple formats (json, openrpc, typescript, rust).
 */
abiMarketplaceRouter.get(
  '/contracts/:address/abi/export',
  asyncHandler(async (req: Request, res: Response) => {
    const format = (req.query.format as 'json' | 'openrpc' | 'typescript' | 'rust') || 'json';
    const best = getMarketplaceBestAbi(req.params.address);

    if (!best) {
      throw new AppError(404, `No active ABI found for contract ${req.params.address}`);
    }

    const exported = exportAbi(best.abi, req.params.address, format);
    if (typeof exported === 'string') {
      res.setHeader('Content-Type', 'text/plain');
      return res.send(exported);
    }
    res.json(exported);
  }),
);

// ── 6. Marketplace Stats, Leaderboard & Flagging ──────────────────────────────

/**
 * GET /api/v1/abi-marketplace/stats
 * Aggregate marketplace statistics.
 */
abiMarketplaceRouter.get(
  '/stats',
  asyncHandler(async (_req: Request, res: Response) => {
    const stats = getMarketplaceStats();
    res.json(stats);
  }),
);

/**
 * GET /api/v1/abi-marketplace/leaderboard
 * Top submitters ranked by accepted submissions and quality score.
 */
abiMarketplaceRouter.get(
  '/leaderboard',
  asyncHandler(async (_req: Request, res: Response) => {
    const stats = getMarketplaceStats();
    res.json({ topSubmitters: stats.topSubmitters });
  }),
);

/**
 * POST /api/v1/abi-marketplace/flag
 * Report an incorrect ABI submission.
 */
abiMarketplaceRouter.post(
  '/flag',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = flagSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    }

    const result = flagSubmission(parsed.data);
    res.json(result);
  }),
);

// ── 7. Bulk Export ────────────────────────────────────────────────────────────

/**
 * GET /api/v1/abi-marketplace/export/bulk
 * Export all active ABIs as a JSON array.
 */
abiMarketplaceRouter.get(
  '/export/bulk',
  asyncHandler(async (_req: Request, res: Response) => {
    const activeSubs = listSubmissions({ status: 'active', limit: 100 });
    res.json({
      exportedAt: new Date().toISOString(),
      count: activeSubs.items.length,
      abis: activeSubs.items.map((s) => ({
        contractAddress: s.contractAddress,
        version: s.version,
        qualityScore: s.qualityScore,
        abi: s.abi,
      })),
    });
  }),
);

/**
 * POST /api/v1/abi-marketplace/export/filtered
 * Export filtered subset of ABIs.
 */
abiMarketplaceRouter.post(
  '/export/filtered',
  asyncHandler(async (req: Request, res: Response) => {
    const addresses = req.body.addresses as string[] | undefined;
    let list = listSubmissions({ limit: 100 }).items;
    if (addresses && Array.isArray(addresses)) {
      list = list.filter((s) => addresses.includes(s.contractAddress));
    }
    res.json({
      exportedAt: new Date().toISOString(),
      count: list.length,
      abis: list,
    });
  }),
);

// ── 8. Visualizations ─────────────────────────────────────────────────────────

abiMarketplaceRouter.get(
  '/visualizations/submission-flow',
  asyncHandler(async (_req: Request, res: Response) => {
    res.json(getSubmissionFlowVisualization());
  }),
);

abiMarketplaceRouter.get(
  '/visualizations/quality-distribution',
  asyncHandler(async (_req: Request, res: Response) => {
    res.json({ distribution: getQualityDistributionVisualization() });
  }),
);

abiMarketplaceRouter.get(
  '/visualizations/bounty-heatmap',
  asyncHandler(async (_req: Request, res: Response) => {
    res.json({ heatmap: getBountyHeatmapVisualization() });
  }),
);

// ── 9. User Notifications ─────────────────────────────────────────────────────

abiMarketplaceRouter.get(
  '/notifications',
  asyncHandler(async (req: Request, res: Response) => {
    const userAddress = req.headers['x-wallet-address'] as string | undefined;
    if (!userAddress) {
      return res.status(400).json({ error: 'x-wallet-address header is required' });
    }
    res.json({ notifications: getNotifications(userAddress) });
  }),
);

abiMarketplaceRouter.post(
  '/notifications/preferences',
  asyncHandler(async (req: Request, res: Response) => {
    const userAddress = req.headers['x-wallet-address'] as string | undefined;
    if (!userAddress) {
      return res.status(400).json({ error: 'x-wallet-address header is required' });
    }
    const prefs = setNotificationPreferences(userAddress, req.body ?? {});
    res.json({ preferences: prefs });
  }),
);
