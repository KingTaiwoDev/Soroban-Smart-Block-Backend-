import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  ANALYTICS_QUERY_BUDGETS,
  AnalyticsBudgetError,
  executeQuery,
  resolveQueryBudget,
} from '../../src/analytics/query-engine/query-router';

const json = (body: unknown) =>
  ({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as Response;

function athenaFetch(status: { State: string; DataScannedInBytes?: number }, rows = 1) {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const target = (init?.headers as Record<string, string>)?.['X-Amz-Target'] ?? '';
    if (target.endsWith('StartQueryExecution')) return json({ QueryExecutionId: 'q-1' });
    if (target.endsWith('GetQueryExecution')) {
      return json({
        QueryExecution: {
          Status: { State: status.State },
          Statistics: { DataScannedInBytes: status.DataScannedInBytes ?? 0 },
        },
      });
    }
    if (target.endsWith('GetQueryResults')) {
      const data = Array.from({ length: rows }, (_, i) => ({
        Data: [{ VarCharValue: String(i) }],
      }));
      return json({ ResultSet: { Rows: [{ Data: [{ VarCharValue: 'n' }] }, ...data] } });
    }
    return json({});
  });
}

const targets = (mock: ReturnType<typeof vi.fn>) =>
  mock.mock.calls.map(([, init]) => (init?.headers as Record<string, string>)?.['X-Amz-Target']);

describe('analytics query budgets', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it('clamps caller limits to server ceilings and defaults zero to the ceiling', () => {
    const budget = resolveQueryBudget({
      timeoutMs: 10_000_000,
      maxScanBytes: 0,
      maxRows: Number.MAX_SAFE_INTEGER,
    });
    expect(budget).toEqual({
      timeoutMs: ANALYTICS_QUERY_BUDGETS.maxTimeoutMs,
      maxScanBytes: ANALYTICS_QUERY_BUDGETS.maxScanBytes,
      maxRows: ANALYTICS_QUERY_BUDGETS.maxRows,
    });
    expect(resolveQueryBudget({ timeoutMs: 5_000, maxRows: 10 })).toMatchObject({
      timeoutMs: 5_000,
      maxRows: 10,
    });
  });

  it('returns results when the query stays within budget', async () => {
    vi.stubGlobal('fetch', athenaFetch({ State: 'SUCCEEDED', DataScannedInBytes: 10 }, 2));
    const { result } = await executeQuery({ sql: 'SELECT 1', engine: 'athena', timeoutMs: 50 });
    expect(result.rowCount).toBe(2);
    expect(result.scanBytes).toBe(10);
  });

  it('rejects up-front when the estimate exceeds an explicit scan limit', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      executeQuery({ sql: 'SELECT * FROM events', engine: 'athena', maxScanBytes: 1024 }),
    ).rejects.toMatchObject({ code: 'SCAN_BUDGET_EXCEEDED', statusCode: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('cancels and fails an Athena query that does not finish within its timeout', async () => {
    const fetchMock = athenaFetch({ State: 'RUNNING', DataScannedInBytes: 2048 });
    vi.stubGlobal('fetch', fetchMock);
    const err = await executeQuery({ sql: 'SELECT 1', engine: 'athena', timeoutMs: 50 }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(AnalyticsBudgetError);
    expect(err.code).toBe('QUERY_TIMEOUT');
    expect(err.statusCode).toBe(504);
    expect(targets(fetchMock)).toContain('AmazonAthena.StopQueryExecution');
    expect(targets(fetchMock)).not.toContain('AmazonAthena.GetQueryResults');
  });

  it('stops an Athena query once actual scanned bytes exceed the limit', async () => {
    const fetchMock = athenaFetch({ State: 'RUNNING', DataScannedInBytes: 2 * 1024 ** 3 });
    vi.stubGlobal('fetch', fetchMock);
    const err = await executeQuery({
      sql: 'SELECT 1',
      engine: 'athena',
      timeoutMs: 1_000,
      maxScanBytes: 1024 ** 3 + 1,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(AnalyticsBudgetError);
    expect(err.code).toBe('SCAN_BUDGET_EXCEEDED');
    expect(targets(fetchMock)).toContain('AmazonAthena.StopQueryExecution');
    expect(targets(fetchMock)).not.toContain('AmazonAthena.GetQueryResults');
  });

  it('rejects Athena results that exceed the row budget', async () => {
    vi.stubGlobal('fetch', athenaFetch({ State: 'SUCCEEDED' }, 5));
    await expect(
      executeQuery({ sql: 'SELECT 1', engine: 'athena', timeoutMs: 50, maxRows: 3 }),
    ).rejects.toMatchObject({ code: 'ROW_BUDGET_EXCEEDED', limit: 3 });
  });

  it('times out and cancels a Trino query that keeps paging', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') return json({});
      return json({ id: 't-1', nextUri: 'http://trino/next' });
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      executeQuery({ sql: 'SELECT 1', engine: 'trino', timeoutMs: 20 }),
    ).rejects.toMatchObject({ code: 'QUERY_TIMEOUT', statusCode: 504 });
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(true);
  });

  it('stops paging a Trino query once the row budget is exceeded', async () => {
    let page = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'DELETE') return json({});
        page += 1;
        return json({
          id: 't-2',
          nextUri: 'http://trino/next',
          columns: [{ name: 'n' }],
          data: page > 1 ? [['1'], ['2']] : undefined,
        });
      }),
    );
    await expect(
      executeQuery({ sql: 'SELECT 1', engine: 'trino', timeoutMs: 5_000, maxRows: 3 }),
    ).rejects.toMatchObject({ code: 'ROW_BUDGET_EXCEEDED' });
  });
});
