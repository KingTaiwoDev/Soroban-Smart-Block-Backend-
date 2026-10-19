# Enterprise Rate-Limit Tiers — Design, Operations & API Reference

> **Issue**: [#1027 \[PLT06\] Enterprise custom rate-limit tiers](https://github.com/Soroban-Smart-Block-Explorer/Soroban-Smart-Block-Backend-/issues/1027)
> **Status**: Implemented — `feat/issue-1027-enterprise-custom-rate-limit-tiers`

---

## Table of Contents

1. [Overview](#overview)
2. [Data Model](#data-model)
3. [Architecture & Trade-offs](#architecture--trade-offs)
4. [Rejected Alternatives](#rejected-alternatives)
5. [Admin API Reference](#admin-api-reference)
6. [Operating Runbook](#operating-runbook)
7. [Header Reference](#header-reference)
8. [Feature-Flag Gating](#feature-flag-gating)
9. [Graceful Degradation](#graceful-degradation)

---

## Overview

Standard rate-limit tiers (free / developer / premium / enterprise) are defined globally in `src/auth/rbac.ts`. Enterprise customers with contractually negotiated higher limits require **per-organisation custom tiers** that can be managed without redeploying the service.

This feature adds:

| Component                         | Path                                                  |
| --------------------------------- | ----------------------------------------------------- |
| In-memory TTL cache               | `src/middleware/enterpriseTierCache.ts`               |
| Rate-limit enforcement middleware | `src/middleware/enterpriseRateLimit.ts`               |
| Admin CRUD API                    | `src/api/rate-limits.ts` (`/enterprise-tiers` routes) |
| Unit tests                        | `tests/enterpriseTier.test.ts`                        |

---

---

## Data Model

Enterprise tiers are stored in the **dedicated `EnterpriseTierConfig` Prisma model** (table `_enterprise_tier_configs`, added in migration `20261019000000_enterprise_tier_configs` for Issue #1283), with typed Prisma access across all admin operations.

### Prisma Schema (`_enterprise_tier_configs`)

```prisma
model EnterpriseTierConfig {
  id               String   @id @default(cuid()) @map("id")
  orgId            String   @unique @map("org_id") @db.VarChar(128)
  maxPerMinute     Int      @map("max_per_minute")
  maxBurst         Int      @map("max_burst")
  windowMs         Int      @default(60000) @map("window_ms")
  label            String   @map("label") @db.VarChar(128)
  featureFlags     String[] @default([]) @map("feature_flags")
  graceDegradation String   @default("fallback") @map("grace_degradation") @db.VarChar(32)
  createdAt        DateTime @default(now()) @map("created_at")
  updatedAt        DateTime @updatedAt @map("updated_at")

  @@index([orgId])
  @@map("_enterprise_tier_configs")
}
```

| DB column           | Type         | Constraints          | Description                                                      |
| ------------------- | ------------ | -------------------- | ---------------------------------------------------------------- |
| `id`                | `TEXT`       | Primary key (cuid)   | Unique configuration record ID                                   |
| `org_id`            | `VARCHAR`    | Unique, Indexed      | Organisation identifier (e.g. `org_acme`)                        |
| `max_per_minute`    | `INTEGER`    | > 0                  | Sustained request ceiling per 60-second window                   |
| `max_burst`         | `INTEGER`    | > 0                  | Instantaneous token-bucket burst capacity                        |
| `window_ms`         | `INTEGER`    | Default `60000`      | Rolling window in milliseconds                                   |
| `label`             | `VARCHAR`    | 1–128 chars          | Human-readable tier label shown in `X-RateLimit-Policy`          |
| `feature_flags`     | `TEXT[]`     | Default `{}`         | Enabled feature flags scoped to this organisation                |
| `grace_degradation` | `VARCHAR`    | Default `'fallback'` | Degradation strategy: `'drop'` \| `'queue'` \| `'fallback'`      |
| `created_at`        | `TIMESTAMPTZ`| Default `NOW()`      | Record creation timestamp                                        |
| `updated_at`        | `TIMESTAMPTZ`| Auto-updated         | Last modification timestamp                                      |

### Safe Defaults & Data Migration

The migration automatically backfills existing entries from the legacy `_rate_limit_overrides` table (identifying rows prefixed with `ent:`) into the new typed schema with safe defaults without altering effective rate limits. The admin routes maintain fallback reads if run against an unmigrated database.

---

## Architecture & Cross-Replica Propagation

### In-Memory Cache with Sub-Second Cross-Replica Propagation (Issue #1284)

1. **Low-Latency In-Process Reads**:
   - Every API replica maintains an in-memory `Map<orgId, CacheEntry>` with lazy TTL eviction (5 minutes).
   - Rate-limit evaluations never perform a Redis or database round-trip during request handling.

2. **Cross-Replica Invalidation Channel**:
   - Mutating operations (`POST /enterprise-tiers`, `DELETE /enterprise-tiers/:orgId`) publish an invalidation payload to Redis Pub/Sub channel `__enterprise_tier:invalidate`.
   - All active API replicas listening to the channel evict the stale entry locally within a **≤ 500 ms propagation bound**.

3. **Resilience & Degraded Recovery**:
   - If Redis Pub/Sub is unavailable or disconnected, replicas emit an observable structured diagnostic:
     `alert: 'ENTERPRISE_TIER_INVALIDATION_DEGRADED'`.
   - Replicas automatically recover within the 5-minute TTL window via lazy eviction.
   - Redis is **not** a hard dependency: if running in standalone memory mode (`CACHE_URL=memory://`), the in-memory cache functions completely independently without errors.

---

## Migration, Deployment Order & Rollback Runbook

### Deployment Order

1. **Phase 1: Database Migration**:
   - Apply additive migration `npx prisma migrate deploy`.
   - Creates `_enterprise_tier_configs` table and backfills any existing legacy rows.
   - Zero downtime: Existing pods continue using `_rate_limit_overrides` uninterrupted.

2. **Phase 2: Application Release**:
   - Deploy backend pods running the new release.
   - Pods register the Pub/Sub invalidation subscriber and perform typed reads/writes on `EnterpriseTierConfig`.

### Rollback Procedure

- **Application Rollback**: If the release is rolled back, the prior application version continues operating using `_rate_limit_overrides`.
- **Database Rollback**: The migration is additive and does not drop `_rate_limit_overrides`. No destructive SQL migration is required.

---

## Admin API Reference

All endpoints require the `X-Admin-Token` header (see `src/middleware/adminAuth.ts`).

### `GET /api/admin/rate-limits/enterprise-tiers`

List all custom enterprise tiers.

**Response 200**

```json
{
  "success": true,
  "tiers": [
    {
      "orgId": "org_acme",
      "maxPerMinute": 50000,
      "maxBurst": 5000,
      "windowMs": 60000,
      "label": "acme-enterprise-gold",
      "featureFlags": ["analytics", "bulk-export"],
      "graceDegradation": "fallback"
    }
  ]
}
```

---

### `POST /api/admin/rate-limits/enterprise-tiers`

Create or update the enterprise tier for an org.

**Request body**

```json
{
  "orgId": "org_acme",
  "maxPerMinute": 50000,
  "maxBurst": 5000,
  "windowMs": 60000,
  "label": "acme-enterprise-gold",
  "featureFlags": ["analytics", "bulk-export"],
  "graceDegradation": "fallback"
}
```

| Field              | Type     | Required | Default      | Constraints                           |
| ------------------ | -------- | -------- | ------------ | ------------------------------------- |
| `orgId`            | string   | ✅       | —            | 1–128 chars                           |
| `maxPerMinute`     | integer  | ✅       | —            | 1–10 000 000                          |
| `maxBurst`         | integer  | ✅       | —            | 1–10 000 000                          |
| `windowMs`         | integer  |          | 60 000       | 1–86 400 000                          |
| `label`            | string   | ✅       | —            | 1–128 chars                           |
| `featureFlags`     | string[] |          | `[]`         | each 1–64 chars                       |
| `graceDegradation` | enum     |          | `"fallback"` | `"drop"` \| `"queue"` \| `"fallback"` |

**Response 201**

```json
{
  "success": true,
  "orgId": "org_acme",
  "config": {
    "maxPerMinute": 50000,
    "maxBurst": 5000,
    "windowMs": 60000,
    "label": "acme-enterprise-gold",
    "featureFlags": ["analytics", "bulk-export"],
    "graceDegradation": "fallback"
  }
}
```

**Response 400** (validation failure)

```json
{
  "error": "Invalid enterprise tier payload",
  "details": { "fieldErrors": { "maxPerMinute": ["Number must be positive"] } }
}
```

---

### `GET /api/admin/rate-limits/enterprise-tiers/:orgId`

Retrieve the custom tier for a specific org.

**Response 200**

```json
{
  "success": true,
  "orgId": "org_acme",
  "config": { ... }
}
```

**Response 404** — no custom tier; standard enterprise defaults are returned for reference:

```json
{
  "error": "No custom enterprise tier found for this org",
  "orgId": "org_acme",
  "defaults": {
    "maxPerMinute": 10000,
    "maxBurst": 20000,
    "windowMs": 60000,
    "label": "enterprise",
    "featureFlags": [],
    "graceDegradation": "fallback"
  }
}
```

---

### `DELETE /api/admin/rate-limits/enterprise-tiers/:orgId`

Remove the custom tier for an org. The org reverts to standard enterprise defaults immediately (cache is cleared).

**Response 200**

```json
{
  "success": true,
  "orgId": "org_acme",
  "message": "Custom enterprise tier removed. Org will use standard enterprise defaults.",
  "defaults": { ... }
}
```

---

## Operating Runbook

### Setting a new enterprise tier for an org

```bash
curl -X POST https://api.example.com/api/admin/rate-limits/enterprise-tiers \
  -H "X-Admin-Token: $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "orgId": "org_acme",
    "maxPerMinute": 50000,
    "maxBurst": 5000,
    "label": "acme-gold",
    "featureFlags": [],
    "graceDegradation": "fallback"
  }'
```

The change is persisted to the DB and the in-memory cache is updated on the pod that served the request. Other pods will pick it up within the 5-minute cache TTL.

### Updating an existing tier

Re-POST with the same `orgId`. The endpoint is idempotent (upsert).

### Deleting / resetting to defaults

```bash
curl -X DELETE https://api.example.com/api/admin/rate-limits/enterprise-tiers/org_acme \
  -H "X-Admin-Token: $ADMIN_API_KEY"
```

### Debugging: which tier is active?

Inspect the response headers from any API call made by the org:

```
X-RateLimit-Tier:    enterprise-custom   ← custom config is active
X-RateLimit-Policy:  acme-gold           ← label from the config
X-RateLimit-Limit:   50000
X-RateLimit-Remaining: 49998
X-RateLimit-Reset:   1720000060
```

If `X-RateLimit-Tier` is `enterprise` (without `-custom`), the org is on standard defaults — either no custom config exists or the cache TTL expired and the DB returned no row.

### Recovering from stale cache

If a tier was updated but pods still serve the old config:

1. Wait up to 5 minutes for the TTL to expire naturally, **or**
2. Issue a rolling restart of the backend pods.

### DB health check

The admin API returns 500 if the DB is unreachable. The enforcement middleware (`applyEnterpriseRateLimit`) falls back to standard enterprise defaults and logs a warning — requests are never dropped due to a DB outage unless `graceDegradation: "drop"` is configured.

---

## Header Reference

| Header                  | Description                                                                 |
| ----------------------- | --------------------------------------------------------------------------- |
| `X-RateLimit-Limit`     | Effective request ceiling for the current window.                           |
| `X-RateLimit-Remaining` | Requests remaining in the current window.                                   |
| `X-RateLimit-Reset`     | Unix timestamp (seconds) when the window resets.                            |
| `X-RateLimit-Tier`      | `enterprise-custom` for custom configs; `enterprise` for standard defaults. |
| `X-RateLimit-Policy`    | Human-readable label from `EnterpriseTierConfig.label`.                     |
| `Retry-After`           | Set only on 429 responses; seconds until the limit resets.                  |

---

## Feature-Flag Gating

When `featureFlags` is non-empty, the middleware checks the `X-Feature-Flags` request header (comma-separated). If any required flag is absent, the request is rejected with 403.

**Example tier config with flag gating:**

```json
{
  "orgId": "org_research",
  "maxPerMinute": 100000,
  "featureFlags": ["bulk-export", "raw-ledger-access"],
  ...
}
```

**Client must send:**

```
X-Feature-Flags: bulk-export,raw-ledger-access
```

This mechanism allows gating experimental high-throughput features to specific enterprise orgs without separate middleware.

---

## Graceful Degradation

When the cache lookup throws (e.g., DB connection timeout):

| Strategy               | Behaviour                                                                       |
| ---------------------- | ------------------------------------------------------------------------------- |
| `fallback` _(default)_ | Apply standard enterprise limits; log a warning. Request proceeds.              |
| `queue`                | Falls through to `fallback` at this layer (queue is a future concern).          |
| `drop`                 | Return 503 immediately. Use only for orgs where incorrect limits are dangerous. |

> [!CAUTION]
> Setting `graceDegradation: "drop"` means any infrastructure fault will cause 503s for that org. Reserve this for security-critical integrations only.

> [!NOTE]
> The `drop` path is only triggered when `usedFallback=true` AND the _registered_ config specifies `"drop"`. Because the fallback is triggered by a failed config lookup, the `drop` signal must have been cached in the pod's in-memory store from a previous successful lookup.
