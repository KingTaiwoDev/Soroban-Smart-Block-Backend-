/**
 * Sandbox Fuel Cost Calibration against Soroban Replay Corpus (#1297).
 *
 * Implements cost-table calibration, per-operation-class error reporting,
 * provenance validation, privacy verification, and acceptance threshold gating.
 */
import { DEFAULT_GAS_COST_TABLE, type GasCostTable, calculateGasUsed, type HostFunction } from './gas-model';
import defaultCorpus from './corpus/replay-corpus.json';

export interface CaseProvenance {
  network: 'mainnet' | 'testnet';
  ledgerSequence: number;
  txHash: string;
  source: string;
}

export interface ReplayCaseOps {
  cpuArith: number;
  cpuLogic: number;
  cpuControl: number;
  cpuDiv: number;
  cpuMul: number;
  cpuRem: number;
  memReadBytes: number;
  memWriteBytes: number;
  memGrowPages: number;
  hostCalls: Partial<Record<HostFunction, number>>;
}

export interface ReplayCorpusCase {
  id: string;
  category: 'SUCCESS' | 'FAILED' | 'RESOURCE_INTENSIVE';
  operationClass: string;
  provenance: CaseProvenance;
  ops: ReplayCaseOps;
  authoritative: {
    totalGas: number;
    cpuGas: number;
    memGas: number;
    outcome: 'success' | 'failed';
  };
}

export interface ReplayCorpus {
  version: string;
  schemaVersion: number;
  description: string;
  lastUpdated: string;
  protocolVersionsValidated: number[];
  acceptanceThresholdPercent: number;
  cases: ReplayCorpusCase[];
}

export interface CaseCalibrationResult {
  id: string;
  category: 'SUCCESS' | 'FAILED' | 'RESOURCE_INTENSIVE';
  operationClass: string;
  provenance: CaseProvenance;
  measured: {
    cpu: number;
    mem: number;
    total: number;
  };
  authoritative: {
    cpu: number;
    mem: number;
    total: number;
    outcome: string;
  };
  absoluteError: number;
  percentageError: number;
}

export interface ClassErrorSummary {
  operationClass: string;
  caseCount: number;
  meanAbsoluteError: number;
  meanAbsolutePercentageError: number;
  maxPercentageError: number;
  passed: boolean;
}

export interface CalibrationReport {
  corpusVersion: string;
  generatedAt: string;
  totalCases: number;
  categoryCounts: {
    SUCCESS: number;
    FAILED: number;
    RESOURCE_INTENSIVE: number;
  };
  overallMAPE: number;
  maxPercentageError: number;
  acceptanceThresholdPercent: number;
  passedThreshold: boolean;
  classSummaries: Record<string, ClassErrorSummary>;
  cases: CaseCalibrationResult[];
}

/** Evaluates a single replay corpus case using the given gas cost table. */
export function evaluateCase(
  caseEntry: ReplayCorpusCase,
  costTable: GasCostTable = DEFAULT_GAS_COST_TABLE
): CaseCalibrationResult {
  const fullHostCalls: Record<HostFunction, number> = {} as Record<HostFunction, number>;
  for (const fn of Object.keys(costTable.host) as HostFunction[]) {
    fullHostCalls[fn] = caseEntry.ops.hostCalls[fn] ?? 0;
  }

  // Calculate measured gas
  let measuredCpu = 0;
  measuredCpu += (caseEntry.ops.cpuArith ?? 0) * costTable.cpu.arith;
  measuredCpu += (caseEntry.ops.cpuLogic ?? 0) * costTable.cpu.logic;
  measuredCpu += (caseEntry.ops.cpuControl ?? 0) * costTable.cpu.control;
  measuredCpu += (caseEntry.ops.cpuDiv ?? 0) * costTable.cpu.div;
  measuredCpu += (caseEntry.ops.cpuMul ?? 0) * costTable.cpu.mul;
  measuredCpu += (caseEntry.ops.cpuRem ?? 0) * costTable.cpu.rem;

  let measuredMem = 0;
  measuredMem += (caseEntry.ops.memReadBytes ?? 0) * costTable.memory.read_per_byte;
  measuredMem += (caseEntry.ops.memWriteBytes ?? 0) * costTable.memory.write_per_byte;
  measuredMem += (caseEntry.ops.memGrowPages ?? 0) * costTable.memory.grow_per_page;

  for (const [fn, count] of Object.entries(caseEntry.ops.hostCalls)) {
    if (count && count > 0 && costTable.host[fn as HostFunction]) {
      measuredCpu += count * costTable.host[fn as HostFunction];
    }
  }

  const measuredTotal = measuredCpu + measuredMem;
  const authoritativeTotal = caseEntry.authoritative.totalGas;
  const absoluteError = Math.abs(measuredTotal - authoritativeTotal);
  const percentageError = authoritativeTotal > 0 ? (absoluteError / authoritativeTotal) * 100 : 0;

  return {
    id: caseEntry.id,
    category: caseEntry.category,
    operationClass: caseEntry.operationClass,
    provenance: caseEntry.provenance,
    measured: {
      cpu: measuredCpu,
      mem: measuredMem,
      total: measuredTotal,
    },
    authoritative: {
      cpu: caseEntry.authoritative.cpuGas,
      mem: caseEntry.authoritative.memGas,
      total: authoritativeTotal,
      outcome: caseEntry.authoritative.outcome,
    },
    absoluteError,
    percentageError: Number(percentageError.toFixed(3)),
  };
}

/** Calibrates sandbox fuel costs across all transactions in the replay corpus. */
export function calibrateCorpus(
  corpus: ReplayCorpus = defaultCorpus as unknown as ReplayCorpus,
  costTable: GasCostTable = DEFAULT_GAS_COST_TABLE,
  thresholdOverride?: number
): CalibrationReport {
  const threshold = thresholdOverride ?? corpus.acceptanceThresholdPercent ?? 5.0;
  const evaluatedCases = corpus.cases.map((c) => evaluateCase(c, costTable));

  // Category counts
  const categoryCounts = {
    SUCCESS: 0,
    FAILED: 0,
    RESOURCE_INTENSIVE: 0,
  };
  for (const c of evaluatedCases) {
    if (categoryCounts[c.category] !== undefined) {
      categoryCounts[c.category]++;
    }
  }

  // Group by operation class
  const classGroups = new Map<string, CaseCalibrationResult[]>();
  for (const c of evaluatedCases) {
    const list = classGroups.get(c.operationClass) ?? [];
    list.push(c);
    classGroups.set(c.operationClass, list);
  }

  const classSummaries: Record<string, ClassErrorSummary> = {};
  for (const [opClass, cases] of classGroups.entries()) {
    const totalAbsError = cases.reduce((acc, c) => acc + c.absoluteError, 0);
    const totalPctError = cases.reduce((acc, c) => acc + c.percentageError, 0);
    const maxPctError = Math.max(...cases.map((c) => c.percentageError));
    const mape = totalPctError / cases.length;

    classSummaries[opClass] = {
      operationClass: opClass,
      caseCount: cases.length,
      meanAbsoluteError: Number((totalAbsError / cases.length).toFixed(2)),
      meanAbsolutePercentageError: Number(mape.toFixed(3)),
      maxPercentageError: Number(maxPctError.toFixed(3)),
      passed: mape <= threshold,
    };
  }

  const overallMAPE = Number(
    (evaluatedCases.reduce((acc, c) => acc + c.percentageError, 0) / evaluatedCases.length).toFixed(3)
  );
  const maxPercentageError = Number(
    Math.max(...evaluatedCases.map((c) => c.percentageError)).toFixed(3)
  );

  return {
    corpusVersion: corpus.version,
    generatedAt: new Date().toISOString(),
    totalCases: evaluatedCases.length,
    categoryCounts,
    overallMAPE,
    maxPercentageError,
    acceptanceThresholdPercent: threshold,
    passedThreshold: overallMAPE <= threshold,
    classSummaries,
    cases: evaluatedCases,
  };
}

/** Checks whether a calibration report satisfies the documented acceptance threshold. */
export function checkAcceptanceThreshold(
  report: CalibrationReport,
  thresholdPercent: number = report.acceptanceThresholdPercent
): { passed: boolean; message: string } {
  if (report.overallMAPE <= thresholdPercent) {
    return {
      passed: true,
      message: `Acceptance threshold passed: Overall MAPE is ${report.overallMAPE}% (Threshold: <= ${thresholdPercent}%) across ${report.totalCases} transactions.`,
    };
  }
  return {
    passed: false,
    message: `Acceptance threshold breached: Overall MAPE is ${report.overallMAPE}% which exceeds the maximum allowed threshold of ${thresholdPercent}%.`,
  };
}

/** Validates the integrity, provenance, and privacy (no secrets/PII) of a corpus. */
export function validateCorpusIntegrity(corpus: ReplayCorpus): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!corpus.version || typeof corpus.version !== 'string') {
    errors.push('Corpus must define a semver version string');
  }

  if (!Array.isArray(corpus.cases) || corpus.cases.length === 0) {
    errors.push('Corpus must contain a non-empty array of cases');
    return { valid: false, errors };
  }

  const hasSuccess = corpus.cases.some((c) => c.category === 'SUCCESS');
  const hasFailed = corpus.cases.some((c) => c.category === 'FAILED');
  const hasResource = corpus.cases.some((c) => c.category === 'RESOURCE_INTENSIVE');

  if (!hasSuccess) errors.push('Corpus must contain representative SUCCESS transactions');
  if (!hasFailed) errors.push('Corpus must contain representative FAILED transactions');
  if (!hasResource) errors.push('Corpus must contain representative RESOURCE_INTENSIVE transactions');

  // Secret / privacy detection regexes:
  // Stellar secret seed: S[0-9A-Z]{55}
  const stellarSecretRegex = /S[A-Z0-9]{55}/;
  // Private key hex strings (e.g. 64-char private key in plaintext labels)
  const privateKeyPattern = /private[_-]?key/i;
  // Email pattern
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;

  const rawCorpusString = JSON.stringify(corpus);
  if (stellarSecretRegex.test(rawCorpusString)) {
    errors.push('Corpus contains un-sanitized Stellar secret seed (S...)');
  }
  if (emailRegex.test(rawCorpusString)) {
    errors.push('Corpus contains user email address / private data');
  }

  const ids = new Set<string>();
  for (const c of corpus.cases) {
    if (ids.has(c.id)) {
      errors.push(`Duplicate case ID found: ${c.id}`);
    }
    ids.add(c.id);

    if (!c.provenance || !c.provenance.network || !c.provenance.source || !c.provenance.txHash) {
      errors.push(`Case '${c.id}' is missing required provenance fields (network, source, txHash)`);
    }

    if (!c.operationClass) {
      errors.push(`Case '${c.id}' is missing operationClass classification`);
    }

    if (privateKeyPattern.test(JSON.stringify(c.ops))) {
      errors.push(`Case '${c.id}' appears to contain private key data in operation payload`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
