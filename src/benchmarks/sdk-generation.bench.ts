/**
 * Performance benchmarks for SDK generation pipeline.
 * Measures generation latency, memory usage, and throughput under various conditions.
 */

import { describe, bench, beforeAll } from 'vitest';
import { generateAll, generateAllParallel } from '../../scripts/sdk/generate';
import { gracefulDegradation } from '../../scripts/sdk/graceful-degradation';
import { metrics } from '../../scripts/sdk/sdk-metrics';
import { featureFlags } from '../../scripts/sdk/feature-flags';
import { swaggerSpec } from '../indexer/swaggerSpec';

// Mock OpenAPI document for benchmarking
const mockOpenAPIDoc = {
  openapi: '3.0.0',
  info: {
    title: 'Test API',
    version: '1.0.0',
  },
  paths: {
    '/test': {
      get: {
        operationId: 'getTest',
        responses: {
          '200': {
            description: 'Success',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    name: { type: 'string' },
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
      TestModel: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
        },
      },
    },
  },
};

describe('SDK Generation Performance Benchmarks', () => {
  beforeAll(() => {
    // Reset state before benchmarks
    metrics.reset();
    gracefulDegradation.resetCircuitBreaker();
  });

  describe('Generation Latency', () => {
    bench('generateAll with minimal spec', () => {
      generateAll(mockOpenAPIDoc);
    });

    bench('generateAll with circuit breaker disabled', () => {
      gracefulDegradation.configure({ circuitBreakerThreshold: 1000 });
      generateAll(mockOpenAPIDoc);
    });

    bench('generateAll with feature flags enabled', () => {
      // Ensure all core features are enabled
      featureFlags.registerFlag('typescript-generation', { enabled: true, description: 'Test' });
      featureFlags.registerFlag('python-generation', { enabled: true, description: 'Test' });
      generateAll(mockOpenAPIDoc);
    });

    bench('generateAllParallel with minimal spec', async () => {
      await generateAllParallel(mockOpenAPIDoc, { maxWorkers: 2 });
    });
  });

  describe('Parallel vs Serial Generation (Current Specification)', () => {
    bench('serial generation (current OpenAPI spec)', () => {
      generateAll(swaggerSpec);
    });

    bench('parallel generation (current OpenAPI spec, 4 workers)', async () => {
      await generateAllParallel(swaggerSpec, { maxWorkers: 4 });
    });

    bench('parallel generation (current OpenAPI spec, 2 workers)', async () => {
      await generateAllParallel(swaggerSpec, { maxWorkers: 2 });
    });
  });

  describe('Metrics Overhead', () => {
    bench('counter increment', () => {
      metrics.incrementCounter('test_counter');
    });

    bench('histogram recording', () => {
      metrics.recordHistogram('test_histogram', Math.random() * 10);
    });

    bench('metrics summary generation', () => {
      // Pre-populate some metrics
      for (let i = 0; i < 100; i++) {
        metrics.incrementCounter('test_counter');
        metrics.recordHistogram('test_histogram', Math.random() * 10);
      }
      metrics.getSummary();
    });
  });

  describe('Feature Flag Performance', () => {
    bench('feature flag check (enabled)', () => {
      featureFlags.isEnabled('typescript-generation');
    });

    bench('feature flag check (disabled)', () => {
      featureFlags.isEnabled('experimental-generators');
    });

    bench('feature flag validation', () => {
      featureFlags.validateDependencies();
    });

    bench('get all enabled flags', () => {
      featureFlags.getEnabledFlags();
    });
  });

  describe('Graceful Degradation Performance', () => {
    bench('circuit breaker status check', () => {
      gracefulDegradation.getCircuitBreakerStatus();
    });

    bench('circuit breaker reset', () => {
      gracefulDegradation.resetCircuitBreaker();
    });

    bench('circuit breaker configuration', () => {
      gracefulDegradation.configure({
        maxRetries: 3,
        retryDelay: 1000,
        circuitBreakerThreshold: 5,
        circuitBreakerTimeout: 60000,
      });
    });
  });

  describe('Memory Usage Patterns', () => {
    bench('large spec generation (100 operations)', () => {
      const largeSpec = createLargeSpec(100);
      generateAll(largeSpec);
    });

    bench('large spec generation (500 operations)', () => {
      const largeSpec = createLargeSpec(500);
      generateAll(largeSpec);
    });

    bench('large spec generation (1000 operations)', () => {
      const largeSpec = createLargeSpec(1000);
      generateAll(largeSpec);
    });
  });

  describe('Throughput Benchmarks', () => {
    bench('sequential generation (10 specs)', () => {
      for (let i = 0; i < 10; i++) {
        generateAll(mockOpenAPIDoc);
      }
    });

    bench('sequential generation (50 specs)', () => {
      for (let i = 0; i < 50; i++) {
        generateAll(mockOpenAPIDoc);
      }
    });
  });
});

// Helper function to create large OpenAPI specs for stress testing
function createLargeSpec(operationCount: number): any {
  const paths: any = {};
  const schemas: any = {};

  for (let i = 0; i < operationCount; i++) {
    const pathName = `/resource${i}`;
    paths[pathName] = {
      get: {
        operationId: `getResource${i}`,
        summary: `Get resource ${i}`,
        tags: ['resources'],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': {
            description: 'Success',
            content: {
              'application/json': {
                schema: {
                  $ref: `#/components/schemas/Resource${i}`,
                },
              },
            },
          },
        },
      },
    };

    schemas[`Resource${i}`] = {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        metadata: {
          type: 'object',
          properties: {
            created: { type: 'string', format: 'date-time' },
            updated: { type: 'string', format: 'date-time' },
          },
        },
      },
    };
  }

  return {
    openapi: '3.0.0',
    info: {
      title: 'Large Test API',
      version: '1.0.0',
    },
    paths,
    components: {
      schemas,
    },
  };
}
