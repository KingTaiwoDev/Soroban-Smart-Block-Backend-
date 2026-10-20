import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import {
  verifyAnalyticsSchemaRelease,
  type SchemaChangeProposal,
} from '../../scripts/verify-analytics-schema-release';
import {
  createDefaultRegistry,
  CORE_SCHEMAS,
} from '../../src/analytics/lakehouse/schema-registry';

const runbookPath = path.resolve(
  __dirname,
  '../../docs/runbooks/analytics-schema-release-checklist.md',
);
const scriptPath = path.resolve(__dirname, '../../scripts/verify-analytics-schema-release.ts');
const tempDirs: string[] = [];

function createTempProposalFile(proposal: unknown): string {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'analytics-schema-check-'));
  tempDirs.push(dir);
  const filePath = path.join(dir, 'proposal.json');
  fs.writeFileSync(filePath, JSON.stringify(proposal, null, 2), 'utf8');
  return filePath;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('Analytics Schema Release Checklist - Automated Verification', () => {
  it('passes a fully compliant backward-compatible change on devnet', () => {
    const proposal: SchemaChangeProposal = {
      subject: 'soroban.tx.confirmed',
      proposedFields: [
        ...CORE_SCHEMAS['soroban.tx.confirmed'],
        { name: 'execution_phase', type: 'string', optional: true, default: 'apply' },
      ],
      targetNetwork: 'devnet',
      phase: 'expand',
      rollbackPlanDefined: true,
    };

    const result = verifyAnalyticsSchemaRelease(proposal);
    expect(result.passed).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.checks.every((c) => c.passed)).toBe(true);
  });

  it('passes promotional rollout to mainnet once devnet and testnet are validated', () => {
    const proposal: SchemaChangeProposal = {
      subject: 'soroban.tx.confirmed',
      proposedFields: [
        ...CORE_SCHEMAS['soroban.tx.confirmed'],
        { name: 'execution_phase', type: 'string', optional: true, default: 'apply' },
      ],
      targetNetwork: 'mainnet',
      phase: 'write',
      previousValidatedNetworks: ['devnet', 'testnet'],
      rollbackPlanDefined: true,
    };

    const result = verifyAnalyticsSchemaRelease(proposal);
    expect(result.passed).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects a backward-incompatible field addition (required without default)', () => {
    const proposal: SchemaChangeProposal = {
      subject: 'soroban.tx.confirmed',
      proposedFields: [
        ...CORE_SCHEMAS['soroban.tx.confirmed'],
        { name: 'breaking_field', type: 'string' }, // required, no default
      ],
      targetNetwork: 'devnet',
      phase: 'expand',
      rollbackPlanDefined: true,
    };

    const result = verifyAnalyticsSchemaRelease(proposal);
    expect(result.passed).toBe(false);
    expect(result.errors.some((e) => e.includes('Compatibility failure'))).toBe(true);
    expect(result.errors.some((e) => e.includes('Expand phase requires new fields to be optional'))).toBe(true);
  });

  it('rejects field type mutation', () => {
    const modifiedFields = CORE_SCHEMAS['soroban.tx.confirmed'].map((f) =>
      f.name === 'fee_charged' ? { ...f, type: 'string' as const } : f,
    );
    const proposal: SchemaChangeProposal = {
      subject: 'soroban.tx.confirmed',
      proposedFields: modifiedFields,
      targetNetwork: 'devnet',
      phase: 'expand',
      rollbackPlanDefined: true,
    };

    const result = verifyAnalyticsSchemaRelease(proposal);
    expect(result.passed).toBe(false);
    expect(result.errors.some((e) => e.includes('type of "fee_charged" changed long → string'))).toBe(true);
  });

  it('blocks mainnet promotion if devnet or testnet validation is missing', () => {
    const proposal: SchemaChangeProposal = {
      subject: 'soroban.tx.confirmed',
      proposedFields: [
        ...CORE_SCHEMAS['soroban.tx.confirmed'],
        { name: 'priority_bid', type: 'long', optional: true, default: 0 },
      ],
      targetNetwork: 'mainnet',
      phase: 'write',
      previousValidatedNetworks: ['devnet'], // missing testnet!
      rollbackPlanDefined: true,
    };

    const result = verifyAnalyticsSchemaRelease(proposal);
    expect(result.passed).toBe(false);
    expect(result.errors.some((e) => e.includes('Mainnet release blocked'))).toBe(true);
  });

  it('blocks testnet promotion if devnet validation is missing', () => {
    const proposal: SchemaChangeProposal = {
      subject: 'soroban.tx.confirmed',
      proposedFields: [
        ...CORE_SCHEMAS['soroban.tx.confirmed'],
        { name: 'priority_bid', type: 'long', optional: true, default: 0 },
      ],
      targetNetwork: 'testnet',
      phase: 'expand',
      previousValidatedNetworks: [], // missing devnet!
      rollbackPlanDefined: true,
    };

    const result = verifyAnalyticsSchemaRelease(proposal);
    expect(result.passed).toBe(false);
    expect(result.errors.some((e) => e.includes('Testnet release blocked'))).toBe(true);
  });

  it('fails verification if rollback procedure is not defined', () => {
    const proposal: SchemaChangeProposal = {
      subject: 'soroban.tx.confirmed',
      proposedFields: [
        ...CORE_SCHEMAS['soroban.tx.confirmed'],
        { name: 'memo_tag', type: 'string', optional: true, default: '' },
      ],
      targetNetwork: 'devnet',
      phase: 'expand',
      rollbackPlanDefined: false,
    };

    const result = verifyAnalyticsSchemaRelease(proposal);
    expect(result.passed).toBe(false);
    expect(result.errors.some((e) => e.includes('Rollback readiness failed'))).toBe(true);
  });

  it('blocks contract phase when historical OLAP backfill is required but unverified', () => {
    const proposal: SchemaChangeProposal = {
      subject: 'soroban.tx.confirmed',
      proposedFields: CORE_SCHEMAS['soroban.tx.confirmed'],
      targetNetwork: 'mainnet',
      phase: 'contract',
      previousValidatedNetworks: ['devnet', 'testnet'],
      rollbackPlanDefined: true,
      olapBackfillRequired: true,
      olapBackfillVerified: false,
    };

    const result = verifyAnalyticsSchemaRelease(proposal);
    expect(result.passed).toBe(false);
    expect(result.errors.some((e) => e.includes('Contract phase cannot proceed'))).toBe(true);
  });

  it('rejects schema changes that omit required downstream stream processor fields', () => {
    const proposal: SchemaChangeProposal = {
      subject: 'soroban.tx.confirmed',
      // Missing 'tx_hash', 'contract_id' which are required by downstream processors
      proposedFields: [
        { name: 'network_id', type: 'string' },
        { name: 'ledger_sequence', type: 'long' },
      ],
      targetNetwork: 'devnet',
      phase: 'expand',
      rollbackPlanDefined: true,
      compatibilityMode: 'NONE', // bypass backward check to test downstream check specifically
    };

    const result = verifyAnalyticsSchemaRelease(proposal);
    expect(result.passed).toBe(false);
    expect(result.errors.some((e) => e.includes('Downstream pipeline disruption'))).toBe(true);
  });
});

describe('Analytics Schema Release Checklist - CLI Execution', () => {
  it('exits with code 0 for a valid proposal file', () => {
    const proposalFile = createTempProposalFile({
      subject: 'soroban.gas.sample',
      proposedFields: [
        ...CORE_SCHEMAS['soroban.gas.sample'],
        { name: 'cpu_usage_ns', type: 'long', optional: true, default: 0 },
      ],
      targetNetwork: 'devnet',
      phase: 'expand',
      rollbackPlanDefined: true,
    });

    const res = spawnSync('npx', ['ts-node', '--transpile-only', scriptPath, '--proposal', proposalFile], {
      encoding: 'utf8',
      shell: true,
    });

    expect(res.status).toBe(0);
    expect(res.stdout).toContain('All analytics schema release gates passed successfully.');
  });

  it('exits with code 1 for an invalid proposal file', () => {
    const proposalFile = createTempProposalFile({
      subject: 'soroban.gas.sample',
      proposedFields: [
        ...CORE_SCHEMAS['soroban.gas.sample'],
        { name: 'mandatory_field', type: 'long' }, // breaking
      ],
      targetNetwork: 'devnet',
      phase: 'expand',
      rollbackPlanDefined: false,
    });

    const res = spawnSync('npx', ['ts-node', '--transpile-only', scriptPath, '--proposal', proposalFile], {
      encoding: 'utf8',
      shell: true,
    });

    expect(res.status).toBe(1);
    expect(res.stderr).toContain('Release Checklist Verification Errors');
  });

  it('exits with code 2 for missing or invalid arguments', () => {
    const res = spawnSync('npx', ['ts-node', '--transpile-only', scriptPath], {
      encoding: 'utf8',
      shell: true,
    });

    expect(res.status).toBe(2);
    expect(res.stderr).toContain('Usage: verify-analytics-schema-release');
  });
});

describe('Analytics Schema Release Runbook Documentation', () => {
  it('documents backward compatibility rules, expand-contract phases, and network gates', () => {
    expect(fs.existsSync(runbookPath)).toBe(true);
    const doc = fs.readFileSync(runbookPath, 'utf8');

    expect(doc).toContain('Analytics Schema Release Checklist and Operational Runbook');
    expect(doc).toContain('checkCompatibility');
    expect(doc).toContain('BACKWARD');
    expect(doc).toContain('Phase 1: Expand');
    expect(doc).toContain('Phase 2: Write');
    expect(doc).toContain('Phase 3: Contract');
    expect(doc).toContain('Devnet Rollout');
    expect(doc).toContain('Testnet Rollout');
    expect(doc).toContain('Mainnet Canary & Promotion');
    expect(doc).toContain('Operational Rollback');
    expect(doc).toContain('rollback-release.sh');
  });
});
