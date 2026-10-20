import { describe, expect, it } from 'vitest';
import { WriteLatencyBackpressure, canProcessCatchUpRange, missingLedgerRanges } from '../../src/indexer/ledger-range-guard';

describe('ledger range guard', () => {
  it('reports contiguous missing ranges before a cursor can advance', () => {
    expect(missingLedgerRanges(10, 18, [10, 11, 14, 18])).toEqual([
      { start: 12, end: 13 },
      { start: 15, end: 17 },
    ]);
  });

  it('returns no gap for a complete range', () => {
    expect(missingLedgerRanges(4, 6, [4, 5, 6])).toEqual([]);
  });

  it('bounds catch-up by ledger count and elapsed time', () => {
    const budget = { maxLedgers: 5, maxElapsedMs: 100, startedAt: 1_000, processed: 3 };
    expect(canProcessCatchUpRange(budget, 2, 1_050)).toBe(true);
    expect(canProcessCatchUpRange(budget, 3, 1_050)).toBe(false);
    expect(canProcessCatchUpRange(budget, 1, 1_100)).toBe(false);
  });

  it('applies write backpressure only after repeated slow writes and resets on recovery', () => {
    const guard = new WriteLatencyBackpressure(100, 2, 25);
    expect(guard.record(101)).toBe(0);
    expect(guard.record(120)).toBe(25);
    expect(guard.record(50)).toBe(0);
    expect(guard.record(120)).toBe(0);
  });
});
