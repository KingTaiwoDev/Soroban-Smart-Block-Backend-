# Threat Model: Ingestion, Analytics, and Data Export Flows

Scope: the three data paths that move chain data into, through, and out of the
explorer backend. Every component below is referenced by its real source file;
`tests/docs/threat-model-references.test.ts` fails if a referenced path is
renamed or removed, so this document cannot silently drift from the code.

Method: STRIDE per trust boundary, with each threat mapped to the control that
exists today and, where there is none, a tracked gap.

## 1. Assets

| Asset | Where it lives | Why it matters |
| --- | --- | --- |
| Indexed ledger/transaction/event rows | Postgres via `src/db.ts` | Source of truth for every API response, export and dataset |
| Indexer checkpoint / cursor | `src/indexer/checkpoint.ts`, `src/indexer-state.ts` | Corrupting it causes skipped or duplicated ledgers |
| Dead-letter items | `src/indexer/errorQueue.ts` | Contain raw failing payloads; must not be replayed blindly |
| Export job files | `EXPORT_DIR` (`src/config.ts`), written by `src/indexer/csv-exporter.ts` | Per-developer data, may include wallet history and audit trail |
| Published dataset manifests | `src/api/public-datasets.ts` | Public integrity anchor (sha256) for bulk downloads |
| API keys / developer identity | `src/middleware/apiKeyAuth.ts` | Gate for exports, analytics queries and the lakehouse |
| Data lake / warehouse credentials | `src/analytics/query-engine/query-router.ts` | Athena/Trino access used by the analytics query endpoint |

## 2. Trust boundaries

1. **Stellar RPC / Horizon -> indexer** (`src/indexer/rpc.ts`, `src/indexer/indexer.ts`).
   Upstream nodes are operated by third parties and their responses are untrusted input.
2. **Indexer -> Postgres / analytics ETL** (`src/indexer/decoder.ts`,
   `src/analytics/etl/xdr-transform.ts`, `src/analytics/data-lake/iceberg-writer.ts`).
3. **API client -> analytics endpoints** (`src/api/analytics-query.ts`,
   `src/api/lakehouse.ts`, `src/api/sql-export.ts`), mounted behind `requireApiKey`
   in `src/api/router.ts`.
4. **API client -> export endpoints** (`src/api/exports.ts`), authenticated with
   `apiKeyAuth` + `requireApiKey` and scoped by `developerId`.
5. **Public internet -> dataset catalog** (`src/api/public-datasets.ts`), read-only
   and unauthenticated; publishing is behind `adminAuth`.
6. **Backend -> observability** (`src/metrics.ts`, `src/middleware/metricsMiddleware.ts`,
   `src/middleware/errorHandler.ts`). Metrics and logs leave the trust boundary to
   Prometheus/Grafana and log shipping.

## 3. Ingestion flow

`src/indexer/indexer.ts` fetches ledger metadata and events through
`src/indexer/rpc.ts`, decodes XDR in `src/indexer/decoder.ts`, writes rows, and
advances the checkpoint in `src/indexer/checkpoint.ts`. Failures go to
`src/indexer/errorQueue.ts`; consistency is re-checked by
`src/indexer/reconciliation.ts` and repaired by `src/indexer/repair.ts`.

| STRIDE | Threat | Existing control | Gap / follow-up |
| --- | --- | --- | --- |
| Spoofing | Malicious or misconfigured RPC returns forged ledgers | RPC failover and per-network endpoints (`src/indexer/rpc.ts`, `docs/stellar-rpc-failover.md`); deep reorg check against remote metadata in `src/indexer/indexer.ts` | No cross-endpoint quorum; a single compromised endpoint is trusted until reconciliation runs |
| Tampering | Crafted XDR crashes or mis-decodes into wrong rows | Decode via `@stellar/stellar-sdk` types in `src/indexer/decoder.ts`; poison detection and `MAX_RETRIES` isolation to the DLQ in `src/indexer/errorQueue.ts` | DLQ replay must be operator-initiated (`docs/dead-letter-queue-runbook.md`) |
| Repudiation | Unknown which endpoint produced a bad ledger | RPC metrics with `network`/`endpoint` labels (`src/indexer/rpc-metrics.ts`) | Endpoint provenance is not stored per row |
| Information disclosure | Raw payloads from DLQ leak via logs or metrics | Bounded metric labels (`indexer_error_dlq_total{network,reason}`) in `src/metrics.ts`; `reason` passed through `sanitizeMetricLabelValue` (`src/lib/metric-labels.ts`) | Log lines still include item ids; keep log access restricted |
| Denial of service | Oversized ledgers or event floods stall ingestion | Batch prefetch with bounded concurrency, adaptive polling (`src/indexer/adaptive-polling.ts`), graceful degradation (`src/indexer/graceful-degradation.ts`), freshness SLO (`docs/indexer-freshness-slo.md`) | — |
| Elevation of privilege | Ingested contract metadata (names, NFT URIs) used to reach internal hosts | SSRF protections for outbound metadata fetches (`SSRF_DNS_REBINDING_FIX.md`, `src/indexer/nft-metadata-fetcher.ts`) | — |

Network-specific notes: mainnet, testnet and devnet run as separate indexer
processes (`npm run index:<network>`) and rows are network-scoped
(`docs/network-scoped-indexed-records.md`). A compromised testnet RPC must never
write mainnet rows; keep per-network `DATABASE_URL`/`STELLAR_NETWORK` pairs in
separate deployment units.

## 4. Analytics flow

ETL (`src/analytics/etl/xdr-transform.ts`, `src/analytics/etl/kafka-config.ts`)
lands data in the lake (`src/analytics/data-lake/iceberg-writer.ts`,
`src/analytics/data-lake/glue-catalog.ts`). Clients query it through
`POST /api/v1/analytics/query` (`src/api/analytics-query.ts` ->
`src/analytics/query-engine/query-router.ts`), the lakehouse gateway
(`src/api/lakehouse.ts` -> `src/analytics/lakehouse/query-gateway.ts`) and
template rendering (`src/api/sql-export.ts` -> `src/analytics/dashboards/templates.ts`).
Data quality and lineage are tracked in `src/analytics/data-quality/checks.ts`.

| STRIDE | Threat | Existing control | Gap / follow-up |
| --- | --- | --- | --- |
| Spoofing | Anonymous caller runs expensive warehouse queries | `requireApiKey` on `/analytics/query`, `/lakehouse`, `/analytics/sql-export` in `src/api/router.ts` | — |
| Tampering | Raw SQL submitted to `/analytics/query` mutates the lake (DDL/DML) | SQL length capped at 16 000 chars (`src/api/analytics-query.ts`) | **No statement allowlist**: the SQL is forwarded verbatim to Athena/Trino. The warehouse principal used by `src/analytics/query-engine/query-router.ts` must be read-only at the IAM/catalog level. Tracked as a gap |
| Tampering | Template parameter injection | `interpolateTemplate` quotes strings and doubles single quotes (`src/analytics/dashboards/templates.ts`) | Identifier-position parameters are not supported and must stay that way |
| Information disclosure | Cross-tenant data in shared tables | Lake tables contain public chain data only | Do not land tenant/org data (API keys, webhooks, alerts) in the lake |
| Denial of service | Unbounded scans drive cost | `estimateQueryCost` and `maxScanBytes` rejection in `src/analytics/query-engine/query-router.ts`; per-endpoint budgets (`docs/EXPENSIVE_ENDPOINT_BUDGETS.md`) | `maxScanBytes` is optional; set a server-side default before enabling Athena in production |
| Elevation of privilege | Lakehouse group-by/measure names reach SQL | `QuerySchema` zod validation in `src/api/lakehouse.ts`; measures limited to `sum/count/avg/min/max` | `groupBy` and `column` must be checked against the dataset schema in `src/analytics/lakehouse/schema-registry.ts` when a real SQL driver is wired |

## 5. Export flows

### 5.1 Private export jobs (`/api/v1/exports`)

`src/api/exports.ts` enqueues jobs via `enqueueExport` in
`src/indexer/csv-exporter.ts`, which writes files under `EXPORT_DIR`.
Downloads resolve paths through `src/exports/resolve-path.ts`.

| STRIDE | Threat | Existing control | Gap / follow-up |
| --- | --- | --- | --- |
| Spoofing | Unauthenticated job creation/download | `apiKeyAuth` + `requireApiKey` on the router | — |
| Tampering | Path traversal via a stored `filePath` | `resolveExportFilePath` rejects paths escaping `EXPORT_DIR` (`ExportPathError` -> 400) | — |
| Repudiation | Who exported audit-trail data | Jobs record `developerId`; audit trail is append-only | Download events are not audited separately |
| Information disclosure | Developer A reads developer B's job (IDOR) | Every lookup uses `ownedJobWhere` (`developerId` + `id`); foreign ids return 404, not 403 | Exports are scoped per developer, not per organization; org-shared exports require a deliberate design change |
| Information disclosure | CSV formula injection when opened in spreadsheets | `escapeCsv` in `src/indexer/csv-exporter.ts` quotes commas, quotes and newlines | Cells starting with `=`, `+`, `-`, `@` are not neutralised; consumers should import as text until a prefix guard is added |
| Denial of service | Job flooding fills `EXPORT_DIR` | List capped at 50 jobs; API key rate limits | No per-developer concurrent-job quota; default `EXPORT_DIR` is `/tmp/soroban-exports` and must be a dedicated volume in production |

### 5.2 Public datasets (`/api/v1/datasets`)

`src/api/public-datasets.ts` serves catalog and manifests publicly; manifests
are published by operators through `adminAuth`.

| STRIDE | Threat | Existing control | Gap / follow-up |
| --- | --- | --- | --- |
| Spoofing | Non-admin publishes a manifest pointing at attacker files | `adminAuth` on `POST /:dataset/manifests` | — |
| Tampering | Manifest file path escapes the bucket prefix | `FileSchema` regex, `..` and leading `/` rejected; URLs built from `DATASET_PUBLIC_BASE_URL` | — |
| Tampering | Downloaded file differs from what was published | Per-file `sha256` and manifest id hash | Consumers must verify; the backend does not re-hash bucket objects |
| Information disclosure | Private data appears in a public dataset | Dataset definitions (`DATASETS`) list public chain columns only | Any new dataset column requires security review |
| Denial of service | Publish storms | `minIntervalMinutes` per dataset, `MAX_MANIFESTS_PER_DATASET` retention | Manifests are in-memory; restart loses history until persisted |

## 6. Observability as an exfiltration channel

Prometheus labels and logs are readable by a wider audience than the database.
HTTP route labels go through `normaliseRouteLabel` in `src/lib/metric-labels.ts`
(used by `src/middleware/metricsMiddleware.ts` and `src/middleware/errorHandler.ts`),
which replaces Stellar strkeys (`G...` accounts, `C...` contracts, `M...` muxed,
etc.) with `:address`, 64-hex hashes with `:hash`, and UUID/cuid/numeric ids
with `:id`, then caps the value at 128 characters. Free-form label values (for
example the DLQ `reason`) use `sanitizeMetricLabelValue`. `/metrics` access is
restricted (`tests/metrics-access.test.ts`). New metrics must use bounded label
sets; any label not drawn from a fixed allowlist must be passed through
`sanitizeMetricLabelValue`.

Rollout note: for unmatched routes (404s) and error-handler metrics, `route`
values that previously contained raw identifiers now read e.g.
`/api/v1/contracts/:address`. Dashboards or alerts filtering on a specific raw
address must switch to logs/traces; aggregate series are unaffected.

## 7. Compatibility and rollout

- This document introduces no runtime behaviour change.
- Gaps marked above are tracked as follow-ups; the highest priority is the
  read-only warehouse principal for `/analytics/query`, which is an operator
  (IAM) control and is required before enabling Athena/Trino on mainnet.
- Testnet/devnet deployments may share warehouse credentials; mainnet must use
  its own read-only principal and its own `EXPORT_DIR` volume.
- Review this model whenever a new ingestion source, analytics engine, export
  type or public dataset is added.
