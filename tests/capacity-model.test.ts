import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  calculateApiCapacity,
  calculateIndexerCapacity,
  calculateStorageGrowth,
  validateCapacityPlan,
  STELLAR_CHAIN_RATE_LEDGERS_PER_SEC,
} from '../src/utils/capacityModel';

const docPath = path.resolve(__dirname, '../docs/capacity-model.md');
const capacityDoc = readFileSync(docPath, 'utf8');

describe('Capacity Model — API workload calculations', () => {
  it('calculates API instance and core requirements accurately for baseline load', () => {
    const result = calculateApiCapacity({
      requestsPerSecond: 100,
      coresPerInstance: 2,
      targetCpuUtilization: 0.7,
      connectionsPerInstance: 10,
    });

    expect(result.requiredInstances).toBeGreaterThanOrEqual(1);
    expect(result.totalCoresRequired).toBe(result.requiredInstances * 2);
    expect(result.totalDatabaseConnections).toBe(result.requiredInstances * 10);
    expect(result.estimatedMemoryMb).toBe(result.requiredInstances * 1024);
    expect(result.classThroughput.read).toBeCloseTo(70, 1);
    expect(result.classThroughput.write).toBeCloseTo(15, 1);
  });

  it('scales instance count proportionally with heavy compute traffic', () => {
    const normal = calculateApiCapacity({
      requestsPerSecond: 200,
      coresPerInstance: 2,
      targetCpuUtilization: 0.7,
    });

    const heavyCompute = calculateApiCapacity({
      requestsPerSecond: 200,
      coresPerInstance: 2,
      targetCpuUtilization: 0.7,
      trafficDistribution: {
        read: 0.2,
        write: 0.1,
        graphql: 0.1,
        compute: 0.5, // 50% compute
        batch: 0.1,
      },
    });

    expect(heavyCompute.requiredInstances).toBeGreaterThan(normal.requiredInstances);
  });

  it('rejects invalid API inputs with descriptive errors', () => {
    expect(() => calculateApiCapacity({ requestsPerSecond: 0 })).toThrow(
      /requestsPerSecond must be a positive number/,
    );
    expect(() => calculateApiCapacity({ requestsPerSecond: -10 })).toThrow(
      /requestsPerSecond must be a positive number/,
    );
    expect(() => calculateApiCapacity({ requestsPerSecond: 50, coresPerInstance: 0 })).toThrow(
      /coresPerInstance must be greater than zero/,
    );
    expect(() =>
      calculateApiCapacity({ requestsPerSecond: 50, targetCpuUtilization: 1.5 }),
    ).toThrow(/targetCpuUtilization must be between 0 and 1/);
    expect(() =>
      calculateApiCapacity({
        requestsPerSecond: 50,
        trafficDistribution: { read: 0.5, write: 0.1 }, // doesn't sum to 1
      }),
    ).toThrow(/Traffic distribution must sum to 1.0/);
  });
});

describe('Capacity Model — Indexer workload calculations', () => {
  it('calculates catch-up throughput and backlog recovery duration', () => {
    const result = calculateIndexerCapacity({
      network: 'mainnet',
      workers: 4,
      batchSize: 100,
      backlogLedgers: 1000,
    });

    expect(result.steadyStateThroughputLedgersPerSec).toBe(STELLAR_CHAIN_RATE_LEDGERS_PER_SEC);
    expect(result.catchupThroughputLedgersPerSec).toBeGreaterThan(
      STELLAR_CHAIN_RATE_LEDGERS_PER_SEC,
    );
    expect(result.estimatedCatchupTimeSeconds).toBeGreaterThan(0);
    expect(result.requiredDatabaseConnections).toBe(6); // 4 + 2
    expect(result.dailyDatabaseGrowthBytes).toBeGreaterThan(0);
    expect(result.monthlyDatabaseGrowthBytes).toBe(result.dailyDatabaseGrowthBytes * 30);
  });

  it('returns 0 catchup seconds when backlog is zero', () => {
    const result = calculateIndexerCapacity({
      network: 'mainnet',
      workers: 2,
      backlogLedgers: 0,
    });

    expect(result.estimatedCatchupTimeSeconds).toBe(0);
  });

  it('rejects invalid indexer inputs', () => {
    expect(() =>
      calculateIndexerCapacity({
        network: 'mainnet',
        workers: 0,
        backlogLedgers: 100,
      }),
    ).toThrow(/workers must be between 1 and 32/);

    expect(() =>
      calculateIndexerCapacity({
        network: 'mainnet',
        workers: 40,
        backlogLedgers: 100,
      }),
    ).toThrow(/workers must be between 1 and 32/);

    expect(() =>
      calculateIndexerCapacity({
        network: 'mainnet',
        workers: 4,
        backlogLedgers: -5,
      }),
    ).toThrow(/backlogLedgers cannot be negative/);

    expect(() =>
      calculateIndexerCapacity({
        network: 'mainnet',
        workers: 4,
        batchSize: 2000,
        backlogLedgers: 100,
      }),
    ).toThrow(/batchSize must be between 1 and 1000/);
  });
});

describe('Capacity Model — Storage growth calculations', () => {
  it('projects disk storage and index overhead over specified duration', () => {
    const result = calculateStorageGrowth({
      days: 30,
      dailyTransactions: 500_000,
      avgEventsPerTransaction: 4,
    });

    expect(result.dailyGrowthBytes).toBeGreaterThan(0);
    expect(result.tableBytes).toBeGreaterThan(0);
    expect(result.indexOverheadBytes).toBeCloseTo(result.tableBytes * 0.35, -2);
    expect(result.totalStorageBytes).toBe(result.tableBytes + result.indexOverheadBytes);
  });

  it('rejects negative days or negative dailyTransactions', () => {
    expect(() => calculateStorageGrowth({ days: 0, dailyTransactions: 100 })).toThrow(
      /days must be positive/,
    );
    expect(() => calculateStorageGrowth({ days: 10, dailyTransactions: -1 })).toThrow(
      /dailyTransactions cannot be negative/,
    );
  });
});

describe('Capacity Model — validateCapacityPlan integration', () => {
  it('validates compliant capacity plan with no violations', () => {
    const result = validateCapacityPlan({
      api: { requestsPerSecond: 100, coresPerInstance: 2, connectionsPerInstance: 10 },
      indexer: { network: 'mainnet', workers: 4, backlogLedgers: 500 },
      databaseMaxConnections: 100,
      maxAcceptableCatchupMinutes: 60,
    });

    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('detects database connection pool overflow', () => {
    const result = validateCapacityPlan({
      api: { requestsPerSecond: 1000, coresPerInstance: 2, connectionsPerInstance: 15 },
      indexer: { network: 'mainnet', workers: 16, backlogLedgers: 500 },
      databaseMaxConnections: 50, // artificially low limit
    });

    expect(result.valid).toBe(false);
    expect(
      result.violations.some((v) => v.includes('exceeds configured database pool capacity')),
    ).toBe(true);
  });

  it('detects unacceptably long catch-up times exceeding recovery limits', () => {
    const result = validateCapacityPlan({
      api: { requestsPerSecond: 50 },
      indexer: { network: 'mainnet', workers: 1, backlogLedgers: 500_000 }, // massive backlog with only 1 worker
      maxAcceptableCatchupMinutes: 10, // strict 10 min threshold
    });

    expect(result.valid).toBe(false);
    expect(result.violations.some((v) => v.includes('exceeds acceptable limit'))).toBe(true);
  });
});

describe('Capacity Model — Documentation alignment', () => {
  it('documents approved API SLO latency thresholds matching docs/api-slo.md', () => {
    expect(capacityDoc).toContain('250 ms');
    expect(capacityDoc).toContain('500 ms');
    expect(capacityDoc).toContain('1.5 s');
  });

  it('documents indexer freshness and ledger lag warning thresholds', () => {
    expect(capacityDoc).toContain('50 ledgers');
    expect(capacityDoc).toContain('200 ledgers');
    expect(capacityDoc).toContain('60s');
    expect(capacityDoc).toContain('300s');
  });

  it('documents sizing formulas and network-specific provisioning profiles', () => {
    expect(capacityDoc).toContain('Mainnet Provisioning');
    expect(capacityDoc).toContain('Testnet Provisioning');
    expect(capacityDoc).toContain('Devnet Provisioning');
    expect(capacityDoc).toContain('INDEXER_CATCHUP_WORKERS');
  });
});
