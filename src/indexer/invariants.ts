export interface CursorCommitInput {
  rangeStart: number;
  rangeEnd: number;
  lastCommittedLedger: number | null;
  completed: boolean;
  ledgerSequences?: readonly number[];
}

/**
 * Guard the cursor boundary shared by catch-up workers and checkpoint writes.
 * A cursor is only meaningful when it describes a contiguous prefix of the
 * requested ledger range; accepting anything else could make a restart skip
 * unpersisted ledgers.
 */
export function assertCursorCommitInvariant({
  rangeStart,
  rangeEnd,
  lastCommittedLedger,
  completed,
  ledgerSequences,
}: CursorCommitInput): void {
  if (!Number.isInteger(rangeStart) || !Number.isInteger(rangeEnd) || rangeStart < 1 || rangeEnd < rangeStart) {
    throw new Error(`Invalid ledger range ${rangeStart}-${rangeEnd}`);
  }

  if (
    lastCommittedLedger !== null &&
    (!Number.isInteger(lastCommittedLedger) ||
      lastCommittedLedger < rangeStart ||
      lastCommittedLedger > rangeEnd)
  ) {
    throw new Error(`Cursor ${lastCommittedLedger} is outside ledger range ${rangeStart}-${rangeEnd}`);
  }

  if (completed && lastCommittedLedger !== rangeEnd) {
    throw new Error(`Completed range ${rangeStart}-${rangeEnd} must commit cursor ${rangeEnd}`);
  }

  // Callers that own persistence verification provide the recorded ledger
  // set. Pure cursor moves may validate only the range boundary here.
  if (!ledgerSequences) return;

  const requiredEnd = lastCommittedLedger ?? rangeStart - 1;
  const unique = [...new Set(ledgerSequences)].sort((a, b) => a - b);
  if (unique.length !== ledgerSequences.length) {
    throw new Error('Indexed ledger sequences must be unique');
  }
  for (let sequence = rangeStart; sequence <= requiredEnd; sequence += 1) {
    if (!unique.includes(sequence)) {
      throw new Error(`Cursor ${requiredEnd} cannot commit before ledger ${sequence} is persisted`);
    }
  }
}

/** A network-scoped, deterministic identifier safe to reuse on worker retry. */
export function eventPersistenceId(
  network: string,
  transactionHash: string,
  positionKey: string,
  existingLegacyNetwork?: string,
): string {
  if (!network || !transactionHash || !positionKey) {
    throw new Error('Event persistence identity requires network, transaction hash, and position');
  }
  const legacyId = `${transactionHash}-${positionKey}`;
  return existingLegacyNetwork === network ? legacyId : `${network}-${legacyId}`;
}
