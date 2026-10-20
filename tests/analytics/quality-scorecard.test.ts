import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/db', () => ({ prismaRead: {}, prismaWrite: {} }));
vi.mock('../../src/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/config', () => ({ config: { stellarNetwork: 'testnet' } }));
vi.mock('../../src/middleware/adminAuth', () => ({
  adminAuth: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

import {
  recordLineage,
  type EtlLineageRecord,
  type QualityCheckResult,
} from '../../src/analytics/data-quality/checks';
import { buildQualityScorecard, gradeFor } from '../../src/analytics/data-quality/scorecard';
import { publicDatasetsRouter } from '../../src/api/public-datasets';

function check(checkName: string, passed: boolean, severity: QualityCheckResult['severity'] = 'info') {
  return { checkName, passed, severity, message: '', details: {}, checkedAt: '2026-10-01T00:00:00Z' };
}

function job(jobId: string, extra: Partial<EtlLineageRecord> = {}): EtlLineageRecord {
  return {
    jobId,
    network: 'testnet',
    jobStartedAt: '2026-10-01T00:00:00Z',
    jobCompletedAt: '2026-10-01T00:15:00Z',
    sourceTables: ['transactions'],
    pgTxIdRange: { min: 1, max: 2 },
    lsnRange: { min: '0/1', max: '0/2' },
    outputFiles: [],
    rowsProduced: 100,
    rowsRejected: 0,
    qualityResults: [check('null_check:transactions', true), check('file_size_check', true)],
    status: 'success',
    ...extra,
  };
}

describe('data-quality scorecard (#1246)', () => {
  it('grades scores on fixed thresholds', () => {
    expect([95, 85, 75, 65, 10].map(gradeFor)).toEqual(['A', 'B', 'C', 'D', 'F']);
  });

  it('scores a clean table 100/A and tracks the latest run', () => {
    const card = buildQualityScorecard(
      [job('a'), job('b', { jobCompletedAt: '2026-10-02T00:00:00Z' })],
      'testnet',
      new Date('2026-10-03T00:00:00Z'),
    );
    expect(card).toMatchObject({
      network: 'testnet',
      generatedAt: '2026-10-03T00:00:00.000Z',
      jobsEvaluated: 2,
      overall: { score: 100, grade: 'A' },
    });
    expect(card.tables[0]).toMatchObject({
      table: 'transactions',
      checks: 4,
      passedChecks: 4,
      score: 100,
      grade: 'A',
      lastRunAt: '2026-10-02T00:00:00Z',
    });
  });

  it('isolates networks and counts unattributed legacy records', () => {
    const legacy = job('legacy');
    delete legacy.network;
    const records = [
      job('t1'),
      job('m1', { network: 'mainnet', qualityResults: [check('null_check:transactions', false, 'critical')] }),
      legacy,
    ];
    const testnet = buildQualityScorecard(records, 'testnet');
    const mainnet = buildQualityScorecard(records, 'mainnet');
    expect(testnet).toMatchObject({ jobsEvaluated: 1, unattributedJobs: 1, overall: { score: 100 } });
    expect(mainnet.tables[0]).toMatchObject({ failedCritical: 1, score: 0, grade: 'F' });
  });

  it('caps tables with critical failures and penalises rejects and failed jobs', () => {
    const card = buildQualityScorecard(
      [
        job('a', {
          rowsProduced: 90,
          rowsRejected: 10,
          qualityResults: [
            check('null_check:transactions', true),
            check('row_count_match:transactions', false, 'critical'),
            check('foreign_key_check:contract_id', false, 'warning'),
            check('file_size_check', true),
          ],
        }),
        job('b', { status: 'failed' }),
      ],
      'testnet',
    );
    const t = card.tables[0];
    // pass 4/6, reject 10/200, success 1/2 → 32, critical cap irrelevant
    expect(t).toMatchObject({ checks: 6, failedCritical: 1, failedWarning: 1, failedJobs: 1, score: 32, grade: 'F' });
    expect(t.failingChecks).toEqual(['row_count_match:transactions', 'foreign_key_check:contract_id']);

    const capped = buildQualityScorecard(
      [job('c', { qualityResults: [...Array(9)].map(() => check('x', true)).concat(check('y', false, 'critical')) })],
      'testnet',
    );
    expect(capped.tables[0].score).toBe(59);
  });

  it('attributes table-scoped checks only to their table', () => {
    const card = buildQualityScorecard(
      [
        job('a', {
          sourceTables: ['events', 'transactions'],
          qualityResults: [check('null_check:events', false, 'warning'), check('file_size_check', true)],
        }),
      ],
      'testnet',
    );
    expect(card.tables.map((t) => [t.table, t.checks, t.score])).toEqual([
      ['events', 2, 50],
      ['transactions', 1, 100],
    ]);
  });

  it('reports null scores when no checks were recorded', () => {
    const card = buildQualityScorecard([job('a', { qualityResults: [] })], 'testnet');
    expect(card.tables[0]).toMatchObject({ score: null, grade: null });
    expect(card.overall).toEqual({ score: null, grade: null });
    expect(buildQualityScorecard([], 'testnet').tables).toEqual([]);
  });

  describe('GET /datasets/quality-scorecard', () => {
    const app = express().use('/datasets', publicDatasetsRouter);

    it('defaults to the deployment network', async () => {
      recordLineage(job('route-a'));
      recordLineage(job('route-b', { network: 'mainnet' }));
      const res = await request(app).get('/datasets/quality-scorecard');
      expect(res.status).toBe(200);
      expect(res.body.network).toBe('testnet');
      expect(res.body.jobsEvaluated).toBe(1);

      const main = await request(app).get('/datasets/quality-scorecard?network=mainnet');
      expect(main.body).toMatchObject({ network: 'mainnet', jobsEvaluated: 1 });
    });

    it('rejects unknown networks and bad limits', async () => {
      expect((await request(app).get('/datasets/quality-scorecard?network=futurenet')).status).toBe(400);
      expect((await request(app).get('/datasets/quality-scorecard?limit=0')).status).toBe(400);
      expect((await request(app).get('/datasets/quality-scorecard?limit=501')).status).toBe(400);
    });
  });
});
