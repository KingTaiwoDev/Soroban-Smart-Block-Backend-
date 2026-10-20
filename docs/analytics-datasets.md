# Analytics datasets

Public dataset snapshots are published through `src/api/public-datasets.ts`
(`/api/v1/datasets`) from files produced by the CDC → transform → Parquet/Iceberg
pipeline in `src/analytics/`.

## Lineage (#1245)

Every published manifest now records:

- `network` — the deployment's network profile (`STELLAR_NETWORK`); each
  profile runs its own pipeline, so a manifest only ever describes one network.
- `etlJobIds` — the ETL jobs whose output files make up the snapshot. Pass them
  in the publish body (`POST /datasets/:dataset/manifests`, optional, ≤ 100,
  de-duplicated).

`GET /api/v1/datasets/:dataset/manifests/:id/lineage` joins the manifest with
each job's `EtlLineageRecord` (`src/analytics/data-quality/checks.ts`) and
returns, per job, the CDC source tables, PostgreSQL tx-id and WAL LSN ranges,
the Parquet files written and the ledger range they cover
(`src/analytics/lineage.ts`). `complete` is `false` with `issues` when:

| code               | meaning                                                         |
| ------------------ | --------------------------------------------------------------- |
| `no_jobs`          | manifest was published without `etlJobIds`                     |
| `job_not_found`    | no lineage record for a referenced job                          |
| `job_failed`       | a referenced job finished with status `failed`                  |
| `network_mismatch` | a job's `network` differs from the manifest's network           |
| `ledger_gap`       | part of the manifest's `ledgerRange` is not covered by any job  |

### Compatibility and rollout

- Both manifest fields are additive; existing clients are unaffected. Manifests
  published before this change (or without `etlJobIds`) report `no_jobs`.
- `EtlLineageRecord.network` is optional. ETL jobs should set it to the
  `network_id` they ingested; legacy records without it are not flagged as a
  network mismatch.
- Lineage records live in the ETL process's in-memory store (S3-backed in
  production); publish manifests from the process that ran the jobs, or lineage
  reports `job_not_found`.

## Data-quality scorecard (#1246)

`GET /api/v1/datasets/quality-scorecard?network=<testnet|mainnet|devnet>&limit=<1-500>`
aggregates the most recent `limit` (default 100) ETL lineage records for one
network into a score per indexed table (`src/analytics/data-quality/scorecard.ts`):

```
score = 100 × checkPassRate × (1 − rowRejectRate) × jobSuccessRate
```

- Any failed `critical` check caps the table at 59 (grade F). Grades: A ≥ 90,
  B ≥ 80, C ≥ 70, D ≥ 60, F otherwise.
- Checks named `<check>:<table>` count only toward that table; unscoped checks
  (e.g. `file_size_check`) count toward every source table of the job.
- Tables without recorded checks report `score: null` rather than a perfect score.
- `overall` is the mean of the scored tables.

### Network implications

`network` defaults to the deployment's `STELLAR_NETWORK`. Only lineage records
whose `network` matches are scored, so testnet resets or devnet churn never
affect the mainnet scorecard. Records written without `network` (before #1245)
are excluded and counted in `unattributedJobs`; set `network` on new ETL
lineage records to have them scored.

## Schema compatibility: Kafka events → Parquet (#1247)

`tests/analytics/schema-compat.test.ts` guards both seams of the pipeline using
`src/analytics/etl/schema-compat.ts`:

- **CDC → Parquet rows.** Debezium-shaped CDC records are run through
  `transformRecord` and the Parquet sink (`writePartitionToS3`, S3 mocked); every
  written row must validate against `ANALYTICS_PARQUET_SCHEMA` (required columns
  present, INT columns are safe integers, no columns outside the schema), and the
  transform's output keys must equal the schema's columns.
- **Registry events → Parquet columns.** Each `CORE_SCHEMAS` subject must be
  writable losslessly: `long`/`int`/`double` may land in their numeric column or a
  UTF8 decimal string (fees and amounts are strings in Parquet), and an optional
  event field may not feed a required column. Fields with no column (e.g.
  `token_in`/`token_out` on `soroban.swap.executed`) are reported as
  `droppedFields`.

When changing either schema, update `ANALYTICS_PARQUET_SCHEMA` (and bump the
`x-iceberg-schema-version` object metadata for breaking changes) in the same
change; these tests fail on drift. Note for multi-network deployments: the
transform falls back to `network_id = 'testnet'` when a CDC row has no
`networkId`, so non-testnet sources must emit it for partitions to be correct.
