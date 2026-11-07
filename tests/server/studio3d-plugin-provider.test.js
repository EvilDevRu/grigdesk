import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import Fastify from '../../server/node_modules/fastify/fastify.js';
import { createProviderCapabilities } from '../../server/src/modules/plugins/providerCapabilities.ts';
import { createPluginCore } from '../../server/src/modules/plugins/core.ts';
import { getProviderAdapters, isChatExecutor } from '../../server/src/lib/executors/index.ts';
import { createTripoStudio } from '../../server/src/lib/tripo/studio.ts';
import { startFakeTripo } from './helpers/fakeTripo.js';
import { START_CONTEXT } from '../../server/src/lib/studio3d/provider.ts';

const developmentDir = process.env.STUDIO3D_DEVELOPMENT_DIR;

if (developmentDir !== undefined) {
  if (!path.isAbsolute(developmentDir)) {
    throw new Error('STUDIO3D_DEVELOPMENT_DIR должен быть абсолютным путём.');
  }

  await fs.access(path.join(developmentDir, 'src/shared/studio3d/studio3dOperations.ts'));
}

async function product(relative) {
  return import(pathToFileURL(path.join(developmentDir, 'src', relative)).href);
}

const { createLibrary } = developmentDir ? await product('lib/studio3d/library.ts') : {};
const { createIntents } = developmentDir ? await product('lib/studio3d/intents.ts') : {};
const { createJobs } = developmentDir ? await product('lib/studio3d/jobs.ts') : {};

function integrationTest(name, callback) {
  return test(name, {
    skip: !developmentDir && 'Нужен STUDIO3D_DEVELOPMENT_DIR: внешний source integration.',
  }, callback);
}

test('PV-01 настоящий реестр имеет studio3d у Tripo, чатовый допуск остаётся закрыт', async () => {
  const adapters = await getProviderAdapters();

  assert.equal(adapters.get('tripo').studio3d.id, 'tripo');
  assert.equal(isChatExecutor(adapters.get('tripo')), false);
});

test('PV-02 узкие studio3d адаптеры затем local, универсальные и карточки без поля исключены', () => {
  const declared = {
      id: 'fixture',
      name: 'Исполнитель',
      local: false,
      available: () => true,
      operations: () => [],
      validate: () => ({}),
      quote: () => ({})
  };
  const local = { id: 'local' };
  const providers = createProviderCapabilities()(new Map([
    ['fixture', {
        id: 'fixture',
        type: '3d',
        studio3d: declared
    }],
    ['chat', {
        id: 'chat',
        type: 'universal',
        studio3d: declared
    }],
    ['empty', { id: 'empty', type: '3d' }],
  ]), '3d').concat(local);

  assert.deepEqual(providers.map((provider) => provider.id), ['fixture', 'local']);
});

/**
 * Только ядро знает HTTP протокол Tripo и credentials. Перенесённый scheduler
 * получает настоящий public facade и настоящий lifetime flock через core.
 */
async function fixture(t, { loseOwner = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio3d-plugin-core-provider-'));
  const fake = await startFakeTripo();
  const server = Fastify({ logger: false });
  const core = createPluginCore(server, 'studio3d');
  let clock = Date.parse('2026-11-05T10:00:00Z');
  const library = createLibrary({
      dir: root,
      acquireLock: core.acquireKernelFileLock,
      now: () => clock
  });

  await library.ensure();

  const provider = createProviderCapabilities()(new Map([['tripo', {
    type: '3d', studio3d: createTripoStudio({
        env: fake.env,
        baseUrl: fake.baseUrl,
        sleep: async () => {
        }
    }),
  }]]), '3d')[0];
  const intents = createIntents({ library });
  const jobs = createJobs({
      library,
      intents,
      providers: [provider],
      now: () => clock,
      setTimer: () => 1,
      clearTimer: () => {
      },
      fault: async (boundary) => {
          if (loseOwner && boundary === 'before-send') {
              await fs.unlink(path.join(root, '.owner.lock'));
              await fs.writeFile(path.join(root, '.owner.lock'), 'заменённый inode');
          }
      }
  });

  t.after(async () => {
    await jobs.stop();
    await library.close();
    await server.close();
    await fake.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  const context = {
      kind: null,
      format: null,
      stats: null,
      params: null,
      nativeTaskType: null,
      rigCheck: null,
      views: []
  };
  const values = provider.validate('text-to-model',
    { prompt: 'Только синтетический локальный заказ' }, context).values;
  const request = {
      libraryId: library.libraryId,
      idempotencyKey: randomUUID(),
      provider: 'tripo',
      operation: 'text-to-model',
      values,
      expectedPrice: provider.quote('text-to-model', values, context).total
  };

  return {
      root,
      fake,
      provider,
      library,
      intents,
      jobs,
      request,
      advance: (milliseconds) => {
          clock += milliseconds;
      },
      disk: async () => JSON.parse(await fs.readFile(
        path.join(root, '.jobs', request.idempotencyKey, 'intent.json'), 'utf8')),
      creates: () => fake.requests.filter((item) => item.path === '/v3/generation/text-to-model')
  };
}

integrationTest('PORT-CORE настоящий facade + fake HTTP сохраняют foreign credits=false и opaque snapshot',
  async (t) => {
    const f = await fixture(t);
    const snapshot = f.provider.snapshot();

    assert.deepEqual(Object.keys(snapshot).sort(), ['accountKey', 'billingUrl']);
    assert.equal(Object.isFrozen(snapshot), true);
    assert.throws(() => f.provider.isCurrent({ ...snapshot }), /Снимок аккаунта/);
    assert.equal(f.provider.isCurrent(snapshot), true);
    f.fake.respondOnce('POST', /text-to-model/, 402, { code: 2010, message: 'fake credits' });
    await f.jobs.run(f.request);
    await f.jobs.tick();

    const child = (await f.disk()).children[0];

    assert.equal(child.stage, 'prepared');
    assert.equal(child.status, 'waiting');
    assert.equal(child.paymentState, 'unpaid');
    assert.equal(child.error.kind, 'credits');
    assert.match(child.error.message, /кредитов Tripo/);
    assert.equal(Number.isFinite(child.retryAt), true);
    assert.equal(f.creates().length, 1);
    await f.jobs.tick();
    assert.equal(f.creates().length, 1);
    f.advance(30_001);
    await f.jobs.tick();
    assert.equal(f.creates().length, 2);
    assert.equal((await f.disk()).children[0].taskId !== null, true);
    await f.jobs.tick();
    assert.equal(f.creates().length, 2);
  });

integrationTest('PORT-CORE настоящий public flock потерян после journal fsync: fake HTTP POST=0',
  async (t) => {
  const f = await fixture(t, { loseOwner: true });

  await f.jobs.run(f.request);
  await f.jobs.tick();
  assert.throws(() => f.library.assertOwnerNow(), (error) => error.code === 'owner_lost');
  assert.equal(f.creates().length, 0);
  assert.equal((await f.disk()).children[0].stage, 'submitting');
});

integrationTest('TO-01 настоящий provider facade закрывает словарь P кроме локальных помощников',
  async () => {
    const { OPERATIONS } = await product('shared/studio3d/studio3dOperations.ts');
    const provider = createProviderCapabilities()(await getProviderAdapters(), '3d')
      .find((item) => item.id === 'tripo');
    const declared = provider.operations(START_CONTEXT).map((entry) => entry.operation);
    const expected = OPERATIONS
      .map((operation) => operation.id)
      .filter((id) => !['rotate', 'scale'].includes(id));

    assert.deepEqual([...declared].sort(), [...expected].sort());
  });
