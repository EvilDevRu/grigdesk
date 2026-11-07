import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import {
  assertLight,
  headsOf,
  jsonRequest,
  listFixture,
  sampleChat,
  versionsOf,
  writeChat,
} from './helpers/chat-list.js';

const median = (values) => [...values].sort((one, two) => one - two)[Math.floor(values.length / 2)];

/**
 * Время ограничено серверными hooks от начала запроса до отправленной сериализации.
 * Клиент inject не добавляет в измерение сеть, браузер или разбор большого JSON.
 */
function timingHooks(samples) {
  return async (app) => {

    const starts = new Map();

    app.addHook('onRequest', async (request) => {
      starts.set(request.id, performance.now());
    });
    app.addHook('onResponse', async (request) => {
      samples.push({
        url: request.url,
        elapsedMs: performance.now() - starts.get(request.id),
      });
      starts.delete(request.id);
    });
  };
}

/**
 * Пять последовательных запросов держат в памяти только один ответ за раз.
 * Размер и digest вычисляются по реальному сериализованному UTF-8 телу Fastify.
 */
async function measure(app, samples, method, url, payload) {

  const sizes = [];

  const times = [];

  const hashes = [];

  for (let pass = 0; pass < 5; pass += 1) {

    const before = samples.length;

    const response = await app.inject({
      method,
      url,
      ...(payload === undefined ? {} : { payload }),
    });

    assert.equal(response.statusCode, 200, `${method} ${url}`);
    assert.equal(samples.length, before + 1, 'измерение пришло из серверного onResponse');
    sizes.push(Buffer.byteLength(response.body));
    times.push(samples.at(-1).elapsedMs);
    hashes.push(createHash('sha256').update(response.body).digest('hex'));
  }

  assert.equal(new Set(sizes).size, 1);
  assert.equal(new Set(hashes).size, 1, 'неизменная история даёт одинаковые байты');

  return {
    bytes: sizes[0],
    serverMedianMs: median(times),
  };
}

test('LIST-BENCHMARK: тысяча чатов, 34 тысячи реплик, около 250 МБ', {
  timeout: 300000,
}, async (t) => {

  const gate = await listFixture(t);

  await jsonRequest(gate.app, 'GET', '/api/chat/store/list');
  await gate.app.close();

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-list-benchmark-'));

  const config = { chatsDir: path.join(root, 'chats') };

  const text = 'т'.repeat(660);

  const stepText = 's'.repeat(12000);

  const chats = [];

  let benchmarkApp = null;

  t.after(async () => {
    await benchmarkApp?.close();
    await fs.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
    });
  });

  for (let index = 0; index < 1000; index += 1) {

    const chat = sampleChat(`bench-${index}`, {
      archived: index % 3 === 0,
      draft: index % 5 === 0 ? 'Неотправленный черновик' : '',
      messages: Array.from({ length: 34 }, (_, position) => position % 2 === 0
        ? {
          role: 'user',
          text,
        }
        : {
          role: 'assistant',
          text,
          steps: [{
          k: 'text',
          text: stepText,
        }],
        }),
    });

    if (index % 10 === 0) {
      Object.assign(chat.messages[0], {
        turnId: `bench-turn-${index}`,
        delivery: 'sending',
        sentAt: Date.now(),
        outbox: { text: 'Не подтверждено' },
      });
    }

    chats.push(chat);
    await writeChat({ config }, chat);
  }

  const samples = [];
  let readFile = t.mock.method(fs, 'readFile');
  const chatReads = () => readFile.mock.calls.filter((call) =>
    /^bench-\d+\.json$/.test(path.basename(String(call.arguments[0])))).length;

  const coldStart = performance.now();

  let fixture = await listFixture(t, [], {
    root,
    extraRoutes: async (app) => {
      await timingHooks(samples)(app);
      // Дешёвая системная ручка на том же event loop изолирует стоимость каталога.
      // Внешние пробы ОС и исполнителей не входят в этот замер.
      app.get('/api/system', async () => ({ ok: true }));
    },
  });

  benchmarkApp = fixture.app;

  const registrationMs = performance.now() - coldStart;

  const firstStarted = performance.now();
  const readsAtReady = chatReads();
  const systemLatencies = [];
  let preparing = true;
  const firstList = jsonRequest(fixture.app, 'GET', '/api/chat/store/list').finally(() => {
    preparing = false;
  });

  while (preparing) {
    const scheduled = performance.now();

    await delay(5);
    await jsonRequest(fixture.app, 'GET', '/api/system');
    // Включаем опоздание таймера: блокировка до начала HTTP тоже считается задержкой.
    systemLatencies.push(performance.now() - scheduled - 5);
  }

  const initial = await firstList;

  const firstListWaitMs = performance.now() - firstStarted;
  const coldChatReads = chatReads();
  const systemMaxMs = Math.max(...systemLatencies);

  const known = versionsOf(initial);

  assert.equal(headsOf(initial).length, 1000);
  assertLight(initial);
  assert.ok(readsAtReady < 1000, 'сервер принимает запросы до завершения подготовки каталога');
  assert.ok(systemLatencies.length > 10, 'системные запросы выполнялись во время прогрева');
  assert.ok(systemMaxMs < 50, `/api/system во время прогрева: ${systemMaxMs.toFixed(1)} мс`);
  assert.equal(coldChatReads, 1000, 'миграция, шапки и выбор восстановления делят один проход');
  readFile.mock.resetCalls();

  await fixture.app.close();

  const warmStart = performance.now();
  const readsBeforeRestart = chatReads();

  fixture = await listFixture(t, [], { root, extraRoutes: timingHooks(samples) });
  benchmarkApp = fixture.app;

  const restarted = await jsonRequest(fixture.app, 'GET', '/api/chat/store/list');
  const warmFirstListMs = performance.now() - warmStart;

  assert.deepEqual(versionsOf(restarted), known);
  assert.equal(chatReads(), readsBeforeRestart, 'рестарт использует персистные шапки без чтений чатов');
  assert.ok(warmFirstListMs < 1000, `первый список с кэшем: ${warmFirstListMs.toFixed(1)} мс`);
  readFile.mock.resetCalls();
  readFile.mock.restore();

  const legacy = await measure(fixture.app, samples, 'GET', '/api/chat/store');

  readFile = t.mock.method(fs, 'readFile');

  const readsAfterLegacy = chatReads();

  const list = await measure(fixture.app, samples, 'GET', '/api/chat/store/list');

  const unchanged = await measure(fixture.app, samples, 'POST', '/api/chat/store/changes', { known });

  assert.equal(chatReads() - readsAfterLegacy, 0,
    'после готовности list и пустая delta не читают JSON чатов');
  assert.ok(legacy.bytes > 200_000_000, 'синтетическая нагрузка действительно сопоставима с исходной');
  assert.ok(list.bytes < legacy.bytes / 10);
  await writeChat(fixture, {
    ...chats[0],
    title: 'Изменён ровно один чат',
  });

  const changed = await measure(fixture.app, samples, 'POST', '/api/chat/store/changes', { known });

  assert.equal(chatReads() - readsAfterLegacy, 1, 'изменение одного чата разбирается один раз');

  const searchUrl = '/api/chat/store/search?q=%D1%82%D1%82%D1%82&archived=0';
  const firstSearch = await jsonRequest(fixture.app, 'GET', searchUrl);
  const readsAfterSearch = chatReads();
  const repeatedSearch = await jsonRequest(fixture.app, 'GET', searchUrl);
  const repeatedSearchChatReads = chatReads() - readsAfterSearch;

  assert.ok(firstSearch.matches.length > 600);
  assert.deepEqual(repeatedSearch, firstSearch);
  assert.equal(repeatedSearchChatReads, 0, 'повторный поиск не читает JSON чатов');

  const detail = await measure(fixture.app, samples, 'GET', '/api/chat/store/chat/bench-1');

  t.diagnostic(JSON.stringify({
    legacy,
    list,
    unchanged,
    changed,
    detail,
    registrationMs,
    firstListWaitMs,
    warmFirstListMs,
    systemMaxMs,
    coldChatReads,
    repeatedSearchChatReads,
    knownBytes: Buffer.byteLength(JSON.stringify({ known })),
  }));
});
