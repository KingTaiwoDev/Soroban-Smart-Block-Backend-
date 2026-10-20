import { prismaWrite } from '../db';
import { uuidv7 } from '../utils/uuidv7';
import { assertCursorCommitInvariant } from './invariants';

export interface IndexedRangeRecords {
  network: string;
  ledgerSequences: number[];
  transactionHashes: string[];
  eventIds: string[];
}

/**
 * Persist checkpoint progress only after verifying the corresponding indexed
 * records. The validation and checkpoint upsert share one database transaction,
 * so a failed check or checkpoint write leaves the cursor unchanged.
 */
export async function commitCatchUpCheckpoint(
  rangeStart: number,
  rangeEnd: number,
  network: string,
  lastCommittedLedger: number | null,
  completed: boolean,
  indexedRecords?: IndexedRangeRecords,
): Promise<void> {
  assertCursorCommitInvariant({
    rangeStart,
    rangeEnd,
    lastCommittedLedger,
    completed,
    ledgerSequences: indexedRecords?.ledgerSequences,
  });

  await prismaWrite.$transaction(async (tx) => {
    if (indexedRecords) {
      if (indexedRecords.network !== network) {
        throw new Error(
          `Cannot checkpoint ${rangeStart}-${rangeEnd} for ${network}: indexed records belong to ${indexedRecords.network}`,
        );
      }

      const [ledgerCount, transactionCount, eventCount] = await Promise.all([
        tx.ledger.count({
          where: { network, sequence: { in: indexedRecords.ledgerSequences } },
        }),
        tx.transaction.count({
          where: { network, hash: { in: indexedRecords.transactionHashes } },
        }),
        tx.event.count({
          where: { network, id: { in: indexedRecords.eventIds } },
        }),
      ]);
      const expectedCounts = [
        indexedRecords.ledgerSequences.length,
        indexedRecords.transactionHashes.length,
        indexedRecords.eventIds.length,
      ];

      if (
        ledgerCount !== expectedCounts[0] ||
        transactionCount !== expectedCounts[1] ||
        eventCount !== expectedCounts[2]
      ) {
        throw new Error(
          `Cannot checkpoint ${rangeStart}-${rangeEnd} for ${network}: indexed row counts ` +
            `ledger=${ledgerCount}/${expectedCounts[0]}, transaction=${transactionCount}/${expectedCounts[1]}, ` +
            `event=${eventCount}/${expectedCounts[2]}`,
        );
      }
    }

    await tx.catchUpCheckpoint.upsert({
      where: { network_rangeStart_rangeEnd: { network, rangeStart, rangeEnd } },
      create: {
        id: uuidv7(),
        network,
        rangeStart,
        rangeEnd,
        lastCommittedLedger,
        completed,
      },
      update: {
        lastCommittedLedger,
        completed,
      },
    });
  });
}
