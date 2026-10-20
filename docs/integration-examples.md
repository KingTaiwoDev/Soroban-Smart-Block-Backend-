# End-to-end integration examples

The examples in `examples/integration/` are deliberately read-only. They make
an end-to-end request through the deployed API rather than accessing the
database or Soroban RPC directly, so they are safe for a developer sandbox,
testnet, and production diagnostic use.

## Prerequisites

Set the base URL for the intended network profile. The API pins one profile at
startup and reports it from `GET /api/v1/network`; do not assume that a URL
serving testnet can query mainnet by adding a request header. Supply `API_KEY`
only if the deployment requires it. `CONTRACT_ID` is optional.

```sh
export API_BASE_URL=https://testnet-api.example.com
export API_KEY=replace-with-a-read-only-key
export CONTRACT_ID=C... # optional
```

## TypeScript

```sh
npx ts-node examples/integration/typescript-e2e.ts
```

The example checks health, discovers the active network, lists recent events,
and optionally retrieves one contract. It exits non-zero on an HTTP failure.

## curl

```sh
sh examples/integration/curl-e2e.sh
```

Both examples use `Authorization: Bearer` only when `API_KEY` is present and
never print the key. For a fuller API contract, use the deployment’s
`/api/docs` Swagger UI.
