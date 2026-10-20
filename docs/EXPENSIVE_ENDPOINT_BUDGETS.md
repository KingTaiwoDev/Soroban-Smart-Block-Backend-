# Expensive endpoint budgets

The API now mounts the request-timeout middleware so the route policies in
`src/middleware/requestTimeout.ts` are enforced. Health and ordinary API
requests use `TIMEOUT_FAST_MS` (5 seconds) and `TIMEOUT_NORMAL_MS` (30 seconds)
respectively. Analytics, archive, export, and compute-heavy API routes
(`simulate`, `verify`, `compiler`, `query`, and `aa`) use `TIMEOUT_LONG_MS`
(5 minutes); bulk routes use `TIMEOUT_EXTENDED_MS` (15 minutes). The timeout
environment variables remain the operational override and are not network
specific.

Non-streaming JSON responses are also capped by route group:

| Route group | Maximum serialized response |
| --- | ---: |
| `/api/v1/batch/*` | 2 MiB |
| Analytics, DEX analytics, portfolio, simulation, verification, compiler, and query routes | 5 MiB |

The server never truncates an over-budget representation. It returns HTTP 500
with code `RESPONSE_TOO_LARGE` and logs the response size and configured cap.
Clients should paginate or narrow filters and retry; exports that need larger
payloads should use a streaming/download contract rather than raising this
JSON cap. Existing 1 MiB request-body limits are unchanged. These limits apply
equally on mainnet, testnet, and devnet; network selection does not change
timeout or response-size budgets.

These enforcement points are additive to existing status/headers except where
a response exceeds its new budget or execution timeout. Operators should
monitor `RESPONSE_TOO_LARGE` logs and `REQUEST_TIMEOUT` responses before
adjusting the current limits. No migration is required.

## Analytics data-lake query budgets

`POST /api/v1/analytics/query` additionally enforces per-query resource budgets
inside the query engine (`src/analytics/query-engine/query-router.ts`), so a
query is cancelled at the engine rather than left running after the HTTP
request times out.

| Budget | Env var | Default | Error code / status |
| --- | --- | ---: | --- |
| Execution time | `ANALYTICS_MAX_TIMEOUT_MS` | 300000 (also the hard max) | `QUERY_TIMEOUT` / 504 |
| Bytes scanned | `ANALYTICS_MAX_SCAN_BYTES` | 1 TiB | `SCAN_BUDGET_EXCEEDED` / 400 |
| Rows returned | `ANALYTICS_MAX_ROWS` | 10000 | `ROW_BUDGET_EXCEEDED` / 400 |

- Callers may pass `timeoutMs`, `maxScanBytes`, and `maxRows` to request a
  *tighter* budget; values above the server ceiling are clamped down, and
  `maxScanBytes: 0` now means "use the server budget" instead of "no limit".
- When the caller supplies `maxScanBytes`, the heuristic estimate is checked
  before submission (existing behaviour). The server ceiling is enforced
  against the engine's actual `DataScannedInBytes` while an Athena query runs.
- Over-budget Athena queries are stopped with `StopQueryExecution`; over-budget
  Trino queries are cancelled with `DELETE nextUri`. Previously a timed-out
  Athena query fell through to fetching partial results, and a timed-out Trino
  query returned whatever rows had arrived; both now fail with `QUERY_TIMEOUT`.
- Error body: `{ "error": "...", "code": "QUERY_TIMEOUT", "limit": 30000 }`.
- Trino does not report scanned bytes on this path, so the scan budget is
  enforced for Athena only. For defence in depth, also set the Athena workgroup
  `BytesScannedCutoffPerQuery` to the same value.
- Budgets are global, not per network: the data lake holds all networks and
  queries filter by `network_id`.
