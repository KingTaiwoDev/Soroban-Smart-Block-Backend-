# External price feeds: availability and fallback

Token USD prices are composed in `src/services/pricing/composite-price.ts` from
a stablecoin peg, on-chain DEX pools, and external providers resolved by
`discoverExternalPrice()` in `src/services/pricing/external-api-source.ts`.
This document defines how the external providers behave when they are slow,
failing, or unreachable.

## Provider order

| Order | Provider | Keyed by | Requires | Base confidence |
| ---: | --- | --- | --- | ---: |
| 1 | CoinGecko | token symbol | — | 0.85 |
| 2 | CoinMarketCap | token symbol | `COINMARKETCAP_API_KEY` | 0.90 |
| 3 | stellar.expert | token address | — | 0.60 |

The first provider returning a positive, finite price wins. A provider that
returns no data (HTTP 404, unknown symbol, missing API key, local rate limit)
is skipped without counting as an outage.

## Availability policy

| Setting | Env var | Default |
| --- | --- | ---: |
| Per-request timeout | `EXTERNAL_PRICE_TIMEOUT_MS` | 3000 ms |
| Failures before a provider is marked unavailable | `EXTERNAL_PRICE_FAILURE_THRESHOLD` | 3 |
| Cooldown while unavailable | `EXTERNAL_PRICE_COOLDOWN_MS` | 60000 ms |
| Max age of a last-known-good fallback | `EXTERNAL_PRICE_MAX_STALE_MS` | 900000 ms (15 min) |

- Every provider call is aborted after the request timeout. Previously calls
  had no timeout and could stall the price updater.
- Network errors, timeouts, non-404 HTTP errors and malformed bodies count as
  failures. After `FAILURE_THRESHOLD` consecutive failures the provider is
  skipped until the cooldown elapses, then retried; one success resets it.
- A CoinGecko HTTP 429 additionally saturates the local per-minute rate limit.
- Provider cache hits (`cg_price`, `cmc_price`, `se_price`, 30 s TTL) are now
  checked before the local rate limit, so cached reads no longer consume quota.
- `getExternalPriceFeedStatus()` returns per-provider `available`,
  `consecutiveFailures`, `lastSuccessAt`, `lastFailureAt`, `lastError` and
  `unavailableUntil` for health/diagnostic surfaces.

## Fallback behaviour

1. If no provider yields a live price, the token's last-known-good external
   price is returned when it is no older than `EXTERNAL_PRICE_MAX_STALE_MS`.
   It keeps its original `source` and `observedAt`, is flagged `stale: true`,
   and its confidence is halved.
2. Beyond that window `discoverExternalPrice()` returns `null` and the
   composite price relies on the peg and DEX sources, as before.
3. Stale fallbacks are never written to `token_prices` / `token_price_history`:
   the external price updater skips them, and `computeCompositePrice()` does
   not persist a result whose selected source is a stale fallback. In the
   composite `breakdown`, a stale entry carries `stale: true`.

Availability state and last-known-good values are held in process memory
(bounded to 5,000 tokens). They reset on restart and are not shared between
replicas; each instance converges independently.

## Network-specific implications

- Deployments are per network (`STELLAR_NETWORK`), so provider state is per
  network as well.
- CoinGecko and CoinMarketCap are looked up by **symbol** and only quote
  mainnet market prices. On testnet and devnet, a token reusing a mainnet
  symbol (for example `USDC`) is priced at the mainnet value; treat external
  prices on non-mainnet networks as illustrative only.
- The stellar.expert lookup uses the public explorer endpoint, which does not
  resolve testnet/devnet contract addresses; expect `null` (404) there, which
  does not mark the provider unavailable.

## Compatibility

`ExternalPrice` gains optional `observedAt` and `stale` fields and composite
`breakdown` entries gain an optional `stale` flag; existing fields are
unchanged. No migration is required. Operators can tune the env vars above
without redeploying code.
