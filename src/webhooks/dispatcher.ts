import { Prisma } from '@prisma/client';
import { prismaRead, prismaWrite } from '../db';
import { featureFlags } from '../feature-flags';
import {
  webhookBatchEvents,
  webhookBatchEventsOtel,
  webhookBatchOperationsOtel,
  webhookBatchOperationsTotal,
  webhookDeliveryDurationOtel,
  webhookDeliveryDurationSeconds,
  webhookEventToDeliveryOtel,
  webhookEventToDeliverySeconds,
  gasFeeAlertDeliveryAttempts,
  gasFeeAlertDeliveryAttemptsOtel,
  gasFeeAlertEventToDeliveryOtel,
  gasFeeAlertEventToDeliverySeconds,
  setWebhookOutboxDepth,
} from '../metrics';
import { processResponseBody } from './redaction';
import { assertSafeUrl, safePost, SsrfBlockedError } from './ssrf-guard';
import { buildWebhookSignatureHeaders } from './webhookVerify';
import { logger } from '../logger';
import { uuidv7 } from '../utils/uuidv7';
import { cleanupAllExpiredWebhookDeliveries } from './retention';
import { enqueueGasFeeAlertDeliveries } from '../services/gasFeeAlertDelivery';
import {
  createBatchIdempotencyKey,
  isBatchBodyWithinLimit,
  orderWebhookEvents,
  serializeWebhookBatch,
} from './batch-utils';

// Maximum delivery attempts before a delivery is marked permanently failed
export const MAX_ATTEMPTS = 5;
// Hard timeout per HTTP request (ms)
export const REQUEST_TIMEOUT_MS = 10_000;
// How long a processing lease is held before it is considered stale (ms)
export const LEASE_DURATION_MS = 60_000;
// Maximum concurrent outbound HTTP deliveries for fan-out and retry (#483)
function boundedIntegerSetting(name: string, fallback: number, max: number): number {
  const parsed = Number(process.env[name]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}

export const DISPATCH_CONCURRENCY = boundedIntegerSetting('WEBHOOK_DISPATCH_CONCURRENCY', 10, 100);

/** Compute exponential backoff delay for a given attempt (1-based). */
export function backoffMs(attempt: number): number {
  // 10s, 30s, 90s, 270s, 810s — capped at 15 min
  return Math.min(10_000 * 3 ** (attempt - 1), 900_000);
}

function recordGasFeeAlertDeliveryOutcome(
  idempotencyKey: string | null,
  outcome: 'success' | 'http_error' | 'network_error' | 'ssrf_blocked',
  isGasFeeAlert: boolean,
  occurredAt?: Date | string,
): void {
  if (!idempotencyKey || !isGasFeeAlert) return;
  gasFeeAlertDeliveryAttempts.inc({ outcome });
  gasFeeAlertDeliveryAttemptsOtel.add(1, { outcome });
  if (outcome === 'success' && occurredAt) {
    const occurredAtMs = new Date(occurredAt).getTime();
    if (Number.isFinite(occurredAtMs)) {
      const elapsedSeconds = Math.max(0, (Date.now() - occurredAtMs) / 1000);
      gasFeeAlertEventToDeliverySeconds.observe(elapsedSeconds);
      gasFeeAlertEventToDeliveryOtel.record(elapsedSeconds);
    }
  }
}

// ── Metrics (#483) ────────────────────────────────────────────────────────────

let _queueDepth = 0;
let _lastDeliveryLatencyMs = 0;

/** Live dispatch metrics exported for observability. */
export function getDispatchMetrics(): { queueDepth: number; lastDeliveryLatencyMs: number } {
  return { queueDepth: _queueDepth, lastDeliveryLatencyMs: _lastDeliveryLatencyMs };
}

// ── Concurrency pool (#483) ───────────────────────────────────────────────────

/**
 * Run `fn` over every item in `items` with at most `concurrency` tasks
 * executing in parallel. Excess items wait in a queue. Errors are collected
 * and aggregated so that one failure does not abort remaining deliveries.
 */
async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;

  const queue = [...items];
  _queueDepth += queue.length;
  const errors: Array<{ item: T; error: unknown }> = [];

  await new Promise<void>((resolve) => {
    let active = 0;
    let settled = 0;
    const total = items.length;

    function next(): void {
      while (active < concurrency && queue.length > 0) {
        const item = queue.shift()!;
        _queueDepth--;
        active++;
        fn(item)
          .catch((error) => {
            errors.push({ item, error });
          })
          .finally(() => {
            active--;
            settled++;
            if (settled === total) {
              if (errors.length > 0) {
                logger.error('[webhooks] Some deliveries failed during fan-out', {
                  total,
                  failed: errors.length,
                  errors: errors.map((e) => ({
                    item:
                      typeof e.item === 'object' && e.item !== null && 'id' in e.item
                        ? (e.item as Record<string, unknown>).id
                        : String(e.item),
                    error: e.error instanceof Error ? e.error.message : String(e.error),
                  })),
                });
              }
              resolve();
            } else {
              next();
            }
          });
      }
    }

    next();
  });
}

// ─────────────────────────────────────────────────────────────────────────────

export interface WebhookPayload {
  id: string;
  contractAddress: string;
  eventType: string;
  topicSymbol?: string | null;
  decoded: unknown;
  ledgerSequence: number;
  ledgerCloseTime: Date;
  transactionHash: string;
}

interface GasFeeAlertWebhookPayload {
  id: string;
  eventType: 'gas_fee_alert';
  network: string;
  occurredAt: Date;
  ruleId: string;
  direction: string;
  thresholdStroops: string;
  previousFeeStroops: string;
  currentFeeStroops: string;
  trend: string;
}

type DeliveryPayload = WebhookPayload | GasFeeAlertWebhookPayload;

// Maximum number of webhook subscriptions fetched per page when fanning out (#724)
export const DISPATCH_PAGE_SIZE = boundedIntegerSetting('WEBHOOK_DISPATCH_PAGE_SIZE', 500, 2_000);
export const MAX_BATCH_BODY_BYTES = 1_000_000;
export const MAX_PENDING_OUTBOX_EVENTS = 50_000;
const MAX_BATCH_SUBSCRIPTIONS_PER_TICK = 50;
let webhookBatchSubscriptionCursor: string | undefined;

interface StoredBatchPayload {
  batchId: string;
  idempotencyKey: string;
  events: WebhookPayload[];
}

type WebhookDeliveryErrorCode =
  | 'SSRF_BLOCKED'
  | 'HTTP_NON_2XX'
  | 'NETWORK_ERROR'
  | 'PAYLOAD_TOO_LARGE';

/**
 * Fan-out a single event to all matching active webhook subscriptions.
 * Uses cursor-based pagination to handle tables with >1 000 rows safely (#724).
 * Batch subscriptions are durably enqueued; immediate subscriptions are fanned
 * out asynchronously. Immediate outbound concurrency is bounded by
 * DISPATCH_CONCURRENCY (#483).
 */
export async function dispatchWebhooks(event: WebhookPayload): Promise<void> {
  // Collect all matching subscriptions via cursor-based pagination (#724).
  // Typed to the projected row shape rather than the full model.
  type DispatchSubscription = {
    id: string;
    url: string;
    secret: string;
    eventType: string;
    topicSymbol: string | null;
    storeResponseBody: boolean;
    responseRetentionDays: number;
  };
  const allSubs: DispatchSubscription[] = [];
  let cursor: string | undefined;
  let hasMore = true;

  while (hasMore) {
    const page = await prismaRead.webhookSubscription.findMany({
      where: {
        active: true,
        ...(event.contractAddress && {
          OR: [{ contractAddress: null }, { contractAddress: event.contractAddress }],
        }),
      },
      select: {
        id: true,
        url: true,
        secret: true,
        eventType: true,
        topicSymbol: true,
        storeResponseBody: true,
        responseRetentionDays: true,
        deliveryStrategy: true,
        batchSize: true,
        batchWindowMs: true,
      },
      take: DISPATCH_PAGE_SIZE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: 'asc' },
    });

    allSubs.push(...page);

    if (page.length < DISPATCH_PAGE_SIZE) {
      hasMore = false;
    } else {
      cursor = page[page.length - 1].id;
    }
  }

  const subs = allSubs;

  const matching = subs.filter((s) => {
    if (s.eventType && s.eventType !== event.eventType) return false;
    if (s.topicSymbol && s.topicSymbol !== event.topicSymbol) return false;
    return true;
  });

  const batchEnabled =
    featureFlags.isAvailableSync('webhookBatchDelivery') &&
    featureFlags.isEnabledSync('webhookBatchDelivery');
  const immediate: typeof matching = [];
  const batched: typeof matching = [];
  for (const sub of matching) {
    if (sub.deliveryStrategy !== 'batch' || batchEnabled) {
      (sub.deliveryStrategy === 'batch' ? batched : immediate).push(sub);
      continue;
    }

    const earlierBatch = await prismaRead.webhookOutboxEvent.findFirst({
      where: {
        subscriptionId: sub.id,
        entityKey: event.contractAddress,
        status: { in: ['pending', 'batched'] },
      },
      select: { id: true },
      take: DISPATCH_CONCURRENCY * 5,
    });
    (earlierBatch ? batched : immediate).push(sub);
  }

  for (const sub of batched) {
    let pendingCount = 0;
    let enqueuedCount = 0;
    try {
      enqueuedCount = await prismaWrite.$transaction(async (tx) => {
        const eligible = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT "id"
          FROM "_webhook_subscriptions"
          WHERE "id" = ${sub.id}
            AND "active" = true
            AND "delivery_strategy" = 'batch'
          FOR UPDATE
        `);
        if (eligible.length === 0) return 0;

        const duplicate = await tx.webhookOutboxEvent.findFirst({
          where: { subscriptionId: sub.id, eventId: event.id },
          select: { id: true },
        });
        if (duplicate) return 0;

        pendingCount = await tx.webhookOutboxEvent.count({
          where: { subscriptionId: sub.id, status: { in: ['pending', 'batched'] } },
        });
        if (pendingCount >= MAX_PENDING_OUTBOX_EVENTS) {
          throw new Error('WEBHOOK_OUTBOX_CAPACITY_EXCEEDED');
        }

        const result = await tx.webhookOutboxEvent.createMany({
          data: [
            {
              id: uuidv7(),
              subscriptionId: sub.id,
              eventId: event.id,
              eventPayload: JSON.parse(JSON.stringify(event)) as Prisma.InputJsonValue,
              entityKey: event.contractAddress,
              ledgerSequence: event.ledgerSequence,
              transactionHash: event.transactionHash,
              expiresAt: new Date(
                Date.now() + Math.max(90, sub.responseRetentionDays) * 24 * 60 * 60 * 1000,
              ),
              updatedAt: new Date(),
            },
          ],
          skipDuplicates: true,
        });
        return result.count;
      });
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'WEBHOOK_OUTBOX_CAPACITY_EXCEEDED') {
        throw error;
      }
      logger.error('[webhooks] Batch outbox capacity reached; event ingestion must retry', {
        subscriptionId: sub.id,
        pendingCount,
      });
      webhookBatchOperationsTotal.inc({ operation: 'enqueue', outcome: 'capacity' });
      webhookBatchOperationsOtel.add(1, { operation: 'enqueue', outcome: 'capacity' });
      throw error;
    }
    if (enqueuedCount > 0) {
      webhookBatchOperationsTotal.inc(
        { operation: 'enqueue', outcome: 'accepted' },
        enqueuedCount,
      );
      webhookBatchOperationsOtel.add(enqueuedCount, {
        operation: 'enqueue',
        outcome: 'accepted',
      });
    }
  }

  void runWithConcurrency(immediate, DISPATCH_CONCURRENCY, (sub) =>
    deliverOnce(
      sub.id,
      sub.url,
      sub.secret,
      event,
      1,
      undefined,
      sub.storeResponseBody,
      sub.responseRetentionDays,
    ),
  ).catch((error) => logger.error('[webhooks] Immediate fan-out failed', { error: String(error) }));
}

/**
 * Claim and deliver ready batches. Event snapshots and membership are persisted
 * before network I/O, so a process crash retries the same signed event set.
 */
export async function flushPendingWebhookBatches(): Promise<void> {
  if (!featureFlags.isAvailableSync('webhookBatchDelivery')) {
    return;
  }

  const subscriptionWhere = {
    active: true,
    deliveryStrategy: 'batch',
    outboxEvents: { some: { status: 'pending' } },
  };
  let subscriptions = await prismaRead.webhookSubscription.findMany({
    where: subscriptionWhere,
    select: {
      id: true,
      url: true,
      secret: true,
      storeResponseBody: true,
      responseRetentionDays: true,
      batchSize: true,
      batchWindowMs: true,
    },
    orderBy: { id: 'asc' },
    take: MAX_BATCH_SUBSCRIPTIONS_PER_TICK,
    ...(webhookBatchSubscriptionCursor
      ? { skip: 1, cursor: { id: webhookBatchSubscriptionCursor } }
      : {}),
  });
  if (subscriptions.length === 0 && webhookBatchSubscriptionCursor) {
    webhookBatchSubscriptionCursor = undefined;
    subscriptions = await prismaRead.webhookSubscription.findMany({
      where: subscriptionWhere,
      select: {
        id: true,
        url: true,
        secret: true,
        storeResponseBody: true,
        responseRetentionDays: true,
        batchSize: true,
        batchWindowMs: true,
      },
      orderBy: { id: 'asc' },
      take: MAX_BATCH_SUBSCRIPTIONS_PER_TICK,
    });
  }
  webhookBatchSubscriptionCursor =
    subscriptions.length === MAX_BATCH_SUBSCRIPTIONS_PER_TICK
      ? subscriptions[subscriptions.length - 1].id
      : undefined;

  const claimed: Array<{
    id: string;
    subscriptionId: string;
    url: string;
    secret: string;
    storeResponseBody: boolean;
    responseRetentionDays: number;
  }> = [];

  for (const sub of subscriptions) {
    const queued = await prismaRead.webhookOutboxEvent.findMany({
      where: { subscriptionId: sub.id, status: 'pending' },
      orderBy: [{ ledgerSequence: 'asc' }, { transactionHash: 'asc' }, { eventId: 'asc' }],
      take: Math.min(sub.batchSize * 20, 2_000),
    });
    if (queued.length === 0) continue;

    const groups = new Map<string, typeof queued>();
    for (const item of queued) {
      const group = groups.get(item.entityKey) ?? [];
      group.push(item);
      groups.set(item.entityKey, group);
    }

    let claimedForSubscription = false;
    for (const [entityKey, entityEvents] of groups) {
      const earlierBatch = await prismaRead.webhookOutboxEvent.findFirst({
        where: {
          subscriptionId: sub.id,
          entityKey,
          status: 'batched',
          batchDelivery: { status: 'pending' },
        },
        select: { id: true },
      });
      if (earlierBatch) continue;

      let selected = entityEvents.slice(0, sub.batchSize);
      const oldest = selected[0];
      const full = selected.length >= sub.batchSize;
      const windowElapsed =
        oldest.createdAt.getTime() + sub.batchWindowMs <= Date.now();
      if (!full && !windowElapsed) continue;

      let eventPayloads = orderWebhookEvents(selected.map(
        (item) => item.eventPayload as unknown as WebhookPayload,
      ));
      let batchId = uuidv7();
      let idempotencyKey = createBatchIdempotencyKey(sub.id, eventPayloads);
      let batchPayload: StoredBatchPayload = { batchId, idempotencyKey, events: eventPayloads };
      let serialized = serializeWebhookBatch(batchPayload, 1);

      while (!isBatchBodyWithinLimit(serialized, MAX_BATCH_BODY_BYTES) && selected.length > 1) {
        selected = selected.slice(0, -1);
        eventPayloads = orderWebhookEvents(selected.map(
          (item) => item.eventPayload as unknown as WebhookPayload,
        ));
        batchId = uuidv7();
        idempotencyKey = createBatchIdempotencyKey(sub.id, eventPayloads);
        batchPayload = { batchId, idempotencyKey, events: eventPayloads };
        serialized = serializeWebhookBatch(batchPayload, 1);
      }

      if (!isBatchBodyWithinLimit(serialized, MAX_BATCH_BODY_BYTES)) {
        const failedDeliveryId = uuidv7();
        await prismaWrite.$transaction(async (tx) => {
          await tx.webhookDelivery.create({
            data: {
              id: failedDeliveryId,
              subscriptionId: sub.id,
              eventId: null,
              batchPayload: {
                batchId,
                idempotencyKey,
                events: [selected[0].eventPayload as unknown as WebhookPayload],
              } as unknown as Prisma.InputJsonValue,
              idempotencyKey,
              attempt: 1,
              status: 'failed',
              processingStatus: 'done',
              errorMsg: 'WEBHOOK_EVENT_PAYLOAD_TOO_LARGE',
              errorCode: 'PAYLOAD_TOO_LARGE',
              expiresAt: new Date(
                Date.now() + Math.max(90, sub.responseRetentionDays) * 24 * 60 * 60 * 1000,
              ),
            },
          });
          await tx.webhookOutboxEvent.updateMany({
            where: { id: selected[0].id, status: 'pending' },
            data: { status: 'failed', batchDeliveryId: failedDeliveryId },
          });
        });
        logger.error('[webhooks] Single event exceeds batch body limit', {
          subscriptionId: sub.id,
          eventId: selected[0].eventId,
          maxBytes: MAX_BATCH_BODY_BYTES,
        });
        webhookBatchOperationsTotal.inc({ operation: 'delivery', outcome: 'payload_too_large' });
        webhookBatchOperationsOtel.add(1, {
          operation: 'delivery',
          outcome: 'payload_too_large',
        });
        continue;
      }

      const deliveryId = uuidv7();
      try {
        await prismaWrite.$transaction(async (tx) => {
          const eligible = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
            SELECT "id"
            FROM "_webhook_subscriptions"
            WHERE "id" = ${sub.id}
              AND "active" = true
              AND "delivery_strategy" = 'batch'
            FOR UPDATE
          `);
          if (eligible.length === 0) {
            throw new Error('WEBHOOK_BATCH_SUBSCRIPTION_INACTIVE');
          }
          await tx.webhookDelivery.create({
            data: {
              id: deliveryId,
              subscriptionId: sub.id,
              eventId: null,
              batchPayload: batchPayload as unknown as Prisma.InputJsonValue,
              idempotencyKey,
              attempt: 1,
              status: 'pending',
              processingStatus: 'processing',
              leaseExpiresAt: new Date(Date.now() + LEASE_DURATION_MS),
              expiresAt: new Date(
                Date.now() + Math.max(90, sub.responseRetentionDays) * 24 * 60 * 60 * 1000,
              ),
            },
          });
          const result = await tx.webhookOutboxEvent.updateMany({
            where: { id: { in: selected.map((item) => item.id) }, status: 'pending' },
            data: { status: 'batched', batchDeliveryId: deliveryId },
          });
          if (result.count !== selected.length) {
            throw new Error('WEBHOOK_BATCH_CLAIM_CONFLICT');
          }
        });
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !['WEBHOOK_BATCH_CLAIM_CONFLICT', 'WEBHOOK_BATCH_SUBSCRIPTION_INACTIVE'].includes(
            error.message,
          )
        ) {
          throw error;
        }
        continue;
      }

      claimed.push({
        id: deliveryId,
        subscriptionId: sub.id,
        url: sub.url,
        secret: sub.secret,
        storeResponseBody: sub.storeResponseBody,
        responseRetentionDays: sub.responseRetentionDays,
      });
      webhookBatchEvents.observe(selected.length);
      webhookBatchEventsOtel.record(selected.length);
      webhookBatchOperationsTotal.inc({ operation: 'claim', outcome: 'success' });
      webhookBatchOperationsOtel.add(1, { operation: 'claim', outcome: 'success' });
      claimedForSubscription = true;
      break;
    }
    if (claimedForSubscription && claimed.length >= DISPATCH_CONCURRENCY * 5) break;
  }

  await runWithConcurrency(claimed, DISPATCH_CONCURRENCY, (delivery) =>
    deliverOnce(
      delivery.subscriptionId,
      delivery.url,
      delivery.secret,
      null,
      1,
      delivery.id,
      delivery.storeResponseBody,
      delivery.responseRetentionDays,
    ),
  );
}

/**
 * Retry all pending deliveries whose nextRetryAt is due.
 * Rows are claimed atomically with a processing lease so that concurrent
 * service replicas cannot pick up the same delivery twice.
 * Concurrency is bounded by DISPATCH_CONCURRENCY (#483).
 *
 * The durable webhook worker calls this once per second.
 */
export async function retryPendingDeliveries(): Promise<void> {
  const now = new Date();
  const leaseExpiry = new Date(now.getTime() + LEASE_DURATION_MS);

  // Atomically claim a batch of due deliveries that are currently idle.
  const claimed = await prismaWrite.$transaction(async (tx) => {
    const rows = await tx.webhookDelivery.findMany({
      where: {
        status: 'pending',
        OR: [
          { processingStatus: 'idle', nextRetryAt: { lte: now } },
          // Re-claim rows whose lease has expired (e.g. the previous worker crashed)
          { processingStatus: 'processing', leaseExpiresAt: { lte: now } },
        ],
      },
      select: { id: true },
    });

    if (rows.length === 0) return [];

    const ids = rows.map((r) => r.id);

    await tx.webhookDelivery.updateMany({
      where: {
        id: { in: ids },
        OR: [
          { processingStatus: 'idle' },
          { processingStatus: 'processing', leaseExpiresAt: { lte: now } },
        ],
      },
      data: { processingStatus: 'processing', leaseExpiresAt: leaseExpiry },
    });

    return tx.webhookDelivery.findMany({
      where: { id: { in: ids }, processingStatus: 'processing', leaseExpiresAt: leaseExpiry },
      include: {
        subscription: {
          select: {
            url: true,
            secret: true,
            active: true,
            storeResponseBody: true,
            responseRetentionDays: true,
          },
        },
      },
    });
  });

  await runWithConcurrency(claimed, DISPATCH_CONCURRENCY, async (d) => {
    // Skip deliveries for inactive subscriptions (#482).
    if (!d.subscription.active) {
      await prismaWrite.$transaction(async (tx) => {
        await tx.webhookDelivery.update({
          where: { id: d.id },
          data: { status: 'cancelled', processingStatus: 'done', leaseExpiresAt: null },
        });
        await tx.webhookOutboxEvent.updateMany({
          where: { batchDeliveryId: d.id },
          data: { status: 'cancelled' },
        });
      });
      return;
    }

    await deliverOnce(
      d.subscriptionId,
      d.subscription.url,
      d.subscription.secret,
      null,
      d.attempt ?? 1,
      d.id,
      d.subscription.storeResponseBody,
      d.subscription.responseRetentionDays,
    );
  });
}

/**
 * Perform a single HTTP delivery attempt.
 * Validates the destination URL against SSRF rules before every request,
 * including on each redirect hop.
 *
 * @param deliveryId  If provided, updates an existing delivery row; otherwise creates one.
 */
async function deliverOnce(
  subscriptionId: string,
  url: string,
  secret: string,
  event: WebhookPayload | null,
  attempt: number,
  deliveryId?: string,
  storeResponseBody: boolean = true,
  responseRetentionDays: number = 90,
): Promise<void> {
  let payload: DeliveryPayload | null = event;
  let batchPayload: StoredBatchPayload | null = null;
  let eventId = event?.id ?? '';
  let deliveryIdempotencyKey: string | null = null;

  if (!payload && deliveryId) {
    const row = await prismaRead.webhookDelivery.findUnique({ where: { id: deliveryId } });
    if (!row) return;
    deliveryIdempotencyKey = row.idempotencyKey ?? null;
    if (row.batchPayload) {
      batchPayload = row.batchPayload as unknown as StoredBatchPayload;
    } else {
      eventId = row.eventId ?? '';
      const ev = await prismaRead.event.findUnique({ where: { id: eventId } });
      if (ev) {
        payload = {
          id: ev.id,
          contractAddress: ev.contractAddress,
          eventType: ev.eventType,
          topicSymbol: ev.topicSymbol,
          decoded: ev.decoded,
          ledgerSequence: ev.ledgerSequence,
          ledgerCloseTime: ev.ledgerCloseTime,
          transactionHash: ev.transactionHash,
        };
      } else {
        const gasEvent = await prismaRead.gasFeeAlertEvent.findUnique({ where: { id: eventId } });
        if (!gasEvent) return;
        payload = {
          id: gasEvent.eventKey,
          eventType: 'gas_fee_alert',
          network: gasEvent.network,
          occurredAt: gasEvent.bucketEnd,
          ruleId: gasEvent.ruleId,
          direction: gasEvent.direction,
          thresholdStroops: gasEvent.thresholdStroops,
          previousFeeStroops: gasEvent.previousFeeStroops,
          currentFeeStroops: gasEvent.currentFeeStroops,
          trend: gasEvent.trend,
        };
      }
    }
  }

  if (!payload && !batchPayload) return;
  const isGasFeeAlert =
    payload !== null && 'network' in payload && payload.eventType === 'gas_fee_alert';

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const body = batchPayload
    ? serializeWebhookBatch(batchPayload, attempt)
    : JSON.stringify({ event: payload, attempt });
  if (batchPayload) headers['Idempotency-Key'] = batchPayload.idempotencyKey;
  else if (deliveryIdempotencyKey) headers['Idempotency-Key'] = deliveryIdempotencyKey;

  // Every subscription now has a secret (#481).
  // X-Webhook-Timestamp + timestamp-bound X-Webhook-Signature-V2 let the
  // receiver enforce a replay window (#884, #1239); the legacy body-only
  // X-Webhook-Signature is still sent for existing consumers.
  Object.assign(headers, buildWebhookSignatureHeaders(body, secret));

  const expiresAt = new Date(Date.now() + responseRetentionDays * 24 * 60 * 60 * 1000);

  let delivery: { id: string };
  if (deliveryId) {
    const updated = await prismaWrite.webhookDelivery.updateMany({
      where: { id: deliveryId, status: 'pending' },
      data: {
        attempt,
        status: 'pending',
        nextRetryAt: null,
        errorMsg: null,
        errorCode: null,
      },
    });
    if (updated.count === 0) return;
    delivery = { id: deliveryId };
  } else {
    delivery = await prismaWrite.webhookDelivery.create({
        data: {
          id: uuidv7(),
          subscriptionId,
          eventId,
          attempt,
          status: 'pending',
          processingStatus: 'processing',
          leaseExpiresAt: new Date(Date.now() + LEASE_DURATION_MS),
          expiresAt,
        },
        select: { id: true },
      });
  }

  // Persist the attempt before DNS resolution so every rejection is auditable.
  try {
    await assertSafeUrl(url);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (err instanceof SsrfBlockedError) {
      recordGasFeeAlertDeliveryOutcome(deliveryIdempotencyKey, 'ssrf_blocked', isGasFeeAlert);
      await prismaWrite.$transaction(async (tx) => {
        await tx.webhookDelivery.update({
          where: { id: delivery.id },
          data: {
            status: 'failed',
            processingStatus: 'done',
            leaseExpiresAt: null,
            errorMsg: msg,
            errorCode: 'SSRF_BLOCKED',
            nextRetryAt: null,
          },
        });
        if (batchPayload) {
          await tx.webhookOutboxEvent.updateMany({
            where: { batchDeliveryId: delivery.id },
            data: { status: 'failed' },
          });
        }
      });
      if (batchPayload) {
        webhookBatchOperationsTotal.inc({ operation: 'delivery', outcome: 'ssrf_blocked' });
        webhookBatchOperationsOtel.add(1, { operation: 'delivery', outcome: 'ssrf_blocked' });
      }
    } else {
      recordGasFeeAlertDeliveryOutcome(deliveryIdempotencyKey, 'network_error', isGasFeeAlert);
      const processedError = storeResponseBody ? processResponseBody(msg, 500, true) : null;
      await scheduleRetryOrFail(
        delivery.id,
        attempt,
        msg,
        undefined,
        processedError,
        'NETWORK_ERROR',
        batchPayload !== null,
      );
      if (batchPayload) {
        webhookBatchOperationsTotal.inc({ operation: 'delivery', outcome: 'retry' });
        webhookBatchOperationsOtel.add(1, { operation: 'delivery', outcome: 'retry' });
      }
    }
    return;
  }

  const startMs = Date.now();

  try {
    const response = await safePost(url, body, headers, REQUEST_TIMEOUT_MS);
    _lastDeliveryLatencyMs = Date.now() - startMs;
    const mode = batchPayload ? 'batch' : 'single';
    webhookDeliveryDurationSeconds.observe({ mode }, _lastDeliveryLatencyMs / 1000);
    webhookDeliveryDurationOtel.record(_lastDeliveryLatencyMs / 1000, { mode });

    const success = response.status >= 200 && response.status < 300;
    const rawResponseBody = String(response.data ?? '');

    if (success) {
      const processedResponseBody = storeResponseBody
        ? processResponseBody(rawResponseBody, 500, true)
        : null;

      await prismaWrite.$transaction(async (tx) => {
        await tx.webhookDelivery.update({
          where: { id: delivery.id },
          data: {
            status: 'success',
            processingStatus: 'done',
            leaseExpiresAt: null,
            httpStatus: response.status,
            responseBody: processedResponseBody,
            deliveredAt: new Date(),
            errorMsg: null,
            errorCode: null,
          },
        });
        if (batchPayload) {
          await tx.webhookOutboxEvent.updateMany({
            where: { batchDeliveryId: delivery.id },
            data: { status: 'delivered' },
          });
        }
      });
      recordGasFeeAlertDeliveryOutcome(
        deliveryIdempotencyKey,
        'success',
        isGasFeeAlert,
        payload && 'occurredAt' in payload ? payload.occurredAt : undefined,
      );
      if (batchPayload) {
        webhookBatchOperationsTotal.inc({ operation: 'delivery', outcome: 'success' });
        webhookBatchOperationsOtel.add(1, { operation: 'delivery', outcome: 'success' });
      }
      const eventTimes = (batchPayload?.events ?? (payload ? [payload] : []))
        .map((item) =>
          new Date(
            String('ledgerCloseTime' in item ? item.ledgerCloseTime : item.occurredAt),
          ).getTime(),
        )
        .filter(Number.isFinite);
      if (eventTimes.length > 0) {
        const eventToDeliverySeconds = Math.max(0, (Date.now() - Math.min(...eventTimes)) / 1000);
        const deliveryMode = batchPayload ? 'batch' : 'single';
        webhookEventToDeliverySeconds.observe({ mode: deliveryMode }, eventToDeliverySeconds);
        webhookEventToDeliveryOtel.record(eventToDeliverySeconds, { mode: deliveryMode });
      }
      return;
    }

    const processedResponseBody = storeResponseBody
      ? processResponseBody(rawResponseBody, 500, true)
      : null;

    await scheduleRetryOrFail(
      delivery.id,
      attempt,
      `HTTP ${response.status}`,
      response.status,
      processedResponseBody,
      'HTTP_NON_2XX',
      batchPayload !== null,
    );
    recordGasFeeAlertDeliveryOutcome(deliveryIdempotencyKey, 'http_error', isGasFeeAlert);
    if (batchPayload) {
      webhookBatchOperationsTotal.inc({ operation: 'delivery', outcome: 'http_error' });
      webhookBatchOperationsOtel.add(1, { operation: 'delivery', outcome: 'http_error' });
    }
  } catch (err: unknown) {
    _lastDeliveryLatencyMs = Date.now() - startMs;
    const mode = batchPayload ? 'batch' : 'single';
    webhookDeliveryDurationSeconds.observe({ mode }, _lastDeliveryLatencyMs / 1000);
    webhookDeliveryDurationOtel.record(_lastDeliveryLatencyMs / 1000, { mode });
    const msg = err instanceof Error ? err.message : String(err);

    // SSRF blocks on redirect are permanent failures — don't retry
    if (err instanceof SsrfBlockedError) {
      recordGasFeeAlertDeliveryOutcome(deliveryIdempotencyKey, 'ssrf_blocked', isGasFeeAlert);
      await prismaWrite.$transaction(async (tx) => {
        await tx.webhookDelivery.update({
          where: { id: delivery.id },
          data: {
            status: 'failed',
            processingStatus: 'done',
            leaseExpiresAt: null,
            errorMsg: msg,
            errorCode: 'SSRF_BLOCKED',
            nextRetryAt: null,
          },
        });
        if (batchPayload) {
          await tx.webhookOutboxEvent.updateMany({
            where: { batchDeliveryId: delivery.id },
            data: { status: 'failed' },
          });
        }
      });
      if (batchPayload) {
        webhookBatchOperationsTotal.inc({ operation: 'delivery', outcome: 'ssrf_blocked' });
        webhookBatchOperationsOtel.add(1, { operation: 'delivery', outcome: 'ssrf_blocked' });
      }
      return;
    }

    recordGasFeeAlertDeliveryOutcome(deliveryIdempotencyKey, 'network_error', isGasFeeAlert);
    const processedError = storeResponseBody ? processResponseBody(msg, 500, true) : null;
    await scheduleRetryOrFail(
      delivery.id,
      attempt,
      msg,
      undefined,
      processedError,
      'NETWORK_ERROR',
      batchPayload !== null,
    );
    if (batchPayload) {
      webhookBatchOperationsTotal.inc({ operation: 'delivery', outcome: 'retry' });
      webhookBatchOperationsOtel.add(1, { operation: 'delivery', outcome: 'retry' });
    }
  }
}

async function scheduleRetryOrFail(
  deliveryId: string,
  attempt: number,
  errorMsg: string,
  httpStatus?: number,
  responseBody?: string | null,
  errorCode?: WebhookDeliveryErrorCode,
  retryIndefinitely: boolean = false,
): Promise<void> {
  const nextAttempt = attempt + 1;

  if (!retryIndefinitely && nextAttempt > MAX_ATTEMPTS) {
    await prismaWrite.$transaction(async (tx) => {
      await tx.webhookDelivery.update({
        where: { id: deliveryId },
        data: {
          status: 'failed',
          processingStatus: 'done',
          leaseExpiresAt: null,
          errorMsg,
          errorCode,
          httpStatus,
          responseBody,
          nextRetryAt: null,
        },
      });
      await tx.webhookOutboxEvent.updateMany({
        where: { batchDeliveryId: deliveryId },
        data: { status: 'failed' },
      });
    });
    return;
  }

  const nextRetryAt = new Date(Date.now() + backoffMs(nextAttempt));
  await prismaWrite.webhookDelivery.update({
    where: { id: deliveryId },
    data: {
      status: 'pending',
      processingStatus: 'idle',
      leaseExpiresAt: null,
      errorMsg,
      errorCode,
      httpStatus,
      responseBody,
      nextRetryAt,
      attempt: nextAttempt,
    },
  });
}

// ── Test / "ping" delivery (#verification) ────────────────────────────────────

export interface TestDeliveryResult {
  deliveryId: string;
  success: boolean;
  /** HTTP status returned by the destination, when a response was received. */
  httpStatus?: number;
  durationMs: number;
  /** Populated when the attempt failed or the destination was SSRF-blocked. */
  error?: string;
  /** True when the destination URL failed the SSRF guard. */
  blocked?: boolean;
}

/**
 * Perform a single, terminal test delivery for a subscription.
 *
 * Unlike `deliverOnce()`, this is user-triggered ("ping") and synchronous:
 *   - exactly one attempt is made — no retry is scheduled, even on failure
 *   - the result is persisted as a WebhookDelivery row
 *   - the outcome is returned so the API can report status/duration inline
 *
 * The signed envelope (`{ event, attempt }`) matches real deliveries so a
 * receiver's signature-verification code works unchanged.
 */
export async function sendTestDelivery(params: {
  subscriptionId: string;
  url: string;
  secret: string;
  /** The `event` object delivered to the endpoint (already serialisable). */
  payload: unknown;
  storeResponseBody: boolean;
  responseRetentionDays: number;
}): Promise<TestDeliveryResult> {
  const { subscriptionId, url, secret, payload, storeResponseBody, responseRetentionDays } = params;

  const body = JSON.stringify({ event: payload, attempt: 1 });
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...buildWebhookSignatureHeaders(body, secret),
  };
  const expiresAt = new Date(Date.now() + responseRetentionDays * 24 * 60 * 60 * 1000);

  const delivery = await prismaWrite.webhookDelivery.create({
    data: {
      id: uuidv7(),
      subscriptionId,
      eventId: '',
      attempt: 1,
      status: 'pending',
      processingStatus: 'processing',
      leaseExpiresAt: new Date(Date.now() + LEASE_DURATION_MS),
      expiresAt,
    },
    select: { id: true },
  });

  const startMs = Date.now();

  // Pre-flight SSRF check before opening a socket.
  try {
    await assertSafeUrl(url);
  } catch (err) {
    const msg = err instanceof SsrfBlockedError ? err.message : String(err);
    await prismaWrite.webhookDelivery.update({
      where: { id: delivery.id },
      data: {
        status: 'failed',
        processingStatus: 'done',
        leaseExpiresAt: null,
        nextRetryAt: null,
        errorMsg: msg,
      },
    });
    return {
      deliveryId: delivery.id,
      success: false,
      durationMs: Date.now() - startMs,
      error: msg,
      blocked: true,
    };
  }

  try {
    const response = await safePost(url, body, headers, REQUEST_TIMEOUT_MS);
    const durationMs = Date.now() - startMs;
    const success = response.status >= 200 && response.status < 300;
    const processedResponseBody = storeResponseBody
      ? processResponseBody(String(response.data ?? ''), 500, true)
      : null;

    await prismaWrite.webhookDelivery.update({
      where: { id: delivery.id },
      data: {
        status: success ? 'success' : 'failed',
        processingStatus: 'done',
        leaseExpiresAt: null,
        nextRetryAt: null,
        httpStatus: response.status,
        responseBody: processedResponseBody,
        deliveredAt: success ? new Date() : null,
        errorMsg: success ? null : `HTTP ${response.status}`,
      },
    });

    return { deliveryId: delivery.id, success, httpStatus: response.status, durationMs };
  } catch (err: unknown) {
    const durationMs = Date.now() - startMs;
    const msg = err instanceof Error ? err.message : String(err);
    const blocked = err instanceof SsrfBlockedError;
    const processedError = storeResponseBody ? processResponseBody(msg, 500, true) : null;

    await prismaWrite.webhookDelivery.update({
      where: { id: delivery.id },
      data: {
        status: 'failed',
        processingStatus: 'done',
        leaseExpiresAt: null,
        nextRetryAt: null,
        errorMsg: msg,
        responseBody: processedError,
      },
    });

    return { deliveryId: delivery.id, success: false, durationMs, error: msg, blocked };
  }
}

let webhookWorkerTimer: NodeJS.Timeout | undefined;
let webhookWorkerRunning = false;
let webhookWorkerTask: Promise<void> | undefined;
let lastWebhookRetryAt = 0;
let lastWebhookDepthRefreshAt = 0;
let lastWebhookRetentionAt = 0;
let webhookWorkerNextAttemptAt = 0;
let webhookWorkerErrorBackoffMs = 0;

async function refreshWebhookOutboxDepth(): Promise<void> {
  if (Date.now() - lastWebhookDepthRefreshAt < 5_000) return;
  const depth = await prismaRead.webhookOutboxEvent.count({
    where: { status: { in: ['pending', 'batched'] } },
  });
  setWebhookOutboxDepth(depth);
  lastWebhookDepthRefreshAt = Date.now();
}

/** Start durable batch flushing and retry processing. Safe to call more than once. */
export function startWebhookDeliveryWorker(): void {
  if (webhookWorkerTimer) return;

  webhookWorkerTimer = setInterval(() => {
    if (webhookWorkerRunning || Date.now() < webhookWorkerNextAttemptAt) return;
    webhookWorkerRunning = true;

    const task = (async () => {
      try {
        await flushPendingWebhookBatches();
        await enqueueGasFeeAlertDeliveries();
        if (Date.now() - lastWebhookRetryAt >= 1_000) {
          await retryPendingDeliveries();
          lastWebhookRetryAt = Date.now();
        }
        if (Date.now() - lastWebhookRetentionAt >= 3_600_000) {
          await cleanupAllExpiredWebhookDeliveries();
          lastWebhookRetentionAt = Date.now();
        }
        await refreshWebhookOutboxDepth();
        webhookWorkerErrorBackoffMs = 0;
      } catch (error) {
        webhookWorkerErrorBackoffMs = Math.min(
          webhookWorkerErrorBackoffMs === 0 ? 100 : webhookWorkerErrorBackoffMs * 2,
          5_000,
        );
        webhookWorkerNextAttemptAt = Date.now() + webhookWorkerErrorBackoffMs;
        logger.error('[webhooks] Delivery worker tick failed', {
          error: error instanceof Error ? error.message : String(error),
          retryInMs: webhookWorkerErrorBackoffMs,
        });
        webhookBatchOperationsTotal.inc({ operation: 'worker', outcome: 'error' });
        webhookBatchOperationsOtel.add(1, { operation: 'worker', outcome: 'error' });
      } finally {
        webhookWorkerRunning = false;
        webhookWorkerTask = undefined;
      }
    })();
    webhookWorkerTask = task;
  }, 25);
  webhookWorkerTimer.unref();
  logger.info('[webhooks] Durable delivery worker started', { pollIntervalMs: 25 });
}

/** Stop polling during graceful service shutdown. An active lease remains recoverable. */
export async function stopWebhookDeliveryWorker(): Promise<void> {
  if (webhookWorkerTimer) {
    clearInterval(webhookWorkerTimer);
    webhookWorkerTimer = undefined;
  }
  if (webhookWorkerTask) await webhookWorkerTask;
  logger.info('[webhooks] Durable delivery worker stopped');
}
