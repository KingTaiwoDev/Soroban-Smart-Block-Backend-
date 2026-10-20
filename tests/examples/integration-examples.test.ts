import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../..');

describe('integration examples', () => {
  it('keeps TypeScript and curl examples on the documented read-only API flow', () => {
    const typescript = readFileSync(resolve(root, 'examples/integration/typescript-e2e.ts'), 'utf8');
    const curl = readFileSync(resolve(root, 'examples/integration/curl-e2e.sh'), 'utf8');
    for (const source of [typescript, curl]) {
      expect(source).toContain('/api/v1/health');
      expect(source).toContain('/api/v1/network');
      expect(source).toContain('/api/v1/events');
      expect(source).not.toMatch(/\bPOST\b|\bPUT\b|\bDELETE\b/);
    }
  });
});
