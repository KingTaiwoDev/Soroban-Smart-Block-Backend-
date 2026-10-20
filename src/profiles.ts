/**
 * Network profiles — one per Stellar environment.
 *
 * Each profile is fully self-contained: its own DB cluster, read-replica,
 * RPC endpoint, Horizon URL, network passphrase, API subdomain, and cache DSN.
 * The engine code (indexer, API, decoders) is shared across all profiles.
 *
 * Active profile is selected by STELLAR_NETWORK at startup.
 */

export type NetworkName = 'testnet' | 'mainnet' | 'devnet';

export type CacheMode = 'standalone' | 'sentinel';

export interface NetworkProfile {
  name: NetworkName;

  // ── Stellar RPC ──────────────────────────────────────────────────────────
  rpcUrl: string;
  rpcFallbackUrls: string[];
  rpcWsUrl: string;
  horizonUrl: string;
  networkPassphrase: string;

  // ── Database cluster ─────────────────────────────────────────────────────
  databaseUrl: string; // primary (write)
  readReplicaUrl: string; // read replica (falls back to primary)

  // ── API subdomain ────────────────────────────────────────────────────────
  apiSubdomain: string; // e.g. "testnet-api.example.com"

  // ── Cache node ───────────────────────────────────────────────────────────
  cacheUrl: string; // Redis URL (redis://...) or Sentinel URL (sentinel://...)
  cacheMode: CacheMode; // 'standalone' or 'sentinel'
}

// ─── Profile registry ─────────────────────────────────────────────────────────

const PROFILES: Record<NetworkName, NetworkProfile> = {
  testnet: {
    name: 'testnet',
    // Empty env vars mean "not configured" — fall back to the next default.
    rpcUrl: process.env.TESTNET_RPC_URL || 'https://soroban-testnet.stellar.org',
    rpcFallbackUrls: parseEndpointList(process.env.TESTNET_RPC_FALLBACK_URLS),
    rpcWsUrl: process.env.TESTNET_RPC_WS_URL || 'wss://soroban-testnet.stellar.org',
    horizonUrl: process.env.TESTNET_HORIZON_URL || 'https://horizon-testnet.stellar.org',
    networkPassphrase: process.env.TESTNET_PASSPHRASE || 'Test SDF Network ; September 2015',
    databaseUrl: process.env.TESTNET_DATABASE_URL || process.env.DATABASE_URL || '',
    readReplicaUrl:
      process.env.TESTNET_READ_REPLICA_URL ||
      process.env.TESTNET_DATABASE_URL ||
      process.env.DATABASE_URL ||
      '',
    apiSubdomain: process.env.TESTNET_API_SUBDOMAIN || 'testnet-api.localhost',
    cacheUrl: process.env.TESTNET_CACHE_URL || 'memory://',
    cacheMode: (process.env.TESTNET_CACHE_MODE || 'standalone') as CacheMode,
  },

  mainnet: {
    name: 'mainnet',
    rpcUrl: process.env.MAINNET_RPC_URL || '',
    rpcFallbackUrls: parseEndpointList(process.env.MAINNET_RPC_FALLBACK_URLS),
    rpcWsUrl: process.env.MAINNET_RPC_WS_URL || '',
    horizonUrl: process.env.MAINNET_HORIZON_URL || 'https://horizon.stellar.org',
    networkPassphrase:
      process.env.MAINNET_PASSPHRASE || 'Public Global Stellar Network ; September 2015',
    databaseUrl: process.env.MAINNET_DATABASE_URL || '',
    readReplicaUrl: process.env.MAINNET_READ_REPLICA_URL || process.env.MAINNET_DATABASE_URL || '',
    apiSubdomain: process.env.MAINNET_API_SUBDOMAIN || 'api.localhost',
    cacheUrl: process.env.MAINNET_CACHE_URL || 'memory://',
    cacheMode: (process.env.MAINNET_CACHE_MODE || 'standalone') as CacheMode,
  },

  devnet: {
    name: 'devnet',
    rpcUrl: process.env.DEVNET_RPC_URL || 'http://localhost:8000/soroban/rpc',
    rpcFallbackUrls: parseEndpointList(process.env.DEVNET_RPC_FALLBACK_URLS),
    rpcWsUrl: process.env.DEVNET_RPC_WS_URL || 'ws://localhost:8000/soroban/rpc',
    horizonUrl: process.env.DEVNET_HORIZON_URL || 'http://localhost:8000',
    networkPassphrase: process.env.DEVNET_PASSPHRASE || 'Standalone Network ; February 2017',
    databaseUrl:
      process.env.DEVNET_DATABASE_URL ||
      'postgresql://postgres:password@localhost:5433/soroban_devnet',
    readReplicaUrl:
      process.env.DEVNET_READ_REPLICA_URL ||
      process.env.DEVNET_DATABASE_URL ||
      'postgresql://postgres:password@localhost:5433/soroban_devnet',
    apiSubdomain: process.env.DEVNET_API_SUBDOMAIN || 'devnet-api.localhost',
    cacheUrl: process.env.DEVNET_CACHE_URL || 'memory://',
    cacheMode: (process.env.DEVNET_CACHE_MODE || 'standalone') as CacheMode,
  },
};

export const NETWORK_PASSPHRASES: Record<NetworkName, string> = {
  testnet: 'Test SDF Network ; September 2015',
  mainnet: 'Public Global Stellar Network ; September 2015',
  devnet: 'Standalone Network ; February 2017',
};

function parseEndpointList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean);
}

const NETWORK_PASSPHRASES: Record<NetworkName, string> = {
  testnet: 'Test SDF Network ; September 2015',
  mainnet: 'Public Global Stellar Network ; September 2015',
  devnet: 'Standalone Network ; February 2017',
};

// ─── Profile validation ───────────────────────────────────────────────────────

function isHttpUrl(s: string): boolean {
  return s.startsWith('https://') || s.startsWith('http://');
}

function isWsUrl(s: string): boolean {
  return s.startsWith('wss://') || s.startsWith('ws://');
}

function isDbUrl(s: string): boolean {
  return s.startsWith('postgresql://') || s.startsWith('postgres://');
}

/**
 * Validates that a profile's critical URLs are present and well-formed.
 * Throws with an actionable message on the first violation found.
 */
export function validateProfile(profile: NetworkProfile): void {
  const { name, databaseUrl, rpcUrl, rpcWsUrl, horizonUrl, networkPassphrase } = profile;

  // ── Required fields ──────────────────────────────────────────────────────
  if (!databaseUrl) {
    throw new Error(`[${name}] databaseUrl is required. Set ${name.toUpperCase()}_DATABASE_URL.`);
  }
  if (!rpcUrl) {
    throw new Error(`[${name}] rpcUrl is required. Set ${name.toUpperCase()}_RPC_URL.`);
  }
  if (!rpcWsUrl) {
    throw new Error(`[${name}] rpcWsUrl is required. Set ${name.toUpperCase()}_RPC_WS_URL.`);
  }
  if (!horizonUrl) {
    throw new Error(`[${name}] horizonUrl is required. Set ${name.toUpperCase()}_HORIZON_URL.`);
  }
  if (!networkPassphrase) {
    throw new Error(
      `[${name}] networkPassphrase is required. Set ${name.toUpperCase()}_PASSPHRASE.`,
    );
  }
  if (networkPassphrase !== NETWORK_PASSPHRASES[name]) {
    throw new Error(
      `[${name}] networkPassphrase does not match the canonical ${name} network passphrase.`,
    );
  }

  // ── URL protocol validation ───────────────────────────────────────────────
  if (!isDbUrl(databaseUrl)) {
    throw new Error(
      `[${name}] databaseUrl must begin with postgresql:// or postgres://, got: "${databaseUrl.slice(0, 30)}"`,
    );
  }
  if (!isHttpUrl(rpcUrl)) {
    throw new Error(
      `[${name}] rpcUrl must begin with https:// or http://, got: "${rpcUrl.slice(0, 30)}"`,
    );
  }
  if (profile.rpcFallbackUrls.length > 5) {
    throw new Error(`[${name}] At most five RPC fallback URLs may be configured.`);
  }
  for (const fallbackUrl of profile.rpcFallbackUrls) {
    if (!isHttpUrl(fallbackUrl)) {
      throw new Error(`[${name}] RPC fallback URLs must begin with https:// or http://.`);
    }
    if (fallbackUrl === rpcUrl) {
      throw new Error(`[${name}] RPC fallback URLs must not repeat the primary RPC URL.`);
    }
    if (name !== 'devnet' && fallbackUrl.startsWith('http://')) {
      throw new Error(`[${name}] Insecure HTTP RPC fallback URLs are only allowed on devnet.`);
    }
    if (name === 'mainnet' && fallbackUrl.includes('testnet')) {
      throw new Error(`[mainnet] RPC fallback URL appears to point to testnet infrastructure.`);
    }
  }
  if (!isWsUrl(rpcWsUrl)) {
    throw new Error(
      `[${name}] rpcWsUrl must begin with wss:// or ws://, got: "${rpcWsUrl.slice(0, 30)}"`,
    );
  }
  if (horizonUrl && !isHttpUrl(horizonUrl)) {
    throw new Error(
      `[${name}] horizonUrl must begin with https:// or http://, got: "${horizonUrl.slice(0, 30)}"`,
    );
  }

  // ── Network profile consistency ───────────────────────────────────────────
  if (name === 'mainnet') {
    if (rpcUrl.startsWith('http://')) {
      throw new Error(`[mainnet] Insecure HTTP RPC URL is not allowed. Use https://.`);
    }
    if (rpcWsUrl.startsWith('ws://')) {
      throw new Error(`[mainnet] Insecure WS RPC WebSocket URL is not allowed. Use wss://.`);
    }
    if (rpcUrl.includes('testnet') || horizonUrl.includes('testnet')) {
      throw new Error(`[mainnet] rpcUrl or horizonUrl appears to point to testnet infrastructure.`);
    }
  }
}

/** Return the profile for `name`, throwing if unknown or misconfigured. */
export function getProfile(name: string): NetworkProfile {
  const profile = PROFILES[name as NetworkName];
  if (!profile) {
    throw new Error(
      `Unknown STELLAR_NETWORK "${name}". Valid values: ${Object.keys(PROFILES).join(', ')}`,
    );
  }
  validateProfile(profile);
  return profile;
}

/** All registered profiles (useful for multi-network tooling). */
export const allProfiles = PROFILES;
