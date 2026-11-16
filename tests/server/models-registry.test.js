import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ChatHistoryStore } from '../../server/src/lib/chat/historyStore.ts';
import { resolveLegacyModel } from '../../server/src/lib/chat/modelRef.ts';
import { getExecutors } from '../../server/src/lib/executors/index.ts';
import claude from '../../server/src/lib/executors/claude.ts';
import {
  getModelsRegistry,
  mergeCatalogModel,
  mergeCatalog,
  modelInfoFromRegistry,
  resolveEffortHints,
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

test('первый scope доступа сохраняет алиасы актуальных моделей без каталога другого аккаунта', async () => {
  const file = {
    fixture: [
      {
        id: 'current-model',
        modelRefAliases: ['previous-model'],
        name: 'Старое имя',
      },
      { id: 'account-a-only-model', modelRefAliases: ['private-old-model'] },
    ],
    _meta: { fixture: {
      catalogVersion: 'v',
      catalogSchema: 12,
      catalogCacheKey: 'old-key',
    } },
  };
  const adapter = {
    probe: async () => ({ version: 'v' }),
    catalogAccessScope: () => 'profile-b/default/1',
    catalogCacheKey: () => 'new-key',
    catalog: async () => [{ id: 'current-model', name: 'Новое имя' }],
  };

  await mergeCatalog(file, 'fixture', adapter, {});

  const [mergedModel] = file.fixture;

  assert.match(mergedModel.firstSeen, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  delete mergedModel.firstSeen;
  assert.deepEqual(file.fixture, [{
    id: 'current-model',
    name: 'Новое имя',
    modelRefAliases: ['previous-model'],
  }]);
  assert.equal(JSON.stringify(file).includes('account-a-only-model'), false);
  assert.equal(JSON.stringify(file).includes('private-old-model'), false);
});

test('справка усилия следует доступным ступеням и не придумывает смысл новой', () => {
  const model = {
    id: 'synthetic',
    effortHints: {
      high: 'Upstream high',
      future: 'Upstream future',
      stale: 'Stale',
    },
  };
  const executor = { effortHints: { high: 'Русское описание', ultra: 'Делегирование' } };

  assert.deepEqual(resolveEffortHints(model, executor, ['high', 'future', 'unknown']), {
    high: 'Русское описание',
    future: 'Upstream future',
    unknown: 'Описание этого уровня пока недоступно.',
  });
  assert.deepEqual(resolveEffortHints({ ...model, custom: true }, executor, ['high']), {
    high: 'Upstream high',
  });
  assert.deepEqual(resolveEffortHints(model, executor, []), {});
});

test('справка описывает делегирование только у ultra Codex и ultracode Claude', async () => {
  const executors = await getExecutors();

  assert.match(executors.get('codex').effortHints.ultra, /делегированием/);
  assert.equal(executors.get('claude').effortHints.ultracode,
    'Глубина xhigh; запрашивает делегирование задач при доступном workflow. Расход может вырасти.');

  for (const executor of executors.values()) {
    for (const [level, hint] of Object.entries(executor.effortHints || {})) {
      if (executor.id === 'codex' && level === 'ultra') {
        continue;
      }

      if (executor.id === 'claude' && level === 'ultracode') {
        continue;
      }

      assert.doesNotMatch(hint, /делегирован/);
    }
  }
});

/**
 * Подменяет общий Map недоступным исполнителем без каталога и восстанавливает его после теста.
 * Счётчики отличают фильтрацию по регистрации от ошибочного опроса доступности или входа.
 */
async function unavailableExecutorFixture(t, adapter = {}) {
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
    ...adapter,
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

// Запись models.json без лишних полей: семейство пустое, если его объявляет адаптер.
function catalogModel(id, family, tier) {
  return {
    id,
    ...(family && { family }),
    tier,
    efforts: [],
  };
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-retired-catalog-'));

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

test('runtime-каталог любого исполнителя прячет прежние версии семейства, не переписывая файл', async (t) => {
  await unavailableExecutorFixture(t, {
    modelFamily: (model) => (String(model?.id || '').startsWith('line-b') ? 'line-b' : ''),
  });

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-superseded-catalog-'));

  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const modelsPath = path.join(root, 'models.json');
  const catalogJson = JSON.stringify({
    'test-live': [
      catalogModel('line-a-2', 'line-a', 100),
      catalogModel('line-a-1', 'line-a', 90),
      catalogModel('line-b-2', '', 80),
      catalogModel('line-b-1', '', 70),
      catalogModel('solo', '', 60),
    ],
    _meta: { 'test-live': { catalogVersion: 'fixture' } },
  }, null, 2);

  await fs.writeFile(modelsPath, catalogJson);

  const runtimeRegistry = await getModelsRegistry({ modelsPath }, { refresh: true });

  assert.deepEqual(runtimeRegistry['test-live'].map((model) => [model.id, !!model.extra]), [
    ['line-a-2', false],
    ['line-a-1', true],
    ['line-b-2', false],
    ['line-b-1', true],
    ['solo', false],
  ]);
  assert.equal(modelInfoFromRegistry('line-a', runtimeRegistry).model.id, 'line-a-2');
  assert.equal(await fs.readFile(modelsPath, 'utf8'), catalogJson);
});

test('runtime-каталог отдаёт справку только разрешённых уровней без записи в файл', async (t) => {
  await unavailableExecutorFixture(t, {
    effortHints: { high: 'Тщательная работа.', ultra: 'Делегирование.' },
    efforts: () => ['high', 'ultra'],
    modelEfforts: () => ['high'],
  });

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-effort-hints-'));

  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const modelsPath = path.join(root, 'models.json');
  const catalogJson = JSON.stringify({ 'test-live': [{ id: 'synthetic' }] });

  await fs.writeFile(modelsPath, catalogJson);

  const runtimeRegistry = await getModelsRegistry({ modelsPath }, { refresh: true });
  const model = runtimeRegistry['test-live'][0];

  assert.deepEqual(model.efforts, ['high']);
  assert.deepEqual(model.effortHints, { high: 'Тщательная работа.' });
  assert.equal(await fs.readFile(modelsPath, 'utf8'), catalogJson);
});

test('общий фильтр получает исходный discovery до fallback, включая неизвестный результат', async (t) => {
  let discovered;
  const received = [];

  await unavailableExecutorFixture(t, {
    efforts: () => discovered,
    modelEfforts: (_model, ladder, fresh) => {
      received.push({ ladder, fresh });

      return ladder;
    },
  });

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-discovery-contract-'));

  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const modelsPath = path.join(root, 'models.json');

  await fs.writeFile(modelsPath, JSON.stringify({ 'test-live': [{ id: 'synthetic', efforts: ['stored'] }] }));

  for (const value of [null, undefined, 'invalid', ['fresh']]) {
    discovered = value;
    await getModelsRegistry({ modelsPath }, { refresh: true });
    assert.deepEqual(received.at(-1), {
      ladder: Array.isArray(value) ? value : ['stored'],
      fresh: Array.isArray(value) ? value : null,
    });
  }
});

test('runtime Claude снимает старый ultracode без свежего discovery и сохраняет custom', async (t) => {
  const ladder = ['high', 'xhigh', 'ultracode'];
  let discovered = ladder;
  const filtered = [];

  await unavailableExecutorFixture(t, {
    effortHints: claude.effortHints,
    efforts: () => discovered,
    modelEfforts: (model, levels, fresh) => {
      filtered.push(model.id);

      return claude.modelEfforts(model, levels, fresh);
    },
  });

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-ultracode-registry-'));

  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const modelsPath = path.join(root, 'models.json');
  const compatible = {
    efforts: ladder,
    capabilities: ['effort', 'xhigh_effort'],
    effortGates: ['xhigh'],
  };
  const customHint = 'Ручной режим';
  const catalogJson = JSON.stringify({
    'test-live': [
      { ...compatible, id: 'compatible' },
      {
        ...compatible,
        id: 'incompatible',
        capabilities: ['effort'],
      },
      { id: 'unknown', efforts: ladder },
      {
        ...compatible,
        id: 'unverified',
        effortUnverified: true,
      },
      {
        id: 'manual',
        custom: true,
        efforts: ['ultracode'],
        effortHints: { ultracode: customHint },
      },
    ],
  });

  await fs.writeFile(modelsPath, catalogJson);

  for (const fresh of [ladder, null, ['high', 'xhigh'], ladder]) {
    discovered = fresh;

    const registry = await getModelsRegistry({ modelsPath }, { refresh: true });
    const by = new Map(registry['test-live'].map((model) => [model.id, model]));
    const hasMode = fresh === ladder;

    assert.deepEqual(by.get('compatible').efforts, hasMode ? ladder : ['high', 'xhigh']);
    assert.equal(by.get('compatible').effortHints.ultracode,
      hasMode ? claude.effortHints.ultracode : undefined);
    assert.deepEqual(by.get('incompatible').efforts, ['high']);
    assert.deepEqual(by.get('unknown').efforts, ['high', 'xhigh']);
    assert.deepEqual(by.get('unverified').efforts, []);
    assert.deepEqual(by.get('manual').efforts, ['ultracode']);
    assert.deepEqual(by.get('manual').effortHints, { ultracode: customHint });
    assert.equal(filtered.includes('manual'), false);
    assert.equal(await fs.readFile(modelsPath, 'utf8'), catalogJson);
  }
});

test('момент первого наблюдения переживает пересборку и ручной выбор', () => {
  const first = mergeCatalogModel({ id: 'model' }, undefined);
  const customCurrent = {
    id: 'model',
    custom: true,
    firstSeen: '2026-01-01T00:00:00.000Z',
  };

  assert.match(first.firstSeen, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  assert.equal(mergeCatalogModel({ id: 'model', name: 'Новое имя' }, first).firstSeen, first.firstSeen);
  assert.equal(mergeCatalogModel({ id: 'model' }, customCurrent).firstSeen, '2026-01-01T00:00:00.000Z');
});

test('нечат-модель уходит под «все модели», а порядок задают сила и свежесть', async (t) => {
  await unavailableExecutorFixture(t);

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-nonchat-catalog-'));

  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const modelsPath = path.join(root, 'models.json');
  const catalogJson = JSON.stringify({
    'test-live': [
      {
        id: 'old-chat',
        tier: 10,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'fresh-chat',
        tier: 10,
        createdAt: '2026-10-01T00:00:00.000Z',
      },
      {
        id: 'video-model',
        tier: 10,
        createdAt: '2026-02-01T00:00:00.000Z',
        nonChat: true,
        nonChatReason: 'Генерация видео, не текстовый чат',
      },
      { id: 'no-date-b', tier: 10 },
      { id: 'no-date-a', tier: 10 },
      {
        id: 'strong-old',
        tier: 20,
        createdAt: '2025-01-01T00:00:00.000Z',
      },
    ],
  });

  await fs.writeFile(modelsPath, catalogJson);

  const runtimeRegistry = await getModelsRegistry({ modelsPath }, { refresh: true });
  const models = runtimeRegistry['test-live'];

  assert.deepEqual(models.map((model) => model.id), [
    'strong-old', 'fresh-chat', 'video-model', 'old-chat', 'no-date-a', 'no-date-b',
  ]);
  assert.equal(models.find((model) => model.id === 'video-model').extra, true);
  assert.equal(models.find((model) => model.id === 'video-model').nonChatReason,
    'Генерация видео, не текстовый чат');
  assert.deepEqual(models.filter((model) => !model.extra).map((model) => model.id), [
    'strong-old', 'fresh-chat', 'old-chat', 'no-date-a', 'no-date-b',
  ]);
  assert.equal(await fs.readFile(modelsPath, 'utf8'), catalogJson);
});

test('без даты сервиса свежесть задаёт момент первого наблюдения реестра', async (t) => {
  let catalogIds = ['old-model'];

  await unavailableExecutorFixture(t, {
    catalogLive: true,
    probe: async () => ({ version: 'v1' }),
    catalog: async () => catalogIds.map((id) => ({ id })),
  });

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-firstseen-catalog-'));

  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const modelsPath = path.join(root, 'models.json');

  await fs.writeFile(modelsPath, JSON.stringify({ 'test-live': [] }));
  await getModelsRegistry({ modelsPath }, { refresh: true });

  catalogIds = ['old-model', 'new-model'];
  await new Promise((resolve) => setTimeout(resolve, 5));

  const registry = await getModelsRegistry({ modelsPath }, { refresh: true });

  assert.deepEqual(registry['test-live'].map((model) => model.id), ['new-model', 'old-model']);

  const stored = JSON.parse(await fs.readFile(modelsPath, 'utf8'))['test-live'];
  const oldSeen = stored.find((model) => model.id === 'old-model').firstSeen;
  const newSeen = stored.find((model) => model.id === 'new-model').firstSeen;

  assert.ok(oldSeen && newSeen);
  assert.ok(newSeen > oldSeen);
});
