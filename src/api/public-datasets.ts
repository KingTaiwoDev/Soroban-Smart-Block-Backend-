/**
 * Public dataset & bulk-download exports (ECO02 / #1013).
 *
 * Public:
 *   GET  /api/v1/datasets                              — catalog with schema + freshness
 *   GET  /api/v1/datasets/quality-scorecard            — per-network data-quality scorecard (#1246)
 *   GET  /api/v1/datasets/:dataset                     — dataset detail
 *   GET  /api/v1/datasets/:dataset/manifests           — published snapshots (newest first)
 *   GET  /api/v1/datasets/:dataset/manifests/latest    — latest snapshot manifest
 *   GET  /api/v1/datasets/:dataset/manifests/:id/lineage — source ledgers / ETL jobs behind a snapshot (#1245)
 * Admin:
 *   POST /api/v1/datasets/:dataset/manifests           — publish a generated snapshot manifest
 *
 * Files are served from DATASET_PUBLIC_BASE_URL (S3/HTTP). Generation is rate-aware: a dataset
 * cannot be republished more often than its `minIntervalMinutes`.
 *
 * Column schemas and their sensitivity review are documented in docs/public-datasets.md.
 */
import { Router, Request, Response } from 'express';
import { createHash } from 'crypto';
import { z } from 'zod';
import { adminAuth } from '../middleware/adminAuth';
import { config } from '../config';
import { buildDatasetLineage } from '../analytics/lineage';
import { listLineage } from '../analytics/data-quality/checks';
import { buildQualityScorecard } from '../analytics/data-quality/scorecard';
import { allProfiles } from '../profiles';

export type DatasetId = 'transactions' | 'events' | 'contracts' | 'tokens';
export type DatasetFormat = 'parquet' | 'csv';

/**
 * - `public`: on-chain value with no link to an account holder.
 * - `pseudonymous`: public on-chain identifier (account / contract address) that
 *   could be correlated with a person off-chain.  Already public on the ledger.
 */
export type ColumnSensitivity = 'public' | 'pseudonymous';

export interface DatasetColumn {
  name: string;
  type: string;
  description: string;
  sensitivity: ColumnSensitivity;
}

interface DatasetDefinition {
  id: DatasetId;
  description: string;
  cadence: 'hourly' | 'daily';
  minIntervalMinutes: number;
  partitionBy: string;
  columns: DatasetColumn[];
}

/**
 * Column names that must never appear in a public dataset (secrets, off-chain
 * PII, request metadata, raw signatures).  Checked at module load so a schema
 * change that adds one fails fast.
 */
export const SENSITIVE_COLUMN_PATTERN =
  /(password|secret|private|seed|api_?key|auth|session|cookie|email|phone|ip_?addr|^ip$|user_?agent|signature|envelope_xdr|memo)/i;

export function findSensitiveColumns(
  datasets: Record<string, Pick<DatasetDefinition, 'columns'>>,
): string[] {
  return Object.entries(datasets).flatMap(([id, def]) =>
    def.columns.filter((c) => SENSITIVE_COLUMN_PATTERN.test(c.name)).map((c) => `${id}.${c.name}`),
  );
}

export interface DatasetFile {
  path: string;
  format: DatasetFormat;
  rows: number;
  bytes: number;
  sha256: string;
  url: string;
}

export interface DatasetManifest {
  id: string;
  dataset: DatasetId;
  /** Network the snapshot was indexed from (the deployment's network profile). */
  network: string;
  schemaVersion: number;
  ledgerRange: { from: number; to: number };
  files: DatasetFile[];
  /** ETL jobs (see `EtlLineageRecord`) that produced the files — lineage from source ledgers. */
  etlJobIds: string[];
  totalRows: number;
  totalBytes: number;
  publishedAt: string;
}

const HOUR = 60;
const CADENCE_MINUTES = { hourly: HOUR, daily: 24 * HOUR };

export const DATASETS: Record<DatasetId, DatasetDefinition> = {
  transactions: {
    id: 'transactions',
    description: 'All Soroban transactions with fees, status and invoked contract',
    cadence: 'hourly',
    minIntervalMinutes: 30,
    partitionBy: 'ledger_date',
    columns: [
      {
        name: 'hash',
        type: 'string',
        description: 'Transaction hash (hex)',
        sensitivity: 'public',
      },
      { name: 'ledger', type: 'int64', description: 'Ledger sequence', sensitivity: 'public' },
      {
        name: 'ledger_date',
        type: 'date',
        description: 'UTC ledger close date',
        sensitivity: 'public',
      },
      {
        name: 'source_account',
        type: 'string',
        description: 'Source account (G… strkey)',
        sensitivity: 'pseudonymous',
      },
      {
        name: 'contract_id',
        type: 'string',
        description: 'Invoked contract (C… strkey), null if none',
        sensitivity: 'public',
      },
      {
        name: 'fee_charged',
        type: 'int64',
        description: 'Fee charged in stroops',
        sensitivity: 'public',
      },
      {
        name: 'successful',
        type: 'bool',
        description: 'Transaction succeeded',
        sensitivity: 'public',
      },
    ],
  },
  events: {
    id: 'events',
    description: 'Decoded contract events',
    cadence: 'hourly',
    minIntervalMinutes: 30,
    partitionBy: 'ledger_date',
    columns: [
      { name: 'id', type: 'string', description: 'Event id', sensitivity: 'public' },
      { name: 'ledger', type: 'int64', description: 'Ledger sequence', sensitivity: 'public' },
      {
        name: 'ledger_date',
        type: 'date',
        description: 'UTC ledger close date',
        sensitivity: 'public',
      },
      {
        name: 'contract_id',
        type: 'string',
        description: 'Emitting contract (C… strkey)',
        sensitivity: 'public',
      },
      { name: 'topic', type: 'string', description: 'Decoded event topics', sensitivity: 'public' },
      {
        name: 'data_json',
        type: 'string',
        description: 'Decoded event payload as JSON; may contain account addresses',
        sensitivity: 'pseudonymous',
      },
    ],
  },
  contracts: {
    id: 'contracts',
    description: 'Deployed contracts with wasm hash and deployer',
    cadence: 'daily',
    minIntervalMinutes: 6 * HOUR,
    partitionBy: 'deployed_date',
    columns: [
      {
        name: 'contract_id',
        type: 'string',
        description: 'Contract address (C… strkey)',
        sensitivity: 'public',
      },
      {
        name: 'wasm_hash',
        type: 'string',
        description: 'Installed WASM hash (hex)',
        sensitivity: 'public',
      },
      {
        name: 'deployer',
        type: 'string',
        description: 'Deploying account (G… strkey)',
        sensitivity: 'pseudonymous',
      },
      {
        name: 'deployed_ledger',
        type: 'int64',
        description: 'Deployment ledger',
        sensitivity: 'public',
      },
      {
        name: 'deployed_date',
        type: 'date',
        description: 'UTC deployment date',
        sensitivity: 'public',
      },
    ],
  },
  tokens: {
    id: 'tokens',
    description: 'Token contracts (SEP-41 / SAC) with metadata and supply',
    cadence: 'daily',
    minIntervalMinutes: 6 * HOUR,
    partitionBy: 'snapshot_date',
    columns: [
      {
        name: 'contract_id',
        type: 'string',
        description: 'Token contract address (C… strkey)',
        sensitivity: 'public',
      },
      { name: 'symbol', type: 'string', description: 'Token symbol', sensitivity: 'public' },
      { name: 'decimals', type: 'int32', description: 'Token decimals', sensitivity: 'public' },
      {
        name: 'total_supply',
        type: 'decimal(38,0)',
        description: 'Total supply in base units',
        sensitivity: 'public',
      },
      {
        name: 'snapshot_date',
        type: 'date',
        description: 'UTC snapshot date',
        sensitivity: 'public',
      },
    ],
  },
};

const sensitive = findSensitiveColumns(DATASETS);
if (sensitive.length > 0) {
  throw new Error(`Public dataset schema exposes sensitive columns: ${sensitive.join(', ')}`);
}

const SCHEMA_VERSION = 1;
const MAX_MANIFESTS_PER_DATASET = 500;
const manifests = new Map<DatasetId, DatasetManifest[]>();

/** Test helper — clears published manifests. */
export function resetPublicDatasets(): void {
  manifests.clear();
}

const FileSchema = z.object({
  path: z
    .string()
    .max(256)
    .regex(/^[A-Za-z0-9_\-=/.]+\.(parquet|csv|csv\.gz)$/, 'Invalid file path')
    .refine((p) => !p.includes('..') && !p.startsWith('/'), 'Invalid file path'),
  rows: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

const PublishSchema = z
  .object({
    ledgerRange: z.object({
      from: z.number().int().nonnegative(),
      to: z.number().int().nonnegative(),
    }),
    files: z.array(FileSchema).min(1).max(1_000),
    etlJobIds: z
      .array(z.string().regex(/^[A-Za-z0-9_\-:.]{1,128}$/, 'Invalid ETL job id'))
      .max(100)
      .optional(),
  })
  .refine((b) => b.ledgerRange.to >= b.ledgerRange.from, 'ledgerRange.to must be >= from');

/**
 * Public download base URL.  Any `user:pass@` credentials embedded in
 * DATASET_PUBLIC_BASE_URL are stripped so they are never echoed in manifests.
 */
export function baseUrl(): string {
  const raw = (process.env.DATASET_PUBLIC_BASE_URL ?? '/datasets').replace(/\/+$/, '');
  return raw.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, '$1');
}

function freshness(def: DatasetDefinition) {
  const latest = manifests.get(def.id)?.[0];
  const expectedMinutes = CADENCE_MINUTES[def.cadence];
  if (!latest) return { lastPublishedAt: null, ageMinutes: null, expectedMinutes, stale: true };
  const ageMinutes = Math.floor((Date.now() - Date.parse(latest.publishedAt)) / 60_000);
  // Stale once a full cadence period has been missed.
  return {
    lastPublishedAt: latest.publishedAt,
    ageMinutes,
    expectedMinutes,
    stale: ageMinutes > expectedMinutes * 2,
  };
}

function describe(def: DatasetDefinition) {
  return {
    ...def,
    schemaVersion: SCHEMA_VERSION,
    formats: ['parquet', 'csv'] as DatasetFormat[],
    freshness: freshness(def),
  };
}

function getDataset(req: Request, res: Response): DatasetDefinition | undefined {
  const def = Object.prototype.hasOwnProperty.call(DATASETS, req.params.dataset)
    ? DATASETS[req.params.dataset as DatasetId]
    : undefined;
  if (!def) res.status(404).json({ error: 'Dataset not found' });
  return def;
}

export const publicDatasetsRouter = Router();

publicDatasetsRouter.get('/', (_req: Request, res: Response) => {
  res.json({ data: Object.values(DATASETS).map(describe) });
});

publicDatasetsRouter.get('/quality-scorecard', (req: Request, res: Response) => {
  const network = req.query.network === undefined ? config.stellarNetwork : String(req.query.network);
  if (!Object.prototype.hasOwnProperty.call(allProfiles, network)) {
    res.status(400).json({ error: `Unknown network. Valid values: ${Object.keys(allProfiles).join(', ')}` });
    return;
  }
  const limit = req.query.limit === undefined ? 100 : Number(req.query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    res.status(400).json({ error: 'limit must be an integer between 1 and 500' });
    return;
  }
  res.json(buildQualityScorecard(listLineage(limit), network));
});

publicDatasetsRouter.get('/:dataset', (req: Request, res: Response) => {
  const def = getDataset(req, res);
  if (def) res.json(describe(def));
});

publicDatasetsRouter.get('/:dataset/manifests', (req: Request, res: Response) => {
  const def = getDataset(req, res);
  if (!def) return;
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
  const list = manifests.get(def.id) ?? [];
  res.json({ data: list.slice(0, limit), total: list.length });
});

publicDatasetsRouter.get('/:dataset/manifests/latest', (req: Request, res: Response) => {
  const def = getDataset(req, res);
  if (!def) return;
  const latest = manifests.get(def.id)?.[0];
  if (!latest) {
    res.status(404).json({ error: 'No snapshot published yet' });
    return;
  }
  res.json(latest);
});

publicDatasetsRouter.get('/:dataset/manifests/:id/lineage', (req: Request, res: Response) => {
  const def = getDataset(req, res);
  if (!def) return;
  const manifest = manifests.get(def.id)?.find((m) => m.id === req.params.id);
  if (!manifest) {
    res.status(404).json({ error: 'Manifest not found' });
    return;
  }
  res.json(buildDatasetLineage(manifest));
});

publicDatasetsRouter.post('/:dataset/manifests', adminAuth, (req: Request, res: Response) => {
  const def = getDataset(req, res);
  if (!def) return;
  const parsed = PublishSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid manifest', details: parsed.error.flatten() });
    return;
  }
  const list = manifests.get(def.id) ?? [];
  const last = list[0];
  if (last) {
    const elapsedMin = (Date.now() - Date.parse(last.publishedAt)) / 60_000;
    if (elapsedMin < def.minIntervalMinutes) {
      const retryAfter = Math.ceil((def.minIntervalMinutes - elapsedMin) * 60);
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({ error: 'Dataset was published too recently', retryAfter });
      return;
    }
  }
  const files: DatasetFile[] = parsed.data.files.map((f) => ({
    path: f.path,
    format: f.path.endsWith('.parquet') ? 'parquet' : 'csv',
    rows: f.rows,
    bytes: f.bytes,
    sha256: f.sha256,
    url: `${baseUrl()}/${def.id}/${f.path}`,
  }));
  const publishedAt = new Date().toISOString();
  const manifest: DatasetManifest = {
    id: createHash('sha256')
      .update(`${def.id}:${publishedAt}:${files.map((f) => f.sha256).join(',')}`)
      .digest('hex')
      .slice(0, 16),
    dataset: def.id,
    network: config.stellarNetwork,
    schemaVersion: SCHEMA_VERSION,
    ledgerRange: {
      from: parsed.data.ledgerRange.from,
      to: parsed.data.ledgerRange.to,
    },
    files,
    etlJobIds: [...new Set(parsed.data.etlJobIds ?? [])],
    totalRows: files.reduce((s, f) => s + f.rows, 0),
    totalBytes: files.reduce((s, f) => s + f.bytes, 0),
    publishedAt,
  };
  list.unshift(manifest);
  manifests.set(def.id, list.slice(0, MAX_MANIFESTS_PER_DATASET));
  res.status(201).json(manifest);
});
