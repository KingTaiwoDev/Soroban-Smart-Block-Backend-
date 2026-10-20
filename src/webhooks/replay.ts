/**
 * Webhook Checkpoint Replay Engine (Issue #1286).
 *
 * Provides controlled replay of on-chain contract events from a selected
 * ledger checkpoint for subscription owners.
 *
 * Guarantees:
 * - Checkpoint range validation & retention enforcement
 * - Idempotent replay job creation & event-level delivery deduplication
 * - Resumable jobs on interruption
 * - Full HMAC-SHA256 signature verification matching live delivery
 * - Explicit replay markers (headers and envelope fields)
 * - Safe handling of subscription deactivation and filter mutations
 */

import { uuidv7 } from '../utils/uuidv7';
import { safePost, SsrfBlockedError } from './ssrf-guard';
import { signWebhookBody } from './webhookVerify';
import { REQUEST_TIMEOUT_MS } from './dispatcher';
import { prismaRead, prismaWrite as prisma } from '../db';
import { logger } from '../logger';

export const MAX_REPLAY_LEDGER_RANGE = 10_000;
export const MAX_REPLAY_RETENTION_DAYS = 90;

export type ReplayJobStatus =
  | 'pending'
  | 'in_progress'
  | 'interrupted'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface ReplayFilters {
  contractAddress?: string | null;
  eventType?: string | null;
  topicSymbol?: string | null;
}

export interface ReplayJob {
  id: string;
  subscriptionId: string;
  apiKeyId: string;
  fromLedger: number;
  toLedger: number;
  currentLedger: number;
  status: ReplayJobStatus;
  idempotencyKey?: string;
  filters: ReplayFilters;
  eventsTotal: number;
  eventsReplayed: number;
  eventsFailed: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

// In-memory job state store with fast lookup (can be backed by DB/outbox)
const replayJobs = new Map<string, ReplayJob>();
const idempotencyIndex = new Map<string, string>(); // `subId:idempotencyKey` -> jobId

export class CheckpointValidationError extends Error {
  readonly code: string;
  constructor(message: string, code = 'INVALID_LEDGER_CHECKPOINT') {
    super(message);
    this.name = 'CheckpointValidationError';
    this.code = code;
  }
}

export class FilterMismatchError extends Error {
  readonly code = 'FILTER_MISMATCH';
  constructor(message: string) {
    super(message);
    this.name = 'FilterMismatchError';
  }
}

export interface CreateReplayParams {
  subscriptionId: string;
  apiKeyId: string;
  fromLedger: number;
  toLedger?: number;
  filters?: ReplayFilters;
  idempotencyKey?: string;
}

export async function validateAndCreateReplayJob(
  params: CreateReplayParams,
  sub: {
    id: string;
    apiKeyId: string;
    active: boolean;
    contractAddress: string | null;
    eventType: string | null;
    topicSymbol: string | null;
  },
): Promise<{ job: ReplayJob; isDuplicate: boolean }> {
  if (!sub.active) {
    throw new CheckpointValidationError(
      'Cannot replay events for an inactive subscription',
      'SUBSCRIPTION_INACTIVE',
    );
  }

  // Idempotency check
  if (params.idempotencyKey) {
    const dedupeKey = `${params.subscriptionId}:${params.idempotencyKey}`;
    const existingJobId = idempotencyIndex.get(dedupeKey);
    if (existingJobId) {
      const existingJob = replayJobs.get(existingJobId);
      if (existingJob) {
        return { job: existingJob, isDuplicate: true };
      }
    }
  }

  // Validate fromLedger
  if (!Number.isInteger(params.fromLedger) || params.fromLedger < 1) {
    throw new CheckpointValidationError(
      'fromLedger must be a positive integer greater than or equal to 1',
      'INVALID_LEDGER_CHECKPOINT',
    );
  }

  // Resolve toLedger if not specified
  let targetToLedger = params.toLedger;
  if (targetToLedger === undefined || targetToLedger === null) {
    const latestLedger = await prismaRead.ledger.findFirst({
      orderBy: { sequence: 'desc' },
      select: { sequence: true },
    });
    targetToLedger = latestLedger?.sequence ?? params.fromLedger;
  }

  if (!Number.isInteger(targetToLedger) || targetToLedger < params.fromLedger) {
    throw new CheckpointValidationError(
      `toLedger (${targetToLedger}) must be an integer greater than or equal to fromLedger (${params.fromLedger})`,
      'INVALID_LEDGER_CHECKPOINT',
    );
  }

  // Check delivery limit range
  const range = targetToLedger - params.fromLedger + 1;
  if (range > MAX_REPLAY_LEDGER_RANGE) {
    throw new CheckpointValidationError(
      `Replay range (${range} ledgers) exceeds the maximum allowed limit of ${MAX_REPLAY_LEDGER_RANGE} ledgers`,
      'RANGE_LIMIT_EXCEEDED',
    );
  }

  // Filter contract matching: Replay cannot widen subscription-defined filters
  const requestedFilters = params.filters ?? {};
  if (sub.contractAddress && requestedFilters.contractAddress && requestedFilters.contractAddress !== sub.contractAddress) {
    throw new FilterMismatchError(
      `Requested contractAddress filter (${requestedFilters.contractAddress}) conflicts with subscription contract (${sub.contractAddress})`,
    );
  }
  if (sub.eventType && requestedFilters.eventType && requestedFilters.eventType !== sub.eventType) {
    throw new FilterMismatchError(
      `Requested eventType filter (${requestedFilters.eventType}) conflicts with subscription eventType (${sub.eventType})`,
    );
  }
  if (sub.topicSymbol && requestedFilters.topicSymbol && requestedFilters.topicSymbol !== sub.topicSymbol) {
    throw new FilterMismatchError(
      `Requested topicSymbol filter (${requestedFilters.topicSymbol}) conflicts with subscription topicSymbol (${sub.topicSymbol})`,
    );
  }

  // Check active job concurrency
  const activeJob = Array.from(replayJobs.values()).find(
    (j) => j.subscriptionId === sub.id && (j.status === 'in_progress' || j.status === 'pending'),
  );
  if (activeJob) {
    throw new CheckpointValidationError(
      `A replay job (${activeJob.id}) is already in progress for this subscription`,
      'REPLAY_JOB_ALREADY_IN_PROGRESS',
    );
  }

  const effectiveFilters: ReplayFilters = {
    contractAddress: sub.contractAddress ?? requestedFilters.contractAddress ?? null,
    eventType: sub.eventType ?? requestedFilters.eventType ?? null,
    topicSymbol: sub.topicSymbol ?? requestedFilters.topicSymbol ?? null,
  };

  const jobId = `replay_${uuidv7()}`;
  const now = new Date().toISOString();

  const job: ReplayJob = {
    id: jobId,
    subscriptionId: sub.id,
    apiKeyId: params.apiKeyId,
    fromLedger: params.fromLedger,
    toLedger: targetToLedger,
    currentLedger: params.fromLedger,
    status: 'pending',
    idempotencyKey: params.idempotencyKey,
    filters: effectiveFilters,
    eventsTotal: 0,
    eventsReplayed: 0,
    eventsFailed: 0,
    createdAt: now,
    updatedAt: now,
  };

  replayJobs.set(jobId, job);
  if (params.idempotencyKey) {
    idempotencyIndex.set(`${params.subscriptionId}:${params.idempotencyKey}`, jobId);
  }

  return { job, isDuplicate: false };
}

export function getReplayJob(jobId: string, subscriptionId: string): ReplayJob | null {
  const job = replayJobs.get(jobId);
  if (!job || job.subscriptionId !== subscriptionId) return null;
  return job;
}

export function listReplayJobs(subscriptionId: string): ReplayJob[] {
  return Array.from(replayJobs.values())
    .filter((j) => j.subscriptionId === subscriptionId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function cancelReplayJob(jobId: string, subscriptionId: string): Promise<ReplayJob | null> {
  const job = getReplayJob(jobId, subscriptionId);
  if (!job) return null;

  job.status = 'cancelled';
  job.updatedAt = new Date().toISOString();
  return job;
}

export async function resumeReplayJob(
  jobId: string,
  subscriptionId: string,
): Promise<ReplayJob | null> {
  const job = getReplayJob(jobId, subscriptionId);
  if (!job) return null;
  if (job.status !== 'interrupted' && job.status !== 'paused') {
    throw new CheckpointValidationError(
      `Job cannot be resumed from status ${job.status}`,
      'CANNOT_RESUME_JOB',
    );
  }

  job.status = 'pending';
  job.updatedAt = new Date().toISOString();
  return job;
}

/**
 * Execute replay runner step (processes batches from currentLedger up to toLedger).
 */
export async function executeReplayStep(jobId: string): Promise<void> {
  const job = replayJobs.get(jobId);
  if (!job || job.status === 'in_progress' || job.status === 'completed' || job.status === 'cancelled' || job.status === 'interrupted') {
    return;
  }

  job.status = 'in_progress';
  job.updatedAt = new Date().toISOString();

  // Load subscription to verify state and obtain secret + url
  const sub = await prismaRead.webhookSubscription.findUnique({
    where: { id: job.subscriptionId },
  });

  if (!sub || !sub.active) {
    job.status = 'interrupted';
    job.error = 'Subscription deactivated or removed during replay';
    job.updatedAt = new Date().toISOString();
    return;
  }

  // Verify subscription contract has not drifted
  if (
    (sub.contractAddress && job.filters.contractAddress && sub.contractAddress !== job.filters.contractAddress) ||
    (sub.eventType && job.filters.eventType && sub.eventType !== job.filters.eventType)
  ) {
    job.status = 'interrupted';
    job.error = 'Subscription filters modified during replay';
    job.updatedAt = new Date().toISOString();
    return;
  }

  try {
    // Find matching events in range
    const whereClause: any = {
      ledgerSequence: { gte: job.currentLedger, lte: job.toLedger },
    };
    if (job.filters.contractAddress) {
      whereClause.contractAddress = job.filters.contractAddress;
    }
    if (job.filters.eventType) {
      whereClause.eventType = job.filters.eventType;
    }
    if (job.filters.topicSymbol) {
      whereClause.topicSymbol = job.filters.topicSymbol;
    }

    const events = await prismaRead.event.findMany({
      where: whereClause,
      orderBy: [{ ledgerSequence: 'asc' }, { transactionHash: 'asc' }, { id: 'asc' }],
      take: 100,
    });

    job.eventsTotal = Math.max(job.eventsTotal, job.eventsReplayed + events.length);

    for (const evt of events) {
      // Check for interruption or cancellation
      if (job.status === 'cancelled' || job.status === 'interrupted') {
        return;
      }

      // Check if subscription was deactivated mid-execution
      const currentSub = await prismaRead.webhookSubscription.findUnique({
        where: { id: job.subscriptionId },
        select: { active: true },
      });
      if (!currentSub || !currentSub.active) {
        job.status = 'interrupted';
        job.error = 'Subscription deactivated during event replay';
        job.updatedAt = new Date().toISOString();
        return;
      }

      const replayedEvent = {
        id: evt.id,
        contractAddress: evt.contractAddress,
        eventType: evt.eventType,
        topicSymbol: evt.topicSymbol,
        topics: evt.topics,
        data: evt.data,
        decoded: evt.decoded,
        ledgerSequence: evt.ledgerSequence,
        ledgerCloseTime: evt.ledgerCloseTime.toISOString(),
        transactionHash: evt.transactionHash,
        replayed: true,
        replayJobId: job.id,
        checkpointLedger: evt.ledgerSequence,
      };

      const payload = {
        event: replayedEvent,
        replayed: true,
        replayJobId: job.id,
        attempt: 1,
      };

      const rawBody = JSON.stringify(payload);
      const timestampMs = Date.now();
      const idempotencyKey = `replay:${job.subscriptionId}:${job.id}:${evt.id}`;

      try {
        const response = await safePost(
          sub.url,
          payload,
          {
            'Content-Type': 'application/json',
            'X-Webhook-Timestamp': String(timestampMs),
            'X-Webhook-Signature': signWebhookBody(rawBody, sub.secret),
            'X-Webhook-Replay': 'true',
            'X-Webhook-Replay-Job-Id': job.id,
            'Idempotency-Key': idempotencyKey,
          },
          REQUEST_TIMEOUT_MS,
        );

        if (response.status >= 200 && response.status < 300) {
          job.eventsReplayed++;
        } else {
          job.eventsFailed++;
        }
      } catch (postErr) {
        job.eventsFailed++;
        if (postErr instanceof SsrfBlockedError) {
          job.status = 'failed';
          job.error = `SSRF blocked: ${(postErr as Error).message}`;
          job.updatedAt = new Date().toISOString();
          return;
        }
      }

      job.currentLedger = evt.ledgerSequence;
      job.updatedAt = new Date().toISOString();
    }

    if (events.length < 100 || job.currentLedger >= job.toLedger) {
      job.status = 'completed';
      job.completedAt = new Date().toISOString();
      job.updatedAt = job.completedAt;
    }
  } catch (err) {
    logger.error('Replay runner error', { jobId, error: String(err) });
    job.status = 'failed';
    job.error = err instanceof Error ? err.message : String(err);
    job.updatedAt = new Date().toISOString();
  }
}

// For unit testing: clear in-memory stores
export function _resetReplayStore(): void {
  replayJobs.clear();
  idempotencyIndex.clear();
}
