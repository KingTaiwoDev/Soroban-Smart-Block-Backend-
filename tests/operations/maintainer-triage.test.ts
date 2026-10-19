import { describe, expect, it } from 'vitest';
import {
  SLA_MINUTES,
  calculateSeverity,
  evaluateSlaStatus,
  transitionDisputeStatus,
} from '../../src/services/triage-helper';

describe('Maintainer Triage Guide and Helper', () => {
  describe('Severity Classification Matrix', () => {
    it('classifies active security exploits as P0 requiring immediate paging', () => {
      const evaluation = calculateSeverity({
        category: 'security_vulnerability',
        network: 'mainnet',
        affectedSubsystem: 'api',
        impact: 'critical',
        blastRadius: 'all_users',
        isExploitActive: true,
      });

      expect(evaluation.severity).toBe('P0');
      expect(evaluation.slaMinutes).toBe(15);
      expect(evaluation.requiresPager).toBe(true);
      expect(evaluation.escalationTarget).toBe('on-call-commander');
    });

    it('classifies mainnet indexer data corruption as P0', () => {
      const evaluation = calculateSeverity({
        category: 'incident',
        network: 'mainnet',
        affectedSubsystem: 'indexer',
        impact: 'high',
        blastRadius: 'all_users',
        dataCorruption: true,
      });

      expect(evaluation.severity).toBe('P0');
      expect(evaluation.requiresPager).toBe(true);
    });

    it('classifies critical testnet incidents or mainnet high-blast impacts as P1', () => {
      const evaluationTestnet = calculateSeverity({
        category: 'incident',
        network: 'testnet',
        affectedSubsystem: 'rpc_failover',
        impact: 'critical',
        blastRadius: 'all_users',
      });
      expect(evaluationTestnet.severity).toBe('P1');
      expect(evaluationTestnet.slaMinutes).toBe(60);
      expect(evaluationTestnet.requiresPager).toBe(true);

      const evaluationEnterprise = calculateSeverity({
        category: 'incident',
        network: 'mainnet',
        affectedSubsystem: 'cache',
        impact: 'medium',
        blastRadius: 'enterprise_tier',
      });
      expect(evaluationEnterprise.severity).toBe('P1');
    });

    it('classifies standard contract data disputes and moderate mainnet issues as P2', () => {
      const evaluation = calculateSeverity({
        category: 'data_dispute',
        network: 'mainnet',
        affectedSubsystem: 'metadata_registry',
        impact: 'medium',
        blastRadius: 'single_contract',
      });

      expect(evaluation.severity).toBe('P2');
      expect(evaluation.slaMinutes).toBe(240);
      expect(evaluation.requiresPager).toBe(false);
      expect(evaluation.escalationTarget).toBe('maintainer-queue');
    });

    it('classifies devnet low-impact reports as P3', () => {
      const evaluation = calculateSeverity({
        category: 'community_report',
        network: 'devnet',
        affectedSubsystem: 'api',
        impact: 'low',
        blastRadius: 'internal_only',
      });

      expect(evaluation.severity).toBe('P3');
      expect(evaluation.slaMinutes).toBe(1440);
      expect(evaluation.requiresPager).toBe(false);
      expect(evaluation.escalationTarget).toBe('backlog');
    });
  });

  describe('Data Dispute State Machine', () => {
    it('executes valid dispute progression from intake to resolution', () => {
      const step1 = transitionDisputeStatus('opened', 'quarantined', 'triage-lead', 'Quarantining contested metadata');
      expect(step1.toStatus).toBe('quarantined');
      expect(step1.actor).toBe('triage-lead');

      const step2 = transitionDisputeStatus('quarantined', 'investigating', 'maintainer-1', 'Reviewing commit bytecode');
      expect(step2.toStatus).toBe('investigating');

      const step3 = transitionDisputeStatus('investigating', 'arbitration', 'council-chair', 'Escalating to multi-sign arbiters');
      expect(step3.toStatus).toBe('arbitration');

      const step4 = transitionDisputeStatus('arbitration', 'resolved', 'council-chair', 'Verified publisher signature validated');
      expect(step4.toStatus).toBe('resolved');
    });

    it('allows reopening resolved or dismissed disputes on appeal', () => {
      const reopened = transitionDisputeStatus('resolved', 'opened', 'appellant', 'New counter-evidence submitted');
      expect(reopened.toStatus).toBe('opened');

      const reopenedDismissed = transitionDisputeStatus('dismissed', 'opened', 'appellant', 'Appealed with transaction proofs');
      expect(reopenedDismissed.toStatus).toBe('opened');
    });

    it('rejects invalid state jumps', () => {
      expect(() =>
        transitionDisputeStatus('opened', 'resolved', 'actor'),
      ).toThrowError(/Invalid dispute status transition/);

      expect(() =>
        transitionDisputeStatus('quarantined', 'resolved', 'actor'),
      ).toThrowError(/Invalid dispute status transition/);
    });
  });

  describe('SLA Timer Evaluation', () => {
    it('correctly tracks active remaining time and detects breach', () => {
      const now = new Date('2026-10-19T12:00:00.000Z');
      const createdAtRecent = new Date('2026-10-19T11:50:00.000Z'); // 10m ago

      const recentP0 = evaluateSlaStatus(createdAtRecent, 'P0', now);
      expect(recentP0.breached).toBe(false);
      expect(recentP0.elapsedMinutes).toBe(10);
      expect(recentP0.remainingMinutes).toBe(5); // 15 - 10

      const createdAtOld = new Date('2026-10-19T11:40:00.000Z'); // 20m ago
      const breachedP0 = evaluateSlaStatus(createdAtOld, 'P0', now);
      expect(breachedP0.breached).toBe(true);
      expect(breachedP0.elapsedMinutes).toBe(20);
      expect(breachedP0.remainingMinutes).toBe(-5);
    });
  });
});
