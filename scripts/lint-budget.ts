/**
 * ESLint warning budget — ratchet enforcement, fixes #920.
 *
 * The repo's `lint` script used to run `eslint ... --max-warnings 1750`, which
 * meant CI silently tolerated up to 1,750 warnings. With that much headroom a
 * genuinely new warning was indistinguishable from the existing debt and there
 * was no pressure to pay the pile down. This script replaces the flat
 * `--max-warnings` cap with a *ratchet*, mirroring `scripts/typecheck-budget.ts`
 * and the `--max-orphans` pattern in scripts/validate-routes.ts:
 *
 *   1. It counts the *blocking* warnings (everything except the tracked-but-
 *      non-blocking "noise" rules, see below) and fails CI only when that
 *      count exceeds a checked-in budget. So a new warning — any new warning —
 *      pushes the count above budget and fails the build, while the large
 *      pre-existing backlog is paid down incrementally rather than in one PR.
 *   2. It records and prints a warning-count *trend* so a PR that burns down
 *      warnings (or lets them climb back) is visible in the CI log.
 *   3. Tracked non-blocking warnings and existing errors have per-file,
 *      per-rule baselines. Any increase fails, even if a decrease elsewhere
 *      would keep the aggregate count flat. Selected legacy source files use
 *      warning-level exceptions for any/non-null assertions until those
 *      exceptions are removed.
 *
 * Usage:
 *   npx ts-node scripts/lint-budget.ts                    # blocking budget 0
 *   npx ts-node scripts/lint-budget.ts --max-warnings 196
 *   npm run lint:budget                                   # enforce budget
 *   npm run lint:budget:ci                                # CI budget
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const LINT_TARGETS = ['src/**/*.ts', 'tests/**/*.ts'];

/**
 * Rules that become a trending-but-non-blocking warnings pass.
 *
 * NOTE: `@typescript-eslint/no-explicit-any` was previously listed here as
 * non-blocking debt (#920). It has been removed: all 288 `as any` casts in
 * src/ were eliminated in #1115 and the rule was promoted from "warn" to
 * "error" in .eslintrc.json. Any new `as any` now causes a hard ESLint error
 * (severity 2) and fails CI without relying on the budget ratchet at all.
 *
 * `error-handling/no-phantom-prisma-field` remains non-blocking because the
 * custom plugin flags generated Prisma model names that are not yet visible
 * at lint time — those are schema-awareness false positives, not real bugs.
 */
const NON_BLOCKING_RULES = new Set([
  '@typescript-eslint/no-non-null-assertion',
  'error-handling/no-phantom-prisma-field',
]);
const BASELINE_PATH = path.join(__dirname, 'lint-debt-baseline.json');

type RuleCounts = Record<string, Record<string, number>>;

interface LintResult {
  totalWarnings: number;
  blockingWarnings: number;
  errors: number;
  warningsByFile: RuleCounts;
  errorsByFile: RuleCounts;
  output: string;
  failed: boolean;
}

interface LintDebtBaseline {
  warnings: RuleCounts;
  errors: RuleCounts;
}

/** Runs eslint and counts warnings and errors by file and rule. */
function runLint(): LintResult {
  const result = spawnSync('npx', ['eslint', ...LINT_TARGETS, '--format', 'json'], {
    encoding: 'utf-8',
    maxBuffer: 1024 * 1024 * 64,
  });
  const stdout = `${result.stdout ?? ''}`;
  const stderr = `${result.stderr ?? ''}`;

  // By default eslint exits non-zero only when it finds errors (a cap like
  // `--max-warnings -1` isn't valid and plain warnings don't trip the exit
  // code), so we parse the JSON to enforce the ratchet ourselves. A hard
  // failure (bad config, fatal parse error) surfaces as stderr or a non-zero
  // exit code even with only warnings present; treat that as an error.
  if (/fatal|Parsing error/i.test(stderr)) {
    // eslint still prints JSON to stdout on many failures; fall through to the
    // JSON-lines below if we can parse it, otherwise bail with the raw text.
    const parsed = safeParseJson(stdout);
    if (parsed === null) {
      return {
        totalWarnings: -1,
        blockingWarnings: -1,
        errors: 1,
        warningsByFile: {},
        errorsByFile: {},
        output: stderr + stdout,
        failed: true,
      };
    }
    return countFromJson(parsed, stderr + stdout, true);
  }

  const parsed = safeParseJson(stdout);
  if (parsed === null) {
    return {
      totalWarnings: -1,
      blockingWarnings: -1,
      errors: 1,
      warningsByFile: {},
      errorsByFile: {},
      output: stderr + stdout,
      failed: true,
    };
  }
  return countFromJson(parsed, stderr + stdout, false);
}

function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function countFromJson(data: unknown, output: string, forcedError: boolean): LintResult {
  const files = Array.isArray(data)
    ? (data as Array<{ filePath?: string; messages?: Array<Record<string, unknown>> }>)
    : [];
  let totalWarnings = 0;
  let blockingWarnings = 0;
  let errors = 0;
  const warningsByFile: RuleCounts = {};
  const errorsByFile: RuleCounts = {};
  for (const file of files) {
    const relativePath =
      typeof file.filePath === 'string'
        ? path.relative(path.join(__dirname, '..'), file.filePath).split(path.sep).join('/')
        : '<unknown>';
    for (const msg of file.messages ?? []) {
      const severity = msg.severity as number | undefined;
      const ruleId = typeof msg.ruleId === 'string' ? (msg.ruleId as string) : '';
      if (severity === 2) {
        errors += 1;
        incrementRuleCount(errorsByFile, relativePath, ruleId);
      } else if (severity === 1) {
        totalWarnings += 1;
        incrementRuleCount(warningsByFile, relativePath, ruleId);
        if (!NON_BLOCKING_RULES.has(ruleId)) blockingWarnings += 1;
      }
    }
  }
  if (forcedError && errors === 0) errors = 1;
  return {
    totalWarnings,
    blockingWarnings,
    errors,
    warningsByFile,
    errorsByFile,
    output,
    failed: forcedError,
  };
}

function incrementRuleCount(counts: RuleCounts, file: string, ruleId: string): void {
  if (!ruleId) return;
  counts[file] ??= {};
  counts[file][ruleId] = (counts[file][ruleId] ?? 0) + 1;
}

export function findLintDebtIncreases(
  current: RuleCounts,
  baseline: RuleCounts,
): Array<{ file: string; rule: string; current: number; baseline: number }> {
  const increases: Array<{ file: string; rule: string; current: number; baseline: number }> = [];
  for (const [file, rules] of Object.entries(current)) {
    for (const [rule, count] of Object.entries(rules)) {
      const allowed = baseline[file]?.[rule] ?? 0;
      if (count > allowed) increases.push({ file, rule, current: count, baseline: allowed });
    }
  }
  return increases.sort((a, b) => a.file.localeCompare(b.file) || a.rule.localeCompare(b.rule));
}

function readDebtBaseline(): LintDebtBaseline {
  const raw: unknown = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf-8'));
  if (
    raw === null ||
    typeof raw !== 'object' ||
    !('warnings' in raw) ||
    !('errors' in raw) ||
    typeof raw.warnings !== 'object' ||
    raw.warnings === null ||
    typeof raw.errors !== 'object' ||
    raw.errors === null
  ) {
    throw new Error(`Invalid lint debt baseline at ${BASELINE_PATH}`);
  }
  return raw as LintDebtBaseline;
}

function parseMaxWarnings(argv: string[]): number {
  const budgetIndex = argv.indexOf('--max-warnings');
  if (budgetIndex === -1) return 0;
  const raw = argv[budgetIndex + 1];
  const parsed = raw !== undefined ? parseInt(raw, 10) : NaN;
  if (Number.isNaN(parsed) || parsed < 0) {
    console.error(
      `Invalid --max-warnings value: "${String(raw)}" (expected a non-negative integer)`,
    );
    process.exit(2);
  }
  return parsed;
}

function parseMaxNonBlocking(argv: string[]): number {
  const budgetIndex = argv.indexOf('--max-non-blocking');
  if (budgetIndex === -1) return 0;
  const raw = argv[budgetIndex + 1];
  const parsed = raw !== undefined ? parseInt(raw, 10) : NaN;
  if (Number.isNaN(parsed) || parsed < 0) {
    console.error(
      `Invalid --max-non-blocking value: "${String(raw)}" (expected a non-negative integer)`,
    );
    process.exit(2);
  }
  return parsed;
}

/** Reads the last-recorded warning count for trend reporting, if any. */
function readBaseline(): number | null {
  const file = path.join(__dirname, '..', 'node_modules', '.lint-budget-baseline');
  try {
    const n = parseInt(fs.readFileSync(file, 'utf-8').trim(), 10);
    return Number.isNaN(n) ? null : n;
  } catch {
    return null;
  }
}

/** Persists the current warning count so the next run can show the trend. */
function writeBaseline(count: number): void {
  try {
    const dir = path.join(__dirname, '..', 'node_modules');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.lint-budget-baseline'), String(count), 'utf-8');
  } catch {
    // Trend is best-effort; a failure to write must never fail lint.
  }
}

if (require.main === module) {
  const maxWarnings = parseMaxWarnings(process.argv.slice(2));
  const maxNonBlocking = parseMaxNonBlocking(process.argv.slice(2));

  console.log('Running eslint (budget ratchet, #920)...\n');
  const {
    totalWarnings,
    blockingWarnings,
    errors,
    warningsByFile,
    errorsByFile,
    output,
    failed,
  } = runLint();
  let baseline: LintDebtBaseline;
  try {
    baseline = readDebtBaseline();
  } catch (error) {
    console.error(`❌ LINT FAILED — ${String(error)}\n`);
    process.exit(1);
  }

  const warningIncreases = findLintDebtIncreases(warningsByFile, baseline.warnings);
  const errorIncreases = findLintDebtIncreases(errorsByFile, baseline.errors);
  if (failed || (errors > 0 && errorIncreases.length > 0)) {
    console.log(output);
  }

  const previous = readBaseline();

  // ── Trend ────────────────────────────────────────────────────────────────
  const arrow =
    previous === null
      ? ''
      : blockingWarnings > previous
        ? `  (⬆️ +${blockingWarnings - previous} since last run)`
        : blockingWarnings < previous
          ? `  (⬇️ -${previous - blockingWarnings} since last run)`
          : '  (unchanged)';
  console.log('───────────────────────────────────────────────────');
  console.log(`Total warnings:     ${totalWarnings}`);
  console.log(`Blocking warnings:  ${blockingWarnings}${arrow}`);
  console.log(
    `Non-blocking debt:  ${totalWarnings - blockingWarnings} (tracked per file and rule)`,
  );
  console.log(`Budget:             ${maxWarnings}`);
  console.log(`Non-blocking cap:   ${maxNonBlocking}`);
  console.log(`Errors:             ${errors}`);
  if (previous !== null) {
    console.log(`Previous blocking:  ${previous}`);
  }
  console.log('───────────────────────────────────────────────────');

  if (failed || warningIncreases.length > 0 || errorIncreases.length > 0) {
    for (const item of [...warningIncreases, ...errorIncreases]) {
      console.error(
        `  ${item.file} [${item.rule}]: ${item.current} (baseline ${item.baseline})`,
      );
    }
  }

  if (warningIncreases.length > 0 || errorIncreases.length > 0) {
    console.log(
      `❌ LINT FAILED — ${warningIncreases.length} warning debt and ${errorIncreases.length} error ` +
        `count(s) increased from their per-file baselines${failed ? ' or ESLint failed to run' : ''}.\n`,
    );
    process.exit(1);
  }

  if (totalWarnings - blockingWarnings > maxNonBlocking) {
    console.log(
      `❌ LINT FAILED — ${totalWarnings - blockingWarnings} non-blocking warning(s) exceed ` +
        `budget of ${maxNonBlocking}.\n`,
    );
    process.exit(1);
  }

  if (blockingWarnings > maxWarnings) {
    console.log(
      `❌ LINT FAILED — ${blockingWarnings} blocking warning(s) exceed budget of ${maxWarnings}. ` +
        `${blockingWarnings - maxWarnings} new warning(s) were introduced. Fix them, or — if this is a ` +
        `deliberate, reviewed burn-down step — bump the budget in package.json ('lint:budget:ci').\n`,
    );
    process.exit(1);
  }

  if (blockingWarnings > 0) {
    console.log(
      `✅ LINT PASSED — ${blockingWarnings} blocking warning(s), within budget of ${maxWarnings}. ` +
        `Consider fixing some and lowering the budget in package.json ('lint:budget:ci').\n`,
    );
  } else {
    console.log('✅ LINT PASSED — no blocking warnings\n');
  }

  writeBaseline(blockingWarnings);
  process.exit(0);
}

export { countFromJson, runLint };
