import assert from 'node:assert/strict';
import test from 'node:test';
import { createApiPerformanceSummary } from '../../web/src/shared/apiPerformanceSummary.ts';

test('10 тысяч попыток учитываются без потери счётчика и без события на каждую', () => {
  const rows = [];
  let clock = 0;
  const summary = createApiPerformanceSummary({ now: () => clock, emit: (row) => rows.push(row) });

  for (let index = 0; index < 10_000; index += 1) {
    summary.add({
      method: 'GET',
      path: `/api/group${index % 200}`,
      ms: 3,
      headersMs: 1,
      bodyMs: 1,
      parseMs: 1,
      ...(index % 2 ? { serverMs: 1, pipeMs: 2 } : {}),
    });
  }

  assert.equal(rows.length, 0);
  clock = 10_000;
  summary.flush();
  assert.ok(rows.length > 0);
  assert.ok(rows.length <= 16);
  assert.equal(rows.reduce((sum, row) => sum + row.count, 0), 10_000);
  assert.equal(rows.reduce((sum, row) => sum + row.totalMs, 0), 30_000);
  assert.equal(rows.reduce((sum, row) => sum + row.serverCount, 0), 5000);
  assert.equal(rows.reduce((sum, row) => sum + row.pipeCount, 0), 5000);
  assert.ok(rows.every((row) => row.periodMs === 10_000));
  assert.equal(rows.filter((row) => row.method === 'other' && row.path === 'other').length, 1);
  assert.equal(new Set(rows.map((row) => `${row.method}:${row.path}`)).size, rows.length);
  summary.flush();
  assert.ok(rows.length <= 16);
});
