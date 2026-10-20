#!/usr/bin/env node
/**
 * Dependency license policy check (#1235).
 *
 * Reads package-lock.json (no install needed) and fails when a third-party
 * dependency is under a disallowed license (GPL, AGPL, SSPL) or has no
 * usable license metadata ("unknown"). SPDX expressions are honoured: an
 * `A OR B` expression passes if any alternative passes, `A AND B` only if
 * every term passes. Reviewed exceptions live in scripts/license-allowlist.json
 * as `"name@version": "reason"`.
 *
 * Usage: node scripts/check-licenses.mjs [path/to/package-lock.json]
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Copyleft licenses not acceptable for this project. LGPL is not matched. */
const DENIED = /^(A?GPL|SSPL)(-|$)/i;
/** Metadata values that mean "no license information". */
const UNKNOWN = /^(UNLICENSED|SEE LICENSE.*|NONE|UNKNOWN)?$/i;

/** @returns {boolean} whether a single SPDX term (no OR/AND) is acceptable. */
function termAllowed(term) {
  const id = term.replace(/[()]/g, '').replace(/\s+WITH\s+.*$/i, '').replace(/\+$/, '').trim();
  return !UNKNOWN.test(id) && !DENIED.test(id);
}

/** Evaluate an SPDX expression: OR = any alternative, AND = all terms. */
export function licenseAllowed(expression) {
  if (typeof expression !== 'string') return false;
  const expr = expression.trim();
  if (UNKNOWN.test(expr)) return false;
  return expr
    .replace(/[()]/g, ' ')
    .split(/\s+OR\s+/i)
    .some((alt) => alt.split(/\s+AND\s+/i).every((t) => termAllowed(t)));
}

/** Package name from a lockfile path such as node_modules/a/node_modules/@s/b. */
export function packageName(path, entry = {}) {
  return entry.name ?? path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
}

/**
 * Apply the policy to a parsed package-lock.json `packages` map.
 * First-party packages (outside node_modules) and workspace links are skipped.
 * @returns {{ id: string, license: string, reason: string }[]} violations
 */
export function evaluateLicenses(packages, allowlist = {}) {
  const violations = [];
  for (const [path, entry] of Object.entries(packages)) {
    if (!path.includes('node_modules/') || entry.link) continue;
    const id = `${packageName(path, entry)}@${entry.version ?? 'unknown'}`;
    if (Object.hasOwn(allowlist, id)) continue;
    const license = typeof entry.license === 'string' ? entry.license : undefined;
    if (!license || UNKNOWN.test(license.trim())) {
      violations.push({ id, license: license ?? '(none)', reason: 'unknown license' });
    } else if (!licenseAllowed(license)) {
      violations.push({ id, license, reason: 'disallowed license' });
    }
  }
  return violations;
}

function main() {
  const lockPath = process.argv[2] ?? 'package-lock.json';
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  const allowlist = JSON.parse(
    readFileSync(new URL('./license-allowlist.json', import.meta.url), 'utf8'),
  );
  const violations = evaluateLicenses(lock.packages ?? {}, allowlist);
  if (violations.length === 0) {
    console.log(`License policy OK (${Object.keys(lock.packages ?? {}).length} packages checked).`);
    return 0;
  }
  for (const v of violations) console.error(`${v.id}: ${v.reason} (${v.license})`);
  console.error(
    `${violations.length} license violation(s). Replace the dependency, or add a reviewed ` +
      'exception to scripts/license-allowlist.json (see docs/license-policy.md).',
  );
  return 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main());
