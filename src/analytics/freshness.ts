/**
 * Freshness metadata for pre-aggregated, per-network analytics datasets
 * (gas snapshots, protocol-economics snapshots).
 *
 * Each API deployment serves exactly one Stellar network profile, so the
 * snapshot tables it reads are implicitly scoped to that network.  This helper
 * reports which network the data belongs to, how far the newest snapshot
 * reaches, and whether it is stale relative to the bucket cadence.
 */

export type AnalyticsBucket = 'hour' | 'day' | 'week';

export const ANALYTICS_BUCKET_SECONDS: Record<AnalyticsBucket, number> = {
  hour: 60 * 60,
  day: 24 * 60 * 60,
  week: 7 * 24 * 60 * 60,
};

/**
 * Number of bucket periods that may elapse before a dataset is flagged stale.
 * Devnet ledgers close irregularly (see docs/indexer-freshness-slo.md), so it
 * is given a wider tolerance than mainnet/testnet.
 */
export const STALE_AFTER_PERIODS: Record<string, number> = {
  mainnet: 2,
  testnet: 2,
  devnet: 6,
};
const DEFAULT_STALE_AFTER_PERIODS = 2;

export interface AnalyticsFreshness {
  network: string;
  bucket: AnalyticsBucket;
  /** End of the newest snapshot bucket, capped at "now" for an in-progress bucket. */
  dataAsOf: string | null;
  ageSeconds: number | null;
  maxAgeSeconds: number;
  stale: boolean;
}

export function buildAnalyticsFreshness(
  network: string,
  bucket: AnalyticsBucket,
  latest: { bucketEnd: Date } | null | undefined,
  now: Date = new Date(),
): AnalyticsFreshness {
  const periods = STALE_AFTER_PERIODS[network] ?? DEFAULT_STALE_AFTER_PERIODS;
  const maxAgeSeconds = ANALYTICS_BUCKET_SECONDS[bucket] * periods;
  const endMs = latest ? new Date(latest.bucketEnd).getTime() : Number.NaN;

  if (!Number.isFinite(endMs)) {
    return { network, bucket, dataAsOf: null, ageSeconds: null, maxAgeSeconds, stale: true };
  }

  const asOfMs = Math.min(endMs, now.getTime());
  const ageSeconds = Math.floor((now.getTime() - asOfMs) / 1000);
  return {
    network,
    bucket,
    dataAsOf: new Date(asOfMs).toISOString(),
    ageSeconds,
    maxAgeSeconds,
    stale: ageSeconds > maxAgeSeconds,
  };
}
