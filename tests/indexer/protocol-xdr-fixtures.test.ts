import { describe, expect, it, vi } from 'vitest';
import protocol20 from '../fixtures/xdr-decoder/protocol-20.json';
import protocol21 from '../fixtures/xdr-decoder/protocol-21.json';

vi.mock('../../src/db', () => ({
  prismaRead: { contract: { findUnique: vi.fn() }, contractNetwork: { findUnique: vi.fn() } },
}));

import { decodeEventStrict } from '../../src/indexer/decoder';

const fixtures = [protocol20, protocol21];

describe('protocol-versioned XDR decoder fixtures', () => {
  it.each(fixtures)('keeps protocol $protocolVersion fixtures decodable', (fixture) => {
    expect(fixture.protocolVersion).toBeGreaterThan(0);
    expect(fixture.cases.length).toBeGreaterThan(0);
    for (const event of fixture.cases) {
      const decoded = decodeEventStrict(event.topics, event.data);
      expect(decoded.eventType).toBe(event.expected.eventType);
      expect(decoded.topicSymbol).toBe(event.expected.topicSymbol);
    }
  });

  it('keeps fixtures unique across protocol versions', () => {
    const ids = fixtures.flatMap((fixture) => fixture.cases.map((event) => event.id));
    expect(new Set(ids).size).toBe(ids.length);
  });
});
