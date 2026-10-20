import { createHash } from 'node:crypto';

export interface ReplayEvent {
  id: string;
  payload: unknown;
}

export interface ReplayLedger {
  sequence: number;
  hash: string;
  events: readonly ReplayEvent[];
}

export interface LedgerReplayResult {
  lastCommittedLedger: number | null;
  digest: string;
  eventsPersisted: number;
}

export interface LedgerReplaySink {
  persist(ledger: ReplayLedger): Promise<void>;
}

function stableJson(value: unknown): string {
  if (value === undefined) return '"[undefined]"';
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error('Replay fixture contains a non-finite number');
  }
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
}

/**
 * Replays a fixture range in canonical ledger/event order. It intentionally
 * has no wall-clock, random, or network dependency, making its digest stable
 * across retries and CI runners.
 */
export async function replayLedgers(
  ledgers: readonly ReplayLedger[],
  sink: LedgerReplaySink,
): Promise<LedgerReplayResult> {
  const ordered = [...ledgers].sort((left, right) => left.sequence - right.sequence);
  const digest = createHash('sha256');
  let previousSequence: number | undefined;
  let eventsPersisted = 0;

  for (const ledger of ordered) {
    if (!Number.isInteger(ledger.sequence) || ledger.sequence < 1 || !ledger.hash) {
      throw new Error('Replay fixture contains an invalid ledger');
    }
    if (previousSequence !== undefined && ledger.sequence !== previousSequence + 1) {
      throw new Error(`Replay fixture is not contiguous at ledger ${ledger.sequence}`);
    }

    const eventIds = new Set<string>();
    const canonicalLedger: ReplayLedger = {
      ...ledger,
      events: [...ledger.events].sort((left, right) => left.id.localeCompare(right.id)),
    };
    for (const event of canonicalLedger.events) {
      if (!event.id || eventIds.has(event.id)) {
        throw new Error(`Replay fixture contains a duplicate event at ledger ${ledger.sequence}`);
      }
      eventIds.add(event.id);
    }

    await sink.persist(canonicalLedger);
    digest.update(stableJson(canonicalLedger));
    previousSequence = ledger.sequence;
    eventsPersisted += canonicalLedger.events.length;
  }

  return {
    lastCommittedLedger: previousSequence ?? null,
    digest: digest.digest('hex'),
    eventsPersisted,
  };
}
