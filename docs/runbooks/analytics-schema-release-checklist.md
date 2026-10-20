# Analytics Schema Release Checklist and Operational Runbook

> Operational procedures for introducing, migrating, and releasing analytics schema changes across the multi-layer data lakehouse.

## Overview

The analytics data lakehouse (`DATA_LAKEHOUSE_ARCHITECTURE.md`) separates ingest, real-time stream processing, OLAP reporting (ClickHouse), and cold storage (Iceberg/S3) behind a unified query gateway.

Every event published to the stream bus carries a schema registered in the `SchemaRegistry` (`src/analytics/lakehouse/schema-registry.ts`). Because producers (indexer nodes), stream processors, materialized view loaders, and downstream consumers deploy asynchronously, all analytics schema changes must follow this reproducible checklist and pass the automated release validator.

---

## Automated Checklist Verification

Before cutting an analytics release or applying schema migrations, execute the pre-flight verification script against the proposed schema change:

```bash
# Run automated pre-flight checklist verification
npm run analytics:schema-check -- --proposal path/to/proposal.json
```

The validator verifies:
1. **Schema Compatibility**: Enforces `BACKWARD` compatibility (or configured mode) against the latest registered subject version.
2. **Expand-Contract Discipline**: Ensures new fields in the expand phase are optional or have defaults.
3. **Network Staging Gate**: Guarantees sequential rollout across `devnet` -> `testnet` -> `mainnet`.
4. **Downstream Pipeline Alignment**: Verifies that stream processors and materialized views receive all required fields.
5. **Rollback Readiness**: Confirms a reproducible rollback procedure is configured.

---

## Release Checklist

### Phase 1: Expand (Non-Breaking Registration & Consumer Upgrade)

- [ ] **Verify Subject Compatibility**:
  - Run the schema compatibility check:
    ```typescript
    checkCompatibility('BACKWARD', previousFields, nextFields)
    ```
  - New fields must be marked `optional: true` or have an explicit default value.
  - Existing field types cannot change (`string`, `long`, `double`, `boolean`, `bytes`).
  - Required fields cannot be deleted without a multi-phase contract cycle.
- [ ] **Register Schema in Devnet Registry**:
  - Deploy the updated schema registry to the devnet cluster.
  - Verify schema ID assignment is monotonic.
- [ ] **Deploy Dual-Read Consumers**:
  - Deploy stream processors and materialized view jobs capable of consuming both v(n) and v(n+1) schemas.
  - Verify that consumers use schema defaults when reading v(n) events missing new fields.
- [ ] **Validate Downstream OLAP Alignment**:
  - If ClickHouse tables or Iceberg columns require the new field, execute `ALTER TABLE ... ADD COLUMN` with appropriate nullability/defaults prior to producer enablement.

### Phase 2: Write (Producer Enablement & Network Rollout)

Schema changes must roll out across networks sequentially. Never deploy simultaneously or promote to mainnet without testnet bake time.

- [ ] **Devnet Rollout**:
  - Configure devnet indexers with `STELLAR_NETWORK=devnet`.
  - Produce synthetic traffic; verify zero serialization or deserialization errors in lakehouse logs.
  - Inspect `/api/v1/lakehouse/query` for consistent metrics.
- [ ] **Testnet Rollout**:
  - Configure testnet indexers with `STELLAR_NETWORK=testnet`.
  - Let run for at least 24 hours under live testnet block traffic.
  - Confirm stream lag (`stream_bus_consumer_lag_records`) remains below 500 records.
  - Verify materialized views (`mv_mev_per_block`, `mv_compliance_daily`, `mv_protocol_economics_monthly`) update correctly without dropped rows.
- [ ] **Mainnet Canary & Promotion**:
  - Ensure all previous gates on devnet and testnet are checked and signed off.
  - Deploy canary indexer on mainnet with new schema emitter enabled.
  - Monitor consumer error metrics (`schema_compatibility_error_total`, `stream_bus_dead_letter_total`).
  - Shift remaining mainnet replicas over a 4-hour window.

### Phase 3: Contract (Deprecation & Cleanup)

- [ ] **Observation & Backfill Verification**:
  - Confirm all producers on all active replicas are emitting the new schema version.
  - If an OLAP historical backfill was required (`olapBackfillRequired: true`), verify that the backfill job completed successfully across the warm/cold storage tiers (`olapBackfillVerified: true`).
- [ ] **Retire Legacy Reader Code**:
  - Once the 7-day hot retention window in PostgreSQL/Kafka has passed, deprecate legacy reader fallback paths.

---

## Operational Rollback & Disaster Recovery

### Rollback Trigger Thresholds

Initiate an immediate rollback if any of the following conditions occur after deploying a schema change:
1. Deserialization error rate (`lakehouse_deserialization_errors / total_events`) exceeds **0.01%**.
2. Stream consumer lag surges above **10,000 records** on any partition.
3. Query gateway p95 latency degrades by more than **25%** or returns 5xx errors on analytics endpoints.
4. Data quality validation checks fail in `src/analytics/data-quality/checks.ts`.

### Rollback Steps

1. **Revert Producer Deployment**:
   - Immediately revert the indexer producer image or toggle feature flag to revert to the previous schema version:
     ```bash
     bash scripts/rollback-release.sh soroban soroban-indexer-<network>
     ```
   - Because Phase 1 established dual-read consumers, consumers will cleanly process events from the previous schema version without downtime.
2. **Preserve Schema Registry Monotonicity**:
   - Do NOT delete or modify existing schema IDs in the schema registry.
   - If a schema definition was flawed, register a new version with the fix rather than modifying IDs in place.
3. **Dead-Letter Queue Inspection**:
   - Query the lakehouse DLQ topic/table for any failed messages generated during the incident:
     ```bash
     # Inspect DLQ messages
     npm run dead-letter:inspect -- --subject <subject-name>
     ```
   - Replay messages through the query gateway rehydration tool once the fix is deployed.

---

## Network Profile Reference

| Network | Configuration Variable | Registry Subject Prefix | Minimum Bake Time Before Mainnet |
| --- | --- | --- | --- |
| `devnet` | `DEVNET_DATABASE_URL` | `devnet.*` | Initial validation |
| `testnet` | `TESTNET_DATABASE_URL` | `testnet.*` | 24 hours |
| `mainnet` | `MAINNET_DATABASE_URL` | `soroban.*` | Final production promotion |
