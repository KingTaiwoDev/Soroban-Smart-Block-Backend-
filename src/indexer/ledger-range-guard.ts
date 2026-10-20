export interface LedgerRange { start: number; end: number }

export function missingLedgerRanges(start: number, end: number, present: Iterable<number>): LedgerRange[] {
  const seen = new Set(present);
  const gaps: LedgerRange[] = [];
  let gapStart: number | undefined;
  for (let ledger = start; ledger <= end; ledger += 1) {
    if (!seen.has(ledger) && gapStart === undefined) gapStart = ledger;
    if (seen.has(ledger) && gapStart !== undefined) {
      gaps.push({ start: gapStart, end: ledger - 1 });
      gapStart = undefined;
    }
  }
  if (gapStart !== undefined) gaps.push({ start: gapStart, end });
  return gaps;
}

export interface CatchUpBudget {
  maxLedgers: number;
  maxElapsedMs: number;
  startedAt: number;
  processed: number;
}

export function createCatchUpBudget(now = Date.now()): CatchUpBudget {
  return {
    maxLedgers: Math.max(1, Number(process.env.INDEXER_CATCHUP_MAX_LEDGERS ?? 1_000)),
    maxElapsedMs: Math.max(1, Number(process.env.INDEXER_CATCHUP_MAX_MS ?? 30_000)),
    startedAt: now,
    processed: 0,
  };
}

export function canProcessCatchUpRange(budget: CatchUpBudget, count: number, now = Date.now()): boolean {
  return count > 0 && budget.processed + count <= budget.maxLedgers && now - budget.startedAt < budget.maxElapsedMs;
}

export class WriteLatencyBackpressure {
  private consecutiveSlowWrites = 0;
  constructor(
    private readonly thresholdMs = Math.max(1, Number(process.env.INDEXER_DB_WRITE_LATENCY_MS ?? 500)),
    private readonly requiredSamples = Math.max(1, Number(process.env.INDEXER_DB_SLOW_WRITE_SAMPLES ?? 3)),
    private readonly delayMs = Math.max(0, Number(process.env.INDEXER_BACKPRESSURE_DELAY_MS ?? 250)),
  ) {}

  record(latencyMs: number): number {
    this.consecutiveSlowWrites = latencyMs >= this.thresholdMs ? this.consecutiveSlowWrites + 1 : 0;
    return this.consecutiveSlowWrites >= this.requiredSamples ? this.delayMs : 0;
  }
}
