import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/db', () => ({ prismaRead: {}, prismaWrite: {} }));
vi.mock('../../src/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/config', () => ({ config: { stellarNetwork: 'testnet' } }));
vi.mock('../../src/middleware/adminAuth', () => ({
  adminAuth: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

import { recordLineage, type EtlLineageRecord } from '../../src/analytics/data-quality/checks';
import { buildDatasetLineage, findLedgerGaps, type LineageManifest } from '../../src/analytics/lineage';
import { publicDatasetsRouter, resetPublicDatasets } from '../../src/api/public-datasets';

const SHA = 'a'.repeat(64);

function job(jobId: string, ledgers: Array<[number, number]>, extra: Partial<EtlLineageRecord> = {}) {
  const rec: EtlLineageRecord = {
    jobId,
    network: 'testnet',
    jobStartedAt: '2026-10-01T00:00:00Z',
    jobCompletedAt: '2026-10-01T00:15:00Z',
    sourceTables: ['transactions'],
    pgTxIdRange: { min: 100, max: 200 },
    lsnRange: { min: '0/16B3740', max: '0/16B9000' },
    outputFiles: ledgers.map(([min, max], i) => ({
      s3Key: `iceberg/transactions/network_id=testnet/month=2026-10/data/${jobId}-${i}.parquet`,
      partition: 'network_id=testnet/month=2026-10',
      tableName: 'transactions',
      rowCount: 10,
      fileSizeBytes: 1024,
      minLedger: min,
      maxLedger: max,
      format: 'PARQUET',
    })),
    rowsProduced: 10 * ledgers.length,
    rowsRejected: 0,
    qualityResults: [],
    status: 'success',
    ...extra,
  };
  return rec;
}

function manifest(etlJobIds: string[], from = 1000, to = 1999): LineageManifest {
  return {
    id: 'm1',
    dataset: 'transactions',
    network: 'testnet',
    ledgerRange: { from, to },
    etlJobIds,
    publishedAt: '2026-10-01T01:00:00Z',
  };
}

function lookupFrom(...recs: EtlLineageRecord[]) {
  const byId = new Map(recs.map((r) => [r.jobId, r]));
  return (id: string) => byId.get(id);
}

describe('analytics lineage (#1245)', () => {
  describe('findLedgerGaps', () => {
    it('returns no gaps when ranges cover the target, including overlaps', () => {
      expect(findLedgerGaps({ from: 10, to: 30 }, [{ from: 15, to: 30 }, { from: 5, to: 20 }])).toEqual([]);
    });

    it('reports leading, inner and trailing gaps', () => {
      expect(findLedgerGaps({ from: 1, to: 20 }, [{ from: 3, to: 5 }, { from: 10, to: 12 }])).toEqual([
        { from: 1, to: 2 },
        { from: 6, to: 9 },
        { from: 13, to: 20 },
      ]);
    });
  });

  describe('buildDatasetLineage', () => {
    it('traces a manifest back to source ledgers, CDC offsets and files', () => {
      const lineage = buildDatasetLineage(
        manifest(['job-a', 'job-b']),
        lookupFrom(job('job-a', [[1000, 1499]]), job('job-b', [[1500, 1800], [1801, 1999]])),
      );
      expect(lineage.complete).toBe(true);
      expect(lineage.issues).toEqual([]);
      expect(lineage.network).toBe('testnet');
      expect(lineage.jobs[1]).toMatchObject({
        jobId: 'job-b',
        ledgerRange: { from: 1500, to: 1999 },
        lsnRange: { min: '0/16B3740', max: '0/16B9000' },
        sourceTables: ['transactions'],
      });
      expect(lineage.jobs[1].outputFiles).toHaveLength(2);
    });

    it('flags manifests published without job references', () => {
      const lineage = buildDatasetLineage(manifest([]), lookupFrom());
      expect(lineage.complete).toBe(false);
      expect(lineage.issues.map((i) => i.code)).toEqual(['no_jobs']);
    });

    it('flags unknown jobs and the ledger gap they leave', () => {
      const lineage = buildDatasetLineage(
        manifest(['job-a', 'missing']),
        lookupFrom(job('job-a', [[1000, 1499]])),
      );
      expect(lineage.issues).toEqual([
        { code: 'job_not_found', jobId: 'missing', detail: expect.any(String) },
        { code: 'ledger_gap', detail: 'Ledgers 1500-1999 are not covered by any referenced ETL job' },
      ]);
    });

    it('flags failed jobs and jobs from another network', () => {
      const lineage = buildDatasetLineage(
        manifest(['job-a', 'job-b']),
        lookupFrom(
          job('job-a', [[1000, 1499]], { status: 'failed' }),
          job('job-b', [[1500, 1999]], { network: 'mainnet' }),
        ),
      );
      expect(lineage.complete).toBe(false);
      expect(lineage.issues.map((i) => [i.code, i.jobId])).toEqual([
        ['job_failed', 'job-a'],
        ['network_mismatch', 'job-b'],
      ]);
    });

    it('accepts legacy lineage records without a network', () => {
      const legacy = job('job-a', [[1000, 1999]]);
      delete legacy.network;
      const lineage = buildDatasetLineage(manifest(['job-a']), lookupFrom(legacy));
      expect(lineage.complete).toBe(true);
      expect(lineage.jobs[0].network).toBeNull();
    });
  });

  describe('GET /datasets/:dataset/manifests/:id/lineage', () => {
    const app = express().use(express.json()).use('/datasets', publicDatasetsRouter);

    beforeEach(() => resetPublicDatasets());

    it('publishes a manifest with network + job ids and resolves its lineage', async () => {
      recordLineage(job('route-job-1', [[10, 20]]));
      const pub = await request(app)
        .post('/datasets/transactions/manifests')
        .send({
          ledgerRange: { from: 10, to: 20 },
          files: [{ path: 'ledger_date=2026-10-01/part-0.parquet', rows: 10, bytes: 100, sha256: SHA }],
          etlJobIds: ['route-job-1', 'route-job-1'],
        });
      expect(pub.status).toBe(201);
      expect(pub.body).toMatchObject({ network: 'testnet', etlJobIds: ['route-job-1'] });

      const res = await request(app).get(`/datasets/transactions/manifests/${pub.body.id}/lineage`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ complete: true, sourceLedgerRange: { from: 10, to: 20 } });
      expect(res.body.jobs[0].jobId).toBe('route-job-1');
    });

    it('returns 404 for an unknown manifest', async () => {
      const res = await request(app).get('/datasets/transactions/manifests/nope/lineage');
      expect(res.status).toBe(404);
    });

    it('rejects malformed ETL job ids', async () => {
      const res = await request(app)
        .post('/datasets/transactions/manifests')
        .send({
          ledgerRange: { from: 1, to: 2 },
          files: [{ path: 'a.parquet', rows: 1, bytes: 1, sha256: SHA }],
          etlJobIds: ['../../etc/passwd'],
        });
      expect(res.status).toBe(400);
    });
  });
});
