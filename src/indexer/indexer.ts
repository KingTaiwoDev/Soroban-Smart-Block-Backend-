import WebSocket from 'ws';
import { realtimeHub } from '../realtime/eventHub';
import { xdr } from '@stellar/stellar-sdk';
import { prismaRead, prismaWrite, prismaWrite as prisma } from '../db';
import { config } from '../config';
import { recordIndexerFreshness } from './freshness';
import {
  indexerPipelineStageDuration,
  indexerPipelineStageLag,
  indexerPipelineStageProcessedTotal,
  setIndexerProgress,
} from '../metrics';
import {
  fetchEvents,
  getLatestLedger,
  getRpcWebsocketUrl,
  getTransaction,
  getTransactionFromHorizon,
  type LedgerEvent,
  fetchLedgerMetadata,
  fetchLedgerMetadataBatch,
} from './rpc';
import { decodeTransaction, decodeEventStrict } from './decoder';
import { enqueueFailure, recordLedgerDecodeError } from './errorQueue';
import { decodeZkpVerification, recordZkpVerification } from './zkp-verifier';
import { processAaTransaction } from './aa-indexer';
import { feedOrchestrator } from '../feed/orchestrator';
import { dispatchWebhooks } from '../webhooks/dispatcher';
import { enqueueInitialAudit } from './audit-pipeline';
import { amIResponsibleFor, getRangeCursor, isP2pEnabled, setRangeCursor } from '../p2p';
import { logger } from '../logger';
import { withSpan } from '../tracer';
import { uuidv7 } from '../utils/uuidv7';
import { startSavedSearchScheduler, stopSavedSearchScheduler } from './savedSearchRunner';
import {
  indexContract,
  indexEvent,
  indexTransaction,
  indexSafely,
} from '../services/search/full-text-search';
import { processCheckpointedRange, type CatchUpCheckpointStore } from './catch-up';
import { getIndexerPauseState } from './worker-control';
import { WriteLatencyBackpressure, createCatchUpBudget, missingLedgerRanges } from './ledger-range-guard';

const BATCH = config.indexerBatchSize;
const WORKERS = config.indexerCatchupWorkers;
const CHECKPOINT_WINDOW_SIZE = 100;
const writeBackpressure = new WriteLatencyBackpressure();

const catchUpCheckpointStore: CatchUpCheckpointStore = {
  async findUnique({ where: { network_rangeStart_rangeEnd: key } }) {
    const rows = await prismaWrite.$queryRaw<
      Array<{
        lastCommittedLedger: number | null;
        completed: boolean;
      }>
    >`
      SELECT "last_committed_ledger" AS "lastCommittedLedger", "completed"
      FROM "_catch_up_checkpoints"
      WHERE "network" = ${key.network}
        AND "range_start" = ${key.rangeStart}
        AND "range_end" = ${key.rangeEnd}
      LIMIT 1
    `;
    return rows[0] ?? null;
  },
  async upsert({ where: { network_rangeStart_rangeEnd: key }, create, update }) {
    await prismaWrite.$executeRaw`
      INSERT INTO "_catch_up_checkpoints"
        ("id", "network", "range_start", "range_end", "last_committed_ledger", "completed", "updated_at", "created_at")
      VALUES
        (${create.id}, ${key.network}, ${key.rangeStart}, ${key.rangeEnd}, ${update.lastCommittedLedger}, ${update.completed}, NOW(), NOW())
      ON CONFLICT ("network", "range_start", "range_end")
      DO UPDATE SET
        "last_committed_ledger" = EXCLUDED."last_committed_ledger",
        "completed" = EXCLUDED."completed",
        "updated_at" = NOW()
    `;
  },
};

function withIndexerSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  operation: () => PromiseLike<T> | T,
): Promise<T> {
  return withSpan(name, async (span) => {
    span.setAttributes({ ...attributes, 'network.name': config.profile.name });
    return await operation();
  });
}

// ---------------------------------------------------------------------------
// IndexerState helpers & High Availability (HA) Leader Election
// ---------------------------------------------------------------------------

const getActiveNetwork = (): string => config.stellarNetwork;

export async function getLastIndexedLedger(network = getActiveNetwork()): Promise<number> {
  if (isP2pEnabled()) {
    return getLastIndexedLedgerP2p();
  }
  const state = await prisma.indexerState.findFirst({
    where: { network, id: 'singleton' },
  });
  if (!state) {
    const created = await prisma.indexerState.create({
      data: {
        id: 'singleton',
        network,
        lastLedger: config.indexerStartLedger,
        version: 0,
      },
    });
    return created.lastLedger;
  }
  return state.lastLedger;
}

async function getLastIndexedLedgerP2p(): Promise<number> {
  return getRangeCursor(config.indexerStartLedger);
}

export async function setLastIndexedLedger(
  ledger: number,
  network = getActiveNetwork(),
): Promise<void> {
  if (isP2pEnabled()) {
    await setRangeCursor(ledger, ledger);
    await refreshIndexerFreshness(ledger, network);
    return;
  }

  // Optimistic concurrency CAS guard
  const existing = await prisma.indexerState.findFirst({
    where: { network, id: 'singleton' },
  });

  if (!existing) {
    await prisma.indexerState.create({
      data: {
        id: 'singleton',
        network,
        lastLedger: ledger,
        version: 1,
      },
    });
    await refreshIndexerFreshness(ledger, network);
    return;
  }

  // Compare-and-swap update
  const updated = await prisma.indexerState.updateMany({
    where: {
      network,
      id: 'singleton',
      version: existing.version,
    },
    data: {
      lastLedger: ledger,
      version: existing.version + 1,
    },
  });

  if (updated.count === 0) {
    logger.warn(
      `[IndexerState] Optimistic concurrency lock conflict detected for network '${network}' when setting cursor to ${ledger}. Retrying update...`,
    );
    // Fallback upsert on conflict
    await prisma.indexerState.updateMany({
      where: { network, id: 'singleton' },
      data: { lastLedger: ledger, version: { increment: 1 } },
    });
  }

  await refreshIndexerFreshness(ledger, network);
}

async function refreshIndexerFreshness(ledger: number, network: string): Promise<void> {
  try {
    const indexedLedger = await prismaWrite.ledger.findUnique({
      where: { sequence: ledger },
      select: { closeTime: true },
    });
    if (!indexedLedger) {
      logger.warn(`[indexer] freshness metrics not updated: ledger ${ledger} is not persisted`);
      return;
    }

    const networkTip = await getLatestLedger().catch((error: unknown): undefined => {
      logger.warn('[indexer] unable to refresh ledger-lag metric from RPC', { error });
      return undefined;
    });
    recordIndexerFreshness(network, ledger, indexedLedger.closeTime, networkTip);
  } catch (error) {
    logger.warn('[indexer] unable to refresh indexer freshness metrics', { error });
  }
}

/**
 * Acquire leader lease for HA multi-instance deployments.
 */
export async function acquireLeaderLease(
  nodeId: string,
  network = getActiveNetwork(),
  ttlMs = 30000,
): Promise<boolean> {
  const now = new Date();
  const leaseExpiresAt = new Date(now.getTime() + ttlMs);

  // Read state
  const state = await prisma.indexerState.findFirst({
    where: { network, id: 'singleton' },
  });

  if (!state) {
    await prisma.indexerState.create({
      data: {
        id: 'singleton',
        network,
        lastLedger: config.indexerStartLedger,
        leaderId: nodeId,
        leaderLeaseExpiresAt: leaseExpiresAt,
        version: 1,
      },
    });
    return true;
  }

  // Check if current lease is expired or owned by nodeId
  const isExpired = !state.leaderLeaseExpiresAt || state.leaderLeaseExpiresAt < now;
  const isSelf = state.leaderId === nodeId;

  if (isExpired || isSelf) {
    const res = await prisma.indexerState.updateMany({
      where: {
        network,
        id: 'singleton',
        version: state.version,
      },
      data: {
        leaderId: nodeId,
        leaderLeaseExpiresAt: leaseExpiresAt,
        version: state.version + 1,
      },
    });
    return res.count > 0;
  }

  return false;
}

/** Release leader lease */
export async function releaseLeaderLease(
  nodeId: string,
  network = getActiveNetwork(),
): Promise<void> {
  await prisma.indexerState.updateMany({
    where: { network, id: 'singleton', leaderId: nodeId },
    data: { leaderId: null, leaderLeaseExpiresAt: null },
  });
}

export async function rollbackLedgers(sequences: number[]) {
  const network = getActiveNetwork();
  logger.info(`⚠️ Rollback triggered for ledgers: ${sequences.join(', ')}`);

  await prismaWrite.$transaction([
    // Delete SessionAuthorizations related to these ledgers
    prismaWrite.sessionAuthorization.deleteMany({
      where: {
        startLedger: { in: sequences },
      },
    }),

    // Delete Events for these ledgers
    prismaWrite.event.deleteMany({
      where: {
        network,
        ledgerSequence: { in: sequences },
      },
    }),

    // Delete Transactions for these ledgers
    prismaWrite.transaction.deleteMany({
      where: {
        network,
        ledgerSequence: { in: sequences },
      },
    }),

    // Delete WasmUpgradeHistory for these ledgers
    prismaWrite.wasmUpgradeHistory.deleteMany({
      where: {
        ledgerSequence: { in: sequences },
      },
    }),

    // Delete Ledgers themselves
    prismaWrite.ledger.deleteMany({
      where: {
        network,
        sequence: { in: sequences },
      },
    }),
  ]);

  // Drop the rolled-back ledgers' search documents too, otherwise a reorg
  // leaves orphaned hits in the full-text index. Best-effort: a failure here
  // must never abort the rollback itself.
  try {
    await prismaWrite.$executeRawUnsafe(
      `DELETE FROM "_search_documents" WHERE "metadata"->>'ledgerSequence' = ANY($1::text[])`,
      sequences.map(String),
    );
  } catch (err) {
    logger.warn('search index cleanup after rollback failed', { error: String(err) });
  }
}

export async function processLedgerRange(
  start: number,
  end: number,
  opts: { force?: boolean } = {},
): Promise<IndexedLedgerRange> {
  return withIndexerSpan(
    'indexer.ledger_range',
    { 'ledger.range.start': start, 'ledger.range.end': end },
    () => processLedgerRangeInternal(start, end, opts),
  );
}

async function processLedgerRangeInternal(
  start: number,
  end: number,
  opts: { force?: boolean },
): Promise<void> {
  logger.info(`Indexing ledgers ${start} → ${end}`, {
    ledgerSequence: start,
    ledgerRangeEnd: end,
  });

  // Stage lag metrics update
  try {
    const latestTip = await getLatestLedger().catch(() => end);
    const lag = Math.max(0, latestTip - end);
    const network = config.stellarNetwork;
    indexerPipelineStageLag.set({ network, stage: 'fetch' }, lag);
    indexerPipelineStageLag.set({ network, stage: 'decode' }, lag);
    indexerPipelineStageLag.set({ network, stage: 'persist' }, lag);
    indexerPipelineStageLag.set({ network, stage: 'enrich' }, lag);
  } catch (err) {
    // Non-blocking metrics gauge catch
  }

  // Stage 1: FETCH metadata & Reorg check
  const stopFetchTimer = indexerPipelineStageDuration.startTimer({ stage: 'fetch' });

  // #913 — prefetch ledger metadata for this worker's sequences with bounded
  // concurrency instead of awaiting one RPC/Horizon round-trip per ledger.
  // Downstream reorg-check/persist logic below still runs strictly in order.
  const responsibleSeqs: number[] = [];
  for (let seq = start; seq <= end; seq++) {
    if (opts.force || (await amIResponsibleFor(seq))) {
      responsibleSeqs.push(seq);
    }
  }
  const prefetchedMeta = await withIndexerSpan(
    'indexer.ledger.fetch_metadata',
    { 'ledger.range.start': start, 'ledger.range.end': end },
    () => fetchLedgerMetadataBatch(responsibleSeqs),
  );

  for (const seq of responsibleSeqs) {
    const ledgerMeta =
      prefetchedMeta.get(seq) ??
      (await withIndexerSpan('indexer.ledger.fetch_metadata', { 'ledger.sequence': seq }, () =>
        fetchLedgerMetadata(seq),
      ));

    // Deep Reorg Check & Extended Backtracking
    const prevSeq = seq - 1;
    const prevLedger = await prismaRead.ledger.findUnique({
      where: { network_sequence: { network, sequence: prevSeq } },
    });

    if (prevLedger && prevLedger.hash !== ledgerMeta.previousLedgerHash) {
      logger.warn(
        `🚨 REORG DETECTED at ledger ${seq}! Local hash ${prevLedger.hash} vs network expected ${ledgerMeta.previousLedgerHash}`,
        { ledgerSequence: seq },
      );

      const maxDepth = config.indexerReorgProtectionDepth || 100;
      const rolledBackSequences: number[] = [prevSeq];
      let commonAncestorFound = false;
      let commonAncestorSeq = prevSeq - 1;

      // Backtrack up to maxDepth ledgers to locate common ancestor
      for (let depth = 1; depth < maxDepth; depth++) {
        const checkSeq = prevSeq - depth;
        if (checkSeq <= 0) break;

        const localCheckLedger = await prismaRead.ledger.findUnique({
          where: { network_sequence: { network, sequence: checkSeq } },
        });
        if (!localCheckLedger) break;

        let remoteCheckMeta = null;
        try {
          remoteCheckMeta = await fetchLedgerMetadata(checkSeq);
        } catch (e) {
          logger.error(
            `Failed to fetch remote metadata for deep reorg check at ledger ${checkSeq}`,
            { ledgerSequence: checkSeq, error: e },
          );
          break;
        }

        if (localCheckLedger.hash === remoteCheckMeta.hash) {
          commonAncestorFound = true;
          commonAncestorSeq = checkSeq;
          logger.info(`Found common ancestor at ledger sequence ${checkSeq} (depth: ${depth})`, {
            ledgerSequence: checkSeq,
          });
          break;
        } else {
          rolledBackSequences.push(checkSeq);
        }
      }

      if (!commonAncestorFound) {
        logger.error(
          `🚨 DEEP REORG EXCEEDS SAFETY THRESHOLD (${maxDepth} ledgers). Performing safety rollback for ${rolledBackSequences.length} ledgers.`,
          { ledgerSequence: seq },
        );
      }

      // Record Reorg event and perform atomic single DB transaction rollback
      await prismaWrite.reorgEvent.create({
        data: {
          ledgerSequence: seq,
          expectedHash: prevLedger.hash,
          actualHash: ledgerMeta.previousLedgerHash,
          previousHash: prevLedger.previousLedgerHash ?? '',
          rolledBackLedgers: rolledBackSequences,
        },
      });

      await rollbackLedgers(rolledBackSequences);
      await setLastIndexedLedger(commonAncestorSeq);

      throw new Error(
        `Reorg detected at ledger ${seq}. Rolled back ${rolledBackSequences.length} ledgers (${rolledBackSequences.join(', ')}). Resuming from common ancestor ${commonAncestorSeq}.`,
      );
    }

    // Persist Ledger record
    const stopPersistLedgerTimer = indexerPipelineStageDuration.startTimer({ stage: 'persist' });
    const writeStartedAt = Date.now();
    await withIndexerSpan('indexer.ledger.persist', { 'ledger.sequence': seq }, () =>
      prismaWrite.ledger.upsert({
        where: { sequence: seq },
        update: {
          hash: ledgerMeta.hash,
          previousLedgerHash: ledgerMeta.previousLedgerHash,
          closeTime: ledgerMeta.closeTime,
          txCount: ledgerMeta.txCount,
        },
        create: {
          sequence: seq,
          hash: ledgerMeta.hash,
          previousLedgerHash: ledgerMeta.previousLedgerHash,
          closeTime: ledgerMeta.closeTime,
          txCount: ledgerMeta.txCount,
        },
      }),
    );
    const backpressureDelay = writeBackpressure.record(Date.now() - writeStartedAt);
    if (backpressureDelay > 0) {
      logger.warn(`[indexer] database write latency is elevated; delaying ${backpressureDelay}ms`);
      await new Promise<void>((resolve) => setTimeout(resolve, backpressureDelay));
    }
    stopPersistLedgerTimer();
    indexerPipelineStageProcessedTotal.inc({ stage: 'persist', status: 'success' });
    realtimeHub.publishLedger({
      sequence: seq,
      hash: ledgerMeta.hash,
      closeTime: new Date(ledgerMeta.closeTime).toISOString(),
      txCount: ledgerMeta.txCount,
    });
  }

  // Complete Stage 1 (Fetch)
  stopFetchTimer();
  indexerPipelineStageProcessedTotal.inc({ stage: 'fetch', status: 'success' });

  // Stage 2 & 3: FETCH events & DECODE / PERSIST / ENRICH events and transactions
  const stopEventsFetchTimer = indexerPipelineStageDuration.startTimer({ stage: 'fetch' });
  const events = await withIndexerSpan(
    'indexer.events.fetch',
    { 'ledger.range.start': start, 'ledger.range.end': end },
    () => fetchEvents(start, end),
  );
  stopEventsFetchTimer();
  const legacyEventIds = events.map(
    (event, index) =>
      `${event.transactionHash}-${event.pagingToken || `${event.ledgerSequence}-${index}`}`,
  );
  const existingLegacyEvents = legacyEventIds.length
    ? await prismaWrite.event.findMany({
        where: { id: { in: legacyEventIds } },
        select: { id: true, network: true },
      })
    : [];
  const legacyEventNetworks = new Map(
    existingLegacyEvents.map((event) => [event.id, event.network]),
  );
  const indexedLedgerSequences = new Set(responsibleSeqs);
  const indexedTransactionHashes = new Set<string>();
  const indexedEventIds = new Set<string>();

  // Contracts recur across every event in the range — index each address once
  // per processed range rather than once per event.
  const indexedContracts = new Set<string>();

  for (const [eventIndex, event] of events.entries()) {
    realtimeHub.publishContractEvent({
      contractId: event.contractId,
      eventType: event.topics[0] ?? 'unknown',
      topics: event.topics,
      data: event.data,
      ledgerSequence: event.ledgerSequence,
      transactionHash: event.transactionHash,
      pagingToken: event.pagingToken,
    });
    const stopPersistContractTimer = indexerPipelineStageDuration.startTimer({ stage: 'persist' });
    const contract = await withIndexerSpan(
      'indexer.contract.persist',
      { 'ledger.sequence': event.ledgerSequence },
      () =>
        prismaWrite.contract.upsert({
          where: { address: event.contractId },
          update: {},
          create: { address: event.contractId },
        }),
    );
    stopPersistContractTimer();

    if (!indexedContracts.has(event.contractId)) {
      indexedContracts.add(event.contractId);
      await indexSafely('contract', () => indexContract(contract));
    }

    // Enrich Stage: Queue initial audit
    const stopEnrichAuditTimer = indexerPipelineStageDuration.startTimer({ stage: 'enrich' });
    enqueueInitialAudit(event.contractId);
    stopEnrichAuditTimer();
    indexerPipelineStageProcessedTotal.inc({ stage: 'enrich', status: 'success' });

    const existingTx = await prisma.transaction.findUnique({
      where: {
        network_hash: { network, hash: event.transactionHash },
      },
    });

    if (!existingTx) {
      // Decode Stage
      const stopDecodeTxTimer = indexerPipelineStageDuration.startTimer({ stage: 'decode' });
      const txResult = await withIndexerSpan(
        'indexer.transaction.fetch',
        { 'ledger.sequence': event.ledgerSequence },
        () =>
          getTransaction(event.transactionHash).catch(() =>
            getTransactionFromHorizon(event.transactionHash).catch((): null => null),
          ),
      );
      const txResultData = txResult as Record<string, unknown> | null;
      const rawXdr = typeof (txResultData?.envelopeXdr as { toXDR?: Function } | undefined)?.toXDR === 'function' ? (txResultData?.envelopeXdr as { toXDR(fmt: string): string }).toXDR('base64') : '';
      const decoded = rawXdr
        ? await withIndexerSpan(
            'indexer.transaction.decode',
            { 'ledger.sequence': event.ledgerSequence },
            () => decodeTransaction(rawXdr),
          )
        : {
            contractAddress: event.contractId,
            functionName: null,
            functionArgs: null,
            humanReadable: null,
          };
      stopDecodeTxTimer();
      indexerPipelineStageProcessedTotal.inc({ stage: 'decode', status: 'success' });

      // Persist Stage
      const stopPersistTxTimer = indexerPipelineStageDuration.startTimer({ stage: 'persist' });
      const transaction = await prismaWrite.transaction.upsert({
        where: { hash: event.transactionHash },
        update: {},
        create: {
          id: uuidv7(),
          hash: event.transactionHash,
          ledgerSequence: event.ledgerSequence,
          ledgerCloseTime: event.ledgerCloseTime,
          sourceAccount: String(txResultData?.sourceAccount ?? 'unknown'),
          contractAddress: decoded.contractAddress,
          functionName: decoded.functionName,
          functionArgs: (decoded.functionArgs as object) ?? undefined,
          rawXdr,
          status: txResultData?.status === 'SUCCESS' ? 'success' : 'failed',
          humanReadable: decoded.humanReadable,
          feeCharged: String(txResultData?.feeCharged ?? ''),
        },
      });
      stopPersistTxTimer();
      indexerPipelineStageProcessedTotal.inc({ stage: 'persist', status: 'success' });

      // Search Stage: keep the full-text index in step with new transactions
      await indexSafely('transaction', () => indexTransaction(transaction));

      // Enrich Stage: ZKP & AA & Feeds
      const stopEnrichTxTimer = indexerPipelineStageDuration.startTimer({ stage: 'enrich' });
      try {
        if (rawXdr && decoded.functionName && decoded.contractAddress) {
          const envelope = xdr.TransactionEnvelope.fromXDR(rawXdr, 'base64');
          const ops =
            envelope.switch().name === 'envelopeTypeTx'
              ? envelope.v1().tx().operations()
              : envelope.v0().tx().operations();
          const invokeOp = ops.find((op) => op.body().switch().name === 'invokeHostFunction');
          const scArgs = invokeOp
            ? invokeOp.body().invokeHostFunctionOp().hostFunction().invokeContract().args()
            : [];
          const zkpData = decodeZkpVerification(decoded.functionName, scArgs);
          if (zkpData) {
            await recordZkpVerification(
              transaction.hash,
              decoded.contractAddress,
              zkpData,
              transaction.ledgerSequence,
              transaction.ledgerCloseTime,
            );
          }
        }
      } catch (zkpErr) {
        logger.error('ZKP recording error:', zkpErr);
      }

      try {
        void processAaTransaction(
          transaction.hash,
          transaction.sourceAccount,
          rawXdr,
          transaction.ledgerSequence,
          transaction.ledgerCloseTime,
          transaction.feeCharged ?? undefined,
        );
      } catch (err) {
        logger.error('AA processing error:', err);
      }

      await feedOrchestrator
        .publishTransaction(transaction)
        .catch((err) => logger.error('publishTransaction error:', err));

      stopEnrichTxTimer();
      indexerPipelineStageProcessedTotal.inc({ stage: 'enrich', status: 'success' });
    }
    indexedTransactionHashes.add(event.transactionHash);

    const positionKey = event.pagingToken || `${event.ledgerSequence}-${eventIndex}`;
    const legacyEventId = `${event.transactionHash}-${positionKey}`;
    const eventId = eventPersistenceId(
      network,
      event.transactionHash,
      positionKey,
      legacyEventNetworks.get(legacyEventId),
    );

    // Decode & Persist Event. Malformed XDR is an item-level fault, not a
    // ledger-level fault: persist operational context, send it to the DLQ,
    // and continue with the next event in this range.
    const stopDecodeEventTimer = indexerPipelineStageDuration.startTimer({ stage: 'decode' });
    let decodedEvent: ReturnType<typeof decodeEventStrict>;
    try {
      decodedEvent = await withIndexerSpan(
        'indexer.event.decode',
        { 'ledger.sequence': event.ledgerSequence },
        async () => decodeEventStrict(event.topics, event.data),
      );
      indexerPipelineStageProcessedTotal.inc({ stage: 'decode', status: 'success' });
    } catch (cause) {
      const error = new Error(
        `Malformed event XDR for ${eventId}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      await recordLedgerDecodeError({
        network,
        eventId,
        ledger: event.ledgerSequence,
        transactionHash: event.transactionHash,
        eventIndex,
        topics: event.topics,
        data: event.data,
        error,
      });
      await enqueueFailure({
        itemType: 'event',
        itemId: eventId,
        ledger: event.ledgerSequence,
        rawXdr: JSON.stringify({ topics: event.topics, data: event.data }),
        error,
        context: { network, eventIndex, transactionHash: event.transactionHash },
      });
      logger.error('[indexer] isolated malformed event', {
        network,
        ledger: event.ledgerSequence,
        eventId,
        error: error.message,
      });
      indexerPipelineStageProcessedTotal.inc({ stage: 'decode', status: 'error' });
      continue;
    } finally {
      stopDecodeEventTimer();
    }
    const { eventType, decoded } = decodedEvent;

    const stopPersistEventTimer = indexerPipelineStageDuration.startTimer({ stage: 'persist' });
    const savedEvent = await withIndexerSpan(
      'indexer.event.persist',
      { 'ledger.sequence': event.ledgerSequence },
      () =>
        prismaWrite.event.upsert({
          where: { id: eventId },
          update: {},
          create: {
            id: eventId,
            transactionHash: event.transactionHash,
            contractAddress: event.contractId,
            eventType,
            topics: event.topics,
            data: { raw: event.data },
            decoded: decoded as object,
            ledgerSequence: event.ledgerSequence,
            ledgerCloseTime: event.ledgerCloseTime,
          },
        }),
    );
    stopPersistEventTimer();
    indexerPipelineStageProcessedTotal.inc({ stage: 'persist', status: 'success' });
    indexedEventIds.add(eventId);

    // Search Stage: index the decoded event for discovery
    await indexSafely('event', () => indexEvent(savedEvent));

    // Enrich Event: Feeds & Session Authorization
    const stopEnrichEventTimer = indexerPipelineStageDuration.startTimer({ stage: 'enrich' });
    await feedOrchestrator
      .publishEvent(savedEvent)
      .catch((err) => logger.error('publishEvent error:', err));

    await dispatchWebhooks({
      id: savedEvent.id,
      contractAddress: savedEvent.contractAddress,
      eventType: savedEvent.eventType,
      topicSymbol: savedEvent.topicSymbol,
      decoded: savedEvent.decoded,
      ledgerSequence: savedEvent.ledgerSequence,
      ledgerCloseTime: savedEvent.ledgerCloseTime,
      transactionHash: savedEvent.transactionHash,
    });

    await processSessionAuthorization(event, eventType, decoded, eventId);
    stopEnrichEventTimer();
    indexerPipelineStageProcessedTotal.inc({ stage: 'enrich', status: 'success' });
  }

  return {
    network,
    ledgerSequences: indexedLedgerSequences,
    transactionHashes: [...indexedTransactionHashes],
    eventIds: [...indexedEventIds],
  };
}

/**
 * Indexes exactly one ledger regardless of range ownership — used as the
 * P2P "graceful degradation" on-the-fly indexing fallback (design doc §1.3)
 * when a query's range owners are all unreachable.
 */
export async function indexSingleLedger(ledgerSeq: number): Promise<void> {
  await processLedgerRange(ledgerSeq, ledgerSeq, { force: true });
}

// ---------------------------------------------------------------------------
// Parallel catch-up with durable per-batch checkpointing
// ---------------------------------------------------------------------------

/**
 * Run parallel workers over fixed, network-scoped checkpoint windows. Stable
 * boundaries let a later catch-up with a different target resume the same
 * work, while a failed checkpoint write stops cursor advancement.
 *
 * Database upserts use deterministic transaction/event keys, so a crash
 * between persistence and checkpointing can safely replay the last batch.
 */
async function catchUp(from: number, to: number): Promise<boolean> {
  const budget = createCatchUpBudget();
  const boundedTo = Math.min(to, from + budget.maxLedgers - 1);
  if (boundedTo < to) {
    logger.info(`[catch-up] limiting this pass to ${from}–${boundedTo} (${budget.maxLedgers} ledgers)`);
    to = boundedTo;
  }
  const firstWindow = Math.floor((from - 1) / CHECKPOINT_WINDOW_SIZE) * CHECKPOINT_WINDOW_SIZE + 1;
  const windows: Array<[number, number, number, number]> = [];
  for (let windowStart = firstWindow; windowStart <= to; windowStart += CHECKPOINT_WINDOW_SIZE) {
    const windowEnd = windowStart + CHECKPOINT_WINDOW_SIZE - 1;
    windows.push([windowStart, windowEnd, Math.max(from, windowStart), Math.min(to, windowEnd)]);
  }
  logger.info(`[catch-up] ${windows.length} checkpoint window(s) covering ledgers ${from}–${to}`);

  const concurrency = Math.max(1, WORKERS);
  const workerResults = await Promise.all(
    Array.from({ length: Math.min(concurrency, windows.length) }, async (_, worker) => {
      let complete = true;
      for (let index = worker; index < windows.length; index += concurrency) {
        const [rangeStart, rangeEnd, workStart, workEnd] = windows[index];
        complete =
          (await processCheckpointedRange({
            network: getActiveNetwork(),
            rangeStart,
            rangeEnd,
            workStart,
            workEnd,
            batchSize: BATCH,
            store: catchUpCheckpointStore,
            processRange: processLedgerRange,
            isPaused: async () =>
              (await getIndexerPauseState()).paused ||
              Date.now() - budget.startedAt >= budget.maxElapsedMs,
          })) && complete;
        if (!complete) return false;
      }
      return complete;
    }),
  );
  if (workerResults.some((complete) => !complete) || (await getIndexerPauseState()).paused) {
    return false;
  }
  const persisted = await prismaWrite.ledger.findMany({
    where: { network: getActiveNetwork(), sequence: { gte: from, lte: to } },
    select: { sequence: true },
  });
  const missing = missingLedgerRanges(from, to, persisted.map((ledger) => ledger.sequence));
  if (missing.length > 0) {
    for (const gap of missing) {
      await prismaWrite.ledgerGap.create({
        data: { startSequence: gap.start, endSequence: gap.end, resolved: false },
      });
    }
    logger.warn(`[catch-up] cursor held at missing ledger range(s): ${missing.map((gap) => `${gap.start}-${gap.end}`).join(', ')}`);
    return false;
  }
  await setLastIndexedLedger(to);
  logger.info(`[catch-up] done — cursor advanced to ${to}`);
  return true;
}

async function processSessionAuthorization(
  event: LedgerEvent,
  eventType: string,
  decoded: Record<string, unknown>,
  eventId: string,
) {
  const knownAuthEvents = new Set([
    'session_authorization',
    'authorize_session',
    'hot_signer_authorized',
    'ephemeral_key_auth',
    'authorization_window',
  ]);
  if (!knownAuthEvents.has(eventType)) {
    return;
  }

  const hotSigner = extractHotSigner(decoded, event.topics);
  const startLedger = extractStartLedger(decoded, event.ledgerSequence);
  const expiryLedger = extractExpiryLedger(decoded, startLedger);
  if (!hotSigner || expiryLedger === undefined || expiryLedger <= startLedger) {
    return;
  }

  const allocatedBlocks = Math.max(0, expiryLedger - startLedger);

  await prismaWrite.sessionAuthorization.upsert({
    where: { eventId },
    update: {
      hotSigner,
      authorizationType: eventType,
      startLedger,
      expiryLedger,
      allocatedBlocks,
      contractAddress: event.contractId,
    },
    create: {
      eventId,
      contractAddress: event.contractId,
      hotSigner,
      authorizationType: eventType,
      startLedger,
      expiryLedger,
      allocatedBlocks,
    },
  });
}

function extractHotSigner(decoded: Record<string, unknown>, topics: string[]) {
  if (decoded?.hotSigner) {
    return String(decoded.hotSigner);
  }
  if (decoded?.authorizedSigner) {
    return String(decoded.authorizedSigner);
  }
  if (decoded?.data && typeof decoded.data === 'object' && decoded.data !== null) {
    const candidate = getNumericOrStringField(decoded.data as Record<string, unknown>, [
      'hotSigner',
      'authorizedSigner',
      'signer',
      'address',
    ]);
    if (candidate) {
      return String(candidate);
    }
  }
  if (Array.isArray(decoded.topics) && decoded.topics[1] != null) {
    return String(decoded.topics[1]);
  }
  if (topics[1]) {
    return topics[1];
  }
  return undefined;
}

function extractStartLedger(decoded: Record<string, unknown>, defaultLedger: number) {
  const rawStart =
    decoded?.data && typeof decoded.data === 'object'
      ? getNumericOrStringField(decoded.data as Record<string, unknown>, [
          'startLedger',
          'start_block',
          'fromLedger',
        ])
      : undefined;
  const parsed = rawStart !== undefined ? Number(rawStart) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultLedger;
}

function extractExpiryLedger(decoded: Record<string, unknown>, startLedger: number) {
  const data = decoded?.data;
  const rawExpiry =
    typeof data === 'object' && data !== null
      ? getNumericOrStringField(data as Record<string, unknown>, [
          'expiryLedger',
          'expiresAtLedger',
          'expires_at_ledger',
          'expirationLedger',
          'validUntilLedger',
          'expiresAtBlock',
          'expiryBlock',
        ])
      : undefined;

  if (rawExpiry !== undefined) {
    const expiry = Number(rawExpiry);
    if (Number.isFinite(expiry) && expiry > 0) {
      return expiry;
    }
  }

  const duration =
    typeof data === 'object' && data !== null
      ? getNumericOrStringField(data as Record<string, unknown>, [
          'durationBlocks',
          'allocatedBlocks',
          'windowBlocks',
          'expiresInBlocks',
        ])
      : undefined;
  const parsedDuration = duration !== undefined ? Number(duration) : NaN;
  if (Number.isFinite(parsedDuration) && parsedDuration > 0) {
    return startLedger + parsedDuration;
  }

  return undefined;
}

function getNumericOrStringField(source: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null) {
      return value;
    }
  }
  return undefined;
}
// ---------------------------------------------------------------------------
// Worker class (live tail + catch-up orchestration)
// ---------------------------------------------------------------------------

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

let currentWorker: SorobanEventWorker | null = null;
let currentWorkerTask: Promise<void> | null = null;

export async function runIndexer() {
  await startIndexerService();
}

export async function startIndexerService() {
  const worker = new SorobanEventWorker();
  currentWorker = worker;
  // Match newly indexed contracts/events against stored saved searches (#966).
  startSavedSearchScheduler();
  currentWorkerTask = worker.start();
  await currentWorkerTask;
}

export async function stopIndexerService(): Promise<void> {
  stopSavedSearchScheduler();
  if (currentWorker) {
    currentWorker.stop();
  }
  await currentWorkerTask;
  currentWorker = null;
  currentWorkerTask = null;
}

export class SorobanEventWorker {
  private websocket?: WebSocket;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectDelayMs = 1000;
  private isProcessing = false;
  private shouldStop = false;

  stop(): void {
    this.shouldStop = true;
    if (this.websocket) {
      this.websocket.close();
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  async start() {
    logger.info('🔍 Soroban event worker starting...');
    this.connectWebsocket();

    while (!this.shouldStop) {
      try {
        if ((await getIndexerPauseState()).paused) {
          await sleep(config.indexerPollIntervalMs);
          continue;
        }
        if (this.isProcessing) {
          await sleep(config.indexerPollIntervalMs);
          continue;
        }

        const latest = await getLatestLedger();
        await this.syncToLatest(latest);
      } catch (err) {
        logger.error('Indexer error:', err);
        await sleep(config.indexerPollIntervalMs);
      }
    }
  }

  private async syncToLatest(targetLedger: number) {
    if (this.isProcessing) return;
    this.isProcessing = true;
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if ((await getIndexerPauseState()).paused) return;
        const last = await getLastIndexedLedger();
        setIndexerProgress(config.stellarNetwork, last, targetLedger);
        if (last >= targetLedger) return;

        // --- GAP DETECTION & BACKFILL ---
        if (last < targetLedger - 1) {
          const gapStart = last + 1;
          const gapEnd = targetLedger - 1;
          logger.warn(
            `⚠️ Ledger gap detected: expected next ledger to be ${targetLedger}, but last indexed is ${last}. Gap range: ${gapStart} → ${gapEnd}`,
          );

          // Record LedgerGap in the database
          await prismaWrite.ledgerGap.create({
            data: {
              startSequence: gapStart,
              endSequence: gapEnd,
              resolved: false,
            },
          });

          // Attempt to backfill the gap
          try {
            logger.info(`🔄 Attempting to backfill gap ${gapStart} → ${gapEnd}...`);
            if (gapEnd - gapStart >= BATCH) {
              if (!(await catchUp(gapStart, gapEnd))) return;
            } else {
              await processLedgerRange(gapStart, gapEnd);
              await setLastIndexedLedger(gapEnd);
            }

            // Mark the gap as resolved
            await prismaWrite.ledgerGap.updateMany({
              where: {
                startSequence: gapStart,
                endSequence: gapEnd,
                resolved: false,
              },
              data: { resolved: true },
            });
            logger.info(
              `✅ Ledger gap ${gapStart} → ${gapEnd} successfully backfilled and resolved.`,
            );
          } catch (backfillErr) {
            logger.error(`❌ Failed to backfill ledger gap ${gapStart} → ${gapEnd}:`, backfillErr);
            throw backfillErr;
          }

          // Refresh last indexed ledger after backfill
          continue;
        }

        const gap = targetLedger - last;
        if (gap > BATCH) {
          if (!(await catchUp(last + 1, targetLedger))) return;
          return;
        }

        const end = Math.min(last + BATCH, targetLedger);
        await processLedgerRange(last + 1, end);
        await setLastIndexedLedger(end);
      }
    } finally {
      this.isProcessing = false;
    }
  }

  // -------------------------------------------------------------------------
  // WebSocket live-tail (triggers onLedgerClose for real-time updates)
  // -------------------------------------------------------------------------

  private connectWebsocket() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    const url = getRpcWebsocketUrl();
    logger.info(`Connecting Soroban RPC websocket to ${url}`);
    try {
      this.websocket = new WebSocket(url);
      this.websocket.on('open', () => this.handleWsOpen());
      this.websocket.on('message', (data) => this.handleWsMessage(data));
      this.websocket.on('close', (code, reason) => this.handleWsClose(code, reason.toString()));
      this.websocket.on('error', (error) => this.handleWsError(error));
    } catch (error) {
      logger.error('Failed to establish websocket connection:', error);
      this.scheduleReconnect();
    }
  }

  private handleWsOpen() {
    logger.info('Soroban RPC websocket connected');
    this.reconnectDelayMs = 1000;
    this.subscribeLedgerClose();
  }

  private subscribeLedgerClose() {
    if (!this.websocket || this.websocket.readyState !== WebSocket.OPEN) return;
    this.websocket.send(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'subscribe',
        params: { topic: 'ledger' },
        id: 1,
      }),
    );
  }

  private handleWsMessage(data: WebSocket.Data) {
    const payload = this.dataToString(data);
    if (!payload) return;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const message: any = JSON.parse(payload);
      const ledgerNumber = this.extractLedgerNumber(message);
      if (typeof ledgerNumber === 'number') {
        this.onLedgerClose(ledgerNumber).catch((err) =>
          logger.error('Ledger close handler failed:', err),
        );
      }
    } catch (error) {
      logger.warn('Failed to parse websocket event payload:', error);
    }
  }

  private extractLedgerNumber(message: any): number | undefined {
    const candidate =
      message?.params?.ledger?.sequence ??
      message?.params?.ledger_sequence ??
      message?.params?.sequence ??
      message?.result?.sequence ??
      message?.result?.ledger?.sequence ??
      message?.ledger;
    const ledger = Number(candidate);
    return Number.isFinite(ledger) && ledger > 0 ? ledger : undefined;
  }

  private async onLedgerClose(ledger: number) {
    if (this.isProcessing) return;
    logger.info(`Ledger close event received for ledger ${ledger}`);
    await this.syncToLatest(ledger);
  }

  private handleWsClose(code: number, reason: string) {
    logger.warn(`Soroban RPC websocket closed (${code}) ${reason}`);
    this.scheduleReconnect();
  }

  private handleWsError(error: Error) {
    logger.error('Soroban RPC websocket error:', error.message ?? error);
    this.websocket?.close();
  }

  private scheduleReconnect() {
    if (this.shouldStop) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    this.reconnectTimer = setTimeout(() => {
      this.connectWebsocket();
      this.reconnectTimer = undefined;
    }, this.reconnectDelayMs);
    this.reconnectDelayMs = Math.min(30000, this.reconnectDelayMs * 2);
  }

  private dataToString(raw: WebSocket.Data): string {
    if (typeof raw === 'string') return raw;
    if (raw instanceof Buffer) return raw.toString('utf8');
    if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8');
    if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
    return '';
  }
}
