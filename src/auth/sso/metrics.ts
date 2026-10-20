/**
 * Prometheus metrics for Enterprise SSO / OIDC (PLT09 / #1030).
 *
 * SLO dashboard guidance
 * ──────────────────────
 * Error budget: 99.9 % of SSO logins should complete in < 2 s end-to-end.
 * Alert thresholds:
 *   • sso_login_total{result="error"} / sso_login_total > 0.01 for 5 min  → page
 *   • sso_login_duration_seconds P99 > 2.0 for 5 min                      → warn
 *   • sso_provision_total{result="error"} > 0 for 1 min                   → page
 *   • sso_token_exchange_duration_seconds P99 > 1.0 for 5 min             → warn
 */

import { Counter, Histogram, Gauge, Registry } from 'prom-client';
import { registry as globalRegistry } from '../../metrics';

// Use the application's global Prometheus registry so that /metrics serves
// these alongside all other application metrics.
const reg: Registry = globalRegistry;

// ── Login completions ─────────────────────────────────────────────────────────

/**
 * Total SSO login attempts, labelled by provider and result.
 * result ∈ { "success", "error", "blocked" }
 */
export const ssoLoginTotal = new Counter({
  name: 'sso_login_total',
  help: 'Total SSO login attempts by provider and result',
  labelNames: ['provider_id', 'result'],
  registers: [reg],
});

/**
 * End-to-end SSO login latency (authorization redirect → token issued).
 * Buckets tuned for the 2-second SLO target.
 */
export const ssoLoginDuration = new Histogram({
  name: 'sso_login_duration_seconds',
  help: 'SSO login end-to-end latency in seconds (redirect → token issued)',
  labelNames: ['provider_id'],
  buckets: [0.05, 0.1, 0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 5.0],
  registers: [reg],
});

// ── IdP token exchange ────────────────────────────────────────────────────────

/**
 * Latency of the outbound OIDC token-exchange call to the IdP.
 * Drives the "IdP unreachable" alert.
 */
export const ssoTokenExchangeDuration = new Histogram({
  name: 'sso_token_exchange_duration_seconds',
  help: 'Latency of OIDC token exchange with the identity provider',
  labelNames: ['provider_id'],
  buckets: [0.025, 0.05, 0.1, 0.25, 0.5, 0.75, 1.0, 2.0],
  registers: [reg],
});

// ── Auto-provisioning ─────────────────────────────────────────────────────────

/**
 * User / org provisioning outcomes.
 * result ∈ { "created", "linked", "error" }
 */
export const ssoProvisionTotal = new Counter({
  name: 'sso_provision_total',
  help: 'SSO auto-provisioning outcomes (user created, linked to existing, or error)',
  labelNames: ['provider_id', 'result'],
  registers: [reg],
});

// ── Active sessions ───────────────────────────────────────────────────────────

/** Current number of active (non-revoked, non-expired) SSO sessions. */
export const ssoActiveSessionsGauge = new Gauge({
  name: 'sso_active_sessions_total',
  help: 'Current number of active SSO sessions (gauge, updated on login and logout)',
  labelNames: ['provider_id'],
  registers: [reg],
});

// ── Provider management ───────────────────────────────────────────────────────

/**
 * Admin operations on SSO providers.
 * operation ∈ { "create", "update", "deactivate" }
 */
export const ssoProviderOpsTotal = new Counter({
  name: 'sso_provider_ops_total',
  help: 'Admin operations on SSO providers (create, update, deactivate)',
  labelNames: ['operation'],
  registers: [reg],
});

// ── Error budget helper ───────────────────────────────────────────────────────

/**
 * Records a completed login attempt to all relevant metrics.
 *
 * @param providerId  Provider ID label for the series.
 * @param result      "success" | "error" | "blocked"
 * @param durationSec Wall-clock duration of the full login flow in seconds.
 */
export function recordSsoLogin(
  providerId: string,
  result: 'success' | 'error' | 'blocked',
  durationSec: number,
): void {
  ssoLoginTotal.labels(providerId, result).inc();
  if (result === 'success') {
    ssoLoginDuration.labels(providerId).observe(durationSec);
  }
}

/**
 * Records a completed token-exchange call to the IdP.
 */
export function recordTokenExchange(providerId: string, durationSec: number): void {
  ssoTokenExchangeDuration.labels(providerId).observe(durationSec);
}

/**
 * Records a provisioning outcome.
 */
export function recordProvision(
  providerId: string,
  result: 'created' | 'linked' | 'error',
): void {
  ssoProvisionTotal.labels(providerId, result).inc();
}
