import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import demoModule, {
  profileHasCapability,
} from '../../server/src/modules/demo/index.js';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-demo-capability.'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const profilesDir = path.join(root, 'profiles');
  const stateDir = path.join(root, 'state');
  await Promise.all([
    mkdir(path.join(profilesDir, 'with-demo'), { recursive: true }),
    mkdir(path.join(profilesDir, 'without-demo'), { recursive: true }),
    mkdir(stateDir, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(profilesDir, 'with-demo', 'graph.json'), JSON.stringify({
      capabilities: ['demo'],
    })),
    writeFile(path.join(profilesDir, 'without-demo', 'graph.json'), JSON.stringify({
      capabilities: [],
    })),
  ]);

  const registries = {
    1: { PROFILE: 'with-demo', SHIP: 'done' },
    2: { PROFILE: 'without-demo', SHIP: 'done' },
  };
  const factoryState = {
    listTasks: async () => Object.entries(registries).map(([task, registry]) => ({
      task,
      profile: registry.PROFILE,
      registry,
    })),
    readEnv: async (task) => ({ FE_PORT: task === '1' ? '3100' : '3200' }),
    readRegistry: async (task) => ({ registry: registries[task] }),
  };
  const app = Fastify({ logger: false });
  app.decorate('pluginEnabled', () => true);
  await app.register(demoModule, {
    config: {
      profilesDir,
      stateDir,
      factoryBin: '/factory/bin/factory',
    },
    factoryState,
  });
  t.after(() => app.close());
  return { app, profilesDir };
}

test('capability читается только из валидного graph.json профиля', async (t) => {
  const { profilesDir } = await fixture(t);
  assert.equal(await profileHasCapability(profilesDir, 'with-demo', 'demo'), true);
  assert.equal(await profileHasCapability(profilesDir, 'without-demo', 'demo'), false);
  assert.equal(await profileHasCapability(profilesDir, '../with-demo', 'demo'), false);
});

test('обзор Demo скрывает задачи неподдерживающих профилей', async (t) => {
  const { app } = await fixture(t);
  const response = await app.inject({ method: 'GET', url: '/api/demo/overview' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().tasks.map((item) => item.task), ['1']);
});

test('Demo API не запускает unknown stage неподдерживающего профиля', async (t) => {
  const { app } = await fixture(t);
  const response = await app.inject({ method: 'POST', url: '/api/demo/2/run' });
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error, 'demo_unsupported');
});

test('Demo API принимает только исходный task id в форме N или tN', async (t) => {
  const { app } = await fixture(t);

  for (const id of ['foo1bar2', '0', 't0', 'tt2', '-2']) {
    const response = await app.inject({
      method: 'POST',
      url: `/api/demo/${encodeURIComponent(id)}/run`,
    });
    assert.equal(response.statusCode, 400, id);
    assert.equal(response.json().error, 'bad_task_id', id);
  }

  const prefixed = await app.inject({ method: 'POST', url: '/api/demo/t2/run' });
  assert.equal(prefixed.statusCode, 409);
  assert.equal(prefixed.json().error, 'demo_unsupported');
});
