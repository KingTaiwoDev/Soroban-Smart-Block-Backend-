# Secret rotation responsibilities

Who owns each deployed secret, how often it is rotated, how to rotate it and
how to verify the rotation worked. Names come from `.env.example`,
`src/config.ts`, `k8s/secrets.yaml`, `docker-compose.yml` and
`.github/workflows/*`; `tests/secret-rotation-doc.test.ts` fails if a name
below no longer exists in one of them.

Owners are roles: **Platform** (infrastructure / on-call SRE), **Backend**
(service maintainers), **Security** (security lead), **Release** (release
manager). Cadences are the maximum interval; rotate immediately on suspected
compromise, on offboarding of anyone with access, or after a leak in logs.

General procedure: generate the new value (`openssl rand -hex 32` unless
noted) -> store it in the secret manager (k8s `soroban-explorer-secrets`,
external-secrets/Vault, or the GitHub Environment) -> roll the deployment
(`kubectl rollout restart`) per network, testnet first -> verify -> revoke the
old value. Never commit real values.

## Runtime secrets (environment variables)

| Secret | Owner | Cadence | Procedure | Verification |
| --- | --- | --- | --- | --- |
| `JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY` / `JWT_KEY_ID` | Security | 90 days | Generate a new RSA key pair, set a new `JWT_KEY_ID`, deploy. Previous keys stay valid for the grace window kept by `rotateKeys()` in `src/auth/keys.ts`. | `GET /.well-known/jwks.json` lists the new `kid`; a fresh login token verifies. |
| `JWT_SECRET` | Security | 90 days | Move the old value into `JWT_PREVIOUS_SECRETS` (comma-separated), set the new `JWT_SECRET`, deploy. After `ACCESS_TOKEN_TTL` (24h) remove it from `JWT_PREVIOUS_SECRETS`. | New logins succeed; tokens issued before the rotation still validate until the old secret is removed. |
| `JWT_PREVIOUS_SECRETS` | Security | Cleared 24h after each `JWT_SECRET` rotation | Remove retired values once all tokens signed with them have expired. | Tokens signed with the removed secret are rejected with 401. |
| `ADMIN_API_KEY` | Platform | 90 days | Set the new value and redeploy; update operator tooling that sends `X-Admin-Token`. No overlap window: the change is immediate. | `POST /api/v1/admin/indexer/pause` style admin call succeeds with the new token and returns 401 with the old one. |
| `AUDIT_ADMIN_KEY` | Security | 90 days | Replace and redeploy; update audit-platform operators. | `/verify` and `/suspend` endpoints accept the new key, reject the old. |
| `AUDIT_SIGNING_KEY` | Security | Yearly, or on compromise | Certificates are HMAC-signed with this key, so rotation invalidates verification of previously issued certificates: re-issue or keep the old key available for verification-only before switching. | A newly issued certificate verifies; sampled old certificates are re-issued or verified against the archived key. |
| `COOKIE_SECRET` | Backend | 180 days | Set the new value and redeploy. Existing signed session cookies become invalid and users re-authenticate. | Login sets a cookie; a cookie signed with the old secret is rejected. |
| `METRICS_TOKEN` | Platform | 90 days | Update the value in the secret manager and in the Prometheus scrape config together. | `/metrics` scrape returns 200 with the new bearer token; Prometheus target is `UP`. |
| `WEBHOOK_SECRET_ENCRYPTION_KEY` | Security | Yearly | Used to AES-256-GCM encrypt developer webhook secrets at rest. Re-encrypt all `DevWebhook.secret` rows with the new key before removing the old one; do not swap it in place. | Delivery of a test webhook still carries a valid signature for a pre-existing webhook. |
| `WEBHOOK_SECRET` | Backend | 90 days | Replace and redeploy; update any sender that signs requests with it. | Signed inbound test request is accepted. |
| `WS_SECRET` | Backend | 90 days | Replace and redeploy; clients reconnect and re-handshake. | New WebSocket connection succeeds. |
| `STRIPE_SECRET_KEY` | Platform | Yearly, or on Stripe-side exposure | Roll the key in the Stripe dashboard, update k8s secret, redeploy. | Billing metering job completes; Stripe dashboard shows the old key unused. |
| `STRIPE_WEBHOOK_SECRET` | Platform | Yearly | Roll the endpoint secret in Stripe (supports a short overlap), update k8s secret, redeploy. | Stripe test event is delivered and verified (2xx). |
| `STRIPE_RAMP_WEBHOOK_SECRET` | Platform | Yearly | As above for the on-ramp endpoint. | Stripe test event for the ramp endpoint returns 2xx. |
| `MOONPAY_API_KEY` / `MOONPAY_SECRET_KEY` / `MOONPAY_WEBHOOK_SECRET` | Platform | Yearly | Rotate in the provider dashboard, update secret, redeploy. | Ramp quote request and a provider test webhook succeed. |
| `TRANSAK_API_KEY` / `TRANSAK_SECRET_KEY` | Platform | Yearly | Same as above. | Ramp quote request succeeds. |
| `BANXA_API_KEY` / `BANXA_SECRET_KEY` | Platform | Yearly | Same as above. | Ramp quote request succeeds. |
| `RAMP_NETWORK_API_KEY` | Platform | Yearly | Same as above. | Ramp quote request succeeds. |
| `POSTGRES_PASSWORD` | Platform | 90 days | Change the role password in Postgres, update `POSTGRES_PASSWORD` and the derived `*_DATABASE_URL` values, restart API and indexer. | `/readyz` reports the database healthy; indexer resumes without connection errors. |
| `TESTNET_DATABASE_URL` / `MAINNET_DATABASE_URL` | Platform | With the database password | Update per network; do mainnet only after testnet verified. Read-replica URLs (`TESTNET_READ_REPLICA_URL`, `MAINNET_READ_REPLICA_URL`) carry the same credentials and are rotated together. | `/readyz` is healthy per network; no auth errors in logs. |
| `TESTNET_CACHE_URL` / `MAINNET_CACHE_URL` | Platform | 90 days | Rotate the Redis password (`REDIS_PASSWORD` in `docker-compose.yml`), update the URL, restart. | Cache health probe passes; rate limiting works across replicas. |
| `MAINNET_RPC_URL` / `MAINNET_RPC_WS_URL` | Platform | Yearly, or on provider exposure | The provider API key is embedded in the URL path: issue a new key, update both URLs, redeploy, revoke the old key. | Indexer ledger lag stays within SLO; no RPC 401/403. |
| `API_KEYS_DEVELOPER` / `API_KEYS_PREMIUM` | Backend | 180 days | Static tier keys: add the new key alongside the old, migrate clients, then remove the old one. | Requests with the new key get the expected tier headers. |
| `ANCHOR_SECRET_KEY` | Security | Yearly, or on compromise | Stellar secret seed used to anchor audit data: fund a new account, update the secret, redeploy, then drain the old account. | Next anchor transaction is submitted from the new public key. |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | Backend | 90 days | Create a new key at the provider, update secret, redeploy, revoke the old key. | An NLQ/LLM-backed request succeeds. |

Developer-facing API keys (`sk_...`) are rotated by their owners through
`POST /api/v1/developer/keys/:id/rotate` (see `docs/API_KEY_ROTATION.md`) and
are not covered here.

## CI/CD secrets (GitHub)

| Secret | Owner | Cadence | Procedure | Verification |
| --- | --- | --- | --- | --- |
| `KUBE_CONFIG_STAGING` | Release | 90 days | Issue a new service-account kubeconfig, base64-encode it, update the `staging` GitHub Environment secret. | Run the rollback workflow's staging dry run; `kubectl` auth step passes. |
| `KUBE_CONFIG_PRODUCTION` | Release | 90 days | Same, in the `production` Environment (requires environment approval). | Rollback workflow production auth step passes. |
| `NPM_TOKEN` | Release | 90 days | Create a new automation token on npm scoped to the SDK package, update the repo secret, revoke the old token. | `sdk-publish` workflow authenticates (`npm whoami`). |
| `DATABASE_URL` | Platform | With the database password | Update the repo secret used by the backup/restore drill; use a read-only role. | The scheduled backup and isolated restore drill job passes. |

`GITHUB_TOKEN` is issued per workflow run by GitHub and needs no rotation.

## Placeholders to replace before deploying

`k8s/secrets.yaml` ships `REPLACE_*` placeholders (including the
`INTERNAL_API_KEY` placeholder); `.env.example` ships `changeme` /
`change-me-*` values for `POSTGRES_PASSWORD`, `COOKIE_SECRET`,
`AUDIT_SIGNING_KEY` and `AUDIT_ADMIN_KEY`. These must never reach a deployed
environment. `WEBHOOK_SECRET_ENCRYPTION_KEY` and `AUDIT_SIGNING_KEY` fall back
to insecure built-in defaults when unset, so an unset value in production is
itself a finding.

## Network considerations

Mainnet and testnet use separate database, cache and RPC credentials
(`MAINNET_*` / `TESTNET_*`). Rotate testnet first, verify, then mainnet, and
never reuse a value across networks.
