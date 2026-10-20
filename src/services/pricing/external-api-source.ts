import { cacheGet, cacheSet } from '../../cache';
import { logger } from '../../logger';

const RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 30;

function positiveIntEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Availability / fallback policy for external price feeds (#1250).
 * See docs/external-price-feeds.md.
 */
export const EXTERNAL_PRICE_FEED_POLICY = {
  /** Per-request timeout for a single provider call. */
  requestTimeoutMs: positiveIntEnv('EXTERNAL_PRICE_TIMEOUT_MS', 3_000),
  /** Consecutive failures before a provider is marked unavailable. */
  failureThreshold: positiveIntEnv('EXTERNAL_PRICE_FAILURE_THRESHOLD', 3),
  /** How long an unavailable provider is skipped before it is retried. */
  cooldownMs: positiveIntEnv('EXTERNAL_PRICE_COOLDOWN_MS', 60_000),
  /** Max age of a last-known-good price served when every provider fails. */
  maxStaleMs: positiveIntEnv('EXTERNAL_PRICE_MAX_STALE_MS', 15 * 60_000),
  /** Confidence multiplier applied to a stale fallback price. */
  staleConfidenceFactor: 0.5,
} as const;

const MAX_LAST_KNOWN_GOOD = 5_000;

export type ExternalPriceSource = 'coingecko' | 'cmc' | 'stellarexpert';

/** Thrown by a provider for transport/HTTP failures (counts against availability). */
class PriceFeedUnavailableError extends Error {}

interface SourceHealth {
  consecutiveFailures: number;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastError: string | null;
  unavailableUntil: number | null;
}

const sourceHealth = new Map<ExternalPriceSource, SourceHealth>();
const lastKnownGood = new Map<string, ExternalPrice>();

interface RateLimitState {
  count: number;
  windowStart: number;
}

const rateLimitState: Record<string, RateLimitState> = {};

export interface ExternalPrice {
  priceUsd: number;
  priceXlm?: number;
  marketCapUsd?: number;
  volume24hUsd?: number;
  fullyDilutedValuation?: number;
  circulatingSupply?: number;
  totalSupply?: number;
  priceChange1h?: number;
  priceChange24h?: number;
  priceChange7d?: number;
  source: string;
  confidence: number;
  /** ISO time the provider value was observed. */
  observedAt?: string;
  /** True when this is a last-known-good fallback, not a live provider value. */
  stale?: boolean;
}

function healthOf(source: ExternalPriceSource): SourceHealth {
  let h = sourceHealth.get(source);
  if (!h) {
    h = {
      consecutiveFailures: 0,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastError: null,
      unavailableUntil: null,
    };
    sourceHealth.set(source, h);
  }
  return h;
}

function isSourceAvailable(source: ExternalPriceSource, now = Date.now()): boolean {
  const until = healthOf(source).unavailableUntil;
  return until === null || now >= until;
}

function recordSuccess(source: ExternalPriceSource): void {
  const h = healthOf(source);
  h.consecutiveFailures = 0;
  h.lastSuccessAt = Date.now();
  h.unavailableUntil = null;
}

function recordFailure(source: ExternalPriceSource, err: unknown): void {
  const h = healthOf(source);
  const now = Date.now();
  h.consecutiveFailures += 1;
  h.lastFailureAt = now;
  h.lastError = err instanceof Error ? err.message : String(err);
  if (h.consecutiveFailures >= EXTERNAL_PRICE_FEED_POLICY.failureThreshold) {
    h.unavailableUntil = now + EXTERNAL_PRICE_FEED_POLICY.cooldownMs;
    logger.warn('[ExternalPrice] provider marked unavailable', {
      source,
      consecutiveFailures: h.consecutiveFailures,
      cooldownMs: EXTERNAL_PRICE_FEED_POLICY.cooldownMs,
      error: h.lastError,
    });
  }
}

async function fetchFeed(url: string, init: RequestInit = {}): Promise<Response | null> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(EXTERNAL_PRICE_FEED_POLICY.requestTimeoutMs),
    });
  } catch (err) {
    throw new PriceFeedUnavailableError(`request failed: ${(err as Error).message}`);
  }
  // 404 means "no price for this asset", which is not a provider outage.
  if (response.status === 404) return null;
  if (!response.ok) throw new PriceFeedUnavailableError(`HTTP ${response.status}`);
  return response;
}

function rememberLastKnownGood(tokenAddress: string, price: ExternalPrice): void {
  lastKnownGood.delete(tokenAddress);
  lastKnownGood.set(tokenAddress, price);
  if (lastKnownGood.size > MAX_LAST_KNOWN_GOOD) {
    const oldest = lastKnownGood.keys().next().value;
    if (oldest !== undefined) lastKnownGood.delete(oldest);
  }
}

function staleFallback(tokenAddress: string): ExternalPrice | null {
  const last = lastKnownGood.get(tokenAddress);
  if (!last?.observedAt) return null;
  const ageMs = Date.now() - Date.parse(last.observedAt);
  if (!(ageMs <= EXTERNAL_PRICE_FEED_POLICY.maxStaleMs)) return null;
  return {
    ...last,
    confidence: last.confidence * EXTERNAL_PRICE_FEED_POLICY.staleConfidenceFactor,
    stale: true,
  };
}

export interface ExternalPriceFeedStatus {
  source: ExternalPriceSource;
  available: boolean;
  consecutiveFailures: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
  unavailableUntil: string | null;
}

const ALL_SOURCES: ExternalPriceSource[] = ['coingecko', 'cmc', 'stellarexpert'];
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

/** Snapshot of provider availability for health/diagnostic surfaces. */
export function getExternalPriceFeedStatus(): ExternalPriceFeedStatus[] {
  const now = Date.now();
  return ALL_SOURCES.map((source) => {
    const h = healthOf(source);
    return {
      source,
      available: isSourceAvailable(source, now),
      consecutiveFailures: h.consecutiveFailures,
      lastSuccessAt: iso(h.lastSuccessAt),
      lastFailureAt: iso(h.lastFailureAt),
      lastError: h.lastError,
      unavailableUntil: iso(h.unavailableUntil),
    };
  });
}

/** Test helper — clears availability and last-known-good state. */
export function resetExternalPriceFeedState(): void {
  sourceHealth.clear();
  lastKnownGood.clear();
  for (const key of Object.keys(rateLimitState)) delete rateLimitState[key];
}

function checkRateLimit(source: string): boolean {
  const state = rateLimitState[source] ?? { count: 0, windowStart: Date.now() };
  if (Date.now() - state.windowStart > RATE_LIMIT_WINDOW_MS) {
    state.count = 0;
    state.windowStart = Date.now();
  }
  if (state.count >= MAX_REQUESTS_PER_WINDOW) return false;
  state.count++;
  rateLimitState[source] = state;
  return true;
}

function coingeckoIdFromSymbol(symbol: string): string {
  const map: Record<string, string> = {
    usdc: 'usd-coin',
    usdt: 'tether',
    xlm: 'stellar',
    eurc: 'euro-coin',
    dai: 'dai',
    sushi: 'sushi',
    uni: 'uniswap',
    yfi: 'yearn-finance',
    aave: 'aave',
    link: 'chainlink',
    wbtc: 'wrapped-bitcoin',
    weth: 'wrapped-ether',
  };
  return map[symbol.toLowerCase()] ?? symbol.toLowerCase();
}

async function fetchCoinGeckoPrice(tokenSymbol: string): Promise<ExternalPrice | null> {
  const cacheKey = `cg_price:${tokenSymbol}`;
  const cached = await cacheGet<ExternalPrice>(cacheKey);
  if (cached) return cached;

  if (!checkRateLimit('coingecko')) {
    logger.warn('[ExternalPrice] CoinGecko rate limited');
    return null;
  }

  const cgId = coingeckoIdFromSymbol(tokenSymbol);
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${cgId}&vs_currencies=usd&include_24hr_vol=true&include_24hr_change=true&include_market_cap=true`;

  try {
    const response = await fetchFeed(url);
    if (!response) return null;

    const data = (await response.json()) as Record<string, Record<string, number>>;
    const priceData = data[cgId];
    if (!priceData || !priceData.usd) return null;

    const result: ExternalPrice = {
      priceUsd: priceData.usd,
      volume24hUsd: priceData.usd_24h_vol,
      marketCapUsd: priceData.usd_market_cap,
      priceChange24h: priceData.usd_24h_change,
      priceChange1h: 0,
      source: 'coingecko',
      confidence: 0.85,
      observedAt: new Date().toISOString(),
    }; // #917 — TTL resolved from the per-route registry (se_price → 30s).
    await cacheSet(cacheKey, result);
    return result;
  } catch (err) {
    if (err instanceof PriceFeedUnavailableError && err.message === 'HTTP 429') {
      rateLimitState['coingecko'] = { count: MAX_REQUESTS_PER_WINDOW, windowStart: Date.now() };
    }
    throw err;
  }
}

async function fetchCoinMarketCapPrice(tokenSymbol: string): Promise<ExternalPrice | null> {
  const cmcApiKey = process.env.COINMARKETCAP_API_KEY;
  if (!cmcApiKey) return null;

  const cacheKey = `cmc_price:${tokenSymbol}`;
  const cached = await cacheGet<ExternalPrice>(cacheKey);
  if (cached) return cached;

  if (!checkRateLimit('cmc')) {
    logger.warn('[ExternalPrice] CMC rate limited');
    return null;
  }

  const response = await fetchFeed(
    `https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?symbol=${tokenSymbol}`,
    { headers: { 'X-CMC_PRO_API_KEY': cmcApiKey } },
  );

  if (!response) return null;
  const data = (await response.json()) as {
    data?: Record<
      string,
      Array<{
        quote: {
          USD: {
            price: number;
            volume_24h: number;
            market_cap: number;
            percent_change_1h: number;
            percent_change_24h: number;
            percent_change_7d: number;
          };
        };
      }>
    >;
  };

  const quotes = data.data?.[tokenSymbol.toUpperCase()];
  if (!quotes || quotes.length === 0) return null;

  const quote = quotes[0].quote.USD;
  const result: ExternalPrice = {
    priceUsd: quote.price,
    volume24hUsd: quote.volume_24h,
    marketCapUsd: quote.market_cap,
    priceChange1h: quote.percent_change_1h,
    priceChange24h: quote.percent_change_24h,
    priceChange7d: quote.percent_change_7d,
    source: 'cmc',
    confidence: 0.9,
    observedAt: new Date().toISOString(),
  };

  // #917 — TTL resolved from the per-route registry (cmc_price → 30s).
  await cacheSet(cacheKey, result);
  return result;
}

async function fetchStellarExpertPrice(tokenAddress: string): Promise<ExternalPrice | null> {
  const cacheKey = `se_price:${tokenAddress}`;
  const cached = await cacheGet<ExternalPrice>(cacheKey);
  if (cached) return cached;

  if (!checkRateLimit('stellarexpert')) return null;

  const response = await fetchFeed(`https://api.stellar.expert/explorer/asset/${tokenAddress}`, {
    headers: { Accept: 'application/json' },
  });
  if (!response) return null;
  const data = (await response.json()) as { price?: string };
  if (!data.price) return null;

  const result: ExternalPrice = {
    priceUsd: parseFloat(data.price),
    source: 'stellarexpert',
    confidence: 0.6,
    observedAt: new Date().toISOString(),
  }; // #917 — TTL resolved from the per-route registry (se_price → 30s).
  await cacheSet(cacheKey, result);
  return result;
}

/**
 * Resolve a USD price from external providers in priority order
 * (CoinGecko → CoinMarketCap → stellar.expert).
 *
 * - Providers in cooldown after repeated failures are skipped.
 * - The first live price > 0 wins and becomes the token's last-known-good value.
 * - If no live price is available, a last-known-good value no older than
 *   `maxStaleMs` is returned with `stale: true` and reduced confidence.
 * - Otherwise `null` (callers fall back to DEX / peg sources).
 */
export async function discoverExternalPrice(
  tokenAddress: string,
  tokenSymbol?: string | null,
): Promise<ExternalPrice | null> {
  const sources: Array<{ name: ExternalPriceSource; fetch: () => Promise<ExternalPrice | null> }> =
    [];

  if (tokenSymbol) {
    sources.push({ name: 'coingecko', fetch: () => fetchCoinGeckoPrice(tokenSymbol) });
    sources.push({ name: 'cmc', fetch: () => fetchCoinMarketCapPrice(tokenSymbol) });
  }
  sources.push({ name: 'stellarexpert', fetch: () => fetchStellarExpertPrice(tokenAddress) });

  for (const source of sources) {
    if (!isSourceAvailable(source.name)) continue;
    try {
      const price = await source.fetch();
      recordSuccess(source.name);
      if (price && Number.isFinite(price.priceUsd) && price.priceUsd > 0) {
        rememberLastKnownGood(tokenAddress, price);
        return price;
      }
    } catch (err) {
      recordFailure(source.name, err);
    }
  }

  return staleFallback(tokenAddress);
}
