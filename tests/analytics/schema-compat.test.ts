import { beforeEach, describe, expect, it, vi } from 'vitest';

const s3 = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    send = s3.send;
  },
  PutObjectCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
  HeadBucketCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
}));
vi.mock('../../src/db', () => ({
  prismaRead: {
    contract: { findUnique: vi.fn().mockResolvedValue({ name: 'Soroswap Router' }) },
    token: { findFirst: vi.fn().mockResolvedValue({ name: 'USD Coin', decimals: 7 }) },
  },
  prismaWrite: {},
}));
vi.mock('../../src/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { transformRecord, type RawCdcRecord } from '../../src/analytics/etl/xdr-transform';
import { ANALYTICS_PARQUET_SCHEMA, writePartitionToS3 } from '../../src/analytics/data-lake/iceberg-writer';
import { CORE_SCHEMAS, type SchemaField } from '../../src/analytics/lakehouse/schema-registry';
import {
  checkEventToParquetCompatibility,
  validateParquetRow,
} from '../../src/analytics/etl/schema-compat';

/** Debezium-style CDC envelope for a Soroban transaction row. */
function cdc(after: Record<string, unknown> | null, op: RawCdcRecord['op'] = 'c'): RawCdcRecord {
  return {
    op,
    ts_ms: 1_727_740_800_000,
    source: { table: 'transactions', lsn: '0/16B3748', txId: 7421 },
    before: null,
    after,
  };
}

const TX_ROW = {
  hash: 'a'.repeat(64),
  networkId: 'mainnet',
  ledgerSequence: 51_234_567,
  ledgerCloseTime: '2026-10-01T12:00:05.000Z',
  contractId: 'CCJZ5DGASBWQXR5MPFCJXMBI333XE5U3FSJTNQU7RIKE3P5GN2K2WYD5',
  sourceAccount: 'GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI',
  operationType: 'invoke_host_function',
  status: 'success',
  feeCharged: '104857',
  resourceInstructions: 2_500_000,
  resourceReadBytes: 4096,
  resourceWriteBytes: 512,
};

const parquetColumns = ANALYTICS_PARQUET_SCHEMA.fields.map((f) => f.name);

describe('Kafka → Parquet schema compatibility (#1247)', () => {
  beforeEach(() => {
    s3.send.mockReset().mockResolvedValue({});
  });

  describe('CDC transform output vs Parquet schema', () => {
    it('produces exactly the Parquet columns (no drift either way)', async () => {
      const row = await transformRecord(cdc(TX_ROW), 'job-1');
      expect(Object.keys(row!).sort()).toEqual([...parquetColumns].sort());
    });

    it('produces schema-valid rows for camelCase and snake_case CDC payloads', async () => {
      const camel = await transformRecord(cdc(TX_ROW), 'job-1');
      const snake = await transformRecord(
        cdc({
          tx_hash: 'b'.repeat(64),
          networkId: 'testnet',
          ledger_sequence: '777',
          ledgerCloseTime: '2026-10-01T00:00:00.000Z',
          contract_id: TX_ROW.contractId,
          source_account: TX_ROW.sourceAccount,
          operation_type: 'invoke_host_function',
          fee_charged: 100,
        }),
        'job-2',
      );
      expect(validateParquetRow(camel!)).toEqual([]);
      expect(validateParquetRow(snake!)).toEqual([]);
      expect(snake).toMatchObject({ ledger_sequence: 777, fee_charged: '100', network_id: 'testnet' });
    });

    it('populates optional event columns from decoded params', async () => {
      const row = await transformRecord(
        cdc({ ...TX_ROW, eventType: 'transfer', parsedParams: { amount: '5000000', assetCode: 'USDC' } }),
        'job-3',
      );
      expect(validateParquetRow(row!)).toEqual([]);
      expect(row).toMatchObject({ event_type: 'transfer', transfer_amount: '5000000', token_decimals: 7 });
    });

    it('carries CDC provenance into the Parquet row', async () => {
      const row = await transformRecord(cdc(TX_ROW), 'job-4');
      expect(row).toMatchObject({ etl_job_id: 'job-4', source_pg_lsn: '0/16B3748', source_pg_tx_id: 7421 });
    });

    it('flags a CDC payload whose ledger sequence is not numeric', async () => {
      const row = await transformRecord(cdc({ ...TX_ROW, ledgerSequence: 'not-a-ledger' }), 'job-5');
      expect(validateParquetRow(row!)).toEqual(['column "ledger_sequence" expected INT64, got null']);
    });

    it('drops delete and tombstone events instead of writing invalid rows', async () => {
      expect(await transformRecord(cdc(TX_ROW, 'd'), 'job-6')).toBeNull();
      expect(await transformRecord(cdc(null, 'u'), 'job-6')).toBeNull();
    });
  });

  describe('Parquet sink output', () => {
    it('writes rows that read back valid against the Parquet schema', async () => {
      const rows = await Promise.all([
        transformRecord(cdc(TX_ROW), 'job-7'),
        transformRecord(cdc({ ...TX_ROW, hash: 'c'.repeat(64), ledgerSequence: 51_234_570 }), 'job-7'),
      ]);
      const file = await writePartitionToS3(
        'transactions',
        'network_id=mainnet/month=2026-10',
        rows.map((r) => r!),
        'snapshot-0001',
      );

      const { input } = s3.send.mock.calls[0][0] as { input: { Body: Buffer; Metadata: Record<string, string> } };
      const written = input.Body.toString('utf-8').trim().split('\n').map((l) => JSON.parse(l));
      expect(written).toHaveLength(2);
      for (const row of written) expect(validateParquetRow(row)).toEqual([]);
      expect(input.Metadata['x-iceberg-schema-version']).toBe('1');
      expect(file).toMatchObject({ rowCount: 2, minLedger: 51_234_567, maxLedger: 51_234_570 });
    });
  });

  describe('validateParquetRow failure cases', () => {
    it('reports missing required, wrong-typed and unknown columns', async () => {
      const row = { ...(await transformRecord(cdc(TX_ROW), 'job-8'))! } as Record<string, unknown>;
      delete row.tx_hash;
      row.network_id = null;
      row.resource_instructions = 1.5;
      row.unexpected = 'x';
      expect(validateParquetRow(row)).toEqual([
        'required column "network_id" is null',
        'required column "tx_hash" is missing',
        'column "resource_instructions" expected INT64, got 1.5',
        'column "unexpected" is not in the Parquet schema',
      ]);
    });
  });

  describe('registry event schemas vs Parquet schema', () => {
    it.each(Object.entries(CORE_SCHEMAS))('%s is writable to Parquet without loss', (subject, fields) => {
      const report = checkEventToParquetCompatibility(subject, fields);
      expect(report.violations).toEqual([]);
      expect(report.compatible).toBe(true);
    });

    it('reports event fields that are not persisted to the lake', () => {
      const report = checkEventToParquetCompatibility('soroban.swap.executed', CORE_SCHEMAS['soroban.swap.executed']);
      expect(report.droppedFields).toEqual(['token_in', 'token_out']);
    });

    it('rejects an event type change the Parquet column cannot hold', () => {
      const evolved: SchemaField[] = CORE_SCHEMAS['soroban.tx.confirmed'].map((f) =>
        f.name === 'ledger_sequence' ? { ...f, type: 'string' } : f,
      );
      const report = checkEventToParquetCompatibility('soroban.tx.confirmed', evolved);
      expect(report.compatible).toBe(false);
      expect(report.violations).toEqual([
        '"ledger_sequence" (string) cannot be written losslessly to INT64 column "ledger_sequence"',
      ]);
    });

    it('rejects making a field optional when its Parquet column is required', () => {
      const evolved: SchemaField[] = CORE_SCHEMAS['soroban.tx.confirmed'].map((f) =>
        f.name === 'tx_hash' ? { ...f, optional: true } : f,
      );
      expect(checkEventToParquetCompatibility('soroban.tx.confirmed', evolved).violations).toEqual([
        'optional event field "tx_hash" maps to required column "tx_hash"',
      ]);
    });
  });
});
