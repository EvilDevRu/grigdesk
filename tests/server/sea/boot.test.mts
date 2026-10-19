import assert from 'node:assert/strict';
import test from 'node:test';

import { isolatedRelease } from './isolation.mts';

test('SEA-ISOLATION-01: checkout недоступен, внешний Node заглушен, R только для чтения', {
  timeout: 90000,
}, async (t) => {
  const fixture = await isolatedRelease(t);
  const report = await fixture.run('probe');

  assert.equal(report.sourceHidden, true);
  assert.equal(report.hostNodeStatus, 97);
  assert.equal(report.readOnly, true);
  assert.equal(report.node, 'v24.21.0');
  assert.equal(report.loopback, true);
});

test('SEA-BOOT-01: CLI запускает ELF из .env, auth закрыт, lock и SIGTERM работают (нестабильный)', {
  timeout: 150000,
}, async (t) => {
  const fixture = await isolatedRelease(t);
  const report = await fixture.run('boot');

  assert.equal(report.ready, true);
  assert.equal(report.lockCode, 78);
  assert.equal(report.shutdownCode, 0);
  assert.equal(report.lockReleased, true);
  assert.equal(report.isSea, true);
});
