export type TriageSeverity = 'P0' | 'P1' | 'P2' | 'P3';

export type TriageCategory =
  | 'security_vulnerability'
  | 'incident'
  | 'data_dispute'
  | 'community_report';

export type TriageSubsystem =
  | 'indexer'
  | 'api'
  | 'rpc_failover'
  | 'cache'
  | 'database'
  | 'metadata_registry'
  | 'auth';

export type DisputeStatus =
  | 'opened'
  | 'quarantined'
  | 'investigating'
  | 'arbitration'
  | 'resolved'
  | 'dismissed';

export interface TriageInput {
  category: TriageCategory;
  network: 'mainnet' | 'testnet' | 'devnet';
  affectedSubsystem: TriageSubsystem;
  impact: 'critical' | 'high' | 'medium' | 'low';
  blastRadius: 'all_users' | 'enterprise_tier' | 'single_contract' | 'internal_only';
  isExploitActive?: boolean;
  dataCorruption?: boolean;
}

export interface TriageEvaluation {
  severity: TriageSeverity;
  slaMinutes: number;
  requiresPager: boolean;
  escalationTarget: string;
  recommendedAction: string;
}

export const SLA_MINUTES: Record<TriageSeverity, number> = {
  P0: 15,
  P1: 60,
  P2: 240, // 4 hours
  P3: 1440, // 24 hours
};

/**
 * Calculates incident or report severity based on network, blast radius, and impact.
 */
export function calculateSeverity(input: TriageInput): TriageEvaluation {
  const { category, network, impact, blastRadius, isExploitActive, dataCorruption } = input;

  // Active exploits or mainnet data corruption are unconditionally P0
  if (
    isExploitActive ||
    (network === 'mainnet' && dataCorruption) ||
    (category === 'security_vulnerability' && impact === 'critical') ||
    (network === 'mainnet' && impact === 'critical' && blastRadius === 'all_users')
  ) {
    return {
      severity: 'P0',
      slaMinutes: SLA_MINUTES.P0,
      requiresPager: true,
      escalationTarget: 'on-call-commander',
      recommendedAction:
        'Initiate war room immediately. Declare outage/incident channel. Page primary and secondary on-call engineers.',
    };
  }

  // P1: High severity impacts on mainnet or critical on testnet
  if (
    (network === 'mainnet' && (impact === 'high' || blastRadius === 'all_users' || blastRadius === 'enterprise_tier')) ||
    (network === 'testnet' && impact === 'critical') ||
    (category === 'security_vulnerability' && (impact === 'high' || impact === 'medium')) ||
    (category === 'data_dispute' && network === 'mainnet' && blastRadius === 'enterprise_tier')
  ) {
    return {
      severity: 'P1',
      slaMinutes: SLA_MINUTES.P1,
      requiresPager: true,
      escalationTarget: 'lead-engineer',
      recommendedAction:
        'Acknowledge incident within 15m. Begin root-cause isolation and stage mitigation patch or fallback switch.',
    };
  }

  // P2: Moderate impact on mainnet, or high impact on testnet
  if (
    (network === 'mainnet' && impact === 'medium') ||
    (network === 'testnet' && impact === 'high') ||
    category === 'data_dispute'
  ) {
    return {
      severity: 'P2',
      slaMinutes: SLA_MINUTES.P2,
      requiresPager: false,
      escalationTarget: 'maintainer-queue',
      recommendedAction:
        'Assign maintainer during normal operating hours. Investigate evidence and update reporter within 4 hours.',
    };
  }

  // P3: Low impact, devnet issues, documentation or cosmetic disputes
  return {
    severity: 'P3',
    slaMinutes: SLA_MINUTES.P3,
    requiresPager: false,
    escalationTarget: 'backlog',
    recommendedAction:
      'Queue for scheduled triage. Review and respond within standard 24-hour maintenance window.',
  };
}

const VALID_DISPUTE_TRANSITIONS: Record<DisputeStatus, DisputeStatus[]> = {
  opened: ['quarantined', 'investigating', 'dismissed'],
  quarantined: ['investigating', 'dismissed'],
  investigating: ['arbitration', 'resolved', 'dismissed'],
  arbitration: ['resolved', 'dismissed'],
  resolved: ['opened'], // can reopen on new evidence
  dismissed: ['opened'], // can reopen on appeal
};

export interface DisputeStateEvent {
  fromStatus: DisputeStatus;
  toStatus: DisputeStatus;
  actor: string;
  reason?: string;
  timestamp: string;
}

/**
 * Validates and executes state transitions across the metadata dispute lifecycle.
 */
export function transitionDisputeStatus(
  current: DisputeStatus,
  next: DisputeStatus,
  actor: string,
  reason?: string,
): DisputeStateEvent {
  const allowed = VALID_DISPUTE_TRANSITIONS[current];
  if (!allowed || !allowed.includes(next)) {
    throw new Error(
      `Invalid dispute status transition from '${current}' to '${next}'. Allowed: ${allowed ? allowed.join(', ') : 'none'}`,
    );
  }

  return {
    fromStatus: current,
    toStatus: next,
    actor,
    reason,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Evaluates SLA status and remaining time for a ticket.
 */
export function evaluateSlaStatus(
  createdAt: Date | string,
  severity: TriageSeverity,
  asOf: Date = new Date(),
): { breached: boolean; elapsedMinutes: number; remainingMinutes: number; slaMinutes: number } {
  const createdDate = typeof createdAt === 'string' ? new Date(createdAt) : createdAt;
  const elapsedMs = asOf.getTime() - createdDate.getTime();
  const elapsedMinutes = Math.max(0, Math.floor(elapsedMs / (60 * 1000)));
  const slaMinutes = SLA_MINUTES[severity];
  const remainingMinutes = slaMinutes - elapsedMinutes;

  return {
    breached: remainingMinutes < 0,
    elapsedMinutes,
    remainingMinutes,
    slaMinutes,
  };
}
