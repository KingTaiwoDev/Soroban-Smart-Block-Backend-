/**
 * Content-addressed caching for SDK generation artifacts (#1292).
 *
 * Cache keys are derived from:
 *   1. OpenAPI specification content hash (canonical SHA-256)
 *   2. Generator and tool versions (generator version, Node version)
 *   3. Source code hashes of generator scripts and language emitters
 *   4. Active feature flags
 *
 * Provides safe fallback with explicit diagnostics on cache corruption or absence.
 */
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import type { OpenApiDocument } from '../../src/lib/openapi/normalize';
import type { GeneratedFile } from './generate';
import { logger } from './sdk-logger';

const ROOT = path.join(__dirname, '..', '..');
export const DEFAULT_CACHE_DIR = path.join(ROOT, '.cache', 'sdk-generator');
export const GENERATOR_VERSION = '1.0.0';

export interface CacheMetadata {
  cacheKey: string;
  createdAt: string;
  generatorVersion: string;
  nodeVersion: string;
  openApiHash: string;
  emitterSourceHash: string;
  flagsHash: string;
}

export interface CachedFileEntry {
  path: string;
  content: string;
  sha256: string;
}

export interface CacheManifest {
  metadata: CacheMetadata;
  files: CachedFileEntry[];
}

export interface CacheLookupResult {
  hit: boolean;
  files?: GeneratedFile[];
  diagnostic: string;
  reason?: 'HIT' | 'CACHE_MISS' | 'CACHE_CORRUPTED' | 'DISABLED';
}

/** Canonical JSON stringifier to guarantee deterministic hashing regardless of key ordering. */
export function canonicalJsonStringify(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return `[${obj.map(canonicalJsonStringify).join(',')}]`;
  }
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  const entries = keys.map((k) => `${JSON.stringify(k)}:${canonicalJsonStringify((obj as Record<string, unknown>)[k])}`);
  return `{${entries.join(',')}}`;
}

/** Hashes a string using SHA-256. */
export function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** Computes combined hash of generator and emitter source files. */
export function computeEmitterSourceHash(rootDir: string = ROOT): string {
  const sourceFiles = [
    'scripts/sdk/generate.ts',
    'scripts/sdk/emit-typescript.ts',
    'scripts/sdk/emit-python.ts',
    'scripts/sdk/emit-java.ts',
    'scripts/sdk/surface.ts',
    'scripts/sdk/parity.ts',
    'scripts/sdk/feature-flags.ts',
  ];

  const hash = createHash('sha256');
  for (const relPath of sourceFiles) {
    const absPath = path.join(rootDir, relPath);
    if (fs.existsSync(absPath)) {
      hash.update(relPath).update(fs.readFileSync(absPath));
    }
  }
  return hash.digest('hex');
}

/** Computes the content-addressed cache key from OpenAPI doc, tool versions, and emitter code. */
export function computeCacheKey(
  doc: OpenApiDocument,
  enabledFlags: string[] = [],
  rootDir: string = ROOT
): { cacheKey: string; metadata: CacheMetadata } {
  const canonicalDoc = canonicalJsonStringify(doc);
  const openApiHash = sha256(canonicalDoc);
  const emitterSourceHash = computeEmitterSourceHash(rootDir);
  const sortedFlags = [...enabledFlags].sort();
  const flagsHash = sha256(sortedFlags.join(','));
  const nodeVersion = process.version;

  const rawKeyMaterial = [
    `openapi:${openApiHash}`,
    `generator:${GENERATOR_VERSION}`,
    `node:${nodeVersion}`,
    `emitters:${emitterSourceHash}`,
    `flags:${flagsHash}`,
  ].join('|');

  const cacheKey = sha256(rawKeyMaterial);

  const metadata: CacheMetadata = {
    cacheKey,
    createdAt: new Date().toISOString(),
    generatorVersion: GENERATOR_VERSION,
    nodeVersion,
    openApiHash,
    emitterSourceHash,
    flagsHash,
  };

  return { cacheKey, metadata };
}

export class SdkGenerationCache {
  private cacheDir: string;

  constructor(cacheDir: string = DEFAULT_CACHE_DIR) {
    this.cacheDir = cacheDir;
  }

  getCacheDir(): string {
    return this.cacheDir;
  }

  private getManifestPath(cacheKey: string): string {
    return path.join(this.cacheDir, `${cacheKey}.json`);
  }

  /**
   * Retrieves cached generation artifacts.
   * On absence or corruption, returns a detailed diagnostic and signals fallback.
   */
  get(cacheKey: string): CacheLookupResult {
    const manifestPath = this.getManifestPath(cacheKey);

    if (!fs.existsSync(manifestPath)) {
      const diagnostic = `Diagnostic: Cache entry absent for key ${cacheKey}; executing clean generation.`;
      logger.info(diagnostic);
      return {
        hit: false,
        reason: 'CACHE_MISS',
        diagnostic,
      };
    }

    let manifestRaw: string;
    try {
      manifestRaw = fs.readFileSync(manifestPath, 'utf8');
    } catch (err) {
      const diagnostic = `Diagnostic: Failed to read cache manifest at ${manifestPath}: ${err}. Falling back to clean run.`;
      logger.warn(diagnostic);
      return {
        hit: false,
        reason: 'CACHE_CORRUPTED',
        diagnostic,
      };
    }

    let manifest: CacheManifest;
    try {
      manifest = JSON.parse(manifestRaw);
      if (!manifest || !manifest.metadata || !Array.isArray(manifest.files)) {
        throw new Error('Manifest is missing required metadata or files array');
      }
    } catch (err) {
      const diagnostic = `Diagnostic: Cache corruption detected at ${manifestPath} (malformed JSON): ${err}. Falling back to clean run.`;
      logger.warn(diagnostic);
      return {
        hit: false,
        reason: 'CACHE_CORRUPTED',
        diagnostic,
      };
    }

    // Verify metadata match
    if (manifest.metadata.cacheKey !== cacheKey) {
      const diagnostic = `Diagnostic: Cache corruption detected: manifest key mismatch (expected ${cacheKey}, found ${manifest.metadata.cacheKey}). Falling back to clean run.`;
      logger.warn(diagnostic);
      return {
        hit: false,
        reason: 'CACHE_CORRUPTED',
        diagnostic,
      };
    }

    // Verify checksum of every single cached file to guarantee byte-identical integrity
    const outputFiles: GeneratedFile[] = [];
    for (const entry of manifest.files) {
      if (typeof entry.path !== 'string' || typeof entry.content !== 'string' || typeof entry.sha256 !== 'string') {
        const diagnostic = `Diagnostic: Cache corruption detected: invalid file entry in manifest. Falling back to clean run.`;
        logger.warn(diagnostic);
        return {
          hit: false,
          reason: 'CACHE_CORRUPTED',
          diagnostic,
        };
      }

      const calculatedHash = sha256(entry.content);
      if (calculatedHash !== entry.sha256) {
        const diagnostic = `Diagnostic: Cache corruption detected for ${entry.path}: checksum mismatch (recorded: ${entry.sha256}, calculated: ${calculatedHash}). Falling back to clean run.`;
        logger.warn(diagnostic);
        return {
          hit: false,
          reason: 'CACHE_CORRUPTED',
          diagnostic,
        };
      }

      outputFiles.push({
        path: entry.path,
        content: entry.content,
      });
    }

    const diagnostic = `Diagnostic: Cache hit for key ${cacheKey}; restored ${outputFiles.length} byte-identical artifacts.`;
    logger.info(diagnostic);
    return {
      hit: true,
      reason: 'HIT',
      files: outputFiles,
      diagnostic,
    };
  }

  /**
   * Stores generated files into the content-addressed cache store.
   */
  set(metadata: CacheMetadata, files: GeneratedFile[]): void {
    try {
      fs.mkdirSync(this.cacheDir, { recursive: true });

      const fileEntries: CachedFileEntry[] = files.map((f) => ({
        path: f.path,
        content: f.content,
        sha256: sha256(f.content),
      }));

      const manifest: CacheManifest = {
        metadata,
        files: fileEntries,
      };

      const manifestPath = this.getManifestPath(metadata.cacheKey);
      const tempPath = `${manifestPath}.tmp.${Date.now()}`;
      fs.writeFileSync(tempPath, JSON.stringify(manifest, null, 2), 'utf8');
      fs.renameSync(tempPath, manifestPath);

      logger.debug('Stored generation artifacts in cache', {
        cacheKey: metadata.cacheKey,
        fileCount: files.length,
      });
    } catch (err) {
      logger.warn(`Failed to write to SDK generation cache: ${err}`);
    }
  }

  /**
   * Cleans the entire local SDK cache directory.
   */
  clear(): { cleared: boolean; directory: string } {
    if (fs.existsSync(this.cacheDir)) {
      fs.rmSync(this.cacheDir, { recursive: true, force: true });
      logger.info(`Cleared SDK generation cache at ${this.cacheDir}`);
      return { cleared: true, directory: this.cacheDir };
    }
    return { cleared: false, directory: this.cacheDir };
  }
}

export const sdkCache = new SdkGenerationCache();

// CLI support for cache cleanup
if (require.main === module) {
  if (process.argv.includes('--clean')) {
    const res = sdkCache.clear();
    console.log(res.cleared ? `Cleaned SDK cache at ${res.directory}` : `Cache directory ${res.directory} was empty.`);
  } else {
    console.log(`SDK Generation Cache directory: ${sdkCache.getCacheDir()}`);
    console.log(`Run with --clean to delete local cache.`);
  }
}
