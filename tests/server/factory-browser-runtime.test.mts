import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { factoryBrowserRuntimeEnv } from '../../server/src/lib/browser/factoryBrowserRuntime.ts';
import { selectedFactoryRuntimeConfig } from '../../server/src/lib/factoryLaunch.ts';
import { routeLaunchEnv } from '../../server/src/lib/factoryRouteCli.ts';

/**
 * Fixture создаёт два разных поколения с настоящими каталогами и файлами helper.
 * Содержимое helper не выполняется: проверяется выбор authority до engine spawn.
 */
async function runtime(root: string, label: string, browser = true) {
  const runtimeRoot = path.join(root, label);
  const directory = path.join(runtimeRoot, 'server/runtime/helpers');
  const node = path.join(runtimeRoot, 'runtime/node/bin/node');

  await mkdir(directory, { recursive: true });
  await mkdir(path.dirname(node), { recursive: true });
  await writeFile(node, '', { mode: 0o700 });
  await writeFile(path.join(directory, 'factory-browser.mjs'), 'export {};');
  await writeFile(path.join(directory, 'helpers.json'), JSON.stringify({
    schema: 1,
    helpers: [{ id: 'factory-runtime-pin', entry: 'pin.ts' },
      ...(browser ? [{ id: 'factory-browser', entry: 'browser.ts' }] : [])],
  }));

  return {
    packageId: label.repeat(64),
    runtimeRoot,
    node,
    engineHome: path.join(runtimeRoot, 'engine'),
    engineBin: path.join(runtimeRoot, 'engine/bin/factory'),
  };
}

test('R01: B обслуживает A выбранным Node/helper A; extraEnv не меняет host fields', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'browser-pin-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  const a = await runtime(root, 'a');
  const b = await runtime(root, 'b');
  const config = {
    dataHome: root,
    rootDir: b.runtimeRoot,
    factoryHome: b.engineHome,
    factoryBin: b.engineBin,
    profilesDir: path.join(root, 'profiles'),
    stateDir: path.join(root, 'state'),
    factoryConfigRoot: path.join(root, 'config'),
    factoryControlDir: path.join(root, 'control'),
    routesDir: path.join(root, 'routes'),
  };
  const prepared = selectedFactoryRuntimeConfig(config, a);
  const env = routeLaunchEnv(prepared, {
    GRIGDESK_BROWSER_NODE: '/forged/node',
    GRIGDESK_BROWSER_HELPER: '/forged/helper',
    GRIGDESK_BROWSER_RELAY_SOCKET: '/forged/socket',
  });

  assert.equal(env.GRIGDESK_BROWSER_NODE, a.node);
  assert.equal(env.GRIGDESK_BROWSER_HELPER,
    path.join(a.runtimeRoot, 'server/runtime/helpers/factory-browser.mjs'));
  assert.equal(env.GRIGDESK_BROWSER_RELAY_SOCKET, path.join(root, 'browser/relay.sock'));
  assert.equal(prepared.factoryBin, a.engineBin);
});

test('R02: старый A без browser entry не заимствует новый helper B; broken manifest — отказ', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'browser-old-pin-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  const a = await runtime(root, 'a', false);
  const env = factoryBrowserRuntimeEnv(a, path.join(root, 'socket'));

  assert.deepEqual(Object.values(env), ['', '', '']);
  await writeFile(path.join(a.runtimeRoot, 'server/runtime/helpers/helpers.json'), '{broken');
  assert.throws(() => factoryBrowserRuntimeEnv(a, path.join(root, 'socket')), /каталог|Каталог/u);
});
