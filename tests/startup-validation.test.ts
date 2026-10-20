/**
 * tests/startup-validation.test.ts
 *
 * Verifies that getProfile() rejects incomplete or misconfigured profiles
 * before the process starts connecting to external services.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

async function loadProfiles() {
  vi.resetModules();
  return import('../src/profiles');
}

// ── Required URL fields ───────────────────────────────────────────────────────

describe('startup validation — mainnet requires explicit URLs', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('throws when MAINNET_DATABASE_URL is not set', async () => {
    vi.stubEnv('MAINNET_RPC_URL', 'https://mainnet.example.com/rpc');
    vi.stubEnv('MAINNET_RPC_WS_URL', 'wss://mainnet.example.com/rpc');
    const { getProfile } = await loadProfiles();
    expect(() => getProfile('mainnet')).toThrow(/databaseUrl is required/);
  });

  it('throws when MAINNET_RPC_URL is not set', async () => {
    vi.stubEnv('MAINNET_DATABASE_URL', 'postgresql://mainnet-db/soroban');
    vi.stubEnv('MAINNET_RPC_WS_URL', 'wss://mainnet.example.com/rpc');
    const { getProfile } = await loadProfiles();
    expect(() => getProfile('mainnet')).toThrow(/rpcUrl is required/);
  });

  it('throws when MAINNET_RPC_WS_URL is not set', async () => {
    vi.stubEnv('MAINNET_DATABASE_URL', 'postgresql://mainnet-db/soroban');
    vi.stubEnv('MAINNET_RPC_URL', 'https://mainnet.example.com/rpc');
    const { getProfile } = await loadProfiles();
    expect(() => getProfile('mainnet')).toThrow(/rpcWsUrl is required/);
  });

  it('accepts mainnet when all required URLs are provided', async () => {
    vi.stubEnv('MAINNET_DATABASE_URL', 'postgresql://mainnet-db/soroban');
    vi.stubEnv('MAINNET_RPC_URL', 'https://mainnet.example.com/rpc');
    vi.stubEnv('MAINNET_RPC_WS_URL', 'wss://mainnet.example.com/rpc');
    const { getProfile } = await loadProfiles();
    expect(() => getProfile('mainnet')).not.toThrow();
  });
});

describe('startup validation — testnet requires a database URL', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('throws when neither TESTNET_DATABASE_URL nor DATABASE_URL is set', async () => {
    vi.stubEnv('TESTNET_DATABASE_URL', '');
    vi.stubEnv('DATABASE_URL', '');
    const { getProfile } = await loadProfiles();
    expect(() => getProfile('testnet')).toThrow(/databaseUrl is required/);
  });

  it('accepts testnet when DATABASE_URL fallback is provided', async () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://localhost/testdb');
    const { getProfile } = await loadProfiles();
    expect(() => getProfile('testnet')).not.toThrow();
  });
});

// ── URL protocol validation ───────────────────────────────────────────────────

describe('startup validation — URL protocol checks', () => {
  afterEach(() => vi.unstubAllEnvs());

  const base = () => {
    vi.stubEnv('MAINNET_DATABASE_URL', 'postgresql://mainnet-db/soroban');
    vi.stubEnv('MAINNET_RPC_URL', 'https://mainnet.example.com/rpc');
    vi.stubEnv('MAINNET_RPC_WS_URL', 'wss://mainnet.example.com/rpc');
  };

  it('throws when databaseUrl uses a non-postgres protocol', async () => {
    vi.stubEnv('MAINNET_DATABASE_URL', 'mysql://wrong-db/soroban');
    vi.stubEnv('MAINNET_RPC_URL', 'https://mainnet.example.com/rpc');
    vi.stubEnv('MAINNET_RPC_WS_URL', 'wss://mainnet.example.com/rpc');
    const { getProfile } = await loadProfiles();
    expect(() => getProfile('mainnet')).toThrow(/postgresql/);
  });

  it('throws when rpcUrl uses a non-http protocol', async () => {
    base();
    vi.stubEnv('MAINNET_RPC_URL', 'ftp://mainnet.example.com/rpc');
    const { getProfile } = await loadProfiles();
    expect(() => getProfile('mainnet')).toThrow(/https?/);
  });

  it('throws when rpcWsUrl uses an http protocol instead of ws', async () => {
    base();
    vi.stubEnv('MAINNET_RPC_WS_URL', 'https://mainnet.example.com/rpc');
    const { getProfile } = await loadProfiles();
    expect(() => getProfile('mainnet')).toThrow(/wss?/);
  });

  it('accepts both postgresql:// and postgres:// for databaseUrl', async () => {
    vi.stubEnv('MAINNET_DATABASE_URL', 'postgres://mainnet-db/soroban');
    vi.stubEnv('MAINNET_RPC_URL', 'https://mainnet.example.com/rpc');
    vi.stubEnv('MAINNET_RPC_WS_URL', 'wss://mainnet.example.com/rpc');
    const { getProfile } = await loadProfiles();
    expect(() => getProfile('mainnet')).not.toThrow();
  });

  it('accepts both https:// and http:// for rpcUrl (devnet uses http)', async () => {
    const { getProfile } = await loadProfiles();
    expect(() => getProfile('devnet')).not.toThrow();
    const p = getProfile('devnet');
    expect(p.rpcUrl).toMatch(/^http:\/\//);
  });
});

// ── Network profile consistency ───────────────────────────────────────────────

describe('startup validation — network profile consistency', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('throws when mainnet rpcUrl contains "testnet"', async () => {
    vi.stubEnv('MAINNET_DATABASE_URL', 'postgresql://mainnet-db/soroban');
    vi.stubEnv('MAINNET_RPC_URL', 'https://soroban-testnet.stellar.org');
    vi.stubEnv('MAINNET_RPC_WS_URL', 'wss://mainnet.example.com/rpc');
    const { getProfile } = await loadProfiles();
    expect(() => getProfile('mainnet')).toThrow(/testnet/);
  });

  it('throws when mainnet horizonUrl contains "testnet"', async () => {
    vi.stubEnv('MAINNET_DATABASE_URL', 'postgresql://mainnet-db/soroban');
    vi.stubEnv('MAINNET_RPC_URL', 'https://mainnet.example.com/rpc');
    vi.stubEnv('MAINNET_RPC_WS_URL', 'wss://mainnet.example.com/rpc');
    vi.stubEnv('MAINNET_HORIZON_URL', 'https://horizon-testnet.stellar.org');
    const { getProfile } = await loadProfiles();
    expect(() => getProfile('mainnet')).toThrow(/testnet/);
  });

  it('accepts mainnet with correct production URLs', async () => {
    vi.stubEnv('MAINNET_DATABASE_URL', 'postgresql://mainnet-db/soroban');
    vi.stubEnv('MAINNET_RPC_URL', 'https://mainnet.example.com/rpc');
    vi.stubEnv('MAINNET_RPC_WS_URL', 'wss://mainnet.example.com/rpc');
    const { getProfile } = await loadProfiles();
    const p = getProfile('mainnet');
    expect(p.name).toBe('mainnet');
  });

  it('rejects a testnet passphrase configured for mainnet', async () => {
    vi.stubEnv('MAINNET_DATABASE_URL', 'postgresql://mainnet-db/soroban');
    vi.stubEnv('MAINNET_RPC_URL', 'https://mainnet.example.com/rpc');
    vi.stubEnv('MAINNET_RPC_WS_URL', 'wss://mainnet.example.com/rpc');
    vi.stubEnv('MAINNET_PASSPHRASE', 'Test SDF Network ; September 2015');
    const { getProfile } = await loadProfiles();
    expect(() => getProfile('mainnet')).toThrow(/canonical mainnet network passphrase/);
  });

  it('rejects a non-canonical passphrase on each supported network', async () => {
    vi.stubEnv('TESTNET_DATABASE_URL', 'postgresql://testnet-db/soroban');
    vi.stubEnv('MAINNET_DATABASE_URL', 'postgresql://mainnet-db/soroban');
    vi.stubEnv('MAINNET_RPC_URL', 'https://mainnet.example.com/rpc');
    vi.stubEnv('MAINNET_RPC_WS_URL', 'wss://mainnet.example.com/rpc');
    const { allProfiles, validateProfile } = await loadProfiles();
    for (const profile of Object.values(allProfiles)) {
      expect(() =>
        validateProfile({ ...profile, networkPassphrase: 'wrong network passphrase' }),
      ).toThrow(new RegExp(`canonical ${profile.name} network passphrase`));
    }
  });
});

// ── validateProfile exported directly ────────────────────────────────────────

describe('startup validation — validateProfile helper', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('is exported and callable directly', async () => {
    const { validateProfile } = await loadProfiles();
    vi.stubEnv('MAINNET_DATABASE_URL', 'postgresql://mainnet-db/soroban');
    vi.stubEnv('MAINNET_RPC_URL', 'https://mainnet.example.com/rpc');
    vi.stubEnv('MAINNET_RPC_WS_URL', 'wss://mainnet.example.com/rpc');
    const { getProfile: gp } = await (async () => {
      vi.resetModules();
      return import('../src/profiles');
    })();
    const profile = gp('mainnet');
    expect(() => validateProfile(profile)).not.toThrow();
  });

  it('throws immediately on an empty databaseUrl', async () => {
    const { validateProfile } = await loadProfiles();
    const bad = {
      name: 'mainnet' as const,
      databaseUrl: '',
      rpcUrl: 'https://ok.example.com',
      rpcFallbackUrls: [],
      rpcWsUrl: 'wss://ok.example.com',
      horizonUrl: 'https://horizon.stellar.org',
      readReplicaUrl: '',
      apiSubdomain: 'api.localhost',
      cacheUrl: 'memory://',
      networkPassphrase: 'Public Global Stellar Network ; September 2015',
    };
    expect(() => validateProfile(bad)).toThrow(/databaseUrl is required/);
  });

  it('rejects plain HTTP rpcUrl on mainnet', async () => {
    const { validateProfile } = await loadProfiles();
    const bad = {
      name: 'mainnet' as const,
      databaseUrl: 'postgresql://prod-db.example.com:5432/soroban',
      rpcUrl: 'http://mainnet.example.com/rpc',
      rpcFallbackUrls: [],
      rpcWsUrl: 'wss://mainnet.example.com/rpc',
      horizonUrl: 'https://horizon.stellar.org',
      readReplicaUrl: '',
      apiSubdomain: 'api.localhost',
      cacheUrl: 'redis://cache.example.com:6379',
      networkPassphrase: 'Public Global Stellar Network ; September 2015',
    };
    expect(() => validateProfile(bad)).toThrow(/Insecure HTTP RPC URL is not allowed/);
  });

  it('rejects plain WS rpcWsUrl on mainnet', async () => {
    const { validateProfile } = await loadProfiles();
    const bad = {
      name: 'mainnet' as const,
      databaseUrl: 'postgresql://prod-db.example.com:5432/soroban',
      rpcUrl: 'https://mainnet.example.com/rpc',
      rpcFallbackUrls: [],
      rpcWsUrl: 'ws://mainnet.example.com/rpc',
      horizonUrl: 'https://horizon.stellar.org',
      readReplicaUrl: '',
      apiSubdomain: 'api.localhost',
      cacheUrl: 'redis://cache.example.com:6379',
      networkPassphrase: 'Public Global Stellar Network ; September 2015',
    };
    expect(() => validateProfile(bad)).toThrow(/Insecure WS RPC WebSocket URL is not allowed/);
  });
});

// ── Production configuration against unsafe defaults ──────────────────────────

describe('startup validation — validateProductionConfig', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('TESTNET_DATABASE_URL', 'postgresql://testnet-db/soroban');
  });
  afterEach(() => vi.unstubAllEnvs());

  const validProfile = {
    name: 'mainnet',
    databaseUrl: 'postgresql://soroban:SuperSecretProdPass123!@db.prod.internal:5432/soroban_prod',
    rpcUrl: 'https://soroban-rpc.stellar.org',
    rpcFallbackUrls: [],
    rpcWsUrl: 'wss://soroban-rpc.stellar.org',
    horizonUrl: 'https://horizon.stellar.org',
    readReplicaUrl:
      'postgresql://soroban:SuperSecretProdPass123!@db-replica.prod.internal:5432/soroban_prod',
    apiSubdomain: 'api.stellar.org',
    cacheUrl: 'redis://:CacheToken1234567890@redis.prod.internal:6379',
    cacheMode: 'standalone' as const,
    networkPassphrase: 'Public Global Stellar Network ; September 2015',
  };

  const validEnv = {
    NODE_ENV: 'production',
    ADMIN_API_KEY: 'admin_live_key_abcdef1234567890',
    JWT_SECRET: 'super_secure_jwt_secret_key_at_least_32_chars_long_12345',
    WS_SECRET: 'super_secure_ws_secret_key_at_least_32_chars_long_12345',
    WEBHOOK_SECRET: 'super_secure_webhook_secret_key_at_least_32_chars_long',
    COOKIE_SECRET: 'super_secure_cookie_secret_key_at_least_32_chars_long_!',
    COOKIE_SECURE: true,
    FORECAST_MODE: 'production',
    METRICS_TOKEN: 'prom_scrape_bearer_token_xyz_123456',
    METRICS_ALLOWED_IPS: '10.0.0.0/8',
  };

  it('accepts fully compliant production configuration', async () => {
    const { validateProductionConfig } = await import('../src/config');
    const result = validateProductionConfig(validEnv, validProfile);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects missing COOKIE_SECRET in production', async () => {
    const { validateProductionConfig } = await import('../src/config');
    const result = validateProductionConfig({ ...validEnv, COOKIE_SECRET: '' }, validProfile);
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.includes('Missing required production variable: COOKIE_SECRET')),
    ).toBe(true);
  });

  it('rejects unsafe placeholder secrets', async () => {
    const { validateProductionConfig } = await import('../src/config');
    for (const placeholder of ['changeme', 'secret', 'password', '123456', 'default']) {
      const result = validateProductionConfig(
        { ...validEnv, JWT_SECRET: placeholder },
        validProfile,
      );
      expect(result.valid).toBe(false);
      expect(
        result.errors.some((e) =>
          e.includes('Unsafe default or placeholder secret detected for JWT_SECRET'),
        ),
      ).toBe(true);
    }
  });

  it('rejects secrets below minimum length threshold', async () => {
    const { validateProductionConfig } = await import('../src/config');
    const result = validateProductionConfig(
      { ...validEnv, JWT_SECRET: 'short_secret' },
      validProfile,
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('Secret JWT_SECRET is too short'))).toBe(true);
  });

  it('rejects COOKIE_SECURE=false in production', async () => {
    const { validateProductionConfig } = await import('../src/config');
    const result = validateProductionConfig({ ...validEnv, COOKIE_SECURE: false }, validProfile);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('COOKIE_SECURE must be true'))).toBe(true);
  });

  it('rejects FORECAST_MODE="demo" in production', async () => {
    const { validateProductionConfig } = await import('../src/config');
    const result = validateProductionConfig({ ...validEnv, FORECAST_MODE: 'demo' }, validProfile);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("FORECAST_MODE cannot be 'demo'"))).toBe(true);
  });

  it('rejects unprotected metrics endpoint in production', async () => {
    const { validateProductionConfig } = await import('../src/config');
    const result = validateProductionConfig(
      { ...validEnv, METRICS_ALLOWED_IPS: '', METRICS_TOKEN: '' },
      validProfile,
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('metrics endpoint must be protected'))).toBe(true);
  });

  it('rejects in-memory cache ("memory://") in production', async () => {
    const { validateProductionConfig } = await import('../src/config');
    const result = validateProductionConfig(validEnv, { ...validProfile, cacheUrl: 'memory://' });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("in-memory cache ('memory://') is unsafe"))).toBe(
      true,
    );
  });

  it('rejects localhost database URL for mainnet production', async () => {
    const { validateProductionConfig } = await import('../src/config');
    const result = validateProductionConfig(validEnv, {
      ...validProfile,
      databaseUrl: 'postgresql://postgres:pass@localhost:5432/db',
    });
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.includes('Localhost or loopback database URL is not allowed')),
    ).toBe(true);
  });

  it('rejects default development credentials in mainnet database URL', async () => {
    const { validateProductionConfig } = await import('../src/config');
    const result = validateProductionConfig(validEnv, {
      ...validProfile,
      databaseUrl: 'postgresql://postgres:password@prod-db.internal:5432/db',
    });
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) =>
        e.includes('Default development database credentials are not allowed'),
      ),
    ).toBe(true);
  });
});
