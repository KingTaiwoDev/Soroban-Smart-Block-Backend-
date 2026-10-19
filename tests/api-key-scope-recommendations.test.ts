/**
 * Keeps docs/api-key-scope-recommendations.md in sync with the scope
 * catalogue in src/services/api-key-lifecycle.ts (#1233).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { KNOWN_SCOPES, validateScope } from '../src/services/api-key-lifecycle';

const doc = readFileSync(join(__dirname, '..', 'docs', 'api-key-scope-recommendations.md'), 'utf8');

/** Returns [useCase, scopes[]] for every row of the Recommendations table. */
function recommendations(markdown: string): Array<[string, string[]]> {
  const section = markdown.split('## Recommendations')[1]?.split('\n## ')[0] ?? '';
  return section
    .split('\n')
    .filter((l) => l.startsWith('|') && !/^\|\s*(Use case|---)/.test(l))
    .map((l) => {
      const cells = l.split('|').map((c) => c.trim());
      const scopes = [...cells[2].matchAll(/`([^`]+)`/g)].map((m) => m[1]);
      return [cells[1], scopes];
    });
}

describe('API key scope recommendations doc', () => {
  const rows = recommendations(doc);

  it('has recommendations', () => {
    expect(rows.length).toBeGreaterThan(5);
  });

  it.each(rows)('%s only recommends scopes that exist in code', (_useCase, scopes) => {
    expect(scopes.length).toBeGreaterThan(0);
    for (const scope of scopes) expect(KNOWN_SCOPES.has(scope)).toBe(true);
    expect(validateScope(scopes.join(','))).toBe(true);
  });

  it('never recommends the wildcard scope', () => {
    expect(rows.flatMap(([, s]) => s)).not.toContain('*');
  });

  it('detects an unknown scope (failure case)', () => {
    const bad = recommendations(
      '## Recommendations\n| Use case | Recommended scope | Notes |\n| --- | --- | --- |\n| x | `ledgers:read` | |\n',
    );
    expect(bad).toEqual([['x', ['ledgers:read']]]);
    expect(KNOWN_SCOPES.has('ledgers:read')).toBe(false);
    expect(validateScope('ledgers:read')).toBe(false);
  });
});
