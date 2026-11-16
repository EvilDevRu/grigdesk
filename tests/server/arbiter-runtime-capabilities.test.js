import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { probeFactoryGotoCapability } from '../../server/src/lib/factoryRuntimeCapabilities.ts';
import * as capabilities from '../../server/src/lib/factoryRuntimeCapabilities.ts';
import { readExistingFactoryRuntimePin } from '../../server/src/lib/factoryRuntimePins.ts';

test('probe запускает выбранный A с его окружением, а не текущий B; unknown не кэшируется', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'arbiter-capability-a-'));
  const helpers = path.join(root, 'server/runtime/helpers');

  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(helpers, { recursive: true });
  await fs.writeFile(path.join(helpers, 'helpers.json'), JSON.stringify({
    schema: 1,
    helpers: [{ id: 'factory-runtime-pin', entry: 'pin.ts' }],
  }));

  let calls = 0;
  const selected = {
    packageId: 'capability-test-a',
    runtimeRoot: root,
    engineHome: path.join(root, 'engine'),
    engineBin: path.join(root, 'engine/bin/factory'),
    node: path.join(root, 'node')
  };
  const config = {
    factoryBin: '/runtime-b/factory',
    rootDir: '/runtime-b',
    factoryHome: '/runtime-b/engine',
    stateDir: '/state',
    factoryControlDir: '/control',
    profilesDir: '/profiles',
    factoryConfigRoot: '/config'
  };
  const deps = {
    readPin: async () => selected, exec: async (command, args, options) => {
      calls += 1;
      assert.equal(command, selected.engineBin);
      assert.deepEqual(args, ['capabilities', '--format', 'json']);
      assert.equal(options.env.NODE_BIN, selected.node);

      if (calls === 1) {
        throw Object.assign(new Error('timeout'), { killed: true });
      }

      return { stdout: '{"schema":1,"features":["goto-expected-stage-v1"]}', stderr: '' };
    }
  };

  assert.equal((await probeFactoryGotoCapability(config, {}, deps)).status, 'unknown');
  assert.equal((await probeFactoryGotoCapability(config, {}, deps)).status, 'supported');
  assert.equal((await probeFactoryGotoCapability(config, {}, deps)).status, 'supported');
  assert.equal(calls, 2);
});

test(("source и отрицательный ответ перепроверяются; отсутствие authority не пишет " +
  "control root"),
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'arbiter-pin-read-'));

    t.after(() => fs.rm(root, { recursive: true, force: true }));

    const roots = {
      controlRoot: path.join(root, 'control'),
      stateRoot: path.join(root, 'state'),
      profileRoot: path.join(root, 'profiles')
    };

    await Promise.all(Object.values(roots).map((dir) => fs.mkdir(dir, { mode: 0o700 })));

    const before = await fs.readdir(root, { recursive: true });

    assert.equal(await readExistingFactoryRuntimePin({
      ...roots,
      cacheDir: path.join(root, 'cache'),
      task: '7',
      profile: 'demo',
      attempt: `a_${'a'.repeat(32)}`
    }), null);
    assert.deepEqual(await fs.readdir(root, { recursive: true }), before);

    let calls = 0;
    const selected = {
      packageId: null,
      runtimeRoot: root,
      engineHome: root,
      engineBin: '/bin/false',
      node: process.execPath
    };
    const config = {
      rootDir: root,
      factoryHome: root,
      factoryBin: '/bin/false',
      stateDir: roots.stateRoot,
      factoryControlDir: roots.controlRoot,
      profilesDir: roots.profileRoot,
      factoryConfigRoot: root
    };
    const deps = {
      readPin: async () => selected, exec: async () => {
        calls += 1;

        return {
          stdout: JSON.stringify({
            schema: 1,
            features: calls === 1 ? [] : ['goto-expected-stage-v1']
          })
        };
      }
    };

    assert.equal((await probeFactoryGotoCapability(config, {}, deps)).status, 'unsupported');
    assert.equal((await probeFactoryGotoCapability(config, {}, deps)).status, 'supported');
    await probeFactoryGotoCapability(config, {}, deps);
    assert.equal(calls, 3);
  }
);

// К6: capability нового редактора проверяется у A и кэшируется отдельно от goto.
test('settings-pin-A-not-B', async (t) => {
  assert.equal(typeof capabilities.probeFactoryStageRunnerSettingsCapability, 'function',
    'нужен самостоятельный probe stage-runner-settings-v1');

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stage-capability-A-'));
  const selected = {
    packageId: null,
    runtimeRoot: root,
    engineHome: root,
    engineBin: `${root}/A with spaces`,
    node: `${root}/own-node`,
  };
  const config = {
    rootDir: '/B',
    factoryHome: '/B/engine',
    factoryBin: '/B/factory',
    stateDir: `${root}/state`,
    factoryControlDir: `${root}/control`,
    profilesDir: `${root}/profiles`,
    factoryConfigRoot: `${root}/config`,
  };
  let count = 0;
  const deps = {
    readPin: async () => selected,
    exec: async (command, args, options) => {
      count += 1;
      assert.equal(command, selected.engineBin);
      assert.equal(options.env.NODE_BIN, selected.node);
      assert.deepEqual(args, ['capabilities', '--format', 'json']);

      if (count === 1) {
        throw Object.assign(new Error('fixture timeout'), { killed: true });
      }

      return { stdout: '{"schema":1,"features":["stage-runner-settings-v1"]}' };
    },
  };

  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const unknown = await capabilities.probeFactoryStageRunnerSettingsCapability(config, {}, deps);

  assert.equal(unknown.status, 'unknown');

  const supported = await capabilities.probeFactoryStageRunnerSettingsCapability(config, {}, deps);

  assert.equal(supported.status, 'supported');
  assert.equal(count, 2, 'unknown допускает повтор, не кэшируется');
});

test('settings-old-runtime', async () => {
  assert.equal(typeof capabilities.probeFactoryStageRunnerSettingsCapability, 'function');

  const config = {
    rootDir: '/A',
    factoryHome: '/A/engine',
    factoryBin: '/A/factory',
    stateDir: '/state',
    factoryControlDir: '/control',
    profilesDir: '/profiles',
    factoryConfigRoot: '/config',
  };
  let executed = 0;
  const missing = await capabilities.probeFactoryStageRunnerSettingsCapability(config, {}, {
    readPin: async () => null,
    exec: async () => {
      executed += 1;
    },
  });

  assert.equal(missing.status, 'unavailable');
  assert.equal(executed, 0, 'без authority нельзя пробовать B');

  const selected = {
    packageId: null,
    runtimeRoot: '/A',
    engineHome: '/A/engine',
    engineBin: '/A/factory',
    node: '/A/node',
  };
  const deps = {
    readPin: async () => selected,
    exec: async () => ({ stdout: '{"schema":1,"features":["goto-expected-stage-v1"]}' }),
  };

  assert.equal((await probeFactoryGotoCapability(config, {}, deps)).status, 'supported');

  const unsupported = await capabilities.probeFactoryStageRunnerSettingsCapability(config, {}, deps);

  assert.equal(unsupported.status, 'unsupported');
});
