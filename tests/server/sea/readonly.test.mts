import assert from 'node:assert/strict';
import test from 'node:test';

import { isolatedRelease } from './isolation.mts';

test('SEA-READONLY-01: реестры, DB query/cancel и ESM lifecycle работают без записи в R (нестабильный)', {
  timeout: 150000,
}, async (t) => {
  const fixture = await isolatedRelease(t);
  const report = await fixture.run('integration');

  assert.deepEqual(report.engines, ['clickhouse', 'mysql', 'redis']);
  assert.deepEqual(report.providers, ['claude', 'codex', 'deepseek', 'glm', 'kimi', 'tripo']);
  assert.equal(report.query, true);
  assert.equal(report.cancel, true);
  assert.equal(report.plugin, true);
  assert.equal(report.lifecycle, true);
});

test('SEA-READONLY-02: fake agent проходит MCP и scope без внешней модели (нестабильный)', {
  timeout: 150000,
}, async (t) => {
  const fixture = await isolatedRelease(t);
  const report = await fixture.run('agent');

  assert.equal(report.agentTurn, true);
  assert.equal(report.mcp, true);
  assert.equal(report.scope, true);
});

test('SEA-READONLY-03: supervisor и Bash wrappers работают из чужого cwd (нестабильный)', {
  timeout: 150000,
}, async (t) => {
  const fixture = await isolatedRelease(t);
  const report = await fixture.run('workers');

  assert.equal(report.supervisor, true);
  assert.equal(report.peerAlive, true);
  assert.equal(report.engine, true);
  assert.equal(report.cli, true);
});

test('SEA-READONLY-04: настоящий SEA сохраняет IPC, restart75 и снимает lock (нестабильный)', {
  timeout: 150000,
}, async (t) => {
  const fixture = await isolatedRelease(t);
  const report = await fixture.run('control');

  assert.equal(report.restartCode, 75);
  assert.equal(report.sameExecutable, true);
  assert.equal(report.disconnectCode, 0);
  assert.equal(report.lockRemoved, true);
});
