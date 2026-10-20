import { uuidv7 } from '../utils/uuidv7';

export interface CatchUpCheckpoint {
  lastCommittedLedger: number | null;
  completed: boolean;
}

export interface CatchUpCheckpointStore {
  findUnique(args: {
    where: {
      network_rangeStart_rangeEnd: { network: string; rangeStart: number; rangeEnd: number };
    };
    select: { lastCommittedLedger: true; completed: true };
  }): Promise<CatchUpCheckpoint | null>;
  upsert(args: {
    where: {
      network_rangeStart_rangeEnd: { network: string; rangeStart: number; rangeEnd: number };
    };
    create: {
      id: string;
      network: string;
      rangeStart: number;
      rangeEnd: number;
      lastCommittedLedger: number | null;
      completed: boolean;
    };
    update: { lastCommittedLedger: number | null; completed: boolean };
  }): Promise<unknown>;
}

export interface CheckpointedRangeOptions {
  network: string;
  rangeStart: number;
  rangeEnd: number;
  workStart: number;
  workEnd: number;
  batchSize: number;
  store: CatchUpCheckpointStore;
  processRange: (start: number, end: number) => Promise<unknown>;
  isPaused?: () => Promise<boolean>;
}

export async function processCheckpointedRange({
  network,
  rangeStart,
  rangeEnd,
  workStart,
  workEnd,
  batchSize,
  store,
  processRange,
  isPaused,
}: CheckpointedRangeOptions): Promise<boolean> {
  if (
    !network ||
    !Number.isInteger(rangeStart) ||
    !Number.isInteger(rangeEnd) ||
    rangeStart < 1 ||
    rangeEnd < rangeStart ||
    !Number.isInteger(workStart) ||
    !Number.isInteger(workEnd) ||
    workStart < rangeStart ||
    workEnd > rangeEnd ||
    workStart > workEnd ||
    !Number.isInteger(batchSize) ||
    batchSize < 1
  ) {
    throw new Error('Invalid checkpointed ledger range');
  }

  const key = { network, rangeStart, rangeEnd };
  const checkpoint = await store.findUnique({
    where: { network_rangeStart_rangeEnd: key },
    select: { lastCommittedLedger: true, completed: true },
  });

  if (checkpoint?.completed) return true;

  const resumeFrom = Math.max(workStart, (checkpoint?.lastCommittedLedger ?? workStart - 1) + 1);
  if (resumeFrom > workEnd) return true;

  await store.upsert({
    where: { network_rangeStart_rangeEnd: key },
    create: {
      id: uuidv7(),
      ...key,
      lastCommittedLedger: resumeFrom > workStart ? resumeFrom - 1 : null,
      completed: false,
    },
    update: {
      lastCommittedLedger: resumeFrom > workStart ? resumeFrom - 1 : null,
      completed: false,
    },
  });

  for (let start = resumeFrom; start <= workEnd; start += batchSize) {
    if (await isPaused?.()) return false;
    const end = Math.min(start + batchSize - 1, workEnd);
    await processRange(start, end);
    await store.upsert({
      where: { network_rangeStart_rangeEnd: key },
      create: {
        id: uuidv7(),
        ...key,
        lastCommittedLedger: end,
        completed: end === rangeEnd,
      },
      update: {
        lastCommittedLedger: end,
        completed: end === rangeEnd,
      },
    });
  }
  return true;
}
