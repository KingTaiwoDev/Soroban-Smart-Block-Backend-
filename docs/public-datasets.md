# Public dataset schemas

Bulk-download datasets are described by `GET /api/v1/datasets` and
`GET /api/v1/datasets/:dataset`, defined in `src/api/public-datasets.ts`.
All datasets are currently at `schemaVersion: 1` and published as Parquet and
CSV, partitioned by the column listed below. Each deployment publishes the
datasets of its own network (`STELLAR_NETWORK`); there is no network column,
so consumers must not mix files from different deployments.

Each column in the catalog response now carries `description` and
`sensitivity` (additive fields).

## Sensitivity classes

| Class | Meaning |
| --- | --- |
| `public` | On-chain value with no direct link to an account holder. |
| `pseudonymous` | Public on-chain account identifier (or payload that may contain one). Already public on the ledger, but can be correlated with a person off-chain. |

## `transactions` (hourly, partitioned by `ledger_date`)

| Column | Type | Sensitivity | Description |
| --- | --- | --- | --- |
| `hash` | string | public | Transaction hash (hex) |
| `ledger` | int64 | public | Ledger sequence |
| `ledger_date` | date | public | UTC ledger close date |
| `source_account` | string | pseudonymous | Source account (G… strkey) |
| `contract_id` | string | public | Invoked contract (C… strkey), null if none |
| `fee_charged` | int64 | public | Fee charged in stroops |
| `successful` | bool | public | Transaction succeeded |

## `events` (hourly, partitioned by `ledger_date`)

| Column | Type | Sensitivity | Description |
| --- | --- | --- | --- |
| `id` | string | public | Event id |
| `ledger` | int64 | public | Ledger sequence |
| `ledger_date` | date | public | UTC ledger close date |
| `contract_id` | string | public | Emitting contract (C… strkey) |
| `topic` | string | public | Decoded event topics |
| `data_json` | string | pseudonymous | Decoded event payload as JSON; may contain account addresses |

## `contracts` (daily, partitioned by `deployed_date`)

| Column | Type | Sensitivity | Description |
| --- | --- | --- | --- |
| `contract_id` | string | public | Contract address (C… strkey) |
| `wasm_hash` | string | public | Installed WASM hash (hex) |
| `deployer` | string | pseudonymous | Deploying account (G… strkey) |
| `deployed_ledger` | int64 | public | Deployment ledger |
| `deployed_date` | date | public | UTC deployment date |

## `tokens` (daily, partitioned by `snapshot_date`)

| Column | Type | Sensitivity | Description |
| --- | --- | --- | --- |
| `contract_id` | string | public | Token contract address (C… strkey) |
| `symbol` | string | public | Token symbol |
| `decimals` | int32 | public | Token decimals |
| `total_supply` | decimal(38,0) | public | Total supply in base units |
| `snapshot_date` | date | public | UTC snapshot date |

## Sensitive-field review

- **Columns:** every exported value is already public on the Stellar ledger.
  No off-chain data (API keys, emails, IP addresses, sessions, user agents) is
  included. Account addresses are classed `pseudonymous`; they are kept because
  they are the primary join keys for explorer analysis.
- **Deliberately excluded:** transaction memos (frequently carry exchange
  deposit IDs or other off-chain identifiers), raw envelope XDR and
  signatures. `SENSITIVE_COLUMN_PATTERN` rejects these and other secret/PII
  names at module load, so a schema change that adds one fails at startup and
  in `tests/api/public-datasets-schema.test.ts`.
- **Manifest URLs (redacted):** file URLs are built from
  `DATASET_PUBLIC_BASE_URL`. Credentials embedded in that URL
  (`https://user:pass@host/...`) were previously echoed in every public
  manifest; they are now stripped. Do not configure signed/secret query
  strings in this variable — it must point at a publicly readable location.
- **Admin-only fields:** manifests are published via the admin endpoint and
  contain only ledger range, file paths, sizes, row counts and SHA-256 hashes.

## Compatibility

Column additions to the catalog response are additive. Changing a column's
name, type or meaning requires bumping `SCHEMA_VERSION`. Removing a column
from a dataset is a breaking change for downstream consumers and should be
announced alongside a schema version bump.
