# Least-privilege API key scopes by use case

Scopes are the `resource:action` tokens defined in `KNOWN_SCOPES` in
`src/services/api-key-lifecycle.ts` (`GET /api/v1/developer/keys/scopes`
returns the same list). A key's scope is a comma-separated string, set with
`PATCH /api/v1/developer/keys/:id/lifecycle` (`{ "scope": "..." }`), and is
validated by `validateScope()`; unknown tokens are rejected with `400`.

Give every key the **smallest** scope set below that covers its job, and use
one key per integration so a leak can be revoked without collateral damage.

## Recommendations

| Use case | Recommended scope | Notes |
| --- | --- | --- |
| Public explorer frontend / dashboard | `transactions:read`, `events:read`, `contracts:read`, `tokens:read` | Equivalent to the built-in `read_only` preset minus `wallets:read`; add `wallets:read` only if account pages are shown. |
| Wallet or portfolio tracker | `wallets:read`, `tokens:read`, `transactions:read` | No contract or analytics access needed. |
| Contract event consumer / indexer mirror | `events:read`, `contracts:read` | Pair with webhooks rather than polling where possible. |
| Search / autocomplete widget | `search:read` | Typically embedded in browsers — keep it single-scope. |
| BI / reporting read access | `analytics:read` | |
| Scheduled analytics pipeline jobs | `analytics:read`, `analytics:write` | `analytics:write` triggers jobs; keep it on a server-side key only. |
| DEX / MEV monitoring | `dex:read`, `mev:read`, `transactions:read` | |
| CI job publishing contract ABIs | `contracts:write` | Add `contracts:read` only if the job verifies what it published. |
| CI job running sandbox simulations | `sandbox:read`, `sandbox:write` | |
| Key inventory / developer-portal automation | `developer:read` | |
| Account-management automation | `developer:read`, `developer:write` | |
| Operator read-only tooling | `admin:read` | |
| Operator break-glass tooling | `admin:read`, `admin:write` | Short `expiresAt`, short `rotation_policy_days`, never shared. |

### Scopes to avoid

- `*` (wildcard, also the `full_access` preset) grants every scope, including
  `admin:write`. Do not issue it to integrations; prefer an explicit list.
- A `NULL` scope (every key created before PLT05) is treated as **unrestricted**
  by `checkScopeAuthorized()`. Set an explicit scope on existing keys when
  touching them.
- Do not put `:write` scopes on browser-embedded keys: keys shipped to
  clients should hold read scopes only.

## Compatibility and rollout

- Scope enforcement is currently **advisory**: `checkScopeAuthorized()` is
  exported for route handlers but the API-key middleware does not yet reject
  out-of-scope requests (see `docs/plt05-api-key-lifecycle/design.md`). Applying
  these recommendations now is safe and becomes binding once enforcement lands.
- Scopes are not network-specific: the same tokens apply on mainnet, testnet
  and devnet deployments. Use separate keys per network so a testnet key can
  never read or write mainnet data through a shared deployment.
- `tests/api-key-scope-recommendations.test.ts` fails if this document names a
  scope that is not in `KNOWN_SCOPES`, so the doc cannot drift from code.
