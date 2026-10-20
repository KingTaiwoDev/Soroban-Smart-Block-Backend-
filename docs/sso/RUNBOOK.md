# Enterprise SSO / OIDC — Operating Runbook

**Issue**: PLT09 / #1030  
**Owner**: Platform & Enterprise team

---

## 1. Starting the SSO feature

SSO is gated behind the `enterpriseSso` feature flag.

```bash
# Enable via environment variable (takes effect on next restart):
ENABLE_ENTERPRISE_SSO=true

# Or toggle at runtime without restart (DB-backed flag):
curl -X POST /api/v1/admin/feature-flags/enterpriseSso \
  -H "Authorization: Bearer <admin-token>" \
  -d '{"enabled": true}'
```

Required Prisma tables (`sso_providers`, `sso_orgs`, `sso_sessions`,
`sso_audit_events`) are created by running the migration:

```bash
npx prisma migrate deploy
```

---

## 2. Registering an OIDC provider

```bash
curl -X POST https://api.yourdomain.com/api/v1/auth/sso/providers \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Okta — Acme Corp",
    "issuerUrl": "https://acme.okta.com",
    "clientId": "0oaXXXXXXXXXXXXXXXXX",
    "clientSecret": "<plaintext-secret-shown-once>",
    "scopes": "openid email profile"
  }'
```

Response includes the `id` of the new provider. Store this for the org-link
step. The `clientSecret` is hashed on receipt and never returned again.

### Linking to an org

```bash
curl -X POST https://api.yourdomain.com/api/v1/auth/sso/providers/<providerId>/orgs \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "orgId": "org-acme",
    "domains": ["acme.com", "acme.org"],
    "defaultRole": "member",
    "defaultTier": "enterprise",
    "autoProvision": true,
    "enforceEmailDomain": true
  }'
```

---

## 3. End-user login flow

1. User navigates to:  
   `GET /api/v1/auth/sso/login/<providerId>?redirect_after=https://app.acme.com/dashboard`

2. Browser is redirected to the IdP.

3. User authenticates at the IdP.

4. IdP redirects to:  
   `GET /api/v1/auth/sso/callback/<providerId>?code=...&state=...`

5. Server exchanges code for tokens, provisions the user, and either:
   - **JSON response** (API clients): `{ token, refreshToken, sessionId, expiresAt, user }`
   - **Browser redirect** (when `redirect_after` was set): `https://app.acme.com/dashboard#token=<jwt>`

6. The `token` is a standard RS256 JWT — use it in `Authorization: Bearer <token>` on every API call.

---

## 4. Production secrets management

**Never store the IdP client secret in plaintext or in environment variables.**

The `POST /providers` endpoint accepts the secret at registration time and
stores its SHA-256 hash. For the token exchange the plaintext secret must be
available at runtime.

### Option A — Vault (recommended)

1. Store the plaintext secret in HashiCorp Vault at:  
   `secret/sso/providers/<providerId>/client_secret`

2. At token-exchange time, fetch from Vault using the app's Vault token.  
   (Wire this into `src/auth/sso/oidc.ts` `exchangeCodeForTokens` by replacing
   the `clientSecret` parameter with a Vault read call.)

### Option B — AWS Secrets Manager

Store at `soroban-explorer/sso/<providerId>/client_secret` and fetch using the
IAM role assigned to the pod.

### Option C — Kubernetes Secret (minimum viable)

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: sso-provider-secrets
type: Opaque
stringData:
  okta-acme: "<plaintext-secret>"
```

Mount as environment variable and read in `exchangeCodeForTokens`.

---

## 5. Monitoring

### Key metrics (Prometheus)

| Metric | Alert |
|---|---|
| `sso_login_total{result="error"}` | > 1 % of total for 5 min |
| `sso_login_duration_seconds` P99 | > 2.0 s for 5 min |
| `sso_token_exchange_duration_seconds` P99 | > 1.0 s for 5 min |
| `sso_provision_total{result="error"}` | any occurrence for 1 min |
| `sso_active_sessions_total` | sudden drop (mass session invalidation) |

All metrics are exported via the existing `/metrics` endpoint and labelled by
`provider_id`.

### Structured log queries

```
# Failed logins:
{ level: "warn", message: "[sso] Token exchange failed" }
{ level: "warn", message: "[sso] IdP returned error on callback" }
{ level: "warn", message: "[sso] ID token validation failed" }
{ level: "warn", message: "[sso] Provisioning failed" }

# Successful provisioning:
{ level: "info", message: "[sso/provision] New SSO user provisioned" }
{ level: "info", message: "[sso] Login successful" }
```

---

## 6. Debugging

### "State mismatch" errors

Cause: PKCE state expired (>10 min between redirect and callback), or the
state was already consumed (replay).

Fix: User should restart the login flow. If persistent, check Redis TTL and
connectivity.

### "Token exchange failed" (502)

Cause: IdP is unreachable or returned an error code.

Steps:
1. Check `sso_token_exchange_duration_seconds` for high latency.
2. Verify the `discoveryUrl` is reachable from the pod: `curl -v <discoveryUrl>`.
3. Verify the `clientId` and secret are correct.
4. Check the IdP's audit log for the failed exchange.

### "provisioning_failed — domain not authorised"

Cause: User's email domain is not in the `SsoOrg.domains` list.

Fix:
```bash
curl -X PATCH /api/v1/auth/sso/providers/<id> \
  -H "Authorization: Bearer <admin-token>" \
  -d '{"metadata": {}}'
# or update the SsoOrg domains via direct DB update:
UPDATE sso_orgs SET domains = '["acme.com","newdomain.com"]' WHERE id = '<ssoOrgId>';
```

---

## 7. Rollback plan

1. Disable the feature flag (immediate, no restart needed):
   ```bash
   curl -X POST /api/v1/admin/feature-flags/enterpriseSso \
     -H "Authorization: Bearer <admin-token>" \
     -d '{"enabled": false}'
   ```
   All `/auth/sso/*` routes return 404 immediately.

2. Existing `AuthSession` rows for SSO users remain valid until expiry (30 days).
   SSO users can continue using their tokens but cannot re-login via SSO.

3. To fully revert the schema (destructive — only if required):
   ```bash
   npx prisma migrate resolve --rolled-back <migration-name>
   ```

---

## 8. API reference

### Admin endpoints (require `admin` role)

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/v1/auth/sso/providers` | Register a new OIDC provider |
| `GET` | `/api/v1/auth/sso/providers` | List all providers |
| `PATCH` | `/api/v1/auth/sso/providers/:id` | Update provider settings |
| `DELETE` | `/api/v1/auth/sso/providers/:id` | Deactivate a provider |
| `POST` | `/api/v1/auth/sso/providers/:id/orgs` | Link provider to an org |
| `GET` | `/api/v1/auth/sso/providers/:id/audit` | Provider audit log |

### End-user endpoints (no auth required)

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/auth/sso/login/:providerId` | Start OIDC flow (redirect) |
| `GET` | `/api/v1/auth/sso/callback/:providerId` | OIDC callback handler |
| `POST` | `/api/v1/auth/sso/logout` | Revoke SSO session (requires Bearer token) |

### Request / response examples

**Register a provider**
```json
POST /api/v1/auth/sso/providers
{
  "name": "Okta — Acme Corp",
  "issuerUrl": "https://acme.okta.com",
  "clientId": "0oaXXX",
  "clientSecret": "plaintext-shown-once",
  "scopes": "openid email profile"
}

201 Created
{
  "id": "cld1...",
  "name": "Okta — Acme Corp",
  "issuerUrl": "https://acme.okta.com",
  "clientId": "0oaXXX",
  "discoveryUrl": "https://acme.okta.com/.well-known/openid-configuration",
  "scopes": "openid email profile",
  "pkceMethod": "S256",
  "isActive": true,
  "createdAt": "2026-10-19T..."
}
```

**Callback success response**
```json
200 OK
{
  "token": "<rs256-jwt>",
  "refreshToken": "<opaque-hex>",
  "sessionId": "sess_...",
  "expiresAt": "2026-11-18T...",
  "user": {
    "id": "01932...",
    "role": "member",
    "tier": "enterprise",
    "isNewUser": true
  }
}
```

**Error responses**

| Code | `error` field | Meaning |
|---|---|---|
| 400 | `invalid_state` | PKCE state expired or mismatched |
| 400 | `invalid_callback` | Missing `code` or `state` query param |
| 400 | `<idp-error>` | IdP rejected the request (e.g. `access_denied`) |
| 401 | `invalid_id_token` | ID token claims validation failed |
| 403 | `provisioning_failed` | Domain enforcement or autoProvision=false |
| 404 | `provider_not_found` | Unknown or inactive provider |
| 404 | `FEATURE_DISABLED` | `ENABLE_ENTERPRISE_SSO` is false |
| 429 | _(standard)_ | IP rate limited or brute-force lockout |
| 502 | `token_exchange_failed` | IdP token endpoint unreachable or returned an error |
