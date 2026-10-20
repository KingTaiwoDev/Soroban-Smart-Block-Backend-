import { readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

vi.mock('../../src/db', () => ({
  prisma: {},
  readReplicaPrisma: {},
}));

vi.mock('../../src/metrics', () => ({
  replicaLagCheckErrors: { inc: vi.fn() },
}));

const scriptPath = path.resolve(__dirname, '../../scripts/reliability-game-day-drill.sh');
const docPath = path.resolve(__dirname, '../../docs/reliability-game-day.md');
const gameDayDoc = readFileSync(docPath, 'utf8');

function runDrill(args: string[] = [], env: Record<string, string> = {}) {
  return spawnSync('bash', [scriptPath, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ...env,
    },
  });
}

function makeMockPrisma(lastLedger: number | null, shouldFail = false) {
  return {
    $queryRawUnsafe: vi.fn().mockResolvedValue([{ exists: true }]),
    indexerState: {
      findUnique: shouldFail
        ? vi.fn().mockRejectedValue(new Error('Connection terminated'))
        : vi.fn().mockResolvedValue(lastLedger !== null ? { lastLedger } : null),
    },
  } as unknown as PrismaClient;
}

describe('Reliability Game Day — Automated Drill Script', () => {
  it('executes full drill successfully under nominal conditions', () => {
    const result = runDrill(['all'], { STELLAR_NETWORK: 'testnet' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Reliability Game Day Drill COMPLETED SUCCESSFULLY');
    expect(result.stdout).toContain('Database failover drill PASSED');
    expect(result.stdout).toContain('Stellar RPC failover drill PASSED');
  });

  it('runs database drill independently', () => {
    const result = runDrill(['database'], { STELLAR_NETWORK: 'testnet' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Database failover drill PASSED');
    expect(result.stdout).not.toContain('Stellar RPC failover drill');
  });

  it('runs rpc drill independently', () => {
    const result = runDrill(['rpc'], { STELLAR_NETWORK: 'testnet' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Stellar RPC failover drill PASSED');
    expect(result.stdout).not.toContain('Database failover drill');
  });

  it('blocks execution against live mainnet without explicit safety override', () => {
    const result = runDrill(['all'], { STELLAR_NETWORK: 'mainnet', ALLOW_MAINNET_DRILL: 'false' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Game day drill cannot be run against live mainnet');
  });

  it('handles simulated database failure with appropriate exit code', () => {
    const result = runDrill(['database'], { SIMULATE_FAILURE: 'db_fail' });
    expect(result.status).toBe(17);
    expect(result.stderr).toContain('Simulated fatal database connection failure injected');
  });

  it('handles simulated RPC exhaustion with appropriate exit code', () => {
    const result = runDrill(['rpc'], { SIMULATE_FAILURE: 'rpc_exhausted' });
    expect(result.status).toBe(18);
    expect(result.stderr).toContain('Simulated all-RPC-endpoints-down failure injected');
  });
});

describe('Reliability Game Day — Database Replica Failover Mechanics', () => {
  it('routes to read replica when lag is within threshold (lag <= 5 ledgers)', async () => {
    vi.stubEnv('TESTNET_DATABASE_URL', 'postgresql://test:test@localhost:5432/test');
    const { measureReplicaLag, getReadClient, LAG_THRESHOLD_LEDGERS, _resetLagCache } =
      await import('../../src/db/replicaGateway');
    _resetLagCache();

    const read = makeMockPrisma(98);
    const write = makeMockPrisma(100);

    const lag = await measureReplicaLag(read, write);
    expect(lag).toBe(2);
    expect(lag).toBeLessThanOrEqual(LAG_THRESHOLD_LEDGERS);

    const client = await getReadClient(read, write);
    expect(client).toBe(read);
  });

  it('falls back to primary write client when replica lag exceeds threshold (lag > 5 ledgers)', async () => {
    vi.stubEnv('TESTNET_DATABASE_URL', 'postgresql://test:test@localhost:5432/test');
    const { measureReplicaLag, getReadClient, LAG_THRESHOLD_LEDGERS, _resetLagCache } =
      await import('../../src/db/replicaGateway');
    _resetLagCache();

    const read = makeMockPrisma(90);
    const write = makeMockPrisma(100);

    const lag = await measureReplicaLag(read, write);
    expect(lag).toBe(10);
    expect(lag).toBeGreaterThan(LAG_THRESHOLD_LEDGERS);

    const client = await getReadClient(read, write);
    expect(client).toBe(write);
  });

  it('forces primary write client when read replica encounters connection failure', async () => {
    vi.stubEnv('TESTNET_DATABASE_URL', 'postgresql://test:test@localhost:5432/test');
    const { measureReplicaLag, getReadClient, LAG_THRESHOLD_LEDGERS, _resetLagCache } =
      await import('../../src/db/replicaGateway');
    _resetLagCache();

    const brokenRead = makeMockPrisma(null, true);
    const healthyWrite = makeMockPrisma(100);

    const lag = await measureReplicaLag(brokenRead, healthyWrite);
    expect(lag).toBeGreaterThan(LAG_THRESHOLD_LEDGERS);

    const client = await getReadClient(brokenRead, healthyWrite);
    expect(client).toBe(healthyWrite);
  });
});

describe('Reliability Game Day — Documentation and Operational Invariants', () => {
  it('documents strict RTO (<= 60 min) and RPO (<= 15 min) targets', () => {
    expect(gameDayDoc).toMatch(/RTO[\s\S]*?60\s*minutes/);
    expect(gameDayDoc).toMatch(/RPO[\s\S]*?15\s*minutes/);
  });

  it('documents safety controls prohibiting live mainnet drill execution', () => {
    expect(gameDayDoc).toContain('Never execute destructive drills on a production database');
    expect(gameDayDoc).toContain('ALLOW_MAINNET_DRILL');
  });

  it('documents Prometheus metrics and alert definitions for RPC and DB failover', () => {
    expect(gameDayDoc).toContain('rpc_endpoint_failovers_total');
    expect(gameDayDoc).toContain('rpc_endpoint_active');
    expect(gameDayDoc).toContain('replicaLagCheckErrors');
    expect(gameDayDoc).toContain('StellarRpcSustainedDegradation');
    expect(gameDayDoc).toContain('StellarRpcEndpointFailover');
  });

  it('documents network-specific differences across devnet, testnet, and mainnet', () => {
    expect(gameDayDoc).toContain('Devnet');
    expect(gameDayDoc).toContain('Testnet');
    expect(gameDayDoc).toContain('Mainnet');
    expect(gameDayDoc).toContain('HTTPS');
  });
});
