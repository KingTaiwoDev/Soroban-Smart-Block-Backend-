# Sensitive-data inventory and retention classification

This inventory establishes handling classifications for data processed by the
explorer. It is an operational baseline, not a claim that every deployment has
an automatic deletion job today. Owners must configure retention controls and
document any legal hold before production rollout.

| Data category | Examples and source of truth | Classification | Retention baseline | Handling requirement |
| --- | --- | --- | --- | --- |
| On-chain public data | Ledger, transaction, event, contract, wallet and token records | Public | Index lifetime; subject to reindex/reorg policy | May be served publicly, but do not reclassify off-chain annotations as public. |
| Account and developer identity | Developer email, organization/profile metadata in Prisma | Confidential | Account lifetime plus documented deletion window | Restrict to support and authorized service workflows; exclude from analytics exports. |
| Authentication artifacts | Session identifiers, token hashes, JWT claims | Restricted | Active session lifetime plus security/audit window | Store hashes where implemented; never log or export bearer tokens. Revoke on logout or compromise. |
| API credentials and administrative secrets | API keys, `ADMIN_API_KEY`, webhook secrets, OAuth/refresh tokens, MFA secrets | Restricted | Only while active; rotate/revoke promptly | Encrypt or use a managed secret store at rest; redact from logs, error bodies, fixtures, and support tickets. |
| Network and device metadata | IP address, user agent, request IDs, rate-limit keys | Confidential | Short operational and abuse-investigation window | Limit access to operations/security; aggregate or delete when no longer needed. |
| Webhook and notification delivery data | Destination URLs, subscriber targets, payloads, delivery attempts | Confidential; payload may be Restricted | Delivery/retry window plus minimal audit window | Apply payload redaction before logs; retain no secret-bearing payload longer than required to diagnose delivery. |
| Dead-letter, raw XDR, and decoder diagnostics | Malformed event payloads, raw XDR, error context | Confidential; may be Restricted | Bounded replay/incident window | Access only to indexer operators; preserve enough provenance for replay, then purge under the raw-XDR retention runbook. |
| User-provided ABI, query, export, and dashboard data | ABI submissions, saved searches, SQL templates, export requests | Confidential | Feature lifetime plus deletion/expiry policy | Validate input, enforce per-tenant authorization, and avoid including user content in broad diagnostics. |

## System references

The inventory is grounded in the persistence and processing paths currently in
the repository:

- `src/auth/tokens.ts` hashes issued tokens; `src/auth/middleware.ts` checks
  active session records.
- `src/middleware/adminAuth.ts` uses the deployment's admin secret and must
  never be enabled without a configured secret.
- `src/webhooks/redaction.ts` provides the baseline redaction patterns for
  outbound/webhook diagnostics.
- Prisma migrations define stored developer, session, webhook, payload, and
  notification fields. Treat a JSON payload as at least Confidential until it
  is classified for the feature that creates it.
- `docs/runbooks/raw-xdr-retention.md` is the operational reference for raw
  XDR retention and disposal.

## Retention procedure

1. Assign every new table, cache, queue, log field, and external processor to
   one of the classifications above before rollout.
2. Record the owner, storage location, deletion mechanism, and retention
   period in the feature's runbook. A classification alone is not a deletion
   mechanism.
3. Keep production, Testnet, and development data stores isolated. Never use
   a production secret or a production data export in fixture data.
4. On deletion or credential revocation, invalidate caches and queued delivery
   work as well as the primary record.
5. Review this inventory at least annually and after authentication, webhook,
   export, or observability changes.
