import { describe, expect, it, vi } from 'vitest';
import { assertCursorCommitInvariant, eventPersistenceId } from '../../src/indexer/invariants';
import { replayLedgers } from '../../src/indexer/replay';

describe('ledger cursor and persistence invariants', () => {
  it('accepts a contiguous persisted prefix before committing its cursor', () => {
    expect(() =>
      assertCursorCommitInvariant({
        rangeStart: 10,
        rangeEnd: 12,
        lastCommittedLedger: 12,
        completed: true,
        ledgerSequences: [10, 11, 12],
      }),
    ).not.toThrow();
  });

  it('rejects a cursor that would skip an unpersisted ledger', () => {
    expect(() =>
      assertCursorCommitInvariant({
        rangeStart: 10,
        rangeEnd: 12,
        lastCommittedLedger: 12,
        completed: true,
        ledgerSequences: [10, 12],
      }),
    ).toThrow(/before ledger 11/);
  });

  it('rejects a completed range whose cursor is not its final ledger', () => {
    expect(() =>
      assertCursorCommitInvariant({
        rangeStart: 10,
        rangeEnd: 12,
        lastCommittedLedger: 11,
        completed: true,
      }),
    ).toThrow(/must commit cursor 12/);
  });

  it('uses the same retry-safe event identifier for an identical event', () => {
    expect(eventPersistenceId('testnet', 'tx-1', '12-0')).toBe(
      eventPersistenceId('testnet', 'tx-1', '12-0'),
    );
    expect(eventPersistenceId('mainnet', 'tx-1', '12-0')).not.toBe(
      eventPersistenceId('testnet', 'tx-1', '12-0'),
    );
  });
});

describe('deterministic ledger replay', () => {
  const fixture = [
    { sequence: 2, hash: 'b', events: [{ id: 'event-b', payload: { value: 2 } }] },
    { sequence: 1, hash: 'a', events: [{ id: 'event-a', payload: { value: 1 } }] },
  ];

  it('persists fixture ledgers in canonical order and returns a stable digest', async () => {
    const firstSink = { persist: vi.fn(async () => undefined) };
    const secondSink = { persist: vi.fn(async () => undefined) };

    const first = await replayLedgers(fixture, firstSink);
    const second = await replayLedgers([...fixture].reverse(), secondSink);

    expect(first).toEqual(second);
    expect(firstSink.persist.mock.calls.map(([ledger]) => ledger.sequence)).toEqual([1, 2]);
    expect(first.eventsPersisted).toBe(2);
  });

  it('fails before committing a replay range with a ledger gap', async () => {
    const sink = { persist: vi.fn(async () => undefined) };

    await expect(
      replayLedgers(
        [
          { sequence: 1, hash: 'a', events: [] },
          { sequence: 3, hash: 'c', events: [] },
        ],
        sink,
      ),
    ).rejects.toThrow(/not contiguous/);
    expect(sink.persist).toHaveBeenCalledTimes(1);
  });

  it('rejects duplicate event records in one ledger', async () => {
    await expect(
      replayLedgers(
        [
          {
            sequence: 1,
            hash: 'a',
            events: [
              { id: 'duplicate', payload: {} },
              { id: 'duplicate', payload: {} },
            ],
          },
        ],
        { persist: vi.fn(async () => undefined) },
      ),
    ).rejects.toThrow(/duplicate event/);
  });
});
