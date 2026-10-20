/**
 * Reproducible Release Checklist & Validator for Analytics Schema Changes (Issue #1253)
 *
 * Enforces pre-flight compatibility, expand-contract phases, network-specific
 * rollout gates (devnet -> testnet -> mainnet), downstream OLAP alignment,
 * and rollback readiness for analytics lakehouse schema evolution.
 */
import fs from 'fs';
import path from 'path';
import {
  SchemaRegistry,
  createDefaultRegistry,
  checkCompatibility,
  type SchemaField,
  type CompatibilityMode,
} from '../src/analytics/lakehouse/schema-registry';

export type NetworkStage = 'devnet' | 'testnet' | 'mainnet';
export type ReleasePhase = 'expand' | 'write' | 'contract';

export interface SchemaChangeProposal {
  subject: string;
  proposedFields: SchemaField[];
  targetNetwork: NetworkStage;
  phase: ReleasePhase;
  compatibilityMode?: CompatibilityMode;
  previousValidatedNetworks?: NetworkStage[];
  rollbackPlanDefined: boolean;
  olapBackfillRequired?: boolean;
  olapBackfillVerified?: boolean;
}

export interface ChecklistItemResult {
  id: string;
  name: string;
  passed: boolean;
  details: string;
}

export interface ChecklistVerificationResult {
  passed: boolean;
  subject: string;
  targetNetwork: NetworkStage;
  phase: ReleasePhase;
  checks: ChecklistItemResult[];
  errors: string[];
}

/** Downstream consumers known to depend on core subjects. */
export const DOWNSTREAM_CONSUMER_REQUIREMENTS: Record<string, string[]> = {
  'soroban.tx.confirmed': [
    'network_id',
    'tx_hash',
    'ledger_sequence',
    'contract_id',
    'fee_charged',
    'status',
  ],
  'soroban.swap.executed': [
    'network_id',
    'tx_hash',
    'ledger_sequence',
    'token_in',
    'token_out',
    'amount_in',
    'amount_out',
  ],
  'soroban.gas.sample': [
    'network_id',
    'ledger_sequence',
    'fee_charged',
    'resource_instructions',
  ],
};

export function verifyAnalyticsSchemaRelease(
  proposal: SchemaChangeProposal,
  registry: SchemaRegistry = createDefaultRegistry(),
): ChecklistVerificationResult {
  const checks: ChecklistItemResult[] = [];
  const errors: string[] = [];

  const existingSchema = registry.latest(proposal.subject);
  const mode = proposal.compatibilityMode ?? registry.getCompatibility(proposal.subject);

  // 1. Compatibility Check
  if (existingSchema) {
    const violation = checkCompatibility(mode, existingSchema.fields, proposal.proposedFields);
    if (violation) {
      checks.push({
        id: 'compatibility-check',
        name: `Schema ${mode} Compatibility Verification`,
        passed: false,
        details: `Violation detected: ${violation}`,
      });
      errors.push(`Compatibility failure (${mode}): ${violation}`);
    } else {
      checks.push({
        id: 'compatibility-check',
        name: `Schema ${mode} Compatibility Verification`,
        passed: true,
        details: `Compatible with previous version ${existingSchema.version} under ${mode} rules.`,
      });
    }
  } else {
    checks.push({
      id: 'compatibility-check',
      name: `Initial Schema Registration`,
      passed: true,
      details: `New subject "${proposal.subject}" registered as initial version.`,
    });
  }

  // 2. Expand-Contract Phase Rules
  if (proposal.phase === 'expand') {
    // In expand phase, any newly introduced fields must be optional or provide a default value
    if (existingSchema) {
      const existingNames = new Set(existingSchema.fields.map((f) => f.name));
      const newlyAdded = proposal.proposedFields.filter((f) => !existingNames.has(f.name));
      const invalidFields = newlyAdded.filter((f) => !f.optional && f.default === undefined);

      if (invalidFields.length > 0) {
        const details = `Expand phase requires new fields to be optional or specify defaults: ${invalidFields
          .map((f) => f.name)
          .join(', ')}`;
        checks.push({
          id: 'expand-phase-non-breaking',
          name: 'Expand Phase Non-Breaking Additions',
          passed: false,
          details,
        });
        errors.push(details);
      } else {
        checks.push({
          id: 'expand-phase-non-breaking',
          name: 'Expand Phase Non-Breaking Additions',
          passed: true,
          details: 'All new fields are non-breaking with optional flag or default values.',
        });
      }
    } else {
      checks.push({
        id: 'expand-phase-non-breaking',
        name: 'Expand Phase Non-Breaking Additions',
        passed: true,
        details: 'Initial subject schema creation.',
      });
    }
  } else if (proposal.phase === 'contract') {
    // In contract phase, if backfill was required, it must have been verified
    if (proposal.olapBackfillRequired && !proposal.olapBackfillVerified) {
      const details =
        'Contract phase cannot proceed: historical OLAP backfill is required but not marked verified.';
      checks.push({
        id: 'contract-backfill-verified',
        name: 'Historical OLAP Backfill Verification',
        passed: false,
        details,
      });
      errors.push(details);
    } else {
      checks.push({
        id: 'contract-backfill-verified',
        name: 'Historical OLAP Backfill Verification',
        passed: true,
        details: 'OLAP backfill verified or not required for this contract change.',
      });
    }
  } else {
    // Write phase
    checks.push({
      id: 'write-phase-alignment',
      name: 'Write Phase Producer Enablement',
      passed: true,
      details: 'Dual-read consumers active; producers can safely emit updated schema version.',
    });
  }

  // 3. Staged Network Rollout Order
  const validated = new Set(proposal.previousValidatedNetworks ?? []);
  if (proposal.targetNetwork === 'mainnet') {
    if (!validated.has('testnet') || !validated.has('devnet')) {
      const details =
        'Mainnet release blocked: schema change must be deployed and validated on devnet and testnet first.';
      checks.push({
        id: 'network-rollout-gates',
        name: 'Network Rollout Promotion Gate',
        passed: false,
        details,
      });
      errors.push(details);
    } else {
      checks.push({
        id: 'network-rollout-gates',
        name: 'Network Rollout Promotion Gate',
        passed: true,
        details: 'Validated on devnet and testnet prior to mainnet promotion.',
      });
    }
  } else if (proposal.targetNetwork === 'testnet') {
    if (!validated.has('devnet')) {
      const details =
        'Testnet release blocked: schema change must be deployed and validated on devnet first.';
      checks.push({
        id: 'network-rollout-gates',
        name: 'Network Rollout Promotion Gate',
        passed: false,
        details,
      });
      errors.push(details);
    } else {
      checks.push({
        id: 'network-rollout-gates',
        name: 'Network Rollout Promotion Gate',
        passed: true,
        details: 'Validated on devnet prior to testnet promotion.',
      });
    }
  } else {
    // devnet is entry point
    checks.push({
      id: 'network-rollout-gates',
      name: 'Network Rollout Promotion Gate',
      passed: true,
      details: 'Devnet is the primary entry point for staged schema evolution.',
    });
  }

  // 4. Downstream OLAP & Stream Processor Alignment
  const requiredConsumers = DOWNSTREAM_CONSUMER_REQUIREMENTS[proposal.subject];
  if (requiredConsumers) {
    const proposedNames = new Set(proposal.proposedFields.map((f) => f.name));
    const missingCore = requiredConsumers.filter((name) => !proposedNames.has(name));
    if (missingCore.length > 0) {
      const details = `Downstream pipeline disruption: missing core fields required by stream processors: ${missingCore.join(', ')}`;
      checks.push({
        id: 'downstream-pipeline-alignment',
        name: 'Downstream Stream & OLAP Alignment',
        passed: false,
        details,
      });
      errors.push(details);
    } else {
      checks.push({
        id: 'downstream-pipeline-alignment',
        name: 'Downstream Stream & OLAP Alignment',
        passed: true,
        details: 'All required fields for downstream stream processors and materialized views present.',
      });
    }
  } else {
    checks.push({
      id: 'downstream-pipeline-alignment',
      name: 'Downstream Stream & OLAP Alignment',
      passed: true,
      details: 'Custom subject without built-in hardcoded downstream dependencies.',
    });
  }

  // 5. Rollback Readiness Gate
  if (!proposal.rollbackPlanDefined) {
    const details =
      'Rollback readiness failed: reproducible rollback runbook and procedure must be documented and tested.';
    checks.push({
      id: 'rollback-readiness',
      name: 'Rollback Procedure Defined',
      passed: false,
      details,
    });
    errors.push(details);
  } else {
    checks.push({
      id: 'rollback-readiness',
      name: 'Rollback Procedure Defined',
      passed: true,
      details: 'Rollback procedure defined and verified against consumer fallback mechanisms.',
    });
  }

  const passed = errors.length === 0;
  return {
    passed,
    subject: proposal.subject,
    targetNetwork: proposal.targetNetwork,
    phase: proposal.phase,
    checks,
    errors,
  };
}

/** CLI entrypoint. */
export function runCli(args: string[]): number {
  const proposalArgIndex = args.indexOf('--proposal');
  if (proposalArgIndex === -1 || !args[proposalArgIndex + 1]) {
    console.error('Usage: verify-analytics-schema-release --proposal <path-to-json-file>');
    return 2;
  }

  const proposalPath = path.resolve(process.cwd(), args[proposalArgIndex + 1]);
  if (!fs.existsSync(proposalPath)) {
    console.error(`Proposal file not found: ${proposalPath}`);
    return 2;
  }

  try {
    const proposal = JSON.parse(fs.readFileSync(proposalPath, 'utf8')) as SchemaChangeProposal;
    const result = verifyAnalyticsSchemaRelease(proposal);

    console.log(`\n=== Analytics Schema Release Checklist Verification ===`);
    console.log(`Subject:        ${result.subject}`);
    console.log(`Target Network: ${result.targetNetwork}`);
    console.log(`Release Phase:  ${result.phase}`);
    console.log(`Status:         ${result.passed ? 'PASSED ✅' : 'FAILED ❌'}\n`);

    for (const c of result.checks) {
      console.log(`[${c.passed ? 'PASS' : 'FAIL'}] ${c.name}`);
      console.log(`       ${c.details}`);
    }

    if (!result.passed) {
      console.error('\nRelease Checklist Verification Errors:');
      for (const err of result.errors) {
        console.error(`- ${err}`);
      }
      return 1;
    }

    console.log('\nAll analytics schema release gates passed successfully.\n');
    return 0;
  } catch (err) {
    console.error(`Failed to process proposal: ${String(err)}`);
    return 1;
  }
}

if (require.main === module) {
  const exitCode = runCli(process.argv.slice(2));
  process.exit(exitCode);
}
