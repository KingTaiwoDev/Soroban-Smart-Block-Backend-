import { describe, expect, it } from 'vitest';
import defaultCorpus from '../../src/sandbox/corpus/replay-corpus.json';
import {
  calibrateCorpus,
  checkAcceptanceThreshold,
  evaluateCase,
  validateCorpusIntegrity,
  type ReplayCorpus,
} from '../../src/sandbox/calibration';

describe('Sandbox Fuel Cost Calibration (#1297)', () => {
  const corpus = defaultCorpus as unknown as ReplayCorpus;

  describe('Corpus Provenance, Versioning & Privacy', () => {
    it('has valid semver versioning and schema version', () => {
      expect(corpus.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(corpus.schemaVersion).toBeGreaterThanOrEqual(1);
      expect(corpus.protocolVersionsValidated).toContain(20);
      expect(corpus.protocolVersionsValidated).toContain(21);
      expect(corpus.protocolVersionsValidated).toContain(22);
      expect(corpus.acceptanceThresholdPercent).toBe(5.0);
    });

    it('contains representative successful, failed, and resource-intensive transactions', () => {
      const categories = corpus.cases.map((c) => c.category);
      expect(categories).toContain('SUCCESS');
      expect(categories).toContain('FAILED');
      expect(categories).toContain('RESOURCE_INTENSIVE');

      const successCount = corpus.cases.filter((c) => c.category === 'SUCCESS').length;
      const failedCount = corpus.cases.filter((c) => c.category === 'FAILED').length;
      const resourceCount = corpus.cases.filter((c) => c.category === 'RESOURCE_INTENSIVE').length;

      expect(successCount).toBeGreaterThanOrEqual(3);
      expect(failedCount).toBeGreaterThanOrEqual(2);
      expect(resourceCount).toBeGreaterThanOrEqual(3);
    });

    it('includes provenance for every corpus transaction', () => {
      for (const c of corpus.cases) {
        expect(c.provenance).toBeDefined();
        expect(['mainnet', 'testnet']).toContain(c.provenance.network);
        expect(c.provenance.ledgerSequence).toBeGreaterThan(0);
        expect(c.provenance.txHash).toMatch(/^[0-9a-fA-F]{64}$/);
        expect(c.provenance.source.length).toBeGreaterThan(0);
      }
    });

    it('does not contain secrets, private keys, or user-private data', () => {
      const integrity = validateCorpusIntegrity(corpus);
      expect(integrity.valid).toBe(true);
      expect(integrity.errors).toEqual([]);

      const raw = JSON.stringify(corpus);
      // No Stellar secret seeds starting with S and 56 base32 chars
      expect(/S[A-Z0-9]{55}/.test(raw)).toBe(false);
      // No user emails
      expect(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(raw)).toBe(false);
    });
  });

  describe('Calibration and Operation Class Error Reporting', () => {
    it('evaluates individual cases accurately against authoritative network results', () => {
      const case0 = corpus.cases[0];
      const result = evaluateCase(case0);

      expect(result.id).toBe(case0.id);
      expect(result.measured.total).toBeGreaterThan(0);
      expect(result.authoritative.total).toBe(case0.authoritative.totalGas);
      expect(result.percentageError).toBeLessThan(1.0); // Within 1%
    });

    it('reports error metrics broken down by operation class', () => {
      const report = calibrateCorpus(corpus);

      expect(report.totalCases).toBe(corpus.cases.length);
      expect(report.overallMAPE).toBeLessThan(2.0); // Well within acceptance threshold
      expect(report.classSummaries).toBeDefined();

      const expectedClasses = [
        'token_transfer',
        'storage_mutation',
        'cpu_arithmetic',
        'host_crypto',
        'failed_execution',
        'memory_operations',
        'host_events',
        'contract_invocation',
      ];

      for (const cls of expectedClasses) {
        expect(report.classSummaries[cls]).toBeDefined();
        expect(report.classSummaries[cls].caseCount).toBeGreaterThan(0);
        expect(report.classSummaries[cls].meanAbsolutePercentageError).toBeLessThanOrEqual(5.0);
        expect(report.classSummaries[cls].passed).toBe(true);
      }
    });
  });

  describe('Acceptance Threshold Gating in CI', () => {
    it('passes when overall MAPE is within the documented acceptance threshold (<= 5%)', () => {
      const report = calibrateCorpus(corpus, undefined, 5.0);
      const check = checkAcceptanceThreshold(report, 5.0);

      expect(report.passedThreshold).toBe(true);
      expect(check.passed).toBe(true);
      expect(check.message).toContain('Acceptance threshold passed');
    });

    it('fails when overall MAPE exceeds a strict threshold', () => {
      const report = calibrateCorpus(corpus);
      // Test with an unrealistically strict threshold (0.1%) to verify CI failure gating
      const check = checkAcceptanceThreshold(report, 0.1);

      expect(check.passed).toBe(false);
      expect(check.message).toContain('Acceptance threshold breached');
    });
  });
});
