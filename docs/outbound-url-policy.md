# Outbound URL-fetch policy (SSRF protection)

All server-side HTTP requests to URLs that a user, developer or operator can
influence go through one policy module: `src/webhooks/ssrf-guard.ts`.

| Need | Use |
| --- | --- |
| Validate a URL at input time (zod schema, config) | `isOutboundUrlAllowed(url)` / `checkOutboundUrl(url)` |
| Validate including DNS resolution | `await assertSafeUrl(url)` |
| Send a POST / GET | `safePost(url, body, headers, timeoutMs)` / `safeGet(url, params, headers, timeoutMs)` |

Do not call `axios`/`fetch` directly with a caller-supplied URL.

## Rules

- **Scheme:** `https:` only. Plain `http:` is allowed only when
  `NETWORK_PROFILE` (or, if unset, `NODE_ENV`) is `local`, `devnet` or `test`.
  Every other scheme (`file:`, `ftp:`, `gopher:` …) is rejected.
- **No embedded credentials** (`https://user:pass@host`).
- **Blocked destinations**, as IP literals (including decimal/hex IPv4 forms and
  IPv4-mapped IPv6 such as `[::ffff:127.0.0.1]`) or as any resolved A/AAAA record:
  loopback, RFC 1918 private, CGNAT `100.64/10`, link-local `169.254/16` and
  `fe80::/10` (cloud metadata), unique-local `fc00::/7`, `fd00:ec2::254`,
  unspecified, multicast, broadcast, reserved and documentation ranges.
- **Reserved hostnames:** `localhost`, `*.localhost`, `*.local`, `*.internal`
  (a trailing root dot is ignored).
- **DNS rebinding:** validated addresses are cached for 5 s and pinned into the
  HTTP agent, so the connection goes to the IP that was checked.
- **Redirects:** followed manually (max 5); every hop is re-validated, so a public
  URL that redirects to a private address or downgrades to `http:` is blocked.

Violations raise `SsrfBlockedError`; delivery code treats it as a permanent
failure (no retries).

## Callers

Webhook subscriptions and deliveries (`/webhooks`, `/developer/webhooks`, batch
dispatcher), auth webhooks, alert sinks (Slack / operator webhooks, suspicious
activity, freeze alerts, saved searches, feed delivery), audit notifications,
threat-intelligence (TIP) Slack/Discord/webhook notifications, compliance
webhooks, NFT/token metadata and Horizon `home_domain` fetches.

## Compatibility / rollout

- `POST /developer/webhooks`, `PATCH /developer/webhooks/:id` and
  `POST /compliance/webhooks` now reject private, loopback and internal URLs at
  creation time with `400`. Before, the developer API accepted
  `http://localhost` outside production, and the compliance API accepted any URL;
  such endpoints already failed (developer) or were reachable (compliance) at
  delivery time. Re-register them with a public HTTPS URL.
- Existing TIP, audit-notification and compliance subscriptions that point at
  private destinations stop receiving deliveries; the failure is logged.
- The policy is the same on every network (testnet, mainnet, devnet). Only the
  `http:` exception depends on the deployment profile.
