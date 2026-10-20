/**
 * Metric label sanitisation (#1241).
 *
 * Prometheus label values are exported to a wider audience than the database
 * and every distinct value creates a new time series. Raw Stellar account /
 * contract identifiers and transaction hashes must therefore never become
 * label values: they leak who is being looked up and explode cardinality.
 *
 * Pure module with no prom-client import so it can be used (and tested) from
 * any metrics call site.
 */

/** Max length of a sanitised label value; longer values are truncated. */
export const MAX_METRIC_LABEL_LENGTH = 128;

// Stellar strkeys: G (account), C (contract), M (muxed), S (seed), B (claimable
// balance), L (liquidity pool), T/X/P (signer variants). Base32 body, 56–69 chars.
// Case-insensitive because Express routes still match lower-cased path params.
const STRKEY = /(?<![A-Za-z0-9])[GCMSBLTXP][A-Z2-7]{55,68}(?![A-Za-z0-9])/gi;
// Transaction / ledger / wasm hashes and other long hex ids (>= 32 hex chars).
const HEX_ID = /(?<![A-Za-z0-9])(?:0x)?[0-9a-f]{32,}(?![A-Za-z0-9])/gi;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Replace any account/contract identifier or hash inside `value` with a placeholder. */
export function redactIdentifiers(value: string): string {
  return value.replace(STRKEY, ':address').replace(HEX_ID, ':hash');
}

/**
 * Sanitise an arbitrary label value: redact identifiers and cap length.
 * Use for any label whose value is not drawn from a fixed allowlist.
 */
export function sanitizeMetricLabelValue(value: unknown): string {
  const s = redactIdentifiers(String(value ?? ''));
  return s.length > MAX_METRIC_LABEL_LENGTH ? s.slice(0, MAX_METRIC_LABEL_LENGTH) : s;
}

/**
 * Normalise an HTTP path into a bounded `route` label. Express route patterns
 * (`/contracts/:id`) pass through unchanged; raw paths (unmatched routes, error
 * handler) have identifiers, UUIDs, cuid-like ids and numbers replaced.
 */
export function normaliseRouteLabel(path: string): string {
  return sanitizeMetricLabelValue(
    redactIdentifiers(path)
      .replace(UUID, ':id')
      .replace(/\/c[a-z0-9]{20,}/g, '/:id')
      .replace(/\/\d+(?=\/|$)/g, '/:id'),
  );
}
