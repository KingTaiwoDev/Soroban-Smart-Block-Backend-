import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../src/config', () => ({ config: { stellarNetwork: 'testnet' } }));
vi.mock('../../src/db', () => ({
  prismaRead: { gasAnalyticsSnapshot: { findMany: vi.fn() } },
}));
vi.mock('../../src/indexer/gasAnalytics', () => ({ runGasAnalytics: vi.fn() }));
vi.mock('../../src/api/protocol-economics', () => ({ protocolEconomicsRouter: express.Router() }));

import * as db from '../../src/db';
import { analyticsRouter } from '../../src/api/analytics';
import { buildAnalyticsFreshness } from '../../src/analytics/freshness';

const NOW = new Date('2026-10-19T12:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

describe('buildAnalyticsFreshness', () => {
  it('reports age and fresh status for a recent bucket', () => {
    const f = buildAnalyticsFreshness('mainnet', 'hour', { bucketEnd: hoursAgo(1) }, NOW);
    expect(f).toEqual({
      network: 'mainnet',
      bucket: 'hour',
      dataAsOf: hoursAgo(1).toISOString(),
      ageSeconds: 3600,
      maxAgeSeconds: 7200,
      stale: false,
    });
  });

  it('flags data stale once two bucket periods are missed on mainnet/testnet', () => {
    const f = buildAnalyticsFreshness('testnet', 'hour', { bucketEnd: hoursAgo(3) }, NOW);
    expect(f.stale).toBe(true);
    expect(f.ageSeconds).toBe(3 * 3600);
  });

  it('gives devnet a wider staleness tolerance', () => {
    const f = buildAnalyticsFreshness('devnet', 'hour', { bucketEnd: hoursAgo(3) }, NOW);
    expect(f.maxAgeSeconds).toBe(6 * 3600);
    expect(f.stale).toBe(false);
  });

  it('caps an in-progress bucket end at now', () => {
    const future = new Date(NOW.getTime() + 30 * 60_000);
    const f = buildAnalyticsFreshness('mainnet', 'hour', { bucketEnd: future }, NOW);
    expect(f.dataAsOf).toBe(NOW.toISOString());
    expect(f.ageSeconds).toBe(0);
  });

  it('marks an empty or malformed dataset as stale with null timestamps', () => {
    for (const latest of [undefined, null, { bucketEnd: new Date('invalid') }]) {
      const f = buildAnalyticsFreshness('mainnet', 'day', latest, NOW);
      expect(f).toMatchObject({ dataAsOf: null, ageSeconds: null, stale: true });
    }
  });
});

describe('GET /analytics/gas freshness', () => {
  beforeEach(() => vi.clearAllMocks());

  function makeApp(network?: string) {
    const app = express();
    if (network) {
      app.use((req, _res, next) => {
        (req as any).networkProfile = { name: network };
        next();
      });
    }
    app.use('/analytics', analyticsRouter);
    return app;
  }

  it('attaches freshness for the network resolved for the request', async () => {
    vi.mocked(db.prismaRead.gasAnalyticsSnapshot.findMany).mockResolvedValue([
      { bucket: 'day', bucketStart: hoursAgo(25), bucketEnd: hoursAgo(1) },
    ] as any);

    const res = await request(makeApp('mainnet')).get('/analytics/gas');
    expect(res.status).toBe(200);
    expect(res.body.freshness).toMatchObject({ network: 'mainnet', bucket: 'day' });
    expect(res.body.freshness.dataAsOf).toBe(hoursAgo(1).toISOString());
  });

  it('falls back to the configured network and reports empty datasets as stale', async () => {
    vi.mocked(db.prismaRead.gasAnalyticsSnapshot.findMany).mockResolvedValue([]);

    const res = await request(makeApp()).get('/analytics/gas?bucket=week');
    expect(res.status).toBe(200);
    expect(res.body.freshness).toMatchObject({
      network: 'testnet',
      bucket: 'week',
      dataAsOf: null,
      stale: true,
    });
  });
});
