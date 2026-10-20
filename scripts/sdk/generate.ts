/**
 * SDK generator (DX01, DX02).
 *
 * Source of truth: the OpenAPI document built by src/indexer/swaggerSpec.ts
 * (the same object served at /api/v1/openapi.json). Everything below is a
 * pure function of that document:
 *
 *   packages/client/src/generated/models.ts        TypeScript models
 *   packages/client/src/generated/operations.ts    TypeScript operation map
 *   packages/client/api-surface.json               surface manifest (semver checks)
 *   docs/sdk/parity-matrix.md                      route parity matrix
 *   + any emitters registered in EMITTERS
 *
 * Usage:
 *   npm run sdk:generate            write files
 *   npm run sdk:generate -- --check exit 1 if any file would change (CI drift gate)
 */
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { normalizeOperations, type OpenApiDocument, type NormalizedOperation } from '../../src/lib/openapi/normalize';
import { emitModels, emitOperations } from './emit-typescript';
import { buildSurface } from './surface';
import { emitParityMatrix } from './parity';
import { EXTRA_EMITTERS } from './emitters';
import { pythonEmitter } from './emit-python';
import { javaEmitter } from './emit-java';
import { logger } from './sdk-logger';
import { metrics, METRIC_NAMES } from './sdk-metrics';
import { featureFlags, FLAG_NAMES } from './feature-flags';
import { gracefulDegradation, fallbacks, type ComponentHandler } from './graceful-degradation';
import { computeCacheKey, sdkCache } from './cache';

const ROOT = path.join(__dirname, '..', '..');

export interface GeneratedFile {
  path: string;
  content: string;
}

function generateCoreFiles(doc: OpenApiDocument, ops: NormalizedOperation[], fingerprint: string): GeneratedFile[] {
  const specVersion = doc.info?.version ?? '0.0.0';
  const surface = buildSurface(specVersion, ops);
  const surfaceJson = `${JSON.stringify(surface, null, 2)}\n`;
  
  return [
    { path: 'packages/client/src/generated/models.ts', content: emitModels(doc) },
    {
      path: 'packages/client/src/generated/operations.ts',
      content: emitOperations(doc, ops, fingerprint),
    },
    { path: 'packages/client/api-surface.json', content: surfaceJson },
  ];
}

export interface GenerateOptions {
  useCache?: boolean;
  noCache?: boolean;
}

export function generateAll(doc: OpenApiDocument, options: GenerateOptions = {}): GeneratedFile[] {
  const startTime = Date.now();
  const context = { correlationId: logger.getCorrelationId() };
  
  const cachingEnabled = !options.noCache && (
    options.useCache === true ||
    featureFlags.isEnabled(FLAG_NAMES.CACHE_OPTIMIZATION, context) ||
    process.env.SDK_CACHE_ENABLED === 'true' ||
    process.argv.includes('--cache')
  );

  let cacheData: ReturnType<typeof computeCacheKey> | null = null;
  if (cachingEnabled) {
    cacheData = computeCacheKey(doc, featureFlags.getEnabledFlags());
    const cached = sdkCache.get(cacheData.cacheKey);
    if (cached.hit && cached.files) {
      metrics.incrementCounter(METRIC_NAMES.GENERATION_SUCCESS);
      return cached.files;
    }
  }

  logger.info('Starting SDK generation', { 
    spec_version: doc.info?.version,
    enabled_flags: featureFlags.getEnabledFlags(),
    correlation_id: context.correlationId
  });
  
  // Validate feature flag dependencies
  const validation = featureFlags.validateDependencies();
  if (!validation.valid) {
    logger.error('Feature flag dependency validation failed', { 
      errors: validation.errors 
    });
    throw new Error(`Feature flag dependency errors: ${validation.errors.join(', ')}`);
  }
  
  const ops = normalizeOperations(doc);
  logger.info('Normalized operations', { operation_count: ops.length });
  metrics.recordHistogram(METRIC_NAMES.OPERATIONS_GENERATED, ops.length);
  
  const specVersion = doc.info?.version ?? '0.0.0';
  const surface = buildSurface(specVersion, ops);
  const surfaceJson = `${JSON.stringify(surface, null, 2)}\n`;
  const fingerprint = createHash('sha256').update(surfaceJson).digest('hex').slice(0, 16);
  
  const files: GeneratedFile[] = [];
  
  // TypeScript generation (core feature)
  if (featureFlags.isEnabled(FLAG_NAMES.TYPESCRIPT_GENERATION, context)) {
    logger.debug('Generating TypeScript SDK');
    files.push(...generateCoreFiles(doc, ops, fingerprint));
  } else {
    logger.warn('TypeScript generation disabled by feature flag');
  }
  
  // Python generation (core feature)
  if (featureFlags.isEnabled(FLAG_NAMES.PYTHON_GENERATION, context)) {
    logger.debug('Generating Python SDK');
    try {
      const emitterFiles = pythonEmitter({ doc, ops, fingerprint });
      files.push(...emitterFiles);
      logger.debug('Python emitter completed', { emitter_files: emitterFiles.length });
    } catch (error) {
      logger.error('Python emitter failed', { error: String(error) });
      if (featureFlags.isEnabled(FLAG_NAMES.STRICT_VALIDATION, context)) {
        throw error;
      }
    }
  } else {
    logger.warn('Python generation disabled by feature flag');
  }

  // Java generation
  if (featureFlags.isEnabled(FLAG_NAMES.JAVA_GENERATION, context)) {
    logger.debug('Generating Java SDK');
    try {
      const emitterFiles = javaEmitter({ doc, ops, fingerprint });
      files.push(...emitterFiles);
      logger.debug('Java emitter completed', { emitter_files: emitterFiles.length });
    } catch (error) {
      logger.error('Java emitter failed', { error: String(error) });
      if (featureFlags.isEnabled(FLAG_NAMES.STRICT_VALIDATION, context)) {
        throw error;
      }
    }
  } else {
    logger.warn('Java generation disabled by feature flag');
  }

  // Parity matrix (always generated for documentation)
  files.push({ path: 'docs/sdk/parity-matrix.md', content: emitParityMatrix(ops, files) });

  const duration = (Date.now() - startTime) / 1000;
  logger.info('SDK generation completed', { 
    file_count: files.length, 
    duration_ms: duration * 1000,
    correlation_id: context.correlationId
  });

  metrics.recordHistogram(METRIC_NAMES.GENERATION_DURATION, duration);
  metrics.incrementCounter(METRIC_NAMES.FILES_GENERATED, files.length);
  metrics.incrementCounter(METRIC_NAMES.GENERATION_SUCCESS);

  if (cachingEnabled && cacheData) {
    sdkCache.set(cacheData.metadata, files);
  }

  return files;
}

// Legacy function for backward compatibility - now uses graceful degradation internally
export async function generateAllWithDegradation(doc: OpenApiDocument): Promise<GeneratedFile[]> {
  const context = { correlationId: logger.getCorrelationId() };

  const ops = normalizeOperations(doc);
  const specVersion = doc.info?.version ?? '0.0.0';
  const surface = buildSurface(specVersion, ops);
  const surfaceJson = `${JSON.stringify(surface, null, 2)}\n`;
  const fingerprint = createHash('sha256').update(surfaceJson).digest('hex').slice(0, 16);

  const handlers: ComponentHandler[] = [
    {
      name: 'typescript-core',
      critical: true,
      execute: () => generateCoreFiles(doc, ops, fingerprint),
    },
    {
      name: 'python-sdk',
      critical: false,
      execute: () => pythonEmitter({ doc, ops, fingerprint }),
      fallback: () => [],
    },
    {
      name: 'java-sdk',
      critical: false,
      execute: () => javaEmitter({ doc, ops, fingerprint }),
      fallback: () => [],
    },
    {
      name: 'parity-matrix',
      critical: false,
      execute: () => {
        const coreFiles = generateCoreFiles(doc, ops, fingerprint);
        return [{ path: 'docs/sdk/parity-matrix.md', content: emitParityMatrix(ops, coreFiles) }];
      },
      fallback: fallbacks.parityMatrix,
    },
  ];
  
  const result = await gracefulDegradation.executeWithDegradation(handlers, context);
  
  if (!result.success) {
    throw new Error(`Critical SDK generation components failed: ${result.failedComponents.join(', ')}`);
  }
  
  return result.generatedFiles;
}

async function main(): Promise<void> {
  const startTime = Date.now();
  const check = process.argv.includes('--check');
  const noCache = process.argv.includes('--no-cache');
  const useCache = process.argv.includes('--cache');
  const context = { correlationId: logger.getCorrelationId() };
  
  logger.info('SDK generation started', { 
    mode: check ? 'check' : 'generate',
    correlation_id: context.correlationId,
    no_cache: noCache,
    cache: useCache
  });
  
  try {
    // Imported lazily so unit tests can call generateAll() with fixtures.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { swaggerSpec } = require('../../src/indexer/swaggerSpec') as {
      swaggerSpec: OpenApiDocument;
    };
    
    const files = generateAll(swaggerSpec, { noCache, useCache });
    
    // Handle drift check and file writing
    const drift: string[] = [];
    let filesWritten = 0;
    
    for (const file of files) {
      const abs = path.join(ROOT, file.path);
      const current = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
      if (current === file.content) continue;
      
      if (check) {
        drift.push(file.path);
      } else {
        try {
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, file.content);
          process.stdout.write(`wrote ${file.path}\n`);
          filesWritten++;
          logger.debug('File written', { path: file.path });
        } catch (error) {
          logger.error('Failed to write file', { path: file.path, error: String(error) });
          throw error;
        }
      }
    }
    
    metrics.incrementCounter(METRIC_NAMES.FILES_WRITTEN, filesWritten);
    
    if (check) {
      if (drift.length > 0) {
        metrics.incrementCounter(METRIC_NAMES.DRIFT_DETECTED, drift.length);
        logger.error('SDK drift detected', { 
          drift_count: drift.length,
          drift_files: drift
        });
        process.stderr.write(
          `SDK drift: generated files are out of date with the OpenAPI spec:\n  - ${drift.join('\n  - ')}\nRun \`npm run sdk:generate\` and commit the result.\n`,
        );
        process.exit(1);
      }
      logger.info('SDK drift check passed', { 
        file_count: files.length,
        correlation_id: context.correlationId
      });
      process.stdout.write(`SDK up to date (${files.length} generated files)\n`);
    } else {
      logger.info('SDK generation completed', { 
        file_count: files.length,
        files_written: filesWritten,
        duration_ms: Date.now() - startTime,
        correlation_id: context.correlationId
      });
    }
    
    // Log metrics summary
    if (process.env.DEBUG_METRICS === 'true') {
      logger.info('Metrics summary', { metrics: metrics.getSummary() });
    }
    
  } catch (error) {
    metrics.incrementCounter(METRIC_NAMES.GENERATION_FAILURE);
    logger.error('SDK generation failed', { 
      error: String(error),
      duration_ms: Date.now() - startTime,
      correlation_id: context.correlationId
    });
    throw error;
  }
}

if (require.main === module) main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
