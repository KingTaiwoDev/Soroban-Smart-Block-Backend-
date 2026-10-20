import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../src/services/transaction.service', () => ({
  transactionService: {
    listTransactions: vi.fn(),
    getTransactionByHash: vi.fn(),
  },
}));

vi.mock('../../src/services/event.service', () => ({
  eventService: {
    listEvents: vi.fn(),
    getEventById: vi.fn(),
  },
}));

import { transactionRouter } from '../../src/api/transactions';
import { eventRouter } from '../../src/api/events';
import { transactionService } from '../../src/services/transaction.service';
import { eventService } from '../../src/services/event.service';

const transaction = {
  hash: 'abc123',
  ledgerSequence: 100,
  ledgerCloseTime: new Date('2024-01-01T00:00:00Z'),
  sourceAccount: 'GABC',
  contractAddress: null,
  functionName: null,
  functionArgs: null,
  status: 'success',
  humanReadable: null,
  feeCharged: null,
  sorobanResources: null,
  failureReason: null,
};

const eventSummary = {
  id: 'event-1',
  transactionHash: 'abc123',
  contractAddress: 'CABC',
  eventType: 'transfer',
  topicSymbol: 'transfer',
  decoded: { amount: '10' },
  ledgerSequence: 100,
  ledgerCloseTime: new Date('2024-01-01T00:00:00Z'),
};

const event = {
  ...eventSummary,
  topics: [],
  data: { raw: 'AA==' },
  compacted: false,
  createdAt: new Date('2024-01-01T00:00:00Z'),
};

function makeApp() {
  const app = express();
  app.use('/transactions', transactionRouter);
  app.use('/events', eventRouter);
  return app;
}

describe('transaction and event API response schemas', () => {
  beforeEach(() => vi.clearAllMocks());

  it('preserves a valid offset-paginated transaction response', async () => {
    vi.mocked(transactionService.listTransactions).mockResolvedValue({
      data: [transaction],
      total: 1,
      page: 1,
      limit: 20,
      pages: 1,
    });

    const response = await request(makeApp()).get('/transactions');

    expect(response.status).toBe(200);
    // Offset pagination is the original public response contract. Keep this
    // assertion explicit so a cursor-pagination refactor cannot quietly
    // remove fields used by existing SDKs.
    expect(Object.keys(response.body).sort()).toEqual(['data', 'limit', 'page', 'pages', 'total']);
    expect(response.body.data[0].hash).toBe(transaction.hash);
    expect(response.body).toMatchObject({ total: 1, page: 1, limit: 20, pages: 1 });
  });

  it('rejects a transaction response that drops a legacy pagination field', async () => {
    vi.mocked(transactionService.listTransactions).mockResolvedValue({
      data: [transaction],
      total: 1,
      page: 1,
      limit: 20,
      // `pages` is intentionally absent: clients rely on it to render the
      // final offset page and it must remain part of the v1 contract.
    } as never);

    const response = await request(makeApp()).get('/transactions');

    expect(response.status).toBe(500);
    expect(response.body.code).toBe('RESPONSE_SCHEMA_VALIDATION_FAILED');
  });

  it('returns a server error for an invalid transaction list response', async () => {
    vi.mocked(transactionService.listTransactions).mockResolvedValue({
      data: [{ ...transaction, ledgerSequence: 'invalid' }],
      total: 1,
      page: 1,
      limit: 20,
      pages: 1,
    } as never);

    const response = await request(makeApp()).get('/transactions');

    expect(response.status).toBe(500);
    expect(response.body.code).toBe('RESPONSE_SCHEMA_VALIDATION_FAILED');
  });

  it('returns a server error for an invalid transaction detail response', async () => {
    vi.mocked(transactionService.getTransactionByHash).mockResolvedValue({
      ...transaction,
      status: null,
      events: [],
    });

    const response = await request(makeApp()).get('/transactions/abc123');

    expect(response.status).toBe(500);
    expect(response.body.code).toBe('RESPONSE_SCHEMA_VALIDATION_FAILED');
  });

  it('preserves a valid event summary response', async () => {
    vi.mocked(eventService.listEvents).mockResolvedValue({
      data: [eventSummary],
      total: 1,
      page: 1,
      limit: 20,
      nextCursor: null,
    });

    const response = await request(makeApp()).get('/events');

    expect(response.status).toBe(200);
    // Event offset pagination predates opaque cursors and remains stable for
    // integrations that have not opted into `pagination=cursor`.
    expect(Object.keys(response.body).sort()).toEqual(['data', 'limit', 'nextCursor', 'page', 'total']);
    expect(response.body.data[0].eventType).toBe('transfer');
    expect(response.body).toMatchObject({ total: 1, page: 1, limit: 20, nextCursor: null });
  });

  it('rejects an event response that drops the legacy nextCursor field', async () => {
    vi.mocked(eventService.listEvents).mockResolvedValue({
      data: [eventSummary],
      total: 1,
      page: 1,
      limit: 20,
    } as never);

    const response = await request(makeApp()).get('/events');

    expect(response.status).toBe(500);
    expect(response.body.code).toBe('RESPONSE_SCHEMA_VALIDATION_FAILED');
  });

  it('returns a server error for an invalid event list response', async () => {
    vi.mocked(eventService.listEvents).mockResolvedValue({
      data: [{ ...eventSummary, ledgerSequence: 'invalid' }],
      total: 1,
      page: 1,
      limit: 20,
      nextCursor: null,
    } as never);

    const response = await request(makeApp()).get('/events');

    expect(response.status).toBe(500);
    expect(response.body.code).toBe('RESPONSE_SCHEMA_VALIDATION_FAILED');
  });

  it('returns a server error for an invalid event detail response', async () => {
    vi.mocked(eventService.getEventById).mockResolvedValue({
      ...event,
      eventType: null,
    });

    const response = await request(makeApp()).get('/events/event-1');

    expect(response.status).toBe(500);
    expect(response.body.code).toBe('RESPONSE_SCHEMA_VALIDATION_FAILED');
  });
});
