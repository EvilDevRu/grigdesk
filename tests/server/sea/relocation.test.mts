import assert from 'node:assert/strict';
import test from 'node:test';

import { isolatedRelease } from './isolation.mts';

test('SEA-RELOCATION-01: boot/MCP/плагин/helpers повторяются после переноса R с пробелами (нестабильный)', {
  timeout: 360000,
}, async (t) => {
  const fixture = await isolatedRelease(t, { mountPath: '/relocated release with spaces' });
  const probe = await fixture.run('probe');

  assert.equal(probe.sourceHidden, true);
  assert.equal(probe.hostNodeStatus, 97);
  assert.equal(probe.readOnly, true);

  const integration = await fixture.run('integration');
  const agent = await fixture.run('agent');
  const workers = await fixture.run('workers');

  assert.equal(integration.query, true);
  assert.equal(integration.plugin, true);
  assert.equal(integration.lifecycle, true);
  assert.equal(agent.agentTurn, true);
  assert.equal(agent.mcp, true);
  assert.equal(agent.scope, true);
  assert.equal(workers.engine, true);
});
