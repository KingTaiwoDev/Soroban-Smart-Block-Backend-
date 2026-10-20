import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const DOC = path.join(ROOT, 'docs/threat-model-ingestion-analytics-export.md');

function referencedPaths(markdown: string): string[] {
  const matches = markdown.match(/`((?:src|docs|tests|scripts)\/[A-Za-z0-9_./-]+)`/g) ?? [];
  return [...new Set(matches.map((m) => m.slice(1, -1)))];
}

describe('threat model for ingestion, analytics and export flows', () => {
  const markdown = fs.readFileSync(DOC, 'utf8');

  it('covers every flow and STRIDE category', () => {
    for (const heading of ['## 3. Ingestion flow', '## 4. Analytics flow', '## 5. Export flows']) {
      expect(markdown).toContain(heading);
    }
    for (const category of [
      'Spoofing',
      'Tampering',
      'Repudiation',
      'Information disclosure',
      'Denial of service',
      'Elevation of privilege',
    ]) {
      expect(markdown).toContain(category);
    }
  });

  it('references real repository files', () => {
    const refs = referencedPaths(markdown);
    expect(refs.length).toBeGreaterThan(20);
    const missing = refs.filter((p) => !fs.existsSync(path.join(ROOT, p)));
    expect(missing).toEqual([]);
  });

  it('detects references to files that do not exist', () => {
    const refs = referencedPaths('see `src/does-not-exist.ts`');
    expect(refs.filter((p) => !fs.existsSync(path.join(ROOT, p)))).toEqual([
      'src/does-not-exist.ts',
    ]);
  });
});
