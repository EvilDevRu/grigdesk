import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ChatHistoryStore } from '../../server/src/lib/chat/historyStore.ts';
import { resolveLegacyModel } from '../../server/src/lib/chat/modelRef.ts';
import { getExecutors } from '../../server/src/lib/executors/index.ts';
import {
  getModelsRegistry,
  mergeCatalogModel,
  modelInfoFromRegistry,
  resolveModelEfforts,
} from '../../server/src/lib/modelsRegistry.ts';

const registry = {
  codex: [
    { id: 'gpt-5.6-sol', family: 'sol', tier: 100, extra: false },
    { id: 'gpt-5.5-sol', family: 'sol', tier: 90, extra: true },
    {
      id: 'gpt-5.6-terra',
      family: 'terra',
      tier: 80,
      extra: false,
      aliases: ['codex-auto-review'],
      modelRefAliases: ['gpt-5.6-terra-retired'],
    },
  ],
};

/**
 * Подменяет общий Map недоступным исполнителем без каталога и восстанавливает его после теста.
 * Счётчики отличают фильтрацию по регистрации от ошибочного опроса доступности или входа.
 */
async function unavailableExecutorFixture(t) {
  const executors = await getExecutors();
  const originalExecutors = new Map(executors);

  t.after(() => {
    executors.clear();

    for (const [id, executor] of originalExecutors) {
      executors.set(id, executor);
    }
  });

  const calls = { probe: 0, auth: 0 };

  executors.clear();
  executors.set('test-live', {
    id: 'test-live',
    bin: () => '',
    probe: () => {
      calls.probe += 1;

      return { available: false };
    },
    auth: () => {
      calls.auth += 1;

      return { loggedIn: false };
    },
    async run() {
      assert.fail('Проверка каталога не должна запускать ИИ.');
    },
  });

  return calls;
}

/**
 * Пишет schema-2 чат и default-пару напрямую, без миграции через saveOne().
 * История и вложение позволяют проверить, что отсутствие адаптера не стирает данные.
 */
async function writeRetiredChat(root, modelRef) {
  const chatsDir = path.join(root, 'chats');
  const monthDir = path.join(chatsDir, '2026-09');
  const messages = [
    {
      role: 'user',
      text: 'История',
      attachments: [{ id: 'fixture-image', name: 'кадр.png' }],
    },
    { role: 'assistant', text: 'Сохранённый ответ' },
  ];

  await fs.mkdir(monthDir, { recursive: true });
  await fs.writeFile(path.join(monthDir, 'retired-chat.json'), JSON.stringify({
    schema: 2,
    id: 'retired-chat',
    modelRef,
    revision: 3,
    messages,
    createdAt: Date.UTC(2026, 8, 1),
    updatedAt: Date.UTC(2026, 8, 1),
  }));
  await fs.writeFile(path.join(chatsDir, 'meta.json'), JSON.stringify({
    schema: 2,
    activeId: 'retired-chat',
    defModelRef: modelRef,
  }));

  return { chatsDir, messages };
}

test('model registry resolves family policy to its current catalog model', () => {
  const info = modelInfoFromRegistry('sol', registry);
  assert.equal(info.provider, 'codex');
  assert.equal(info.model.id, 'gpt-5.6-sol');
});

test('exact model pins and aliases keep precedence over family resolution', () => {
  assert.equal(modelInfoFromRegistry('gpt-5.5-sol', registry).model.id, 'gpt-5.5-sol');
  assert.equal(modelInfoFromRegistry('codex-auto-review', registry).model.id, 'gpt-5.6-terra');
  assert.equal(modelInfoFromRegistry('gpt-5.6-terra-retired', registry).model.id, 'gpt-5.6-terra');
});

test('live catalog effort updates replace an ordinary cached copy', () => {
  const cached = { id: 'gpt-next-sol', efforts: ['low', 'high'] };
  const live = { id: 'gpt-next-sol', efforts: ['low', 'high', 'ultra'] };
  assert.deepEqual(mergeCatalogModel(live, cached).efforts, ['low', 'high', 'ultra']);
});

test('only explicit custom models may override live catalog efforts', () => {
  const cached = { id: 'custom', efforts: ['local'], custom: true };
  const live = { id: 'custom', efforts: ['remote'] };
  assert.deepEqual(mergeCatalogModel(live, cached).efforts, ['local']);
});

test('runtime-only context replaces a stale catalog fallback instead of preserving it', () => {
  const cached = { id: 'gpt-next-sol', context: 400_000 };
  const live = {
    id: 'gpt-next-sol',
    context: 0,
    contextUnverified: true,
    contextRuntimeOnly: true,
  };
  const merged = mergeCatalogModel(live, cached);

  assert.equal(merged.context, 0);
  assert.equal(merged.contextRuntimeOnly, true);
});

test('missing effort discovery stays empty instead of inventing levels', () => {
  assert.deepEqual(resolveModelEfforts(null, null), []);
  assert.deepEqual(resolveModelEfforts(null, ['low', 'future']), ['low', 'future']);
});

test('live CLI discovery replaces stale stored efforts unless the model is custom', () => {
  assert.deepEqual(
    resolveModelEfforts(['low', 'high'], ['low', 'high', 'future']),
    ['low', 'high', 'future'],
  );
  assert.deepEqual(
    resolveModelEfforts(['local'], ['remote'], true),
    ['local'],
  );
});

test('runtime-каталог исключает снятого исполнителя, сохраняя данные и историю', async (t) => {
  const calls = await unavailableExecutorFixture(t);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-retired-catalog-'));

  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const modelsPath = path.join(root, 'models.json');
  const retiredRef = { provider: 'retired-provider', model: 'retired-model' };
  const catalog = {
    'retired-provider': [{
      id: retiredRef.model,
      custom: true,
      note: 'Сохранённое поле',
    }],
    'test-live': [{
      id: 'live-model',
      efforts: [],
      customField: 'Сохранённое поле',
    }],
    _meta: {
      'retired-provider': { watermark: '2026-09-01', customField: 'Сохранить' },
      'test-live': { catalogVersion: 'fixture', customField: 'Сохранить' },
    },
  };
  const catalogJson = JSON.stringify(catalog, null, 2);

  await fs.writeFile(modelsPath, catalogJson);

  const runtimeRegistry = await getModelsRegistry({ modelsPath }, { refresh: true });

  assert.equal(Object.hasOwn(runtimeRegistry, retiredRef.provider), false);
  assert.equal(runtimeRegistry['test-live'][0].id, 'live-model');
  assert.equal(runtimeRegistry['test-live'][0].customField, 'Сохранённое поле');
  assert.deepEqual(calls, { probe: 0, auth: 0 });
  assert.equal(await fs.readFile(modelsPath, 'utf8'), catalogJson);
  assert.equal(resolveLegacyModel(retiredRef.model, runtimeRegistry).error, 'unknown_model');

  const { chatsDir, messages } = await writeRetiredChat(root, retiredRef);
  const store = new ChatHistoryStore({
    chatsDir,
    registryProvider: () => getModelsRegistry({ modelsPath }, { refresh: true }),
  });
  const state = await store.read();
  const chat = state.sessions.find((entry) => entry.id === 'retired-chat');

  assert.deepEqual(chat.modelRef, retiredRef);
  assert.equal(chat.modelRefState.state, 'unknown_provider');
  assert.deepEqual(chat.messages, messages);
  assert.deepEqual(state.defModelRef, retiredRef);
  assert.equal(state.defModelRefState.state, 'unknown_provider');
  assert.equal(await fs.readFile(modelsPath, 'utf8'), catalogJson);
  assert.deepEqual(calls, { probe: 0, auth: 0 });
});
