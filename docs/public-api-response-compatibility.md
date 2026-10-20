# Public API response compatibility

This document defines the compatibility promise for the versioned public API.
It applies to every supported network independently: a Testnet deployment and
a Mainnet deployment may contain different data, but must expose the same v1
response shapes for the same endpoint and pagination mode.

## Compatibility policy

For v1 endpoints, additive fields are permitted. Existing fields, their JSON
types, and the meanings documented here are not removed, renamed, or changed
without a new API version and a migration notice. Consumers should ignore
fields they do not recognise.

Errors are also part of the contract: validation failures use the existing
error envelope. If a route implementation produces a value that does not meet
its response schema, it is rejected with
`RESPONSE_SCHEMA_VALIDATION_FAILED` instead of leaking a partial or malformed
success response.

## Offset pagination contracts

The offset mode remains the default for existing clients.

### `GET /api/v1/transactions`

```json
{
  "data": [{ "hash": "…", "ledgerSequence": 123 }],
  "total": 1,
  "page": 1,
  "limit": 20,
  "pages": 1
}
```

`data`, `total`, `page`, `limit`, and `pages` are all required. `pages` is not
interchangeable with a cursor flag: offset clients use it to determine their
last page.

### `GET /api/v1/events`

```json
{
  "data": [{ "id": "…", "ledgerSequence": 123 }],
  "total": 1,
  "page": 1,
  "limit": 20,
  "nextCursor": null
}
```

`nextCursor` remains present in offset responses and is `null` when no further
result is available. It must not be omitted merely because cursor pagination
is also supported.

## Cursor pagination is opt-in

Clients opt into opaque cursor pagination with `pagination=cursor` where an
endpoint supports it. Cursor responses use the endpoint-specific cursor shape
documented in [API cursor pagination](./api-cursor-pagination.md). Do not
assume an offset response has cursor-only fields, or that a cursor response
has a total count.

## Maintaining this contract

Focused route tests in
`tests/api/transaction-event-response-validation.test.ts` assert the legacy
transaction and event envelopes and reject implementations that omit a
required pagination field. When adding a public route or changing a response:

1. define or update its Zod response schema;
2. add a representative success assertion for the complete stable envelope;
3. add a malformed-output test for the field(s) being protected; and
4. describe an intentional breaking change in a versioned migration note.

This approach protects integrations during staged rollouts: deploy compatible
code to every network first, then ask clients to opt into new fields or modes.
