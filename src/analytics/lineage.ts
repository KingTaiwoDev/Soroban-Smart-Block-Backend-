/**
 * Analytics lineage: source ledger → ETL job → Parquet files → published dataset (#1245).
 *
 * A published dataset manifest (`src/api/public-datasets.ts`) records the ledger
 * range it covers and the ETL job IDs that produced its files. Each ETL job's
 * lineage record (`src/analytics/data-quality/checks.ts`) records the CDC source
 * (tables, PostgreSQL tx-id and WAL LSN ranges) and the Iceberg data files it
 * wrote, each with its min/max ledger. Joining the two answers "which source
 * ledgers and CDC offsets does this published snapshot come from?" and flags
 * snapshots whose lineage is incomplete.
 */

import { getLineage, type EtlLineageRecord } from './data-quality/checks';

export interface LedgerRange {
  from: number;
  to: number;
}

/** Minimal view of a published manifest needed to resolve lineage. */
export interface LineageManifest {
  id: string;
  dataset: string;
  network: string;
  ledgerRange: LedgerRange;
  etlJobIds: string[];
  publishedAt: string;
}

export type LineageIssueCode = 'no_jobs' | 'job_not_found' | 'job_failed' | 'network_mismatch' | 'ledger_gap';

export interface LineageIssue {
  code: LineageIssueCode;
  jobId?: string;
  detail: string;
}

export interface LineageJobNode {
  jobId: string;
  status: EtlLineageRecord['status'];
  network: string | null;
  sourceTables: string[];
  pgTxIdRange: EtlLineageRecord['pgTxIdRange'];
  lsnRange: EtlLineageRecord['lsnRange'];
  /** Ledger range covered by the job's output files (null when it wrote none). */
  ledgerRange: LedgerRange | null;
  outputFiles: string[];
}

export interface DatasetLineage {
  manifestId: string;
  dataset: string;
  network: string;
  publishedAt: string;
  sourceLedgerRange: LedgerRange;
  jobs: LineageJobNode[];
  /** True when every job resolves, succeeded, matches the network and the jobs cover the ledger range. */
  complete: boolean;
  issues: LineageIssue[];
}

function jobLedgerRange(rec: EtlLineageRecord): LedgerRange | null {
  if (!rec.outputFiles.length) return null;
  return {
    from: Math.min(...rec.outputFiles.map((f) => f.minLedger)),
    to: Math.max(...rec.outputFiles.map((f) => f.maxLedger)),
  };
}

/** Sub-ranges of `target` not covered by any of `ranges` (inclusive integer ledgers). */
export function findLedgerGaps(target: LedgerRange, ranges: LedgerRange[]): LedgerRange[] {
  const sorted = [...ranges].sort((a, b) => a.from - b.from);
  const gaps: LedgerRange[] = [];
  let next = target.from;
  for (const r of sorted) {
    if (r.to < next) continue;
    if (r.from > target.to) break;
    if (r.from > next) gaps.push({ from: next, to: r.from - 1 });
    next = Math.max(next, r.to + 1);
    if (next > target.to) break;
  }
  if (next <= target.to) gaps.push({ from: next, to: target.to });
  return gaps;
}

export function buildDatasetLineage(
  manifest: LineageManifest,
  lookup: (jobId: string) => EtlLineageRecord | undefined = getLineage,
): DatasetLineage {
  const issues: LineageIssue[] = [];
  const jobs: LineageJobNode[] = [];

  if (!manifest.etlJobIds.length) {
    issues.push({ code: 'no_jobs', detail: 'Manifest was published without ETL job references' });
  }

  for (const jobId of manifest.etlJobIds) {
    const rec = lookup(jobId);
    if (!rec) {
      issues.push({ code: 'job_not_found', jobId, detail: `No lineage record for ETL job ${jobId}` });
      continue;
    }
    if (rec.status === 'failed') {
      issues.push({ code: 'job_failed', jobId, detail: `ETL job ${jobId} finished with status failed` });
    }
    if (rec.network && rec.network !== manifest.network) {
      issues.push({
        code: 'network_mismatch',
        jobId,
        detail: `ETL job ${jobId} ran on ${rec.network}, manifest is ${manifest.network}`,
      });
    }
    jobs.push({
      jobId,
      status: rec.status,
      network: rec.network ?? null,
      sourceTables: rec.sourceTables,
      pgTxIdRange: rec.pgTxIdRange,
      lsnRange: rec.lsnRange,
      ledgerRange: jobLedgerRange(rec),
      outputFiles: rec.outputFiles.map((f) => f.s3Key),
    });
  }

  if (manifest.etlJobIds.length) {
    const covered = jobs.map((j) => j.ledgerRange).filter((r): r is LedgerRange => r !== null);
    for (const gap of findLedgerGaps(manifest.ledgerRange, covered)) {
      issues.push({
        code: 'ledger_gap',
        detail: `Ledgers ${gap.from}-${gap.to} are not covered by any referenced ETL job`,
      });
    }
  }

  return {
    manifestId: manifest.id,
    dataset: manifest.dataset,
    network: manifest.network,
    publishedAt: manifest.publishedAt,
    sourceLedgerRange: manifest.ledgerRange,
    jobs,
    complete: issues.length === 0,
    issues,
  };
}
