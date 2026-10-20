import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { abiMarketplaceRouter } from '../../src/api/abi-marketplace';
import { abiRouter } from '../../src/api/abi';

const validContract = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
const validContract2 = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC5';
const validWallet = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const validWallet2 = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHG';

let app: express.Express;

beforeAll(() => {
  app = express();
  app.use(express.json());
  app.use('/abi-marketplace', abiMarketplaceRouter);
  app.use('/contracts/:address/abi', abiRouter);
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const statusCode =
      typeof error === 'object' && error !== null && 'statusCode' in error
        ? Number((error as { statusCode: unknown }).statusCode)
        : 500;
    res.status(statusCode).json({ error: error instanceof Error ? error.message : 'Internal error' });
  });
});

describe('Community-Driven ABI Marketplace API', () => {
  let createdSubmissionId: string;
  let createdSubmissionId2: string;
  let createdBountyId: string;

  describe('1. ABI Submission & Evidence Tracking', () => {
    it('rejects submission without wallet authentication header or body', async () => {
      const response = await request(app)
        .post('/abi-marketplace/submissions')
        .send({
          contractAddress: validContract,
          abi: {
            functions: [{ name: 'transfer', inputs: [{ name: 'to', type: 'address' }] }],
          },
          evidence: {
            sourceType: 'manual',
            sources: [{ type: 'url', value: 'https://example.com' }],
            confidence: 'high',
          },
        });

      expect(response.status).toBe(401);
      expect(response.body.error).toMatch(/Wallet authentication required/i);
    });

    it('rejects submission with empty functions array in ABI', async () => {
      const response = await request(app)
        .post('/abi-marketplace/submissions')
        .set('x-wallet-address', validWallet)
        .send({
          contractAddress: validContract,
          abi: { functions: [] },
          evidence: {
            sourceType: 'manual',
            sources: [{ type: 'url', value: 'https://example.com' }],
            confidence: 'high',
          },
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
    });

    it('rejects submission with invalid contract address', async () => {
      const response = await request(app)
        .post('/abi-marketplace/submissions')
        .set('x-wallet-address', validWallet)
        .send({
          contractAddress: 'invalid_address',
          abi: {
            functions: [{ name: 'transfer', inputs: [{ name: 'to', type: 'address' }] }],
          },
          evidence: {
            sourceType: 'github',
            sources: [{ type: 'url', value: 'https://github.com/example/contract' }],
            confidence: 'high',
          },
        });

      expect(response.status).toBe(400);
    });

    it('creates ABI submission and triggers auto-verification', async () => {
      const response = await request(app)
        .post('/abi-marketplace/submissions')
        .set('x-wallet-address', validWallet)
        .send({
          contractAddress: validContract,
          version: '1.0',
          abi: {
            functions: [
              {
                name: 'transfer',
                inputs: [
                  { name: 'from', type: 'address' },
                  { name: 'to', type: 'address' },
                  { name: 'amount', type: 'i128' },
                ],
                stateMutability: 'nonpayable',
              },
              {
                name: 'balance',
                inputs: [{ name: 'id', type: 'address' }],
                outputs: [{ type: 'i128' }],
                stateMutability: 'view',
              },
            ],
            events: [{ name: 'Transfer', inputs: [{ name: 'from', type: 'address', indexed: true }] }],
          },
          evidence: {
            sourceType: 'github',
            sources: [{ type: 'url', value: 'https://github.com/example/contract' }],
            confidence: 'high',
            notes: 'Verified repository code',
          },
        });

      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('id');
      expect(response.body.contractAddress).toBe(validContract);
      expect(response.body.status).toBe('auto_verified');
      expect(response.body.qualityScore).toBeGreaterThan(0);
      createdSubmissionId = response.body.id;
    });

    it('creates a second submission for diffing and version testing', async () => {
      const response = await request(app)
        .post('/abi-marketplace/submissions')
        .set('x-wallet-address', validWallet2)
        .send({
          contractAddress: validContract,
          version: '2.0',
          abi: {
            functions: [
              {
                name: 'transfer',
                inputs: [
                  { name: 'from', type: 'address' },
                  { name: 'to', type: 'address' },
                  { name: 'amount', type: 'i256' }, // changed param
                ],
                stateMutability: 'nonpayable',
              },
              {
                name: 'mint',
                inputs: [
                  { name: 'to', type: 'address' },
                  { name: 'amount', type: 'i128' },
                ],
                stateMutability: 'nonpayable',
              },
            ],
            events: [{ name: 'Mint', inputs: [{ name: 'to', type: 'address' }] }],
          },
          evidence: {
            sourceType: 'official',
            sources: [{ type: 'url', value: 'https://official.org/contract' }],
            confidence: 'high',
          },
        });

      expect(response.status).toBe(201);
      createdSubmissionId2 = response.body.id;
    });

    it('lists submissions with filtering and pagination', async () => {
      const response = await request(app)
        .get('/abi-marketplace/submissions')
        .query({ contractAddress: validContract, page: 1, limit: 10 });

      expect(response.status).toBe(200);
      expect(response.body.items.length).toBeGreaterThanOrEqual(2);
      expect(response.body.pagination.total).toBeGreaterThanOrEqual(2);
    });

    it('gets submission detail by ID', async () => {
      const response = await request(app).get(`/abi-marketplace/submissions/${createdSubmissionId}`);
      expect(response.status).toBe(200);
      expect(response.body.id).toBe(createdSubmissionId);
      expect(response.body).toHaveProperty('votesSummary');
    });

    it('returns 404 for non-existent submission ID', async () => {
      const response = await request(app).get('/abi-marketplace/submissions/00000000-0000-0000-0000-000000000000');
      expect(response.status).toBe(404);
    });
  });

  describe('2. Transaction Simulation & Coverage Reports', () => {
    it('triggers re-simulation for an existing submission', async () => {
      const response = await request(app).post(`/abi-marketplace/submissions/${createdSubmissionId}/simulate`);
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('coveragePercentage');
      expect(response.body.totalTransactions).toBe(50);
      expect(response.body.verdict).toBe('auto_verified');
    });

    it('retrieves simulation results for a submission', async () => {
      const response = await request(app).get(
        `/abi-marketplace/submissions/${createdSubmissionId}/simulation-results`,
      );
      expect(response.status).toBe(200);
      expect(response.body.results).toBeInstanceOf(Array);
      expect(response.body.results.length).toBeGreaterThan(0);
    });

    it('retrieves coverage report for a submission', async () => {
      const response = await request(app).get(
        `/abi-marketplace/submissions/${createdSubmissionId}/coverage-report`,
      );
      expect(response.status).toBe(200);
      expect(response.body.submissionId).toBe(createdSubmissionId);
      expect(response.body.coveragePercentage).toBeGreaterThanOrEqual(90);
    });
  });

  describe('3. Community Verification & Reputation-Weighted Voting', () => {
    it('rejects downvote without reason', async () => {
      const response = await request(app)
        .post(`/abi-marketplace/submissions/${createdSubmissionId}/vote`)
        .send({
          voterAddress: validWallet,
          vote: false,
          reason: '',
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/reason is required/i);
    });

    it('casts upvote with reputation weighting', async () => {
      const response = await request(app)
        .post(`/abi-marketplace/submissions/${createdSubmissionId}/vote`)
        .send({
          voterAddress: validWallet,
          vote: true,
          reason: 'Verified function signatures against on-chain calls',
        });

      expect(response.status).toBe(200);
      expect(response.body.vote.vote).toBe(true);
      expect(response.body.vote.weight).toBeGreaterThanOrEqual(1.0);
    });

    it('returns vote breakdown and aggregates', async () => {
      const response = await request(app).get(`/abi-marketplace/submissions/${createdSubmissionId}/votes`);
      expect(response.status).toBe(200);
      expect(response.body.summary.totalVotes).toBeGreaterThanOrEqual(1);
      expect(response.body.summary.upvotes).toBeGreaterThanOrEqual(1);
    });

    it('returns reviewer leaderboard', async () => {
      const response = await request(app).get('/abi-marketplace/reviewers/leaderboard');
      expect(response.status).toBe(200);
      expect(response.body.reviewers).toBeInstanceOf(Array);
      expect(response.body.reviewers.length).toBeGreaterThan(0);
    });
  });

  describe('4. Escrow Bounty System', () => {
    it('creates an escrow bounty for a contract', async () => {
      const response = await request(app)
        .post('/abi-marketplace/bounties')
        .send({
          contractAddress: validContract,
          creatorAddress: validWallet,
          rewardAmount: '150',
          rewardToken: 'XLM',
          description: 'Need full verified ABI for DEX contract',
          expiresInDays: 30,
        });

      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('id');
      expect(response.body.escrowStatus).toBe('funded');
      expect(response.body.escrowTxHash).toMatch(/^escrow_/);
      createdBountyId = response.body.id;
    });

    it('rejects bounty creation with invalid reward amount format', async () => {
      const response = await request(app)
        .post('/abi-marketplace/bounties')
        .send({
          contractAddress: validContract,
          creatorAddress: validWallet,
          rewardAmount: 'not_a_number',
        });

      expect(response.status).toBe(400);
    });

    it('lists bounties with filters', async () => {
      const response = await request(app)
        .get('/abi-marketplace/bounties')
        .query({ contractAddress: validContract, status: 'funded' });

      expect(response.status).toBe(200);
      expect(response.body.bounties.length).toBeGreaterThanOrEqual(1);
    });

    it('retrieves bounty details with candidates', async () => {
      const response = await request(app).get(`/abi-marketplace/bounties/${createdBountyId}`);
      expect(response.status).toBe(200);
      expect(response.body.bounty.id).toBe(createdBountyId);
      expect(response.body.candidates.length).toBeGreaterThanOrEqual(1);
    });

    it('claims bounty with active submission', async () => {
      const response = await request(app)
        .post(`/abi-marketplace/bounties/${createdBountyId}/claim`)
        .send({ submissionId: createdSubmissionId });

      expect(response.status).toBe(200);
      expect(response.body.escrowStatus).toBe('claimed');
      expect(response.body.claimedBy).toBe(validWallet);
    });

    it('returns bounty leaderboard and stats', async () => {
      const lb = await request(app).get('/abi-marketplace/bounties/leaderboard');
      expect(lb.status).toBe(200);
      expect(lb.body.leaderboard).toBeInstanceOf(Array);

      const stats = await request(app).get('/abi-marketplace/bounties/stats');
      expect(stats.status).toBe(200);
      expect(stats.body).toHaveProperty('totalBountyValue');
      expect(stats.body.claimedCount).toBeGreaterThanOrEqual(1);
    });

    it('handles bounty refund correctly for creator', async () => {
      // Create a second bounty to refund
      const b2 = await request(app)
        .post('/abi-marketplace/bounties')
        .send({
          contractAddress: validContract2,
          creatorAddress: validWallet,
          rewardAmount: '50',
          rewardToken: 'XLM',
        });

      const refundResp = await request(app)
        .post(`/abi-marketplace/bounties/${b2.body.id}/refund`)
        .set('x-wallet-address', validWallet);

      expect(refundResp.status).toBe(200);
      expect(refundResp.body.escrowStatus).toBe('refunded');
    });

    it('rejects refund if requester is not the creator', async () => {
      const b3 = await request(app)
        .post('/abi-marketplace/bounties')
        .send({
          contractAddress: validContract2,
          creatorAddress: validWallet,
          rewardAmount: '50',
        });

      const refundResp = await request(app)
        .post(`/abi-marketplace/bounties/${b3.body.id}/refund`)
        .set('x-wallet-address', validWallet2);

      expect(refundResp.status).toBe(403);
    });
  });

  describe('5. Quality Scoring & Registry Fallback', () => {
    it('retrieves multi-dimensional quality score breakdown', async () => {
      const response = await request(app).get(`/abi-marketplace/contracts/${validContract}/quality`);
      expect(response.status).toBe(200);
      expect(response.body.contractAddress).toBe(validContract);
      expect(response.body.activeSubmission).not.toBeNull();
      expect(response.body.activeSubmission.breakdown).toHaveProperty('transactionCoverage');
      expect(response.body.activeSubmission.breakdown).toHaveProperty('communityVerification');
      expect(response.body.activeSubmission.breakdown).toHaveProperty('sourceTrust');
      expect(response.body.activeSubmission.breakdown).toHaveProperty('stability');
      expect(response.body.activeSubmission.breakdown).toHaveProperty('bugReports');
    });

    it('serves best marketplace ABI through GET /contracts/:address/abi', async () => {
      const response = await request(app).get(`/contracts/${validContract}/abi`);
      expect(response.status).toBe(200);
      expect(response.body.source).toEqual({
        type: 'community_marketplace',
        submissionId: expect.any(String),
      });
      expect(response.body.quality.score).toBeGreaterThan(0);
      expect(response.body.totalSubmissions).toBeGreaterThanOrEqual(1);
    });

    it('retrieves contract submission history', async () => {
      const response = await request(app).get(
        `/abi-marketplace/contracts/${validContract}/submissions/history`,
      );
      expect(response.status).toBe(200);
      expect(response.body.history.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('6. Semantic Diff & Versioning', () => {
    it('diffs two ABI submissions detecting parameter changes and breaking compatibility', async () => {
      const response = await request(app).get(
        `/abi-marketplace/contracts/${validContract}/submissions/diff/${createdSubmissionId}/${createdSubmissionId2}`,
      );

      expect(response.status).toBe(200);
      expect(response.body.addedFunctions).toContain('mint');
      expect(response.body.removedFunctions).toContain('balance');
      expect(response.body.changedFunctions.some((f: { name: string }) => f.name === 'transfer')).toBe(true);
      expect(response.body.compatibility).toBe('breaking');
    });

    it('diffs versions via query parameters', async () => {
      const response = await request(app)
        .get(`/abi-marketplace/contracts/${validContract}/versions/diff`)
        .query({ from: createdSubmissionId, to: createdSubmissionId2 });

      expect(response.status).toBe(200);
      expect(response.body.addedFunctions).toContain('mint');
    });
  });

  describe('7. Automated Interface Discovery', () => {
    it('proposes an ABI for an uncatalogued contract using Soroban heuristics', async () => {
      const response = await request(app).get(`/abi-marketplace/contracts/${validContract2}/discover`);
      expect(response.status).toBe(200);
      expect(response.body.discovered).toBe(true);
      expect(response.body.proposedABI.functions.length).toBeGreaterThan(0);
      expect(response.body.proposedABI.confidence).toBeGreaterThan(0.5);
    });

    it('accepts discovered interface into a new submission', async () => {
      const response = await request(app)
        .post(`/abi-marketplace/contracts/${validContract2}/discover/accept`)
        .set('x-wallet-address', validWallet);

      expect(response.status).toBe(201);
      expect(response.body.contractAddress).toBe(validContract2);
      expect(response.body.evidence.sourceType).toBe('decompiled');
    });
  });

  describe('8. Multi-Format Code Generation & Exports', () => {
    it('exports ABI as OpenRPC 1.3 spec', async () => {
      const response = await request(app)
        .get(`/abi-marketplace/contracts/${validContract}/abi/export`)
        .query({ format: 'openrpc' });

      expect(response.status).toBe(200);
      expect(response.body.openrpc).toBe('1.3.2');
      expect(response.body.methods).toBeInstanceOf(Array);
    });

    it('exports ABI as TypeScript client declarations', async () => {
      const response = await request(app)
        .get(`/abi-marketplace/contracts/${validContract}/abi/export`)
        .query({ format: 'typescript' });

      expect(response.status).toBe(200);
      expect(response.text).toContain('export interface ContractClient');
      expect(response.text).toContain('transfer(');
    });

    it('exports ABI as Rust Soroban SDK client', async () => {
      const response = await request(app)
        .get(`/abi-marketplace/contracts/${validContract}/abi/export`)
        .query({ format: 'rust' });

      expect(response.status).toBe(200);
      expect(response.text).toContain('pub struct Client');
      expect(response.text).toContain('pub fn transfer');
    });

    it('exports active ABIs in bulk', async () => {
      const response = await request(app).get('/abi-marketplace/export/bulk');
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('abis');
    });
  });

  describe('9. Marketplace Stats, Leaderboard, Flagging & Visualizations', () => {
    it('returns aggregate marketplace statistics', async () => {
      const response = await request(app).get('/abi-marketplace/stats');
      expect(response.status).toBe(200);
      expect(response.body.totalSubmissions).toBeGreaterThanOrEqual(3);
      expect(response.body).toHaveProperty('topSubmitters');
      expect(response.body).toHaveProperty('mostActiveContracts');
    });

    it('returns submitter leaderboard', async () => {
      const response = await request(app).get('/abi-marketplace/leaderboard');
      expect(response.status).toBe(200);
      expect(response.body.topSubmitters).toBeInstanceOf(Array);
    });

    it('flags an incorrect ABI submission and penalizes quality score', async () => {
      const response = await request(app)
        .post('/abi-marketplace/flag')
        .send({
          submissionId: createdSubmissionId,
          reason: 'Function transfer parameter types are incompatible',
          evidence: 'Historical transaction test showed failure',
        });

      expect(response.status).toBe(200);
      expect(response.body.flagged).toBe(true);
      expect(response.body.submission.bugReports).toBeGreaterThanOrEqual(1);
    });

    it('returns submission flow visualization data', async () => {
      const response = await request(app).get('/abi-marketplace/visualizations/submission-flow');
      expect(response.status).toBe(200);
      expect(response.body.nodes).toBeInstanceOf(Array);
      expect(response.body.links).toBeInstanceOf(Array);
    });

    it('returns quality distribution visualization buckets', async () => {
      const response = await request(app).get('/abi-marketplace/visualizations/quality-distribution');
      expect(response.status).toBe(200);
      expect(response.body.distribution).toBeInstanceOf(Array);
      expect(response.body.distribution.length).toBe(5);
    });

    it('returns bounty heatmap visualization data', async () => {
      const response = await request(app).get('/abi-marketplace/visualizations/bounty-heatmap');
      expect(response.status).toBe(200);
      expect(response.body.heatmap).toBeInstanceOf(Array);
    });

    it('sets and retrieves user notification preferences', async () => {
      const setResp = await request(app)
        .post('/abi-marketplace/notifications/preferences')
        .set('x-wallet-address', validWallet)
        .send({ onNewSubmission: true, onBountyClaimed: true });

      expect(setResp.status).toBe(200);
      expect(setResp.body.preferences.onNewSubmission).toBe(true);

      const notifResp = await request(app)
        .get('/abi-marketplace/notifications')
        .set('x-wallet-address', validWallet);

      expect(notifResp.status).toBe(200);
      expect(notifResp.body.notifications).toBeInstanceOf(Array);
    });
  });
});
