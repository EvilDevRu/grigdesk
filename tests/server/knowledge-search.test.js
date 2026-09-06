import assert from 'node:assert/strict';
import test from 'node:test';

import { knowledgeFixture, record } from './helpers/knowledge.js';

async function indexedFixture(t) {
  const fixture = await knowledgeFixture(t);
  const rows = [
    record({ title: 'Деплой сервиса', body: 'Справочная запись.', tags: ['knowledge', 'операции'] }),
    record({ title: 'Справочная запись', body: 'Тег описывает выпуск.', tags: ['knowledge', 'деплой'] }),
    record({
      title: 'Справочная запись',
      body: 'Подробно описан деплой приложения.',
      tags: ['knowledge', 'прочее'],
    }),
  ];
  const created = [];
  for (const row of rows) created.push(await fixture.storage.create(row));
  return { ...fixture, ids: created.map((item) => item.id) };
}

test('Ранжирование ставит совпадение заголовка выше тега, а тег выше тела', async (t) => {
  const { storage, ids } = await indexedFixture(t);
  const result = await storage.search({ query: 'деплой', project: 'cockpit-test' });

  assert.deepEqual(result.items.map((item) => item.id), ids);
});

test('Одинаково релевантные результаты имеют стабильный порядок между запросами', async (t) => {
  const { storage } = await knowledgeFixture(t);
  await storage.create(record({ title: 'Одинаковый термин', body: 'Альфа.' }));
  await storage.create(record({ title: 'Одинаковый термин', body: 'Бета.' }));
  const first = await storage.search({ query: 'термин' });
  const second = await storage.search({ query: 'термин' });

  assert.deepEqual(
    first.items.map((item) => item.id),
    second.items.map((item) => item.id),
  );
});

test('Фрагмент берётся из исходного тела и не содержит служебный HTML или стемы', async (t) => {
  const { storage } = await knowledgeFixture(t);
  await storage.create(record({
    title: 'История выпуска',
    body: 'Перед выпуском команда проверяет журнал. После успешного деплоя сверяет метрики.',
  }));
  const result = await storage.search({ query: 'деплой' });
  const fragment = result.items[0]?.fragment || '';

  assert.deepEqual({
    originalWord: fragment.includes('деплоя'),
    html: /<[^>]+>/.test(fragment),
    normalizedLeak: fragment.includes('депл '),
  }, {
    originalWord: true,
    html: false,
    normalizedLeak: false,
  });
});

test('Пустой поиск возвращает успешный пустой список', async (t) => {
  const { storage } = await indexedFixture(t);
  const result = await storage.search({ query: 'несуществующийтермин' });

  assert.deepEqual(result, { items: [] });
});

test('Запрос без пригодных токенов возвращает успешный пустой список', async (t) => {
  const { storage } = await indexedFixture(t);
  const [empty, punctuation] = await Promise.all([
    storage.search({ query: '' }),
    storage.search({ query: '***' }),
  ]);

  assert.deepEqual([empty, punctuation], [{ items: [] }, { items: [] }]);
});

test('Краткий результат поиска содержит точные теги записи', async (t) => {
  const { storage } = await knowledgeFixture(t);
  const created = await storage.create(record({
    title: 'Очередь выпуска',
    tags: ['queue', 'release'],
  }));
  const result = await storage.search({ query: 'очередь' });

  assert.deepEqual({ id: result.items[0]?.id, tags: result.items[0]?.tags }, {
    id: created.id,
    tags: ['queue', 'release'],
  });
});

test('Пунктуация пользователя не попадает в MATCH как синтаксис', async (t) => {
  const { storage } = await indexedFixture(t);
  const result = await storage.search({ query: '"деплой" OR (***):' });

  assert.equal(result.items[0]?.title, 'Деплой сервиса');
});

test('Русский запрос находит отличающуюся словоформу в содержимом', async (t) => {
  const { storage } = await knowledgeFixture(t);
  const created = await storage.create(record({
    title: 'Инструкция выпуска',
    body: 'После деплоя обязательно сверить очередь и метрики.',
  }));
  const result = await storage.search({ query: 'деплой' });

  assert.equal(result.items[0]?.id, created.id);
});

test('Фильтры проекта, репозитория и тегов применяются одновременно', async (t) => {
  const { storage } = await knowledgeFixture(t);
  const wanted = await storage.create(record({
    project: 'alpha', repository: 'backend', title: 'Очередь заданий', tags: ['queue', 'важное'],
  }));
  await storage.create(record({
    project: 'beta', repository: 'backend', title: 'Очередь заданий', tags: ['queue', 'важное'],
  }));
  const result = await storage.search({
    query: 'очередь', project: 'alpha', repository: 'backend', tags: ['важное'],
  });

  assert.deepEqual(result.items.map((item) => item.id), [wanted.id]);
});
