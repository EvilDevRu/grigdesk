import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { probeFactoryGotoCapability } from '../../server/src/lib/factoryRuntimeCapabilities.ts';
import { readExistingFactoryRuntimePin } from '../../server/src/lib/factoryRuntimePins.ts';

test('probe запускает выбранный A с его окружением, а не текущий B; unknown не кэшируется', async () => {
  let calls = 0;
  const selected = {
    packageId: 'capability-test-a',
    runtimeRoot: '/runtime-a',
    engineHome: '/runtime-a/engine',
    engineBin: '/runtime-a/engine/bin/factory',
    node: '/runtime-a/node'
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
