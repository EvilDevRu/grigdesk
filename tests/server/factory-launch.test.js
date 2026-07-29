import assert from 'node:assert/strict';
import test from 'node:test';

import { factoryLaunchEnv } from '../../server/src/lib/factory-launch.js';

test('Cockpit passes every factory runtime root into the detached pipeline scope', () => {
  assert.deepEqual(factoryLaunchEnv({
    profilesDir: '/profiles',
    stateDir: '/state',
    factoryConfigRoot: '/config',
  }, { FACTORY_SB_K: '7' }), {
    FACTORY_SB_K: '7',
    FACTORY_PROFILES_DIR: '/profiles',
    FACTORY_STATE: '/state',
    STATE_DIR: '/state',
    FACTORY_CONFIG_ROOT: '/config',
  });
});
