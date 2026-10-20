/**
 * Per-network data-quality scorecard (#1246).
 *
 * Aggregates the quality check results and row rejections recorded on ETL
 * lineage records (see `./checks.ts`) into one score per indexed table for a
 * single Stellar network. Lineage records without a `network` (written before
 * #1245) cannot be attributed and are only counted in `unattributedJobs`.
 *
 *   score = 100 × checkPassRate × (1 − rowRejectRate) × jobSuccessRate
 *
 * A table with any failed critical check is capped at 59 (grade F). Tables
 * with no recorded checks have `score: null` — absence of evidence is not
 * reported as quality.
 */

import type { EtlLineageRecord } from './checks';

export type QualityGrade = 'A' | 'B' | 'C' | 'D' | 'F';

export interface TableQualityScore {
  table: string;
  jobs: number;
  failedJobs: number;
  checks: number;
  passedChecks: number;
  failedCritical: number;
  failedWarning: number;
  rowsProduced: number;
  rowsRejected: number;
  score: number | null;
  grade: QualityGrade | null;
  /** Names of failed checks in the window (deduplicated, max 20). */
  failingChecks: string[];
  lastRunAt: string | null;
}

export interface QualityScorecard {
  network: string;
  generatedAt: string;
  jobsEvaluated: number;
  unattributedJobs: number;
  overall: { score: number | null; grade: QualityGrade | null };
  tables: TableQualityScore[];
}

const CRITICAL_CAP = 59;

export function gradeFor(score: number): QualityGrade {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

function emptyTable(table: string): TableQualityScore {
  return {
    table,
    jobs: 0,
    failedJobs: 0,
    checks: 0,
    passedChecks: 0,
    failedCritical: 0,
    failedWarning: 0,
    rowsProduced: 0,
    rowsRejected: 0,
    score: null,
    grade: null,
    failingChecks: [],
    lastRunAt: null,
  };
}

function scoreTable(t: TableQualityScore): void {
  if (t.checks === 0) return;
  const passRate = t.passedChecks / t.checks;
  const totalRows = t.rowsProduced + t.rowsRejected;
  const rejectRate = totalRows > 0 ? t.rowsRejected / totalRows : 0;
  const successRate = t.jobs > 0 ? (t.jobs - t.failedJobs) / t.jobs : 1;
  let score = Math.round(100 * passRate * (1 - rejectRate) * successRate);
  if (t.failedCritical > 0) score = Math.min(score, CRITICAL_CAP);
  t.score = score;
  t.grade = gradeFor(score);
}

export function buildQualityScorecard(
  records: EtlLineageRecord[],
  network: string,
  now: Date = new Date(),
): QualityScorecard {
  const tables = new Map<string, TableQualityScore>();
  let jobsEvaluated = 0;
  let unattributedJobs = 0;

  for (const rec of records) {
    if (!rec.network) {
      unattributedJobs++;
      continue;
    }
    if (rec.network !== network) continue;
    jobsEvaluated++;

    for (const table of new Set(rec.sourceTables)) {
      const t = tables.get(table) ?? emptyTable(table);
      tables.set(table, t);
      t.jobs++;
      if (rec.status === 'failed') t.failedJobs++;
      t.rowsProduced += rec.rowsProduced;
      t.rowsRejected += rec.rowsRejected;
      if (!t.lastRunAt || rec.jobCompletedAt > t.lastRunAt) t.lastRunAt = rec.jobCompletedAt;

      for (const q of rec.qualityResults) {
        // Table-scoped checks are named `<check>:<table>`; skip those for other tables.
        const [, scope] = q.checkName.split(':');
        if (scope && rec.sourceTables.includes(scope) && scope !== table) continue;
        t.checks++;
        if (q.passed) {
          t.passedChecks++;
          continue;
        }
        if (q.severity === 'critical') t.failedCritical++;
        else if (q.severity === 'warning') t.failedWarning++;
        if (!t.failingChecks.includes(q.checkName) && t.failingChecks.length < 20) {
          t.failingChecks.push(q.checkName);
        }
      }
    }
  }

  const scored = [...tables.values()].sort((a, b) => a.table.localeCompare(b.table));
  scored.forEach(scoreTable);
  const withScores = scored.filter((t) => t.score !== null).map((t) => t.score as number);
  const overallScore = withScores.length
    ? Math.round(withScores.reduce((s, v) => s + v, 0) / withScores.length)
    : null;

  return {
    network,
    generatedAt: now.toISOString(),
    jobsEvaluated,
    unattributedJobs,
    overall: { score: overallScore, grade: overallScore === null ? null : gradeFor(overallScore) },
    tables: scored,
  };
}
