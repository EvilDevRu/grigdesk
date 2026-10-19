import assert from 'node:assert/strict';
import test from 'node:test';

import { isolatedRelease } from './isolation.mts';

test('REVIEW-P1/P5: writable R, factory-route/npm из PTY, повторный boot и полный manifest '
  + '(нестабильный)', { timeout: 150000 }, async (t) => {
  const fixture = await isolatedRelease(t, { writable: true });
  const report = await fixture.run('writable');

  assert.equal(report.userNodeFirst, true);
  assert.equal(report.bundledNodeLast, true);
  assert.equal(report.pythonNoCache, true);
  assert.equal(report.npmOutsideRelease, true);
  assert.equal(report.restart, true);
  assert.equal(report.integrity, true);
});
