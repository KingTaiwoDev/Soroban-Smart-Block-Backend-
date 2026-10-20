import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  computeCacheKey,
  SdkGenerationCache,
  sha256,
  GENERATOR_VERSION,
  type CacheMetadata,
} from '../scripts/sdk/cache';
import { generateAll } from '../scripts/sdk/generate';
import type { OpenApiDocument } from '../src/lib/openapi/normalize';

const TEST_CACHE_DIR = path.join(__dirname, '..', '.cache', 'test-sdk-cache');

const testDoc: OpenApiDocument = {
  openapi: '3.0.0',
  info: {
    title: 'Test Cache API',
    version: '1.2.3',
  },
  paths: {
    '/ping': {
      get: {
        operationId: 'getPing',
        summary: 'Ping healthcheck',
        responses: {
          '200': {
            description: 'Pong',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    status: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      PingResponse: {
        type: 'object',
        properties: {
          status: { type: 'string' },
        },
      },
    },
  },
};

describe('SDK Generation Content-Addressed Caching (#1292)', () => {
  let cache: SdkGenerationCache;

  beforeEach(() => {
    cache = new SdkGenerationCache(TEST_CACHE_DIR);
    cache.clear();
  });

  afterEach(() => {
    cache.clear();
  });

  it('computes cache keys that include OpenAPI content and generator/tool versions', () => {
    const { cacheKey, metadata } = computeCacheKey(testDoc, ['typescript-generation', 'python-generation']);

    expect(cacheKey).toBeDefined();
    expect(cacheKey).toHaveLength(64); // SHA-256 hex string
    expect(metadata.generatorVersion).toBe(GENERATOR_VERSION);
    expect(metadata.nodeVersion).toBe(process.version);
    expect(metadata.openApiHash).toBeDefined();
    expect(metadata.emitterSourceHash).toBeDefined();
    expect(metadata.flagsHash).toBeDefined();

    // Modifying OpenAPI content changes the cache key
    const modifiedDoc: OpenApiDocument = {
      ...testDoc,
      info: { ...testDoc.info, version: '1.2.4' },
    };
    const { cacheKey: modifiedKey } = computeCacheKey(modifiedDoc, ['typescript-generation', 'python-generation']);
    expect(modifiedKey).not.toBe(cacheKey);

    // Changing feature flags changes the cache key
    const { cacheKey: flagKey } = computeCacheKey(testDoc, ['typescript-generation']);
    expect(flagKey).not.toBe(cacheKey);
  });

  it('produces byte-identical output on cache hit compared to clean generation', () => {
    // 1. Clean generation
    const cleanFiles = generateAll(testDoc, { noCache: true });
    expect(cleanFiles.length).toBeGreaterThan(0);

    // 2. Store in cache
    const { metadata } = computeCacheKey(testDoc, []);
    cache.set(metadata, cleanFiles);

    // 3. Retrieve from cache
    const lookup = cache.get(metadata.cacheKey);
    expect(lookup.hit).toBe(true);
    expect(lookup.reason).toBe('HIT');
    expect(lookup.files).toBeDefined();
    expect(lookup.files!.length).toBe(cleanFiles.length);

    // Verify byte-identical content for each file
    for (let i = 0; i < cleanFiles.length; i++) {
      expect(lookup.files![i].path).toBe(cleanFiles[i].path);
      expect(lookup.files![i].content).toBe(cleanFiles[i].content);
      expect(sha256(lookup.files![i].content)).toBe(sha256(cleanFiles[i].content));
    }
  });

  it('falls back to clean generation with an explicit diagnostic on cache absence', () => {
    const lookup = cache.get('non-existent-cache-key-12345');
    expect(lookup.hit).toBe(false);
    expect(lookup.reason).toBe('CACHE_MISS');
    expect(lookup.diagnostic).toContain('Diagnostic: Cache entry absent for key');
    expect(lookup.files).toBeUndefined();
  });

  it('falls back to clean generation with an explicit diagnostic on cache corruption (checksum mismatch)', () => {
    const cleanFiles = generateAll(testDoc, { noCache: true });
    const { metadata } = computeCacheKey(testDoc, []);
    cache.set(metadata, cleanFiles);

    // Corrupt the cache file on disk
    const manifestPath = path.join(TEST_CACHE_DIR, `${metadata.cacheKey}.json`);
    expect(fs.existsSync(manifestPath)).toBe(true);

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    // Tamper with the content of the first file while leaving sha256 unchanged
    manifest.files[0].content += '\n// TAMPERED';
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    // Retrieve from corrupted cache
    const lookup = cache.get(metadata.cacheKey);
    expect(lookup.hit).toBe(false);
    expect(lookup.reason).toBe('CACHE_CORRUPTED');
    expect(lookup.diagnostic).toContain('Diagnostic: Cache corruption detected');
    expect(lookup.diagnostic).toContain('checksum mismatch');
    expect(lookup.diagnostic).toContain('Falling back to clean run');
  });

  it('falls back to clean generation with an explicit diagnostic on malformed JSON manifest', () => {
    const { metadata } = computeCacheKey(testDoc, []);
    fs.mkdirSync(TEST_CACHE_DIR, { recursive: true });
    const manifestPath = path.join(TEST_CACHE_DIR, `${metadata.cacheKey}.json`);
    fs.writeFileSync(manifestPath, '{ malformed json truncated...', 'utf8');

    const lookup = cache.get(metadata.cacheKey);
    expect(lookup.hit).toBe(false);
    expect(lookup.reason).toBe('CACHE_CORRUPTED');
    expect(lookup.diagnostic).toContain('Diagnostic: Cache corruption detected');
    expect(lookup.diagnostic).toContain('malformed JSON');
    expect(lookup.diagnostic).toContain('Falling back to clean run');
  });

  it('supports local cleanup and invalidation', () => {
    const cleanFiles = generateAll(testDoc, { noCache: true });
    const { metadata } = computeCacheKey(testDoc, []);
    cache.set(metadata, cleanFiles);

    expect(fs.existsSync(TEST_CACHE_DIR)).toBe(true);
    const clearResult = cache.clear();
    expect(clearResult.cleared).toBe(true);
    expect(fs.existsSync(TEST_CACHE_DIR)).toBe(false);

    // After clear, lookup is a cache miss
    const lookup = cache.get(metadata.cacheKey);
    expect(lookup.hit).toBe(false);
    expect(lookup.reason).toBe('CACHE_MISS');
  });
});
