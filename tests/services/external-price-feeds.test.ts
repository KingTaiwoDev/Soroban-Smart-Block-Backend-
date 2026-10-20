import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/cache', () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  EXTERNAL_PRICE_FEED_POLICY,
  discoverExternalPrice,
  getExternalPriceFeedStatus,
  resetExternalPriceFeedState,
} from '../../src/services/pricing/external-api-source';

const TOKEN = 'CTOKEN';
const ok = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
const status = (code: number) =>
  ({ ok: false, status: code, json: async () => ({}) }) as unknown as Response;

const coingeckoOk = ok({ 'usd-coin': { usd: 1.001, usd_24h_vol: 10 } });
const stellarExpertOk = ok({ price: '0.99' });

function statusOf(source: string) {
  return getExternalPriceFeedStatus().find((s) => s.source === source)!;
}

describe('external price feed availability and fallback', () => {
  beforeEach(() => {
    resetExternalPriceFeedState();
    delete process.env.COINMARKETCAP_API_KEY;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('returns the first live provider price and applies a request timeout', async () => {
    const fetchMock = vi.fn().mockResolvedValue(coingeckoOk);
    vi.stubGlobal('fetch', fetchMock);

    const price = await discoverExternalPrice(TOKEN, 'USDC');

    expect(price).toMatchObject({ priceUsd: 1.001, source: 'coingecko' });
    expect(price?.stale).toBeUndefined();
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    expect(statusOf('coingecko')).toMatchObject({ available: true, consecutiveFailures: 0 });
  });

  it('falls through to the next provider when one errors or times out', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'))
      .mockResolvedValueOnce(stellarExpertOk);
    vi.stubGlobal('fetch', fetchMock);

    const price = await discoverExternalPrice(TOKEN, 'USDC');

    expect(price).toMatchObject({ priceUsd: 0.99, source: 'stellarexpert' });
    expect(statusOf('coingecko').consecutiveFailures).toBe(1);
    expect(statusOf('coingecko').lastError).toContain('timed out');
  });

  it('treats 404 as "no price" rather than a provider outage', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(status(404)));

    await expect(discoverExternalPrice(TOKEN, null)).resolves.toBeNull();
    expect(statusOf('stellarexpert')).toMatchObject({ available: true, consecutiveFailures: 0 });
  });

  it('marks a provider unavailable after repeated failures and skips it during cooldown', async () => {
    const fetchMock = vi.fn().mockResolvedValue(status(503));
    vi.stubGlobal('fetch', fetchMock);

    for (let i = 0; i < EXTERNAL_PRICE_FEED_POLICY.failureThreshold; i++) {
      await discoverExternalPrice(TOKEN, null);
    }
    const se = statusOf('stellarexpert');
    expect(se.available).toBe(false);
    expect(se.unavailableUntil).not.toBeNull();

    fetchMock.mockClear();
    await discoverExternalPrice(TOKEN, null);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('retries a provider once its cooldown has elapsed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const fetchMock = vi.fn().mockResolvedValue(status(500));
    vi.stubGlobal('fetch', fetchMock);
    for (let i = 0; i < EXTERNAL_PRICE_FEED_POLICY.failureThreshold; i++) {
      await discoverExternalPrice(TOKEN, null);
    }

    vi.setSystemTime(Date.now() + EXTERNAL_PRICE_FEED_POLICY.cooldownMs + 1);
    fetchMock.mockResolvedValue(stellarExpertOk);

    await expect(discoverExternalPrice(TOKEN, null)).resolves.toMatchObject({ priceUsd: 0.99 });
    expect(statusOf('stellarexpert')).toMatchObject({ available: true, consecutiveFailures: 0 });
  });

  it('serves a last-known-good price as stale with reduced confidence when all providers fail', async () => {
    const fetchMock = vi.fn().mockResolvedValue(stellarExpertOk);
    vi.stubGlobal('fetch', fetchMock);
    const live = await discoverExternalPrice(TOKEN, null);

    fetchMock.mockResolvedValue(status(502));
    const fallback = await discoverExternalPrice(TOKEN, null);

    expect(fallback).toMatchObject({ priceUsd: 0.99, source: 'stellarexpert', stale: true });
    expect(fallback?.confidence).toBeCloseTo(
      live!.confidence * EXTERNAL_PRICE_FEED_POLICY.staleConfidenceFactor,
    );
    expect(fallback?.observedAt).toBe(live?.observedAt);
  });

  it('returns null once the last-known-good price is older than the stale window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const fetchMock = vi.fn().mockResolvedValue(stellarExpertOk);
    vi.stubGlobal('fetch', fetchMock);
    await discoverExternalPrice(TOKEN, null);

    vi.setSystemTime(Date.now() + EXTERNAL_PRICE_FEED_POLICY.maxStaleMs + 1);
    fetchMock.mockResolvedValue(status(502));

    await expect(discoverExternalPrice(TOKEN, null)).resolves.toBeNull();
  });

  it('returns null with no history when every provider is down', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    await expect(discoverExternalPrice(TOKEN, 'USDC')).resolves.toBeNull();
  });
});
