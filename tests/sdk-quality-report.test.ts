import { describe, it, expect } from 'vitest';
import {
  analyzeOpenApiQuality,
  compareWithBaseline,
  escapePointerSegment,
  findingFingerprint,
  type QualityFinding,
  type QualityBaseline,
} from '../scripts/sdk/quality-report';
import { type OpenApiDocument } from '../src/lib/openapi/normalize';

describe('OpenAPI Quality Report (Issue #1294)', () => {
  it('correctly escapes JSON pointer segments per RFC 6901', () => {
    expect(escapePointerSegment('contracts/audit~v1')).toBe('contracts~1audit~0v1');
    expect(escapePointerSegment('/api/v1/feed')).toBe('~1api~1v1~1feed');
  });

  it('evaluates a clean spec with score 100 and no findings', () => {
    const cleanSpec: OpenApiDocument = {
      openapi: '3.0.3',
      info: { title: 'Clean API', version: '1.0.0' },
      paths: {
        '/health': {
          get: {
            operationId: 'getHealth',
            summary: 'Health check',
            responses: {
              '200': {
                description: 'OK',
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: { status: { type: 'string' } },
                    },
                  },
                },
              },
              '500': {
                description: 'Internal server error',
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: { message: { type: 'string' } },
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
          StatusResponse: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
            },
          },
        },
      },
    };

    const report = analyzeOpenApiQuality(cleanSpec);
    expect(report.score).toBe(100);
    expect(report.operationCount).toBe(1);
    expect(report.summary.critical).toBe(0);
    expect(report.summary.warning).toBe(0);
    expect(report.findings).toHaveLength(0);
  });

  it('detects missing operationId on operations as critical', () => {
    const spec: OpenApiDocument = {
      openapi: '3.0.3',
      info: { title: 'Test API', version: '1.0.0' },
      paths: {
        '/users': {
          get: {
            responses: {
              '200': { description: 'OK' },
              '400': { description: 'Bad request' },
            },
          },
        },
      },
    };

    const report = analyzeOpenApiQuality(spec);
    expect(report.summary.critical).toBe(1);
    const opFinding = report.findings.find((f) => f.category === 'missing_operation_id');
    expect(opFinding).toBeDefined();
    expect(opFinding?.severity).toBe('critical');
    expect(opFinding?.pointer).toBe('/paths/~1users/get/operationId');
    expect(opFinding?.remediation).toContain('operationId');
  });

  it('detects undocumented error responses as warnings', () => {
    const spec: OpenApiDocument = {
      openapi: '3.0.3',
      info: { title: 'Test API', version: '1.0.0' },
      paths: {
        '/records': {
          post: {
            operationId: 'createRecord',
            responses: {
              '201': { description: 'Created' },
            },
          },
        },
      },
    };

    const report = analyzeOpenApiQuality(spec);
    const errFinding = report.findings.find((f) => f.category === 'undocumented_error');
    expect(errFinding).toBeDefined();
    expect(errFinding?.severity).toBe('warning');
    expect(errFinding?.pointer).toBe('/paths/~1records/post/responses');
  });

  it('detects dangling $ref and array schemas without items', () => {
    const spec: OpenApiDocument = {
      openapi: '3.0.3',
      info: { title: 'Schema Test', version: '1.0.0' },
      paths: {},
      components: {
        schemas: {
          BrokenList: {
            type: 'array',
          },
          DanglingRef: {
            type: 'object',
            properties: {
              missing: {
                $ref: '#/components/schemas/NonExistentSchema',
              },
            },
          },
        },
      },
    };

    const report = analyzeOpenApiQuality(spec);
    const dangling = report.findings.find((f) => f.category === 'incomplete_schema' && f.pointer.includes('$ref'));
    const noItems = report.findings.find((f) => f.category === 'incomplete_schema' && f.pointer.includes('items'));

    expect(dangling).toBeDefined();
    expect(dangling?.severity).toBe('critical');
    expect(dangling?.message).toContain('NonExistentSchema');

    expect(noItems).toBeDefined();
    expect(noItems?.severity).toBe('critical');
  });

  it('detects ambiguous pagination parameters and schemas', () => {
    const spec: OpenApiDocument = {
      openapi: '3.0.3',
      info: { title: 'Pagination Test', version: '1.0.0' },
      paths: {
        '/items': {
          get: {
            operationId: 'getItems',
            parameters: [
              {
                name: 'limit',
                in: 'query',
                schema: { type: 'string' }, // invalid non-integer
              },
            ],
            responses: {
              '200': {
                description: 'OK',
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: {
                        data: { type: 'array', items: { type: 'string' } },
                      },
                    },
                  },
                },
              },
              '400': { description: 'Bad request' },
            },
          },
        },
      },
    };

    const report = analyzeOpenApiQuality(spec);
    const limitTypeFinding = report.findings.find(
      (f) => f.category === 'ambiguous_pagination' && f.id.includes('PAG_LIMIT_TYPE'),
    );
    const missingCursorFinding = report.findings.find(
      (f) => f.category === 'ambiguous_pagination' && f.id.includes('PAG_MISSING_CURSOR'),
    );

    expect(limitTypeFinding).toBeDefined();
    expect(limitTypeFinding?.pointer).toBe('/paths/~1items/get/parameters/0/schema/type');
    expect(missingCursorFinding).toBeDefined();
    expect(missingCursorFinding?.pointer).toBe('/paths/~1items/get/responses/200/content/application~1json/schema');
  });

  it('handles baseline comparisons and blocks new critical findings', () => {
    const finding1: QualityFinding = {
      id: 'F1',
      category: 'missing_operation_id',
      severity: 'critical',
      pointer: '/paths/~1foo/get/operationId',
      message: 'Missing op id',
      remediation: 'Add op id',
    };
    const finding2: QualityFinding = {
      id: 'F2',
      category: 'undocumented_error',
      severity: 'warning',
      pointer: '/paths/~1foo/get/responses',
      message: 'No 4xx/5xx',
      remediation: 'Add 400',
    };
    const newFinding: QualityFinding = {
      id: 'F3',
      category: 'incomplete_schema',
      severity: 'critical',
      pointer: '/components/schemas/Bad/$ref',
      message: 'Dangling ref',
      remediation: 'Fix ref',
    };

    const baseline: QualityBaseline = {
      version: '1.0.0',
      updatedAt: '2026-10-19T00:00:00.000Z',
      knownFingerprints: [findingFingerprint(finding1), findingFingerprint(finding2)],
    };

    // Case A: Report has only known findings -> passes
    const cleanReport = {
      timestamp: '2026-10-19T00:00:00.000Z',
      specVersion: '1.0.0',
      operationCount: 1,
      score: 80,
      summary: { critical: 1, warning: 1, info: 0 },
      findings: [finding1, finding2],
    };
    const resA = compareWithBaseline(cleanReport, baseline);
    expect(resA.passes).toBe(true);
    expect(resA.newCriticalFindings).toHaveLength(0);

    // Case B: Report has new critical finding -> fails
    const degradedReport = {
      ...cleanReport,
      findings: [finding1, finding2, newFinding],
    };
    const resB = compareWithBaseline(degradedReport, baseline);
    expect(resB.passes).toBe(false);
    expect(resB.newCriticalFindings).toHaveLength(1);
    expect(resB.newCriticalFindings[0].id).toBe('F3');
  });
});
