import { describe, it, expect } from 'vitest';
// @ts-expect-error plain ESM script without type declarations
import { licenseAllowed, evaluateLicenses } from '../scripts/check-licenses.mjs';

const pkg = (version: string, license?: string, extra = {}) => ({ version, license, ...extra });

describe('licenseAllowed', () => {
  it.each(['MIT', 'Apache-2.0', 'ISC', 'BSD-3-Clause', 'MIT AND BSD-3-Clause', 'LGPL-3.0-only'])(
    'accepts %s',
    (l) => expect(licenseAllowed(l)).toBe(true),
  );

  it.each(['GPL-3.0', 'GPL-2.0-only', 'AGPL-3.0-or-later', 'SSPL-1.0', 'UNLICENSED', '', 'SEE LICENSE IN x'])(
    'rejects %s',
    (l) => expect(licenseAllowed(l)).toBe(false),
  );

  it('accepts an OR expression when one alternative is permissive', () => {
    expect(licenseAllowed('(BSD-3-Clause OR GPL-2.0)')).toBe(true);
  });

  it('rejects an AND expression when any term is disallowed', () => {
    expect(licenseAllowed('(MIT AND GPL-3.0)')).toBe(false);
  });

  it('rejects non-string metadata', () => {
    expect(licenseAllowed(undefined)).toBe(false);
    expect(licenseAllowed({ type: 'MIT' })).toBe(false);
  });
});

describe('evaluateLicenses', () => {
  const packages = {
    '': { name: 'root', version: '1.0.0' },
    'packages/client': { name: 'client', version: '1.0.0' },
    'node_modules/ok': pkg('1.0.0', 'MIT'),
    'node_modules/a/node_modules/@s/copyleft': pkg('2.0.0', 'AGPL-3.0'),
    'node_modules/nolicense': pkg('1.1.0'),
    'node_modules/ws-link': { link: true, resolved: 'packages/x' },
  };

  it('reports disallowed and unknown licenses, skipping first-party and links', () => {
    expect(evaluateLicenses(packages)).toEqual([
      { id: '@s/copyleft@2.0.0', license: 'AGPL-3.0', reason: 'disallowed license' },
      { id: 'nolicense@1.1.0', license: '(none)', reason: 'unknown license' },
    ]);
  });

  it('honours version-pinned allowlist exceptions', () => {
    const result = evaluateLicenses(packages, { 'nolicense@1.1.0': 'MIT per upstream' });
    expect(result.map((v: { id: string }) => v.id)).toEqual(['@s/copyleft@2.0.0']);
  });

  it('does not apply an exception to a different version', () => {
    const result = evaluateLicenses(
      { 'node_modules/nolicense': pkg('1.2.0') },
      { 'nolicense@1.1.0': 'reviewed' },
    );
    expect(result).toHaveLength(1);
  });

  it('passes a clean tree', () => {
    expect(evaluateLicenses({ 'node_modules/ok': pkg('1.0.0', 'ISC') })).toEqual([]);
  });
});
