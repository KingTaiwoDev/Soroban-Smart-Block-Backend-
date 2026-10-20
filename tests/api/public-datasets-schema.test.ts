import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../src/middleware/adminAuth', () => ({
  adminAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import {
  DATASETS,
  baseUrl,
  findSensitiveColumns,
  publicDatasetsRouter,
  resetPublicDatasets,
} from '../../src/api/public-datasets';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/datasets', publicDatasetsRouter);
  return app;
}

describe('public dataset schemas', () => {
  const originalBase = process.env.DATASET_PUBLIC_BASE_URL;

  beforeEach(() => resetPublicDatasets());
  afterEach(() => {
    if (originalBase === undefined) delete process.env.DATASET_PUBLIC_BASE_URL;
    else process.env.DATASET_PUBLIC_BASE_URL = originalBase;
  });

  it('documents every column with a description and sensitivity class', () => {
    for (const def of Object.values(DATASETS)) {
      for (const col of def.columns) {
        expect(col.description, `${def.id}.${col.name}`).toMatch(/\S/);
        expect(['public', 'pseudonymous']).toContain(col.sensitivity);
      }
    }
  });

  it('exposes no sensitive columns in the published schemas', () => {
    expect(findSensitiveColumns(DATASETS)).toEqual([]);
  });

  it('flags sensitive column names if they are ever added', () => {
    const col = (name: string) => ({
      name,
      type: 'string',
      description: 'x',
      sensitivity: 'public' as const,
    });
    const flagged = findSensitiveColumns({
      transactions: { columns: [col('hash'), col('memo'), col('envelope_xdr')] },
      accounts: { columns: [col('email'), col('api_key'), col('ip_address'), col('ledger')] },
    });
    expect(flagged).toEqual([
      'transactions.memo',
      'transactions.envelope_xdr',
      'accounts.email',
      'accounts.api_key',
      'accounts.ip_address',
    ]);
  });

  it('serves column descriptions and sensitivity in the catalog', async () => {
    const res = await request(makeApp()).get('/datasets/transactions');
    expect(res.status).toBe(200);
    expect(res.body.columns).toContainEqual(
      expect.objectContaining({ name: 'source_account', sensitivity: 'pseudonymous' }),
    );
  });

  it('strips credentials embedded in DATASET_PUBLIC_BASE_URL from manifest URLs', async () => {
    process.env.DATASET_PUBLIC_BASE_URL = 'https://user:s3cr3t@cdn.example.com/datasets/';
    expect(baseUrl()).toBe('https://cdn.example.com/datasets');

    const res = await request(makeApp())
      .post('/datasets/tokens/manifests')
      .send({
        ledgerRange: { from: 1, to: 2 },
        files: [
          {
            path: 'snapshot_date=2026-10-19/part-0.parquet',
            rows: 1,
            bytes: 10,
            sha256: 'a'.repeat(64),
          },
        ],
      });
    expect(res.status).toBe(201);
    expect(res.body.files[0].url).toBe(
      'https://cdn.example.com/datasets/tokens/snapshot_date=2026-10-19/part-0.parquet',
    );
    expect(JSON.stringify(res.body)).not.toContain('s3cr3t');
  });

  it('leaves relative and credential-free base URLs unchanged', () => {
    delete process.env.DATASET_PUBLIC_BASE_URL;
    expect(baseUrl()).toBe('/datasets');
    process.env.DATASET_PUBLIC_BASE_URL = 'https://cdn.example.com/a@b/';
    expect(baseUrl()).toBe('https://cdn.example.com/a@b');
  });
});
