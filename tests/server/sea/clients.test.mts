import assert from 'node:assert/strict';
import test from 'node:test';

import { isolatedRelease } from './isolation.mts';

test('SEA-CLIENT-01: вход TLS, привязка и отзыв устройства работают без checkout (нестабильный)', {
  timeout: 150000,
}, async (t) => {
  const fixture = await isolatedRelease(t);
  const report = await fixture.run('clients');

  assert.equal(report.clientTls, true);
  assert.equal(report.bootstrap, true);
  assert.equal(report.pairing, true);
  assert.equal(report.revoked, true);
});
