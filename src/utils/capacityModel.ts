/**
 * Sizing and Capacity Model for API and Indexer Workloads
 *
 * Provides analytical calculations and capacity validation to size compute,
 * database connections, worker concurrency, and storage for API and indexer workloads.
 */

export type ApiEndpointClass = 'read' | 'write' | 'compute' | 'graphql' | 'batch';
export type NetworkName = 'mainnet' | 'testnet' | 'devnet';

export interface ApiWorkloadInputs {
  requestsPerSecond: number;
  trafficDistribution?: Partial<Record<ApiEndpointClass, number>>;
  coresPerInstance?: number;
  targetCpuUtilization?: number; // e.g. 0.70 for 70%
  connectionsPerInstance?: number;
}

export interface ApiCapacityResult {
  requiredInstances: number;
  totalCoresRequired: number;
  classThroughput: Record<ApiEndpointClass, number>;
  estimatedMemoryMb: number;
  totalDatabaseConnections: number;
}

export interface IndexerWorkloadInputs {
  network: NetworkName;
  workers: number; // INDEXER_CATCHUP_WORKERS (1-32)
  batchSize?: number; // INDEXER_BATCH_SIZE (1-1000)
  backlogLedgers: number;
  avgTransactionsPerLedger?: number;
  avgEventsPerTransaction?: number;
}

export interface IndexerCapacityResult {
  steadyStateThroughputLedgersPerSec: number;
  catchupThroughputLedgersPerSec: number;
  estimatedCatchupTimeSeconds: number;
  requiredDatabaseConnections: number;
  dailyDatabaseGrowthBytes: number;
  monthlyDatabaseGrowthBytes: number;
}

export interface StorageProjectionInputs {
  days: number;
  dailyTransactions: number;
  avgEventsPerTransaction?: number;
}

export interface StorageProjectionResult {
  tableBytes: number;
  indexOverheadBytes: number;
  totalStorageBytes: number;
  dailyGrowthBytes: number;
}

export interface CapacityPlanValidationResult {
  valid: boolean;
  violations: string[];
}

/**
 * CPU execution cost per class in milliseconds of core execution time.
 * Calibrated against benchmark runs (src/benchmarks/api-responses.bench.ts).
 */
export const CLASS_CPU_COST_MS: Record<ApiEndpointClass, number> = {
  read: 12, // cached / lightweight DB read
  write: 30, // validated submission / state mutation
  compute: 180, // contract simulation, MEV, sandbox execution
  graphql: 45, // field resolver execution and AST validation
  batch: 90, // batched operations and partial-response assembly
};

export const DEFAULT_TRAFFIC_DISTRIBUTION: Record<ApiEndpointClass, number> = {
  read: 0.7,
  write: 0.15,
  graphql: 0.08,
  compute: 0.05,
  batch: 0.02,
};

// Stellar closes a ledger approximately every 5 seconds (0.2 ledgers/sec)
export const STELLAR_LEDGER_INTERVAL_SEC = 5;
export const STELLAR_CHAIN_RATE_LEDGERS_PER_SEC = 1 / STELLAR_LEDGER_INTERVAL_SEC;

// Approximate storage footprints in bytes per record
export const BYTES_PER_LEDGER = 2_048; // header + metadata
export const BYTES_PER_TRANSACTION = 4_096; // envelope + result
export const BYTES_PER_EVENT = 1_536; // decoded topics + data + context
export const INDEX_OVERHEAD_FACTOR = 0.35; // ~35% B-tree/pgvector index overhead

/**
 * Calculates API compute and connection requirements based on workload inputs.
 */
export function calculateApiCapacity(inputs: ApiWorkloadInputs): ApiCapacityResult {
  if (inputs.requestsPerSecond <= 0) {
    throw new Error('requestsPerSecond must be a positive number.');
  }

  const coresPerInstance = inputs.coresPerInstance ?? 2;
  if (coresPerInstance <= 0) {
    throw new Error('coresPerInstance must be greater than zero.');
  }

  const targetCpuUtilization = inputs.targetCpuUtilization ?? 0.7;
  if (targetCpuUtilization <= 0 || targetCpuUtilization > 1) {
    throw new Error('targetCpuUtilization must be between 0 and 1.');
  }

  const connectionsPerInstance = inputs.connectionsPerInstance ?? 10;
  if (connectionsPerInstance <= 0) {
    throw new Error('connectionsPerInstance must be greater than zero.');
  }

  const distribution = {
    ...DEFAULT_TRAFFIC_DISTRIBUTION,
    ...inputs.trafficDistribution,
  };

  const distributionSum = Object.values(distribution).reduce((acc, v) => acc + v, 0);
  if (Math.abs(distributionSum - 1.0) > 0.001) {
    throw new Error(`Traffic distribution must sum to 1.0, got ${distributionSum.toFixed(3)}.`);
  }

  // Calculate RPS per class
  const classThroughput: Record<ApiEndpointClass, number> = {
    read: inputs.requestsPerSecond * distribution.read,
    write: inputs.requestsPerSecond * distribution.write,
    compute: inputs.requestsPerSecond * distribution.compute,
    graphql: inputs.requestsPerSecond * distribution.graphql,
    batch: inputs.requestsPerSecond * distribution.batch,
  };

  // Total CPU core seconds demanded per real-time second
  let totalCpuDemandSeconds = 0;
  for (const [cls, rps] of Object.entries(classThroughput) as Array<[ApiEndpointClass, number]>) {
    const costMs = CLASS_CPU_COST_MS[cls];
    totalCpuDemandSeconds += (rps * costMs) / 1000;
  }

  // Effective capacity per instance accounting for target utilization
  const effectiveCoresPerInstance = coresPerInstance * targetCpuUtilization;
  const requiredInstances = Math.max(
    1,
    Math.ceil(totalCpuDemandSeconds / effectiveCoresPerInstance),
  );
  const totalCoresRequired = requiredInstances * coresPerInstance;
  const totalDatabaseConnections = requiredInstances * connectionsPerInstance;
  const estimatedMemoryMb = requiredInstances * 1024; // 1 GiB base per API instance

  return {
    requiredInstances,
    totalCoresRequired,
    classThroughput,
    estimatedMemoryMb,
    totalDatabaseConnections,
  };
}

/**
 * Calculates indexer catchup throughput and backlog recovery duration.
 */
export function calculateIndexerCapacity(inputs: IndexerWorkloadInputs): IndexerCapacityResult {
  if (inputs.workers <= 0 || inputs.workers > 32) {
    throw new Error('workers must be between 1 and 32.');
  }
  if (inputs.backlogLedgers < 0) {
    throw new Error('backlogLedgers cannot be negative.');
  }

  const batchSize = inputs.batchSize ?? 100;
  if (batchSize <= 0 || batchSize > 1000) {
    throw new Error('batchSize must be between 1 and 1000.');
  }

  const defaultTxPerLedger =
    inputs.network === 'mainnet' ? 50 : inputs.network === 'testnet' ? 10 : 2;
  const txPerLedger = inputs.avgTransactionsPerLedger ?? defaultTxPerLedger;
  const eventsPerTx = inputs.avgEventsPerTransaction ?? 4;

  // Average time to fetch, decode and commit a batch per worker (calibrated from throughput benchmarks)
  // ~25 ms per ledger processing time
  const msPerLedger = Math.max(10, 10 + txPerLedger * 0.3 + txPerLedger * eventsPerTx * 0.05);
  const throughputPerWorkerLedgersPerSec = 1000 / msPerLedger;
  const catchupThroughputLedgersPerSec = inputs.workers * throughputPerWorkerLedgersPerSec;

  // Backlog recovery calculation
  // Net catchup speed = worker throughput - ledger close rate
  const netCatchupRate = catchupThroughputLedgersPerSec - STELLAR_CHAIN_RATE_LEDGERS_PER_SEC;
  const estimatedCatchupTimeSeconds =
    inputs.backlogLedgers === 0
      ? 0
      : netCatchupRate > 0
        ? Math.ceil(inputs.backlogLedgers / netCatchupRate)
        : Number.POSITIVE_INFINITY;

  // DB Connections: 1 primary connection per worker + 2 for health/replication-lag monitoring
  const requiredDatabaseConnections = inputs.workers + 2;

  // Storage growth calculations
  const ledgersPerDay = 86_400 / STELLAR_LEDGER_INTERVAL_SEC; // 17,280 ledgers/day
  const bytesPerLedgerTotal =
    BYTES_PER_LEDGER + txPerLedger * (BYTES_PER_TRANSACTION + eventsPerTx * BYTES_PER_EVENT);
  const dailyDatabaseGrowthBytes = Math.round(
    ledgersPerDay * bytesPerLedgerTotal * (1 + INDEX_OVERHEAD_FACTOR),
  );
  const monthlyDatabaseGrowthBytes = dailyDatabaseGrowthBytes * 30;

  return {
    steadyStateThroughputLedgersPerSec: STELLAR_CHAIN_RATE_LEDGERS_PER_SEC,
    catchupThroughputLedgersPerSec: Number(catchupThroughputLedgersPerSec.toFixed(2)),
    estimatedCatchupTimeSeconds,
    requiredDatabaseConnections,
    dailyDatabaseGrowthBytes,
    monthlyDatabaseGrowthBytes,
  };
}

/**
 * Calculates long-term database storage growth.
 */
export function calculateStorageGrowth(inputs: StorageProjectionInputs): StorageProjectionResult {
  if (inputs.days <= 0) {
    throw new Error('days must be positive.');
  }
  if (inputs.dailyTransactions < 0) {
    throw new Error('dailyTransactions cannot be negative.');
  }

  const eventsPerTx = inputs.avgEventsPerTransaction ?? 4;
  const ledgersPerDay = 86_400 / STELLAR_LEDGER_INTERVAL_SEC;

  const rawBytesPerDay =
    ledgersPerDay * BYTES_PER_LEDGER +
    inputs.dailyTransactions * (BYTES_PER_TRANSACTION + eventsPerTx * BYTES_PER_EVENT);

  const dailyGrowthBytes = Math.round(rawBytesPerDay * (1 + INDEX_OVERHEAD_FACTOR));
  const tableBytes = Math.round(rawBytesPerDay * inputs.days);
  const indexOverheadBytes = Math.round(tableBytes * INDEX_OVERHEAD_FACTOR);
  const totalStorageBytes = tableBytes + indexOverheadBytes;

  return {
    tableBytes,
    indexOverheadBytes,
    totalStorageBytes,
    dailyGrowthBytes,
  };
}

/**
 * Validates a combined workload capacity plan against operational limits and SLOs.
 */
export function validateCapacityPlan(plan: {
  api: ApiWorkloadInputs;
  indexer: IndexerWorkloadInputs;
  databaseMaxConnections?: number;
  maxAcceptableCatchupMinutes?: number;
}): CapacityPlanValidationResult {
  const violations: string[] = [];
  const maxDbConnections = plan.databaseMaxConnections ?? 100;
  const maxCatchupSec = (plan.maxAcceptableCatchupMinutes ?? 60) * 60;

  try {
    const apiResult = calculateApiCapacity(plan.api);
    const indexerResult = calculateIndexerCapacity(plan.indexer);

    const totalRequiredDbConnections =
      apiResult.totalDatabaseConnections + indexerResult.requiredDatabaseConnections;

    if (totalRequiredDbConnections > maxDbConnections) {
      violations.push(
        `Total database connections required (${totalRequiredDbConnections}) exceeds configured database pool capacity (${maxDbConnections}).`,
      );
    }

    if (indexerResult.estimatedCatchupTimeSeconds === Number.POSITIVE_INFINITY) {
      violations.push(
        'Indexer catch-up throughput is lower than chain ledger production rate; backlog will grow indefinitely.',
      );
    } else if (indexerResult.estimatedCatchupTimeSeconds > maxCatchupSec) {
      violations.push(
        `Estimated indexer catch-up duration (${Math.round(indexerResult.estimatedCatchupTimeSeconds / 60)} min) exceeds acceptable limit (${plan.maxAcceptableCatchupMinutes ?? 60} min).`,
      );
    }
  } catch (error) {
    violations.push(error instanceof Error ? error.message : String(error));
  }

  return {
    valid: violations.length === 0,
    violations,
  };
}
