# Audit log integrity (#1244)

`RbacAuditLogger` (`src/rbac/audit-logger.ts`) hash-chains every record it writes
to `_audit_logs`. The checksum is computed by `src/rbac/audit-integrity.ts` over
the **persisted** columns (`id`, `actor`, `action`, `target`, `previousState`,
`newState` minus integrity keys, `reason`, `createdAt`) plus the previous
record's checksum, using canonical JSON (sorted keys) so it survives the JSONB
round-trip. It is stored inside `newState` as `checksum`, `previousChecksum` and
`integrityVersion: 2` — no schema migration is required.

## Verifying

`GET /api/v1/admin/audit-integrity?from=<ISO>&to=<ISO>&limit=<n>` (admin auth)
recomputes every chained record in the window (oldest first, default 1000,
max 10000) and returns `200` when it verifies or `409` with `failures`:

| reason              | meaning                                                                    |
| ------------------- | -------------------------------------------------------------------------- |
| `checksum_mismatch` | stored columns no longer match the checksum (edited row or forged hash)   |
| `chain_broken`      | `previousChecksum` points to a record that no longer exists (deleted row) |
| `missing_checksum`  | a security-sensitive action (`rbac.*` changes, `api_key.*`, `tenant.*`, `admin.action`, `system.config.changed`, `security.*`, freezes, `data.deletion`) has no checksum |

Each failure carries `securitySensitive` so alerting can prioritise changes to
roles, permissions, keys and configuration.

## Rollout and compatibility

- **Keyed checksums.** Set `AUDIT_INTEGRITY_SECRET` (per network profile, from
  the secret store) so checksums are HMAC-SHA256; without it plain SHA-256 is
  used, which detects accidental corruption but not an attacker with DB write
  access. Enabling or rotating the secret starts a new chain — records written
  under the previous key report `checksum_mismatch` and must be verified with the
  old key before rotating.
- **Legacy records.** Rows written before this change carry a `checksum` without
  `integrityVersion`; they cannot be recomputed from stored columns and are only
  counted as `legacy`. The first new record links to the last legacy checksum.
- **Unchained writers.** Request-level writers (`rbac/middleware.ts`
  `permission_check`, `db/tenant-aware-db.ts`, `api/freeze.ts`,
  `services/fraudAlertSystem.ts`) do not use the chain; their rows are counted as
  `unchained` and are not failures.
- **Multiple replicas / networks.** Each process keeps its own chain head, so a
  deployment with several API replicas produces several interleaved chains;
  verification is link-based and handles this. Each network profile has its own
  database and therefore its own independent chain.
