import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import {
  executorTypeGroups,
  isTopbarProvider,
  normalizeExecutorType,
} from '../../shared/chat/executorTypes.ts';
import {
  getExecutors,
  getProviderAdapters,
  isChatExecutor,
} from '../../server/src/lib/executors/index.ts';
import { getModelsRegistry } from '../../server/src/lib/modelsRegistry.ts';
import providersModule from '../../server/src/modules/providers/index.ts';

const Fastify = createRequire(new URL('../../server/package.json', import.meta.url))('fastify');

/**
 * Синтетический узкий адаптер намеренно объявляет весь чатовый контракт.
 * Любое исполнение transport или каталога означает обход допуска по типу.
 */
function narrowAdapter() {
  return {
    id: 'synthetic-3d',
    name: 'Synthetic',
    type: '3d',
    kind: 'api',
    bin: () => null,
    probe: () => ({ ok: true, version: null }),
    auth: () => ({
      available: true,
      mode: 'env',
      label: 'ok'
    }),
    seedModels: () => assert.fail('Узкий seedModels вызван'),
    catalog: () => assert.fail('Узкий catalog вызван'),
    run: () => assert.fail('Узкий run вызван'),
    chatAutoCompact: true,
    scopedWorkspace: true,
    commands: () => [{
      cmd: '/unsafe',
      desc: 'Недоступная команда',
      run: 'prompt'
    }],
    modes: () => [{ id: 'unsafe', label: 'Недоступный режим' }],
  };
}

test('типы нормализуются, группы сохраняют порядок реестра и пропускают пустые', () => {
  for (const value of [undefined, null, '', ' ', 'unknown', 3, {}]) {
    assert.equal(normalizeExecutorType(value), 'universal');
  }

  assert.equal(normalizeExecutorType(' 3d '), '3d');
  assert.deepEqual(executorTypeGroups([]), []);

  const providers = [{ id: 'a' }, { id: 't', type: '3d' }, { id: 'b' }];
  const groups = executorTypeGroups(providers);

  assert.deepEqual(groups.map((group) => group.id), ['universal', '3d']);
  assert.deepEqual(groups[0].providers.map((provider) => provider.id), ['a', 'b']);
  assert.equal(executorTypeGroups([providers[1]]).length, 1);
});

test('тип и run совместно определяют допуск, доступность топбара имеет своё правило', () => {
  assert.equal(isChatExecutor({ run() {} }), true);
  assert.equal(isChatExecutor({ type: '3d', run() {} }), false);
  assert.equal(isChatExecutor({}), false);
  assert.equal(isTopbarProvider({ available: false }), true);
  assert.equal(isTopbarProvider({ chatEnabled: false }), false);
  assert.equal(isTopbarProvider({
    type: '3d',
    available: true,
    chatEnabled: false
  }), true);
  assert.equal(isTopbarProvider({ type: '3d', available: false }), false);
});

test('узкий run не даёт runtime и сохранённые модели; карточка и декораторы защищены', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'executor-types-'));

  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const adapters = await getProviderAdapters();
  const original = new Map(adapters);
  const narrow = narrowAdapter();

  adapters.clear();
  adapters.set(narrow.id, narrow);

  const executors = await getExecutors();

  t.after(() => {
    adapters.clear();
    executors.clear();

    for (const [id, adapter] of original) {
      adapters.set(id, adapter);

      if (isChatExecutor(adapter)) {
        executors.set(id, adapter);
      }
    }
  });
  assert.equal(executors.has(narrow.id), false);

  const config = {
    modelsPath: path.join(root, 'models.json'),
    providerUsageSeenPath: path.join(root, 'seen.json'),
  };

  await fs.writeFile(config.modelsPath, JSON.stringify({ [narrow.id]: [{ id: 'custom', custom: true }] }));
  assert.deepEqual(await getModelsRegistry(config), {});

  const app = Fastify({ logger: false });

  t.after(() => app.close());
  await app.register(providersModule, {
    config,
    getProviderAdapters: async () => new Map([[narrow.id, narrow]]),
    getModelsRegistry: async () => ({ [narrow.id]: [{ id: 'custom' }] }),
  });

  const card = (await app.inject({ url: '/api/providers' })).json().providers[0];

  assert.equal(card.type, '3d');
  assert.equal(card.kind, 'api');
  assert.equal(card.chatEnabled, false);
  assert.deepEqual(card.models, []);
  assert.deepEqual(card.commands, []);
  assert.deepEqual(card.modes, []);
  assert.equal(card.capabilities.chatAutoCompact, false);
  assert.equal(card.capabilities.scopedWorkspace, false);
  assert.equal(await app.executorFor(narrow.id), null);
  assert.deepEqual(await app.providerRegistry(), {});
});

test('discovery находит настоящий Tripo, но не допускает его к ходу', async () => {
  const adapters = await getProviderAdapters();
  const executors = await getExecutors();
  const tripo = adapters.get('tripo');

  assert.equal(tripo.type, '3d');
  assert.equal(tripo.kind, 'api');
  assert.equal(tripo.run, undefined);
  assert.equal(tripo.seedModels, undefined);
  assert.equal(executors.has('tripo'), false);
});

test('старые адаптеры без новых полей сохраняют universal/cli, модели и setup-only состояние', async (t) => {
  const base = {
    id: 'ordinary',
    name: 'Ordinary',
    bin: () => null,
    probe: () => ({ ok: true, version: null }),
    auth: () => ({
      mode: 'env',
      available: true,
      label: 'ok'
    }),
    run: async () => ({ reply: 'ok' }),
    commands: () => [{
      cmd: '/status',
      desc: 'Статус',
      run: 'none'
    }],
    modes: () => [{ id: 'plan', label: 'План' }],
  };
  const setup = {
    ...base,
    id: 'setup',
    run: undefined
  };
  const app = Fastify({ logger: false });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'executor-compatibility-'));

  t.after(async () => {
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  await app.register(providersModule, {
    config: {
      modelsPath: path.join(root, 'models.json'),
      providerUsageSeenPath: path.join(root, 'seen.json'),
    },
    getProviderAdapters: async () => new Map([[base.id, base], [setup.id, setup]]),
    getModelsRegistry: async () => ({ ordinary: [{ id: 'ordinary-model' }], setup: [{ id: 'wrong' }] }),
  });

  const cards = (await app.inject({ url: '/api/providers' })).json().providers;

  assert.deepEqual(cards.map((item) => [item.type, item.kind, item.available, item.chatEnabled]), [
    ['universal', 'cli', true, true], ['universal', 'cli', true, false],
  ]);
  assert.equal(cards[0].models[0].id, 'ordinary-model');
  assert.deepEqual(cards[1].models, []);
  assert.equal(cards[1].commands[0].cmd, '/status');
  assert.equal(cards[1].modes[0].id, 'plan');
});
