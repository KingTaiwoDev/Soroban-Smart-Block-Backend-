/**
 * CLI and CI check script for Sandbox Fuel Cost Calibration (#1297).
 *
 * Usage:
 *   npx ts-node --transpile-only scripts/sandbox/calibrate-fuel.ts
 *   npx ts-node --transpile-only scripts/sandbox/calibrate-fuel.ts --check --threshold 5.0
 */
import {
  calibrateCorpus,
  checkAcceptanceThreshold,
  validateCorpusIntegrity,
} from '../../src/sandbox/calibration';
import defaultCorpus from '../../src/sandbox/corpus/replay-corpus.json';
import type { ReplayCorpus } from '../../src/sandbox/calibration';

export function runCalibrationScript(args: string[] = process.argv): boolean {
  console.log('=== Soroban Sandbox Fuel Cost Calibration Report ===\n');

  const corpus = defaultCorpus as unknown as ReplayCorpus;

  // 1. Validate corpus integrity & privacy
  const integrity = validateCorpusIntegrity(corpus);
  if (!integrity.valid) {
    console.error('FATAL: Corpus integrity validation failed:');
    for (const err of integrity.errors) {
      console.error(`  - ${err}`);
    }
    return false;
  }
  console.log(`Corpus Version: ${corpus.version} (Schema v${corpus.schemaVersion})`);
  console.log(`Validated Protocol Versions: ${corpus.protocolVersionsValidated.join(', ')}`);
  console.log(`Integrity Check: PASSED (Provenance verified, zero secrets/PII)\n`);

  // Parse threshold argument
  let threshold = corpus.acceptanceThresholdPercent ?? 5.0;
  const thresholdIdx = args.indexOf('--threshold');
  if (thresholdIdx !== -1 && args[thresholdIdx + 1]) {
    const parsed = parseFloat(args[thresholdIdx + 1]);
    if (!isNaN(parsed)) {
      threshold = parsed;
    }
  }

  const isCheckMode = args.includes('--check');

  // 2. Run calibration
  const report = calibrateCorpus(corpus, undefined, threshold);

  // 3. Print breakdown table by operation class
  console.log('Operation Class Breakdown:');
  console.log('------------------------------------------------------------------------------------------------');
  console.log(
    `${'Operation Class'.padEnd(25)} | ${'Cases'.padEnd(6)} | ${'MAE'.padEnd(10)} | ${'MAPE (%)'.padEnd(10)} | ${'Max (%)'.padEnd(10)} | Status`
  );
  console.log('------------------------------------------------------------------------------------------------');

  for (const [opClass, summary] of Object.entries(report.classSummaries)) {
    const status = summary.passed ? '✓ PASS' : '✗ FAIL';
    console.log(
      `${opClass.padEnd(25)} | ${String(summary.caseCount).padEnd(6)} | ${String(summary.meanAbsoluteError).padEnd(10)} | ${(summary.meanAbsolutePercentageError + '%').padEnd(10)} | ${(summary.maxPercentageError + '%').padEnd(10)} | ${status}`
    );
  }
  console.log('------------------------------------------------------------------------------------------------\n');

  // 4. Print Overall Summary
  console.log('Overall Summary:');
  console.log(`  Total Transactions Evaluated: ${report.totalCases}`);
  console.log(`    - Successful Transactions:  ${report.categoryCounts.SUCCESS}`);
  console.log(`    - Failed Transactions:      ${report.categoryCounts.FAILED}`);
  console.log(`    - Resource-Intensive:       ${report.categoryCounts.RESOURCE_INTENSIVE}`);
  console.log(`  Overall Mean Absolute Percentage Error (MAPE): ${report.overallMAPE}%`);
  console.log(`  Max Percentage Error:                         ${report.maxPercentageError}%`);
  console.log(`  Documented Acceptance Threshold:               <= ${threshold}%`);

  const checkResult = checkAcceptanceThreshold(report, threshold);
  console.log(`\nResult: ${checkResult.passed ? '✓ ' + checkResult.message : '✗ ' + checkResult.message}`);

  if (isCheckMode && !checkResult.passed) {
    return false;
  }
  return true;
}

if (require.main === module) {
  const success = runCalibrationScript();
  process.exit(success ? 0 : 1);
}
