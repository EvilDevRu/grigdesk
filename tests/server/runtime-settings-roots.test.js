import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveRuntimeSettings } from '../../shared/runtime/runtimeSettings.ts';

process.env.NODE_ENV = 'test';

test('ROOTS-01: COCKPIT-ключи в файле настроек игнорируются', () => {
  const settings = resolveRuntimeSettings({
    env: {},
    file: { COCKPIT_HOME: '/forbidden', COCKPIT_ENV_FILE: '/forbidden' },
    home: '/tmp/grigdesk-roots',
  });

  assert.equal(settings.port, 8140);
});

test('ROOTS-02: GRIGDESK-корни в файле по-прежнему запрещены', () => {
  assert.throws(() => resolveRuntimeSettings({
    env: {},
    file: { GRIGDESK_HOME: '/forbidden' },
    home: '/tmp/grigdesk-roots',
  }), /запрещён в файле настроек/);
});
