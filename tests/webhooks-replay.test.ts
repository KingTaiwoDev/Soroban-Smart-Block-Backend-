import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../src/db', () => {
  const writeMock: any = {
    webhookSubscription: {
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
    },
    webhookDelivery: {
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    webhookOutboxEvent: {
      updateMany: vi.fn(),
    },
  };
  writeMock.$transaction = vi.fn(async (cb: any) => cb(writeMock));

  return {
    prismaWrite: writeMock,
    prismaRead: {
      webhookSubscription: {
        findMany: vi.fn(),
        findFirst: vi.fn(),
        findUnique: vi.fn(),
      },
      webhookDelivery: {
        findMany: vi.fn(),
        count: vi.fn(async () => 0),
      },
      webhookOutboxEvent: {
        count: vi.fn(async () => 0),
      },
      ledger: {
        findFirst: vi.fn(async () => ({ sequence: 1000 })),
      },
      event: {
        findMany: vi.fn(async () => []),
      },
    },
  };
});

vi.mock('../src/middleware/asyncHandler', () => ({
  asyncHandler: (fn: unknown) => fn,
}));

vi.mock('../src/middleware/apiKeyAuth', () => ({
  apiKeyAuth: (req: { apiKey?: unknown }, _res: unknown, next: () => void) => {
    req.apiKey = { id: 'test-api-key' };
    next();
  },
  requireApiKey: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../src/middleware/sensitiveReadLog', () => ({
  sensitiveReadLog: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../src/webhooks/ssrf-guard', () => {
  class SsrfBlockedError extends Error {
    constructor(reason: string) {
      super(`SSRF blocked: ${reason}`);
      this.name = 'SsrfBlockedError';
    }
  }
  return {
    SsrfBlockedError,
    assertSafeUrl: vi.fn(async () => ['93.184.216.34']),
    safePost: vi.fn(async () => ({ status: 200, data: { ok: true } })),
    safeGet: vi.fn(),
  };
});

import { prismaRead } from '../src/db';
import { safePost } from '../src/webhooks/ssrf-guard';
import { webhooksRouter } from '../src/api/webhooks';
import { _resetReplayStore, executeReplayStep } from '../src/webhooks/replay';

const app = express();
app.use(express.json());
app.use('/webhooks', webhooksRouter);

const TEST_SUB = {
  id: 'sub-test-1',
  apiKeyId: 'test-api-key',
  url: 'https://example.com/webhook',
  secret: 'supersecret-0123456789abcdefghijklmnop',
  contractAddress: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  eventType: 'transfer',
  topicSymbol: 'USDC',
  active: true,
  storeResponseBody: true,
  responseRetentionDays: 90,
  deliveryStrategy: 'immediate',
  batchSize: 100,
  batchWindowMs: 50,
  verified: true,
  verifiedAt: new Date(),
  verificationToken: null,
  verificationExpiresAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('Webhook Checkpoint Replay API (#1286)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetReplayStore();
    (prismaRead.webhookSubscription.findFirst as any).mockResolvedValue(TEST_SUB);
    (prismaRead.webhookSubscription.findUnique as any).mockResolvedValue(TEST_SUB);
    (prismaRead.ledger.findFirst as any).mockResolvedValue({ sequence: 5000 });
  });

  describe('POST /webhooks/:id/replay', () => {
    it('creates a replay job for an authorized owner with valid checkpoint', async () => {
      const res = await request(app)
        .post('/webhooks/sub-test-1/replay')
        .send({
          fromLedger: 100,
          toLedger: 200,
          filters: {
            contractAddress: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
            eventType: 'transfer',
          },
          idempotencyKey: 'idemp-key-1',
        });

      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({
        subscriptionId: 'sub-test-1',
        fromLedger: 100,
        toLedger: 200,
        currentLedger: 100,
        status: 'pending',
        idempotencyKey: 'idemp-key-1',
        filters: {
          contractAddress: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          eventType: 'transfer',
        },
      });
    });

    it('returns existing job on duplicate idempotent request', async () => {
      const first = await request(app)
        .post('/webhooks/sub-test-1/replay')
        .send({
          fromLedger: 100,
          toLedger: 200,
          idempotencyKey: 'idemp-duplicate-test',
        });
      expect(first.status).toBe(201);
      const jobId = first.body.data.id;

      const second = await request(app)
        .post('/webhooks/sub-test-1/replay')
        .send({
          fromLedger: 100,
          toLedger: 200,
          idempotencyKey: 'idemp-duplicate-test',
        });
      expect(second.status).toBe(200);
      expect(second.body.data.id).toBe(jobId);
    });

    it('rejects invalid checkpoint (fromLedger < 1)', async () => {
      const res = await request(app)
        .post('/webhooks/sub-test-1/replay')
        .send({ fromLedger: 0, toLedger: 100 });

      expect(res.status).toBe(400);
    });

    it('rejects invalid checkpoint (toLedger < fromLedger)', async () => {
      const res = await request(app)
        .post('/webhooks/sub-test-1/replay')
        .send({ fromLedger: 200, toLedger: 100 });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_LEDGER_CHECKPOINT');
    });

    it('rejects range exceeding delivery limits (>10,000 ledgers)', async () => {
      const res = await request(app)
        .post('/webhooks/sub-test-1/replay')
        .send({ fromLedger: 100, toLedger: 20_000 });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('RANGE_LIMIT_EXCEEDED');
    });

    it('rejects filter mismatch conflicting with subscription contract', async () => {
      const res = await request(app)
        .post('/webhooks/sub-test-1/replay')
        .send({
          fromLedger: 100,
          toLedger: 200,
          filters: {
            contractAddress: 'CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
          },
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('FILTER_MISMATCH');
    });

    it('rejects replay if subscription is inactive', async () => {
      (prismaRead.webhookSubscription.findFirst as any).mockResolvedValue({
        ...TEST_SUB,
        active: false,
      });

      const res = await request(app)
        .post('/webhooks/sub-test-1/replay')
        .send({ fromLedger: 100, toLedger: 200 });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('SUBSCRIPTION_INACTIVE');
    });
  });

  describe('GET /webhooks/:id/replay and /:jobId', () => {
    it('lists replay jobs and inspects specific job progress', async () => {
      const createRes = await request(app)
        .post('/webhooks/sub-test-1/replay')
        .send({ fromLedger: 100, toLedger: 150 });
      const jobId = createRes.body.data.id;

      const listRes = await request(app).get('/webhooks/sub-test-1/replay');
      expect(listRes.status).toBe(200);
      expect(listRes.body.data).toHaveLength(1);
      expect(listRes.body.data[0].id).toBe(jobId);

      const getRes = await request(app).get(`/webhooks/sub-test-1/replay/${jobId}`);
      expect(getRes.status).toBe(200);
      expect(getRes.body.data.id).toBe(jobId);
      expect(getRes.body.data.eventsReplayed).toBeDefined();
    });
  });

  describe('Replay Execution, Signatures, and Interruption Handling', () => {
    it('dispatches replayed events with signature verification and replay headers', async () => {
      const sampleEvents = [
        {
          id: 'evt-1',
          contractAddress: TEST_SUB.contractAddress,
          eventType: 'transfer',
          topicSymbol: 'USDC',
          topics: ['transfer'],
          data: { amount: '100' },
          decoded: { amount: '100' },
          ledgerSequence: 105,
          ledgerCloseTime: new Date(),
          transactionHash: 'txhash-1',
        },
      ];
      (prismaRead.event.findMany as any).mockResolvedValue(sampleEvents);

      const createRes = await request(app)
        .post('/webhooks/sub-test-1/replay')
        .send({ fromLedger: 100, toLedger: 110 });
      const jobId = createRes.body.data.id;

      // Wait for background execution step
      for (let i = 0; i < 20; i++) {
        const check = await request(app).get(`/webhooks/sub-test-1/replay/${jobId}`);
        if (check.body.data.status === 'completed' || check.body.data.status === 'failed') break;
        await new Promise((r) => setTimeout(r, 10));
      }

      // Verify safePost was called with signature and replay headers
      expect(safePost).toHaveBeenCalled();
      const lastCall = (safePost as any).mock.calls[0];
      const headers = lastCall[2];
      expect(headers['X-Webhook-Replay']).toBe('true');
      expect(headers['X-Webhook-Replay-Job-Id']).toBe(jobId);
      expect(headers['X-Webhook-Signature']).toMatch(/^sha256=[a-f0-9]{64}$/);
      expect(headers['Idempotency-Key']).toContain(jobId);

      // Verify payload contains replayed markers
      const payload = lastCall[1];
      expect(payload.replayed).toBe(true);
      expect(payload.event.replayed).toBe(true);
      expect(payload.event.checkpointLedger).toBe(105);

      const jobStatus = await request(app).get(`/webhooks/sub-test-1/replay/${jobId}`);
      expect(jobStatus.body.data.eventsReplayed).toBe(1);
      expect(jobStatus.body.data.status).toBe('completed');
    });

    it('halts and marks job interrupted if subscription is deactivated during replay', async () => {
      // Simulate subscription being deactivated when replay step executes
      (prismaRead.webhookSubscription.findUnique as any).mockResolvedValue({
        ...TEST_SUB,
        active: false,
      });

      const createRes = await request(app)
        .post('/webhooks/sub-test-1/replay')
        .send({ fromLedger: 100, toLedger: 110 });
      const jobId = createRes.body.data.id;

      for (let i = 0; i < 20; i++) {
        const check = await request(app).get(`/webhooks/sub-test-1/replay/${jobId}`);
        if (check.body.data.status === 'interrupted' || check.body.data.status === 'completed' || check.body.data.status === 'failed') break;
        await new Promise((r) => setTimeout(r, 10));
      }

      const jobStatus = await request(app).get(`/webhooks/sub-test-1/replay/${jobId}`);
      expect(jobStatus.body.data.status).toBe('interrupted');
      expect(jobStatus.body.data.error).toContain('Subscription deactivated');
    });

    it('supports resuming an interrupted job and cancelling a job', async () => {
      const createRes = await request(app)
        .post('/webhooks/sub-test-1/replay')
        .send({ fromLedger: 100, toLedger: 110 });
      const jobId = createRes.body.data.id;

      // Wait for first step to complete
      for (let i = 0; i < 20; i++) {
        const check = await request(app).get(`/webhooks/sub-test-1/replay/${jobId}`);
        if (check.body.data.status === 'completed' || check.body.data.status === 'failed') break;
        await new Promise((r) => setTimeout(r, 10));
      }

      // Simulate interruption
      const { getReplayJob } = await import('../src/webhooks/replay');
      const job = getReplayJob(jobId, 'sub-test-1');
      if (job) job.status = 'interrupted';

      // Test resuming the interrupted job
      const resumeRes = await request(app).post(`/webhooks/sub-test-1/replay/${jobId}/resume`);
      expect(resumeRes.status).toBe(200);
      expect(resumeRes.body.data.status).toBe('pending');

      // Cancel job
      const cancelRes = await request(app).post(`/webhooks/sub-test-1/replay/${jobId}/cancel`);
      expect(cancelRes.status).toBe(200);
      expect(cancelRes.body.data.status).toBe('cancelled');
    });
  });
});
