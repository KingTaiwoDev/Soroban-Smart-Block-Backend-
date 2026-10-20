# Enterprise SSO / OIDC — Design Document

**Issue**: PLT09 / #1030  
**Track**: Platform & Enterprise  
**Status**: Implemented

---

## 1. Problem

Enterprise customers require their employees to authenticate using their
organization's Identity Provider (IdP) — Okta, Auth0, Azure AD, etc. — rather
than managing individual Stellar wallet keys. The backend already has
OAuth2/OIDC building blocks (`authOAuth2.ts`) but lacks a first-class OIDC
login path with org provisioning, session linkage to the existing JWT stack,
and enterprise-grade security controls.

---

## 2. Requirements mapping

| Requirement | Implementation |
|---|---|
| OIDC provider support | `src/auth/sso/oidc.ts` — discovery, PKCE, token exchange |
| Org auto-provisioning | `src/auth/sso/provision.ts` — new user, email-merge, domain enforcement |
| Session linkage | `authSso.ts` callback writes both `AuthSession` + `SsoSession` rows so `requireAuth` works unchanged |
| Structured logging | Every code path uses `logger.info/warn/error` with structured fields |
| OpenTelemetry metrics | `src/auth/sso/metrics.ts` — counters + histograms wired to the global Prometheus registry |
| Feature-flag gating | `enterpriseSso` flag in `src/feature-flags/registry.ts`; all routes return 404 when disabled |
| Graceful degradation | Token-exchange failures return 502; provisioning failures return 403; bad state returns 400 — never 500 |
| Security — SSRF | `assertPublicHttpsUrl()` gates every outbound HTTP call; HTTP and private-network URLs are rejected |
| Security — PKCE | S256 on every authorization request; verifier stored in Redis/cache, single-use |
| Security — state | Random 24-byte base64url state validated on callback before any tokens are issued |
| Brute-force protection | Re-uses existing `checkAccountLockout` / `recordAccountFailure` from `bruteForce.ts` |
| Rate limiting | Re-uses `authRateLimit` middleware (10 req/min per IP) applied at router level |
| Input validation | All admin mutations validated with `zod` |
| Audit trail | `SsoAuditEvent` table — append-only, every action (provider CRUD, login, logout, provision) |
| Tenant isolation | Every DB query scoped to `(providerId, idpSubject)` or `email`; no cross-org data access |
| RBAC | Provider management requires `admin` role; OIDC callbacks are unauthenticated (browser flow) |
| No new dependencies | All crypto via `node:crypto`; HTTP via `node:fetch` (Node ≥ 18); no new npm packages |

---

## 3. Architecture

```
Browser / API client
        │
        │  GET /auth/sso/login/:providerId
        ▼
  ┌─────────────────────┐
  │  authSso.ts router  │
  │  (Express)          │
  └────────┬────────────┘
           │  generate PKCE verifier + state
           │  store in Redis (10 min TTL)
           │  fetch discovery document
           │  redirect → IdP authorization endpoint
           │
        Browser
           │  IdP authenticates user
           │  redirect → /auth/sso/callback/:providerId?code=...&state=...
           ▼
  ┌─────────────────────┐
  │  Callback handler   │
  │                     │
  │  1. Validate state  │  ← Redis (single-use)
  │  2. Exchange code   │  ← oidc.ts (PKCE + client_secret)
  │  3. Validate claims │  ← oidc.ts (iss, aud, exp, email_verified)
  │  4. Provision user  │  ← provision.ts
  │  5. Issue JWT       │  ← tokens.ts (same RS256 keypair)
  │  6. Create sessions │  ← SsoSession + AuthSession (mirror)
  │  7. Emit metrics    │  ← metrics.ts
  │  8. Write audit log │  ← SsoAuditEvent
  └─────────────────────┘
```

### Session linkage

The callback writes **two** rows:

- `SsoSession` — SSO-specific fields (idpSubject, pkceChallenge, providerId).
- `AuthSession` — the standard session row that `requireAuth` middleware reads.

This means every part of the API that uses `requireAuth` works transparently
for SSO-authenticated users with no code changes.

---

## 4. Data model

Four new Prisma models (see `prisma/schema.prisma`):

| Table | Purpose |
|---|---|
| `sso_providers` | Registered OIDC providers — one per issuer URL |
| `sso_orgs` | Provider ↔ org links — controls auto-provisioning and domain enforcement |
| `sso_sessions` | SSO session mirror — parallels `auth_sessions` |
| `sso_audit_events` | Append-only tamper-evident audit log |

### Client secret storage

Client secrets are stored as **SHA-256 hex** in `sso_providers.client_secret_hash`. The
plaintext secret is only present in the admin API request body — it is never
persisted.

**Production path**: Inject the real secret at runtime from a secrets manager
(Vault, AWS Secrets Manager). See `RUNBOOK.md §4`.

---

## 5. Security design

### SSRF protection

`assertPublicHttpsUrl()` is called before every outbound HTTP request. It rejects:

- HTTP (plain-text) URLs
- `localhost` and loopback addresses (`127.x.x.x`, `[::1]`)
- RFC-1918 private ranges (`10.x`, `172.16–31.x`, `192.168.x`)

### PKCE (RFC 7636)

Every authorization request uses `code_challenge_method=S256`. The verifier is
stored in Redis with a 10-minute TTL and consumed (deleted) on first use. There
is no fallback to plain (no PKCE) or `code_challenge_method=plain`.

### State parameter (CSRF prevention)

A 24-byte random base64url `state` value is generated per login and validated
on callback. State mismatch increments the brute-force counter.

### No implicit flow

The `response_type=code` is hardcoded. Implicit flow (`response_type=token` or
`response_type=id_token`) is not supported and not reachable.

---

## 6. Trade-offs and rejected alternatives

| Alternative | Reason rejected |
|---|---|
| Use `passport.js` or `openid-client` | Adds a large dependency; the required subset is small enough to implement directly with `node:crypto` + `node:fetch`. Adds a new library only when implicit/hybrid flows are needed. |
| Store client_secret in plaintext | Security: secrets must be hashed or fetched from a vault. Storing plaintext violates the secrets hygiene requirement. |
| Use implicit flow | Deprecated; tokens in URLs leak into server logs and browser history. PKCE code flow is the current best practice (OAuth2 Security BCP RFC 9700). |
| In-memory PKCE state | Lost on restart; Redis/cache ensures durability and supports multi-instance deployments. |
| Separate JWT keypair for SSO | Extra complexity with no benefit; SSO sessions re-use the existing RS256 keypair and `requireAuth` middleware unchanged. |

---

## 7. SLO definitions

| SLO | Target | Metric | Alert condition |
|---|---|---|---|
| SSO login success rate | ≥ 99.9 % | `sso_login_total{result="success"}` / total | error rate > 1 % for 5 min |
| SSO login P99 latency | < 2 s | `sso_login_duration_seconds` P99 | P99 > 2.0 s for 5 min |
| IdP token exchange P99 | < 1 s | `sso_token_exchange_duration_seconds` P99 | P99 > 1.0 s for 5 min |
| Provisioning error rate | 0 % | `sso_provision_total{result="error"}` | any error > 0 for 1 min |

Error budget burn rate = `1 - success_rate / 0.999`. Page at 2× burn rate (fast burn).

---

## 8. Future work

- [ ] Signature verification of ID tokens against IdP's JWKS (currently claim
  validation only; signature verification requires a JWKS key-fetch layer).
- [ ] SCIM 2.0 provisioning (push-based org sync from IdP).
- [ ] Multiple active orgs per provider (domain-routing to select the right SsoOrg).
- [ ] Just-in-time attribute mapping (custom claim → role/tier mapping rules).
- [ ] SLO dashboard Grafana template committed to `deploy/grafana/`.
