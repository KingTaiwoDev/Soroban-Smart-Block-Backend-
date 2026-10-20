# Audit logging for administrative actions

Security-sensitive administrative actions are recorded in the durable
`_audit_logs` table (Prisma model `AuditLog`) through
`recordAdminAudit()` in `src/lib/admin-audit.ts` (#1232).

| Route | `action` | `target` | State recorded |
| --- | --- | --- | --- |
| `POST /api/v1/admin/indexer/pause` / `resume` | `admin.indexer.pause` / `admin.indexer.resume` | `indexer` | `{ network, paused }` |
| `PUT /api/v1/admin/feature-flags/:key` | `feature_flag.updated` | flag key | changed fields |
| `PUT /api/v1/admin/feature-flags/:key/overrides/:scopeType/:scopeValue` | `feature_flag.override_set` | flag key | `{ scopeType, scopeValue, enabled }` |
| `DELETE /api/v1/admin/feature-flags/:key/overrides/:scopeType/:scopeValue` | `feature_flag.override_cleared` | flag key | `{ scopeType, scopeValue }` |
| `POST /api/v1/developer/keys` | `api_key.created` | key id | `{ developerId, keyPrefix, permissions, expiresAt }` |
| `PATCH /api/v1/developer/keys/:id` | `api_key.updated` | key id | changed fields (scopes, IP/domain allowlists) |
| `DELETE /api/v1/developer/keys/:id` | `api_key.revoked` | key id | `{ developerId, status }` |
| `/api/v1/orgs/...` mutations | `org.created`, `org.updated`, `org.member.added`, `org.member.role_changed`, `org.member.removed`, `org.key.scoped`, `org.key.transferred_out`, `org.key.transferred_in` | org id | the details already kept in the per-org log |

Key rotation continues to be recorded in `_key_rotation_audits`, and freeze
actions in `_audit_logs` via the freeze router, unchanged.

`actor` is resolved as: `adminAuth` identity (`admin`) → session user id →
API key developer id → route-specific fallback (the `developerId` for key
routes).

## Behaviour and rollout

- Only successful mutations are logged; validation, authorization and
  not-found failures are not.
- Raw API keys and secrets are never written — only the key id and the
  8-character prefix.
- Writes are fire-and-forget via `background()`. If the audit store is
  unavailable the admin request still succeeds; the failure is logged and
  counted in `background_operation_errors_total{operation="audit.admin_action"}`.
  Alert on that counter if audit completeness is a compliance requirement.
- No schema migration is required: the existing `_audit_logs` table is used.
- Indexer pause/resume entries include the `network` (from `STELLAR_NETWORK`),
  so entries from mainnet, testnet and devnet deployments sharing an audit
  store remain distinguishable.
- Organization audit entries are still also kept in memory for
  `GET /api/v1/orgs/:orgId/audit`; the durable copy survives restarts.
