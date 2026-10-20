/**
 * Keeps docs/secret-rotation.md in sync with the secrets that actually exist
 * in the repository configuration (#1234).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

const root = join(__dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const doc = read('docs/secret-rotation.md');
const [runtimeSection, ciSection] = doc
  .split('## Runtime secrets (environment variables)')[1]
  .split('## CI/CD secrets (GitHub)');

/** Names in backticks in the first cell of each table row. */
export function secretNames(section: string): string[] {
  return section
    .split('\n')
    .filter((l) => l.startsWith('|') && !/^\|\s*(Secret|---)/.test(l))
    .flatMap((l) => [...(l.split('|')[1] ?? '').matchAll(/`([A-Z][A-Z0-9_]+)`/g)].map((m) => m[1]));
}

const configSources = [
  '.env.example',
  'src/config.ts',
  'k8s/secrets.yaml',
  'docker-compose.yml',
  'src/webhooks/secretCrypto.ts',
  'src/indexer/audit-engine.ts',
  'src/lib/anchor-service.ts',
]
  .map(read)
  .join('\n');

const workflows = readdirSync(join(root, '.github/workflows'))
  .map((f) => read(`.github/workflows/${f}`))
  .join('\n');

const mentions = (haystack: string, name: string) =>
  new RegExp(`(^|[^A-Z0-9_])${name}([^A-Z0-9_]|$)`).test(haystack);

describe('secret rotation doc', () => {
  const runtime = secretNames(runtimeSection);
  const ci = secretNames(ciSection);

  it('documents runtime and CI secrets', () => {
    expect(runtime.length).toBeGreaterThan(10);
    expect(ci).toEqual(
      expect.arrayContaining(['KUBE_CONFIG_STAGING', 'KUBE_CONFIG_PRODUCTION', 'NPM_TOKEN']),
    );
  });

  it.each(runtime)('runtime secret %s exists in repo configuration', (name) => {
    expect(mentions(configSources, name)).toBe(true);
  });

  it.each(ci)('CI secret %s is used by a workflow', (name) => {
    expect(mentions(workflows, `secrets\\.${name}`.replace('\\.', '.'))).toBe(true);
  });

  it('rejects names that are not configured (failure case)', () => {
    expect(mentions(configSources, 'NOT_A_REAL_SECRET_NAME')).toBe(false);
    expect(secretNames('| Secret |\n| --- |\n| `FAKE_SECRET_X` | a |')).toEqual(['FAKE_SECRET_X']);
  });
});
