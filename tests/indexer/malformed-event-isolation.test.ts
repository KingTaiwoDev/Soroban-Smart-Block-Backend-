import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/db', () => ({
  prismaWrite: {
    ledgerDecodeError: { upsert: vi.fn() },
  },
}));
vi.mock('../../src/config', () => ({ config: { stellarNetwork: 'testnet' } }));

import { prismaWrite } from '../../src/db';
import { decodeEvent, decodeEventStrict } from '../../src/indexer/decoder';
import { recordLedgerDecodeError } from '../../src/indexer/errorQueue';

describe('malformed event isolation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keeps the compatibility decoder best-effort while the strict decoder exposes malformed XDR', () => {
    expect(() => decodeEventStrict(['not-base64'], 'not-base64')).toThrow();
    expect(decodeEvent(['not-base64'], 'not-base64').eventType).toBe('unknown');
  });

  it('records malformed input with ledger and network context idempotently', async () => {
    await recordLedgerDecodeError({
      network: 'testnet',
      eventId: 'testnet-tx-100-0',
      ledger: 100,
      transactionHash: 'tx',
      eventIndex: 0,
      topics: ['bad-topic'],
      data: 'bad-data',
      error: new Error('Malformed event XDR'),
    });

    expect(prismaWrite.ledgerDecodeError.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { network_eventId: { network: 'testnet', eventId: 'testnet-tx-100-0' } },
        create: expect.objectContaining({ ledger: 100, eventIndex: 0 }),
      }),
    );
  });
});
