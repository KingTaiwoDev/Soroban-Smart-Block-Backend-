import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

vi.mock('../src/metrics', () => ({
  apiSloRequestDuration: { observe: vi.fn() },
  apiSloRequestsTotal: { inc: vi.fn() },
  httpRequestDuration: { observe: vi.fn() },
  httpRequestTotal: { inc: vi.fn() },
}));

import {
  MAX_METRIC_LABEL_LENGTH,
  normaliseRouteLabel,
  redactIdentifiers,
  sanitizeMetricLabelValue,
} from '../src/lib/metric-labels';
import { metricsMiddleware } from '../src/middleware/metricsMiddleware';
import { httpRequestTotal } from '../src/metrics';

const ACCOUNT = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
const CONTRACT = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const MUXED = 'MAAAAAAAAAAAAAB7BQ2L7E5NBWMXDUCMZSIPOBKRDSBYVLMXGSSKF6YNPIB7Y77ITLVL6';
const TX_HASH = 'a3f1c2e4b5d6978812345678abcdef0123456789abcdef0123456789abcdef01';

describe('redactIdentifiers', () => {
  it.each([
    ['account', `/api/v1/accounts/${ACCOUNT}`, '/api/v1/accounts/:address'],
    ['contract', `/api/v1/contracts/${CONTRACT}/events`, '/api/v1/contracts/:address/events'],
    ['muxed account', `/api/v1/accounts/${MUXED}`, '/api/v1/accounts/:address'],
    ['lower-cased contract', `/c/${CONTRACT.toLowerCase()}`, '/c/:address'],
    ['transaction hash', `/api/v1/transactions/${TX_HASH}`, '/api/v1/transactions/:hash'],
    ['0x-prefixed hash', `/tx/0x${TX_HASH}`, '/tx/:hash'],
  ])('replaces %s', (_name, input, expected) => {
    expect(redactIdentifiers(input)).toBe(expected);
  });

  it('leaves bounded values untouched', () => {
    for (const v of ['GET', 'mainnet', 'rate_limited', '/api/v1/contracts/:id', 'success']) {
      expect(redactIdentifiers(v)).toBe(v);
    }
  });

  it('does not redact tokens shorter than an identifier', () => {
    for (const v of [`G${'A'.repeat(40)}`, 'abcdef0123456789abcdef012345678']) {
      expect(redactIdentifiers(v)).toBe(v);
    }
  });
});

describe('sanitizeMetricLabelValue', () => {
  it('redacts identifiers embedded in free text', () => {
    expect(sanitizeMetricLabelValue(`contract ${CONTRACT} trapped`)).toBe(
      'contract :address trapped',
    );
  });

  it('caps label length', () => {
    expect(sanitizeMetricLabelValue('x'.repeat(500))).toHaveLength(MAX_METRIC_LABEL_LENGTH);
  });

  it('handles null and undefined', () => {
    expect(sanitizeMetricLabelValue(undefined)).toBe('');
    expect(sanitizeMetricLabelValue(null)).toBe('');
  });
});

describe('normaliseRouteLabel', () => {
  it('keeps existing UUID/cuid/numeric normalisation', () => {
    expect(normaliseRouteLabel('/api/ledgers/12345')).toBe('/api/ledgers/:id');
    expect(normaliseRouteLabel('/api/events/550e8400-e29b-41d4-a716-446655440000')).toBe(
      '/api/events/:id',
    );
    expect(normaliseRouteLabel('/api/jobs/cjld2cjxh0000qzrmn831i7rn')).toBe('/api/jobs/:id');
    expect(normaliseRouteLabel('/api/v1/contracts/:id')).toBe('/api/v1/contracts/:id');
  });

  it('never emits a raw account or contract identifier', () => {
    const route = normaliseRouteLabel(`/api/v1/accounts/${ACCOUNT}/contracts/${CONTRACT}`);
    expect(route).toBe('/api/v1/accounts/:address/contracts/:address');
    expect(route).not.toContain(ACCOUNT);
    expect(route).not.toContain(CONTRACT);
  });
});

describe('metricsMiddleware route label', () => {
  beforeEach(() => vi.clearAllMocks());

  it('strips identifiers from unmatched raw paths', () => {
    const listeners: Array<() => void> = [];
    const res = {
      statusCode: 404,
      on: vi.fn((event: string, cb: () => void) => {
        if (event === 'finish') listeners.push(cb);
      }),
    } as unknown as Response;
    const req = { method: 'GET', path: `/api/v1/contracts/${CONTRACT}` } as Request;

    metricsMiddleware(req, res, vi.fn() as NextFunction);
    listeners.forEach((fn) => fn());

    expect(httpRequestTotal.inc).toHaveBeenCalledWith({
      method: 'GET',
      route: '/api/v1/contracts/:address',
      status_code: '404',
    });
  });
});
