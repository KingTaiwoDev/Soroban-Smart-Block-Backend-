# Administrative API authorization matrix

This matrix describes the effective authorization currently applied to
administrative routes mounted below `/api/v1`. It is an operator aid and a
review checklist: a route being rate limited is not the same as it being
authorized.

| Route family | Methods | Effective guard | Success identity | Failure behaviour | Source |
| --- | --- | --- | --- | --- | --- |
| `/freeze/*` | router-defined | `adminAuth` / `X-Admin-Token` | deployment administrator | 401 invalid/missing token; 429 temporary lockout | `src/api/router.ts`, `src/middleware/adminAuth.ts` |
| `/admin/indexer/control`, `/admin/indexer/pause`, `/admin/indexer/resume` | GET, POST | `adminAuth` | deployment administrator | 401 invalid/missing token; 429 temporary lockout | `src/api/admin.ts` |
| `/admin/rate-limits/*` | router-defined | `adminAuth` on each handler, plus admin rate limits | deployment administrator | 401 invalid/missing token; 429 rate/lockout | `src/api/rate-limits.ts`, `src/api/router.ts` |
| `/admin/contract-abi-submissions/*` | router-defined | `adminAuth` plus feature gate | deployment administrator | 401 invalid/missing token; feature-gate response when disabled | `src/api/contract-abi-submissions.ts` |
| `/admin/errors/*` | router-defined | Bearer session: `requireAuth`, then `requireRole('admin')` | authenticated admin user | 401 no/invalid session; 403 non-admin | `src/api/admin/errors.ts` |
| `/admin/dead-letter/*` | router-defined | Bearer session: `requireAuth`, then `requireRole('admin')` | authenticated admin user | 401 no/invalid session; 403 non-admin | `src/api/admin/dead-letter.ts` |
| `/admin/feature-flags/*` | router-defined | Bearer session: `requireAuth`, then `requireRole('admin')` | authenticated admin user | 401 no/invalid session; 403 non-admin | `src/api/feature-flags.ts` |
| `/admin/consistency-check` | POST | **No explicit authorization middleware** | none | request is accepted subject to normal application controls | `src/api/admin.ts` |

## Required deployment controls

- Set `ADMIN_API_KEY` (or the equivalent configured admin secret) only through
  the deployment secret manager. `adminAuth` rejects requests when it is not
  configured; it must never fall back to a shared default.
- Use a separate admin secret and authenticated-user population for every
  network and environment. An admin credential from Testnet must not grant
  Mainnet access.
- Put administrative endpoints behind the deployment's TLS, network, logging,
  and alerting controls. Do not put admin tokens in query strings or browser
  history.
- Treat 401 as unauthenticated and 403 as authenticated-but-not-authorized;
  clients must not retry either response with the same credentials.

## Identified gap

`POST /admin/consistency-check` is mounted through `adminRouter`, but unlike
its neighboring indexer-control handlers it has no `adminAuth`, `requireAuth`,
or role middleware in its route definition. It must be explicitly protected
before it is exposed outside a trusted operations network. This document keeps
the gap visible so a rate-limit mount is not mistaken for authorization.

## Change checklist

When adding or changing an administrative route, update this matrix in the
same pull request and verify:

1. the route has an explicit authentication middleware;
2. its required role or token type is listed;
3. its 401/403/429 behaviour is covered by a focused route test; and
4. the deployment/runbook explains any network-specific credential scope.
