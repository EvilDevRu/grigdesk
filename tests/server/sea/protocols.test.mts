import assert from 'node:assert/strict';
import test from 'node:test';

import { isolatedRelease } from './isolation.mts';
import { pluginBootFixture } from '../helpers/pluginBootFixture.js';

test('SEA-PROTOCOLS-01: API/SSE/WS, труба UI и устройства сохраняют auth, PTY отвечает (нестабильный)', {
  timeout: 150000,
}, async (t) => {
  const fixture = await isolatedRelease(t);
  const report = await fixture.run('protocols');

  assert.equal(report.unauthorized, true);
  assert.equal(report.apiOnly, true);
  assert.equal(report.packagedPipeUi, true);
  assert.equal(report.pipeDevices, true);
  assert.equal(report.deviceCli, true);
  assert.equal(report.apiVersion, true);
  assert.equal(report.sessionSse, true);
  assert.equal(report.pythonPty, true);
  assert.equal(report.packageUpdateRejected, true);

  const source = await pluginBootFixture(t, { apiSession: false });
  const sourceCodes: Record<string, number> = {};

  for (const route of ['/api/health', '/api/events', '/api/devices', '/api/terminal',
    `/ui/${'a'.repeat(64)}/`]) {
    const response = await fetch(source.address + route, { signal: AbortSignal.timeout(10000) });

    sourceCodes[route.startsWith('/ui/') ? 'ui' : route] = response.status;
  }

  source.child.kill('SIGTERM');
  assert.equal((await source.exited)[0], 0);
  assert.deepEqual(report.anonymousCodes, sourceCodes);
});
