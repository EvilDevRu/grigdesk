import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ChatHistoryStore } from '../../server/src/lib/chat/historyStore.ts';
import { getExecutors } from '../../server/src/lib/executors/index.ts';
import { getModelsRegistry } from '../../server/src/lib/modelsRegistry.ts';

const PROVIDER = 'test-live';
const SETTLE_MS = 200;
const WAIT_MS = 2000;

/**
 * Обещание с ручным исходом: тест держит сборку реестра на паузе, пока проверяет,
 * кто её ждёт, а затем отпускает. Повторный resolve безопасен.
 */
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

/**
 * Состояние обещания через короткое настоящее ожидание: 'resolved', 'rejected' или
 * 'pending'. Date в тестах подменён, setTimeout — настоящий.
 */
async function settle(promise, ms = SETTLE_MS) {
  let timer;
  const pending = new Promise((done) => {
    timer = setTimeout(() => done('pending'), ms);
  });
  const outcome = promise.then(() => 'resolved', () => 'rejected');

  try {
    return await Promise.race([outcome, pending]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Опрашивает условие до первого истинного результата: фоновая сборка завершается
 * асинхронно, и у теста нет другого способа дождаться её следа.
 */
async function waitFor(check, ms = WAIT_MS) {
  const deadline = performance.now() + ms;

  while (performance.now() < deadline) {
    const value = await check();

    if (value) {
      return value;
    }

    await new Promise((done) => setTimeout(done, 10));
  }

  assert.fail('условие не выполнилось за отведённое время');
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

function ids(registry) {
  return registry[PROVIDER].map((model) => model.id);
}

/**
 * Подменяет общий Map исполнителей одним синтетическим и подменяет Date.
 * Каждая сборка реестра один раз вызывает discoverModels — это счётчик сборок;
 * seedModels вызывается, только когда в файле нет исполнителя, и умеет падать.
 */
async function registryFixture(t) {
  const executors = await getExecutors();
  const original = new Map(executors);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-registry-cache-'));
  const gates = new Map();
  const state = {
    builds: 0,
    seeds: 0,
    failSeed: false,
  };

  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 8) });

  t.after(async () => {
    for (const gate of gates.values()) {
      gate.release.resolve();
    }

    executors.clear();

    for (const [id, executor] of original) {
      executors.set(id, executor);
    }

    await fs.rm(root, { recursive: true, force: true });
  });

  executors.clear();
  executors.set(PROVIDER, {
    id: PROVIDER,
    bin: () => '',
    probe: () => ({ ok: false }),
    auth: () => ({ available: false }),
    async run() {
      assert.fail('Сборка реестра не должна запускать ИИ.');
    },
    seedModels() {
      state.seeds += 1;

      if (state.failSeed) {
        throw new Error('сбой сборки реестра');
      }

      return [{ id: 'seeded', efforts: [] }];
    },
    /**
     * Счётчик сборок: общий код зовёт обнаружение ровно раз за сборку.
     * Если на этот номер поставлена пауза, сборка ждёт, пока тест её отпустит.
     */
    async discoverModels() {
      state.builds += 1;

      const gate = gates.get(state.builds);

      if (gate) {
        gate.started.resolve();
        await gate.release.promise;
      }

      return null;
    },
  });

  /**
   * Пишет файл реестра с одной моделью; null — пустой файл без исполнителя,
   * чтобы следующая сборка пошла через seedModels.
   */
  async function writeCatalog(file, modelId) {
    const body = modelId === null ? {} : { [PROVIDER]: [{ id: modelId, efforts: [] }] };

    await fs.writeFile(file, JSON.stringify(body));
  }

  /**
   * Ставит на паузу сборку с номером builds + 1: started — сборка дошла до паузы,
   * release — отпустить её.
   */
  function blockNextBuild() {
    const gate = { started: deferred(), release: deferred() };

    gates.set(state.builds + 1, gate);

    return {
      started: gate.started.promise,
      release: () => gate.release.resolve(),
    };
  }

  const modelsPath = path.join(root, 'models.json');

  await writeCatalog(modelsPath, 'a');

  return {
    root,
    state,
    config: { modelsPath },
    writeCatalog: (modelId, file = modelsPath) => writeCatalog(file, modelId),
    blockNextBuild,
  };
}

test('свежий реестр отдаётся из памяти без повторной сборки', async (t) => {
  const f = await registryFixture(t);
  const first = await getModelsRegistry(f.config, { refresh: true });

  await f.writeCatalog('b');
  t.mock.timers.tick(59_000);

  assert.equal(await getModelsRegistry(f.config), first);
  assert.equal(f.state.builds, 1);
});

test('устаревший реестр отдаётся сразу, а пересборка идёт в фоне', async (t) => {
  const f = await registryFixture(t);
  const first = await getModelsRegistry(f.config, { refresh: true });

  await f.writeCatalog('b');

  const gate = f.blockNextBuild();

  t.mock.timers.tick(61_000);

  const call = getModelsRegistry(f.config);

  assert.equal(await settle(call), 'resolved');
  assert.equal(await call, first);

  await gate.started;
  assert.equal(f.state.builds, 2);

  gate.release();

  const fresh = await waitFor(async () => {
    const registry = await getModelsRegistry(f.config);

    return registry === first ? null : registry;
  });

  assert.deepEqual(ids(fresh), ['b']);
  assert.equal(f.state.builds, 2);
});

test('параллельные запросы к устаревшему реестру запускают одну пересборку', async (t) => {
  const f = await registryFixture(t);
  const first = await getModelsRegistry(f.config, { refresh: true });
  const gate = f.blockNextBuild();

  t.mock.timers.tick(61_000);

  const calls = Promise.all(Array.from({ length: 5 }, () => getModelsRegistry(f.config)));

  assert.equal(await settle(calls), 'resolved');
  assert.ok((await calls).every((registry) => registry === first));

  await gate.started;
  gate.release();

  await waitFor(async () => (await getModelsRegistry(f.config)) !== first);
  assert.equal(f.state.builds, 2);
});

test('без готового реестра параллельные вызовы ждут одну общую сборку', async (t) => {
  const f = await registryFixture(t);
  const gate = f.blockNextBuild();
  const calls = Promise.all([1, 2, 3].map(() => getModelsRegistry(f.config)));

  assert.equal(await settle(calls), 'pending');

  gate.release();

  const results = await calls;

  assert.equal(f.state.builds, 1);
  assert.ok(results.every((registry) => registry === results[0]));
  assert.deepEqual(ids(results[0]), ['a']);
});

test('refresh ждёт идущую сборку, строит свою, и её итог не затирается', async (t) => {
  const f = await registryFixture(t);

  await getModelsRegistry(f.config, { refresh: true });

  const gate = f.blockNextBuild();

  t.mock.timers.tick(61_000);
  getModelsRegistry(f.config);
  await gate.started;
  await f.writeCatalog('c');

  const refreshed = getModelsRegistry(f.config, { refresh: true });

  assert.equal(await settle(refreshed), 'pending');

  gate.release();

  assert.deepEqual(ids(await refreshed), ['c']);
  assert.equal(f.state.builds, 3);
  assert.deepEqual(ids(await getModelsRegistry(f.config)), ['c']);
});

test('сбой фоновой пересборки оставляет прежний реестр и повторяется не раньше минуты', async (t) => {
  const f = await registryFixture(t);
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);

  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));

  const first = await getModelsRegistry(f.config, { refresh: true });

  await f.writeCatalog(null);
  f.state.failSeed = true;
  t.mock.timers.tick(61_000);

  assert.equal(await getModelsRegistry(f.config), first);
  await waitFor(() => f.state.seeds === 1);
  await sleep(50);

  t.mock.timers.tick(30_000);
  assert.equal(await getModelsRegistry(f.config), first);
  await sleep(50);
  assert.equal(f.state.seeds, 1);

  f.state.failSeed = false;
  t.mock.timers.tick(31_000);
  assert.equal(await getModelsRegistry(f.config), first);

  const fresh = await waitFor(async () => {
    const registry = await getModelsRegistry(f.config);

    return registry === first ? null : registry;
  });

  assert.deepEqual(ids(fresh), ['seeded']);
  assert.equal(f.state.seeds, 2);
  assert.deepEqual(unhandled, []);
});

test('без готового реестра сбой сборки уходит вызывающему, а следующий вызов пробует снова', async (t) => {
  const f = await registryFixture(t);

  await f.writeCatalog(null);
  f.state.failSeed = true;

  await assert.rejects(getModelsRegistry(f.config), /сбой сборки реестра/);

  f.state.failSeed = false;

  assert.deepEqual(ids(await getModelsRegistry(f.config)), ['seeded']);
  assert.equal(f.state.seeds, 2);
});

test('реестры разных файлов не подменяют друг друга', async (t) => {
  const f = await registryFixture(t);
  const otherPath = path.join(f.root, 'other-models.json');

  await f.writeCatalog('b', otherPath);
  await getModelsRegistry(f.config, { refresh: true });

  assert.deepEqual(ids(await getModelsRegistry({ modelsPath: otherPath })), ['b']);
  assert.deepEqual(ids(await getModelsRegistry(f.config)), ['a']);
});

test('сохранение меты чата не ждёт пересборку устаревшего реестра', async (t) => {
  const f = await registryFixture(t);

  await getModelsRegistry(f.config, { refresh: true });

  const gate = f.blockNextBuild();
  const store = new ChatHistoryStore({
    chatsDir: path.join(f.root, 'chats'),
    registryProvider: () => getModelsRegistry(f.config),
  });

  t.mock.timers.tick(61_000);

  const saved = store.saveMeta({ activeId: 'chat-1' });

  assert.equal(await settle(saved), 'resolved');
  assert.equal((await saved).activeId, 'chat-1');

  await gate.started;
  gate.release();
});
