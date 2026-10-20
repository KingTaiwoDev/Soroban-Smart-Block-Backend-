# Protocol-versioned XDR decoder fixtures

`tests/fixtures/xdr-decoder/` contains deterministic, synthetic event XDR for
each supported Stellar protocol version. The fixture test decodes every case
with the production strict decoder; it is intentionally offline and never
depends on an RPC endpoint.

When supporting a new protocol:

1. Add `protocol-<version>.json` with a documented synthetic source and at
   least one event that exercises the new or changed XDR shape.
2. Keep existing fixture files unchanged. They protect compatibility for
   historical ledgers and network profiles.
3. Add the file to `tests/indexer/protocol-xdr-fixtures.test.ts` and include a
   malformed case in the regression corpus when the protocol exposes one.

Malformed XDR is isolated by the indexer into `_ledger_decode_errors` and the
dead-letter queue. It does not block valid events later in the same ledger
range. Operators should resolve the parser/fixture gap and replay the specific
dead-letter item using the audited command in the DLQ runbook.
