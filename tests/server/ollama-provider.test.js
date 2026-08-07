import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { getExecutor, getProviderAdapters } from '../../server/src/lib/executors/index.js';
import ollama from '../../server/src/lib/executors/ollama.js';
import {
  estimateMaxNumCtx,
  kvBytesPerToken,
  systemMemory,
} from '../../server/src/lib/executors/_ollama-client.js';
import { createToolbox } from '../../server/src/lib/executors/_ollama-tools.js';
import { executeProviderUsageAction } from '../../server/src/lib/provider-usage.js';

// Реальная фикстура qwen3.6:latest с машины пользователя: qwen35moe, 36B MoE,
// 24 ГБ весов на RTX 3070 8 ГБ (CPU-offload). head_count_kv: null — как отдаёт демон.
const QWEN35MOE_INFO = {
  'qwen35moe.context_length': 262144,
  'qwen35moe.block_count': 40,
  'qwen35moe.attention.head_count': 16,
  'qwen35moe.attention.head_count_kv': null,
  'qwen35moe.attention.key_length': 256,
  'qwen35moe.attention.value_length': 256,
};
const QWEN35MOE_SIZE = 23938333577;

// Stub демона Ollama: /api/version, /api/tags, /api/show, /api/ps и NDJSON-стрим
// /api/chat. Тела запросов к /api/chat складываем в массив — тесты проверяют, что ушло
// демону. tagsSize/showModelInfo/digestPrefix — для сценариев оценки памяти (кэш
// /api/show keyed по digest, поэтому тест с другим model_info берёт и свой префикс
// digest). capabilities — что модель умеет (от них зависят эффорт и инструменты),
// loaded — ответ /api/ps для всплывашки в топбаре.
function startOllamaStub(t, {
  chatBehavior, tagsSize, showModelInfo, digestPrefix = 'sha256:', capabilities, loaded,
} = {}) {
  const chatRequests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://stub');
    if (req.method === 'GET' && url.pathname === '/api/version') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ version: '0.6.2' }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/ps') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ models: loaded || [] }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/tags') {
      const size = tagsSize ? { size: tagsSize } : {};
      const caps = capabilities ? { capabilities } : {};
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        models: [
          { name: 'qwen3:14b', digest: `${digestPrefix}aaa`, ...size, ...caps, details: { family: 'qwen3', parameter_size: '14.8B', quantization_level: 'Q4_K_M' } },
          { name: 'qwen3:7b', digest: `${digestPrefix}bbb`, ...size, ...caps, details: { family: 'qwen3', parameter_size: '7B' } },
        ],
      }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/show') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ model_info: showModelInfo || { 'qwen3.context_length': 40960 } }));
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/chat') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const parsed = JSON.parse(body);
        chatRequests.push(parsed);
        if (parsed.stream === false) {
          // Так демон отвечает на выгрузку модели: один документ, а не NDJSON-поток.
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ model: parsed.model, done: true, done_reason: 'unload' }));
          return;
        }
        if (chatBehavior === 'tools') {
          // Первый раунд — вызов инструмента, второй — обычный текст: так проверяется
          // цикл «ответ → инструмент → ответ» целиком, включая роль tool в messages.
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
          const first = chatRequests.filter((r) => r.messages?.length).length === 1;
          res.end(`${JSON.stringify(first
            ? {
              message: {
                role: 'assistant',
                content: 'сейчас прочитаю файл',
                tool_calls: [{ function: { name: 'read_file', arguments: { path: 'note.txt' } } }],
              },
              done: true,
              prompt_eval_count: 100,
              eval_count: 5,
            }
            : {
              message: { role: 'assistant', content: 'В файле написано: привет' },
              done: true,
              // prompt_eval_count МЕНЬШЕ первого раунда (попадание в кэш промпта) —
              // проверяем, что расход контекста берёт максимум, а не последнее.
              prompt_eval_count: 40,
              eval_count: 9,
            })}\n`);
          return;
        }
        if (chatBehavior === 'hang') {
          // Ход, который не завершается: первый чанк есть, финала нет — для теста стопа.
          // Сокет не трогаем: его оборвёт abort клиента, а не завершение тела запроса.
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
          res.write(`${JSON.stringify({ message: { role: 'assistant', content: 'начал' }, done: false })}\n`);
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        res.end([
          JSON.stringify({ message: { role: 'assistant', thinking: 'сначала подумаю' }, done: false }),
          JSON.stringify({ message: { role: 'assistant', content: 'Привет' }, done: false }),
          JSON.stringify({ message: { role: 'assistant', content: ', мир!' }, done: false }),
          JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, prompt_eval_count: 120, eval_count: 7 }),
          '',
        ].join('\n'));
      });
      return;
    }
    res.writeHead(404);
    res.end('нет такого пути');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      t.after(() => new Promise((done) => server.close(done)));
      resolve({ server, port: server.address().port, chatRequests });
    });
  });
}

function fakeConfig(port) {
  return {
    // prefs специально несуществующий: выбор человека пуст → адрес берётся из env-config
    prefsPath: path.join(os.tmpdir(), 'cockpit-ollama-test-no-prefs.json'),
    ollamaBaseUrl: `http://127.0.0.1:${port}`,
  };
}

test('Ollama probe/auth идут в HTTP API демона, адаптер виден в обоих реестрах', async (t) => {
  const { port } = await startOllamaStub(t);
  const config = fakeConfig(port);

  assert.deepEqual(await ollama.probe(config), { ok: true, version: '0.6.2' });
  assert.deepEqual(await ollama.auth(config), {
    mode: 'none',
    label: 'локальный HTTP — авторизация не нужна',
    available: true,
  });

  assert.equal((await getProviderAdapters()).get('ollama'), ollama);
  assert.equal(await getExecutor('ollama'), ollama);
  assert.equal(ollama.order, 4);
  assert.equal(ollama.install, 'curl -fsSL https://ollama.com/install.sh | sh');
  assert.deepEqual(ollama.seedModels(), []);
  assert.equal(ollama.catalogLive, true);
  // Инструменты исполняет сам кокпит, поэтому режимы прав — свои, а не спрошенные у CLI.
  const modes = await ollama.modes(config);
  assert.deepEqual(modes.map((m) => m.id), ['plan', 'manual', 'auto', 'acceptEdits', 'dontAsk']);
  // Слэш-команд и автообновления у локального демона нет намеренно.
  assert.equal(ollama.commands, undefined);
  assert.equal(ollama.updateCmd, undefined);

  const declared = await ollama.settings(config); // settings — async-функция (контракт)
  const host = declared.find((s) => s.id === 'host');
  const numCtx = declared.find((s) => s.id === 'numCtx');
  const keepAlive = declared.find((s) => s.id === 'keepAliveMin');
  assert.equal(host.kind, 'text');
  assert.equal(numCtx.kind, 'range');
  assert.equal(numCtx.value, 32768);
  assert.equal(keepAlive.kind, 'range');
  assert.equal(keepAlive.value, 5);
  assert.equal(keepAlive.max, 60);
});

test('Ollama недоступный демон: probe/auth честно молчат, каталог не затирает прошлый', async (t) => {
  // Эфемерный порт открываем и тут же закрываем — слушателя гарантированно нет.
  const probe = http.createServer();
  await new Promise((done) => probe.listen(0, '127.0.0.1', done));
  const deadPort = probe.address().port;
  await new Promise((done) => probe.close(done));

  const config = fakeConfig(deadPort);
  assert.deepEqual(await ollama.probe(config), { ok: false, version: null });
  assert.equal((await ollama.auth(config)).available, false);
  assert.equal(await ollama.catalog(config), null);
});

test('Ollama catalog: модели из /api/tags, окно из /api/show, tier из размера', async (t) => {
  const { port } = await startOllamaStub(t);
  // maxNumCtx считается от живой памяти машины — ожидание выводим той же формулой.
  // stub-модели без size и block_count: дефолт 160 КБ/токен, потолок упирается в окно.
  const mem = await systemMemory();
  const maxNumCtx = estimateMaxNumCtx({
    contextLength: 40960, modelInfo: { 'qwen3.context_length': 40960 }, modelSizeBytes: undefined, mem,
  });
  const catalog = await ollama.catalog(fakeConfig(port));
  assert.deepEqual(catalog, [
    {
      id: 'qwen3:14b', name: 'qwen3:14b (14.8B, Q4_K_M)', context: 40960,
      maxNumCtx, tier: 14.8, efforts: [], family: 'qwen3',
    },
    {
      id: 'qwen3:7b', name: 'qwen3:7b (7B)', context: 40960,
      maxNumCtx, tier: 7, efforts: [], family: 'qwen3',
    },
  ]);
  assert.ok(maxNumCtx <= 40960); // потолок не выше родного окна stub-модели
});

test('Ollama catalog: эффорт объявляется только у думающих моделей и только бинарный', async (t) => {
  const { port } = await startOllamaStub(t, {
    capabilities: ['completion', 'tools', 'thinking', 'vision'],
    digestPrefix: 'sha256:caps-',
  });
  const catalog = await ollama.catalog(fakeConfig(port));
  // Замер: think low/medium/high демон принимает, но длина рассуждения от уровня не
  // зависит — три уровня были бы враньём слайдера, поэтому ровно два.
  assert.deepEqual(catalog.map((m) => m.efforts), [['low', 'high'], ['low', 'high']]);
});

test('Ollama run: история реплеится, хвостовой дубликат и note/error срезаются', async (t) => {
  const { port, chatRequests } = await startOllamaStub(t);
  const steps = [];
  const out = await ollama.run({
    config: fakeConfig(port),
    chatKey: 'chat-1',
    message: 'мета-префикс кокпита\nвторой вопрос',
    model: 'qwen3:14b',
    sessionId: 'ollama:chat-1',
    providerSettings: { numCtx: 8192 },
    chatHistory: [
      { role: 'user', text: 'первый вопрос' },
      { role: 'assistant', text: 'первый ответ' },
      { role: 'note', text: 'служебная плашка' },
      { role: 'error', text: 'старая ошибка' },
      { role: 'user', text: 'второй вопрос' }, // дубликат текущего (суффикс message)
    ],
    onStep: (step) => steps.push(step),
  });

  assert.equal(chatRequests.length, 1);
  const sent = chatRequests[0];
  assert.equal(sent.model, 'qwen3:14b');
  assert.equal(sent.stream, true);
  assert.equal(sent.options.num_ctx, 8192);
  assert.equal(sent.keep_alive, '5m'); // настройка не задана — дефолт держать 5 минут
  assert.equal(sent.tools, undefined); // stub-модель без capability tools
  assert.equal(sent.think, undefined); // и без thinking: поле не шлём вовсе
  assert.equal(sent.messages[0].role, 'system');
  assert.deepEqual(sent.messages.slice(1), [
    { role: 'user', content: 'первый вопрос' },
    { role: 'assistant', content: 'первый ответ' },
    { role: 'user', content: 'мета-префикс кокпита\nвторой вопрос' },
  ]);

  assert.equal(out.reply, 'Привет, мир!');
  assert.equal(out.sessionId, 'ollama:chat-1');
  assert.equal(out.contextTokens, 127); // 120 prompt + 7 eval из финального чанка
  assert.equal(out.contextWindow, 8192);
  assert.equal(out.cost, null);
  assert.equal(out.emptyRun, undefined); // автоповтор для HTTP-чата запрещён
  assert.ok(steps.some((s) => s.k === 'think' && s.text.includes('сначала подумаю')));
  assert.ok(steps.some((s) => s.k === 'text' && s.text.includes('Привет, мир!')));
});

test('Ollama run после сброса памяти (sessionId: null): история не реплеится, id синтетический', async (t) => {
  const { port, chatRequests } = await startOllamaStub(t);
  const out = await ollama.run({
    config: fakeConfig(port),
    chatKey: 'chat-2',
    message: 'свежий вопрос',
    model: 'qwen3:7b',
    sessionId: null,
    providerSettings: {},
    chatHistory: [{ role: 'user', text: 'старое, реплеить нельзя' }],
  });

  assert.deepEqual(chatRequests[0].messages.slice(1), [{ role: 'user', content: 'свежий вопрос' }]);
  assert.equal(chatRequests[0].options.num_ctx, 32768); // настройка не задана — дефолт
  assert.equal(out.sessionId, 'ollama:chat-2'); // кольцо контекста и кнопка сжатия живы
});

test('Ollama run: остановка кнопкой бросает stopped-ошибку с накопленным', async (t) => {
  const { port } = await startOllamaStub(t, { chatBehavior: 'hang' });
  const ac = new AbortController();
  const run = ollama.run({
    config: fakeConfig(port),
    chatKey: 'chat-3',
    message: 'долгий вопрос',
    model: 'qwen3:14b',
    sessionId: 'ollama:chat-3',
    signal: ac.signal,
    providerSettings: {},
    chatHistory: [],
  });
  setTimeout(() => ac.abort(), 100);

  await assert.rejects(run, (err) => {
    assert.equal(err.stopped, true);
    assert.equal(err.message, 'Ход остановлен.');
    assert.equal(err.sessionId, 'ollama:chat-3');
    return true;
  });
});

test('Ollama run: недоступный демон — понятная ошибка без emptyRun-автоповтора', async (t) => {
  const probe = http.createServer();
  await new Promise((done) => probe.listen(0, '127.0.0.1', done));
  const deadPort = probe.address().port;
  await new Promise((done) => probe.close(done));

  await assert.rejects(
    ollama.run({
      config: fakeConfig(deadPort),
      chatKey: 'chat-4',
      message: 'вопрос',
      model: 'qwen3:14b',
      sessionId: null,
      providerSettings: {},
      chatHistory: [],
    }),
    (err) => {
      assert.match(err.message, new RegExp(`демон Ollama не отвечает на http://127\\.0\\.0\\.1:${deadPort}`));
      assert.equal(err.stopped, undefined);
      return true;
    },
  );
});

test('kvBytesPerToken: суффиксный поиск ключей, GQA-эвристика при head_count_kv null', () => {
  // Реальный qwen3.6:latest пользователя: 40 слоёв × 4 KV-головы (ceil(16/4)) ×
  // (256+256) × 2 байта fp16 = 160 КБ/токен.
  assert.equal(kvBytesPerToken(QWEN35MOE_INFO), 40 * 4 * (256 + 256) * 2);
  // Типичная GQA-модель с явным head_count_kv (llama 8B): 32 × 8 × (128+128) × 2.
  assert.equal(kvBytesPerToken({
    'llama.block_count': 32,
    'llama.attention.head_count': 32,
    'llama.attention.head_count_kv': 8,
    'llama.attention.key_length': 128,
    'llama.attention.value_length': 128,
  }), 32 * 8 * (128 + 128) * 2);
  // Без block_count оценить нечего — caller берёт дефолт 160 КБ/токен.
  assert.equal(kvBytesPerToken({ 'qwen3.context_length': 40960 }), null);
});

test('estimateMaxNumCtx: бюджет VRAM+ОЗУ−веса, кламп в окно модели, округление до 1024', () => {
  // Сетап пользователя: RTX 3070 8 ГБ + 48 ГБ свободной ОЗУ, веса qwen3.6 (24 ГБ, offload).
  const mem = { freeVramBytes: 8 * 1024 ** 3, freeRamBytes: 48 * 1024 ** 3 };
  const budget = 8 * 1024 ** 3 + 0.6 * 48 * 1024 ** 3 - QWEN35MOE_SIZE;
  const expected = Math.floor(Math.floor(budget / (40 * 4 * 512 * 2)) / 1024) * 1024;
  const est = estimateMaxNumCtx({
    contextLength: 262144, modelInfo: QWEN35MOE_INFO, modelSizeBytes: QWEN35MOE_SIZE, mem,
  });
  assert.equal(est, expected);   // 94208
  assert.ok(est <= 262144);      // не выше родного окна модели
  assert.equal(est % 1024, 0);   // округление вниз до шага ползунка
  // Веса не влезают и в ОЗУ (бюджет отрицательный) → минимум ползунка.
  assert.equal(estimateMaxNumCtx({
    contextLength: 262144, modelInfo: QWEN35MOE_INFO, modelSizeBytes: QWEN35MOE_SIZE,
    mem: { freeVramBytes: 0, freeRamBytes: 1024 ** 3 },
  }), 2048);
  // model_info нет вовсе → потолок = родное окно; нет и его → дефолт 131072.
  assert.equal(estimateMaxNumCtx({ contextLength: 40960 }), 40960);
  assert.equal(estimateMaxNumCtx({}), 131072);
});

test('estimateMaxNumCtx: уже загруженная модель не вычитается из бюджета дважды', () => {
  // Та же машина ПОСЛЕ первого хода: модель в памяти, поэтому свободного мало —
  // 0.7 ГБ видеопамяти и 29 ГБ ОЗУ (живой замер). Без возврата занятого модели в бюджет
  // её веса вычитались бы второй раз, бюджет уходил в минус, и потолок падал до 2048:
  // разговор, начавшийся с окном 16k, на втором ходу молча ужимался до 2k и вырождался
  // в пустой ответ — модель не помещала в контекст даже свой системный блок.
  const args = { contextLength: 262144, modelInfo: QWEN35MOE_INFO, modelSizeBytes: QWEN35MOE_SIZE };
  const mem = { freeVramBytes: 0.7 * 1024 ** 3, freeRamBytes: 29 * 1024 ** 3 };
  assert.equal(estimateMaxNumCtx({ ...args, mem }), 2048); // как считалось раньше — обрыв
  const withLoaded = estimateMaxNumCtx({
    ...args, mem, loaded: { vramBytes: 5.2 * 1024 ** 3, ramBytes: 16.4 * 1024 ** 3 },
  });
  assert.ok(withLoaded > 60000, `потолок с учётом занятого моделью: ${withLoaded}`);
});

test('Ollama settings: numCtx — ползунок с потолком, вычисленным от памяти и весов', async (t) => {
  const { port } = await startOllamaStub(t);
  const mem = await systemMemory();
  const declared = await ollama.settings(fakeConfig(port));
  assert.deepEqual(declared.map((s) => [s.id, s.kind]), [
    ['host', 'text'], ['numCtx', 'range'], ['keepAliveMin', 'range'],
    // Справочные строки: своего контрола у них нет, фронт рисует подпись + note + hint.
    ['memInfo', 'info'], ['loadedInfo', 'info'], ['ctxCostInfo', 'info'],
  ]);
  assert.match(declared.find((s) => s.id === 'ctxCostInfo').note, /под KV-кэш/);
  assert.match(declared.find((s) => s.id === 'loadedInfo').note, /ничего не загружено/);
  const numCtx = declared.find((s) => s.id === 'numCtx');
  assert.equal(numCtx.min, 2048);
  assert.equal(numCtx.step, 1024);
  assert.equal(numCtx.value, 32768);
  // stub-модели без size и block_count: дефолт 160 КБ/токен, потолок упирается в окно.
  const expected = estimateMaxNumCtx({
    contextLength: 40960, modelInfo: { 'qwen3.context_length': 40960 }, modelSizeBytes: undefined, mem,
  });
  assert.equal(numCtx.max, expected);
  assert.ok(numCtx.max <= 40960);
});

test('Ollama run: оценка памяти ужимает окно, но не ниже рабочего минимума', async (t) => {
  // Веса больше всей памяти машины → оценка потолка выродилась в пол ползунка (2048).
  const { port, chatRequests } = await startOllamaStub(t, {
    tagsSize: 900 * 1024 ** 3, showModelInfo: QWEN35MOE_INFO, digestPrefix: 'sha256:tight-',
  });
  const steps = [];
  const out = await ollama.run({
    config: fakeConfig(port),
    chatKey: 'chat-tight',
    message: 'вопрос',
    model: 'qwen3:14b',
    sessionId: null,
    chatHistory: [],
    providerSettings: { numCtx: 32768 },
    onStep: (s) => steps.push(s),
  });
  // 2048 не ставим: в такое окно не влезает даже системный блок хода, и ответ выходит
  // пустым. Оценка — эвристика, а нехватку демон разложит на CPU, а не свалится.
  assert.equal(chatRequests[0].options.num_ctx, 8192); // настройка 32768 обрезана оценкой
  assert.equal(out.contextWindow, 8192);               // кольцо контекста — от фактического
  assert.ok(steps.some((s) => s.k === 'note' && /num_ctx ограничен до 8192/.test(s.text)));
});

test('Ollama settings: демон молчит — ползунок с дефолтным потолком 131072', async (t) => {
  const probe = http.createServer();
  await new Promise((done) => probe.listen(0, '127.0.0.1', done));
  const deadPort = probe.address().port;
  await new Promise((done) => probe.close(done));

  const declared = await ollama.settings(fakeConfig(deadPort));
  const numCtx = declared.find((s) => s.id === 'numCtx');
  assert.equal(numCtx.kind, 'range');
  assert.equal(numCtx.max, 131072);
});

test('Ollama run: эффорт high → think true, low → think false, не выбран → поля нет', async (t) => {
  const { port, chatRequests } = await startOllamaStub(t, {
    capabilities: ['completion', 'thinking'], digestPrefix: 'sha256:eff-',
  });
  const base = {
    config: fakeConfig(port), chatKey: 'chat-eff', message: 'вопрос',
    model: 'qwen3:14b', sessionId: null, providerSettings: {}, chatHistory: [],
  };
  await ollama.run({ ...base, effort: 'high' });
  await ollama.run({ ...base, effort: 'low' });
  await ollama.run({ ...base });
  assert.deepEqual(chatRequests.map((r) => r.think), [true, false, undefined]);
});

test('Ollama run: keep_alive из настройки исполнителя, 0 — выгружать сразу', async (t) => {
  const { port, chatRequests } = await startOllamaStub(t, { digestPrefix: 'sha256:ka-' });
  const base = {
    config: fakeConfig(port), chatKey: 'chat-ka', message: 'вопрос',
    model: 'qwen3:14b', sessionId: null, chatHistory: [],
  };
  await ollama.run({ ...base, providerSettings: { keepAliveMin: 30 } });
  await ollama.run({ ...base, providerSettings: { keepAliveMin: 0 } });
  assert.deepEqual(chatRequests.map((r) => r.keep_alive), ['30m', '0m']);
});

test('Ollama run: цикл инструментов — вызов, результат ролью tool, второй раунд отвечает', async (t) => {
  const { port, chatRequests } = await startOllamaStub(t, {
    chatBehavior: 'tools', capabilities: ['completion', 'tools'], digestPrefix: 'sha256:tools-',
  });
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-ollama-tools-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  await fs.writeFile(path.join(cwd, 'note.txt'), 'привет из файла\n', 'utf8');

  const steps = [];
  const out = await ollama.run({
    config: fakeConfig(port),
    chatKey: 'chat-tools',
    message: 'что в note.txt?',
    model: 'qwen3:14b',
    sessionId: null,
    providerSettings: {},
    chatHistory: [],
    cwd,
    permissionMode: 'plan', // читающему инструменту план не мешает
    onStep: (step) => steps.push(step),
  });

  assert.equal(chatRequests.length, 2, 'ход сделал два раунда: вызов и ответ');
  assert.ok(Array.isArray(chatRequests[0].tools), 'инструменты объявлены модели');
  assert.ok(chatRequests[0].tools.some((tool) => tool.function?.name === 'read_file'));
  // Второй раунд несёт ответ модели с tool_calls и результат ролью tool.
  const second = chatRequests[1].messages;
  assert.equal(second.at(-2).role, 'assistant');
  assert.deepEqual(second.at(-2).tool_calls[0].function.name, 'read_file');
  assert.equal(second.at(-1).role, 'tool');
  assert.equal(second.at(-1).tool_name, 'read_file');
  assert.match(second.at(-1).content, /привет из файла/);

  assert.equal(out.reply, 'В файле написано: привет');
  // Расход контекста — МАКСИМУМ prompt_eval по раундам (кэш промпта его уменьшает)
  // плюс сумма сгенерированного: 100 + (5 + 9).
  assert.equal(out.contextTokens, 114);
  assert.ok(steps.some((s) => s.k === 'tool' && s.name === 'Read'), 'вызов виден в ленте');
  assert.ok(steps.some((s) => s.k === 'res' && s.ok === true), 'результат виден в ленте');
});

test('Ollama инструменты: путь вне cwd и extraDirs отклоняется, ход не падает', async (t) => {
  const { port } = await startOllamaStub(t, {
    chatBehavior: 'tools', capabilities: ['completion', 'tools'], digestPrefix: 'sha256:sandbox-',
  });
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-ollama-sandbox-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));

  const steps = [];
  const out = await ollama.run({
    config: fakeConfig(port),
    chatKey: 'chat-sandbox',
    // Модель попросит note.txt (stub), но такого файла в cwd нет — ошибка инструмента
    // возвращается модели текстом, а не роняет ход. Отдельно проверяем сам гард пути.
    message: 'прочитай /etc/passwd',
    model: 'qwen3:14b',
    sessionId: null,
    providerSettings: {},
    chatHistory: [],
    cwd,
    onStep: (step) => steps.push(step),
  });
  assert.equal(out.reply, 'В файле написано: привет'); // ход дошёл до конца

  const toolbox = await createToolbox({ cwd, roots: [], permissionMode: 'dontAsk' });
  const outside = await toolbox.call({ name: 'read_file', args: { path: '/etc/passwd' } });
  assert.equal(outside.ok, false);
  assert.match(outside.text, /вне доступных каталогов/);
});

test('Ollama инструменты: режим «план» не даёт писать, отказ уходит модели текстом', async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-ollama-plan-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));

  const plan = await createToolbox({ cwd, roots: [], permissionMode: 'plan' });
  const write = await plan.call({ name: 'write_file', args: { path: 'new.txt', content: 'x' } });
  assert.equal(write.ok, false);
  assert.match(write.text, /только чтение/);
  const bash = await plan.call({ name: 'bash', args: { command: 'echo привет' } });
  assert.equal(bash.ok, false);
  assert.equal(await fs.access(path.join(cwd, 'new.txt')).then(() => true, () => false), false);

  // acceptEdits: правки молча, но команда всё равно спрашивает человека.
  const asked = [];
  const edits = await createToolbox({
    cwd, roots: [], permissionMode: 'acceptEdits',
    onPermission: (p) => { asked.push(p.tool); return { allow: false, comment: 'не надо' }; },
  });
  assert.equal((await edits.call({ name: 'write_file', args: { path: 'ok.txt', content: 'x' } })).ok, true);
  const denied = await edits.call({ name: 'bash', args: { command: 'echo привет' } });
  assert.deepEqual(asked, ['Bash']);
  assert.equal(denied.ok, false);
  assert.match(denied.text, /не надо/); // пояснение человека доезжает до модели
});

test('Ollama usage: полосы памяти, загруженные модели и действие выгрузки', async (t) => {
  const { port, chatRequests } = await startOllamaStub(t, {
    digestPrefix: 'sha256:usage-',
    loaded: [{
      name: 'qwen3.6:latest',
      size: 24 * 1024 ** 3,
      size_vram: 6 * 1024 ** 3,
      context_length: 8192,
      expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    }],
  });
  const config = fakeConfig(port);
  const usage = await ollama.usage(config);

  assert.equal(usage.state, 'ok');
  assert.ok(usage.bars.some((b) => b.key === 'ram'), 'полоса ОЗУ есть на любой машине');
  const daemon = usage.resources.find((r) => r.key === 'daemon');
  assert.equal(daemon.summary, 'версия 0.6.2');
  assert.equal(daemon.note, `http://127.0.0.1:${port}`);

  // Имя модели («qwen3.6:latest») в ключ не годится: контракт ресурсов пропускает
  // только [a-z0-9_-]. Поэтому ключи нумерованные, а имя живёт в подписи.
  const model = usage.resources.find((r) => r.key === 'loaded-1');
  assert.equal(model.label, 'qwen3.6:latest');
  assert.match(model.summary, /6.0 ГБ в видеопамяти \+ 18 ГБ в ОЗУ/);
  assert.equal(Math.round(model.percent), 25);
  assert.match(model.note, /окно 8[\s ]?192 токенов/);
  assert.match(model.note, /выгрузится через 5 мин/);
  assert.equal(model.controls[0].action, 'unload-model');
  assert.deepEqual(model.controls[0].payload, { model: 'qwen3.6:latest' });
  assert.ok(model.controls[0].confirm.text.includes('24 ГБ'));

  // Действие идёт общим путём ядра и обязано быть объявлено в usageActions.
  assert.deepEqual(
    await executeProviderUsageAction(ollama, {
      actionId: 'unload-model', payload: { model: 'qwen3.6:latest' }, requestId: 'req-1', config,
    }),
    { ok: true },
  );
  const unload = chatRequests.at(-1);
  assert.equal(unload.keep_alive, 0);
  assert.deepEqual(unload.messages, []);
  // Незаявленный ключ ядро не исполняет вовсе — это и есть весь контроль доступа.
  assert.deepEqual(
    await executeProviderUsageAction(ollama, { actionId: 'нет-такого', payload: {}, requestId: 'r', config }),
    { ok: false, error: 'unknown_usage_action' },
  );
});

test('Ollama usage: демон молчит — состояние unavailable, а не пустые полосы', async () => {
  const probe = http.createServer();
  await new Promise((done) => probe.listen(0, '127.0.0.1', done));
  const deadPort = probe.address().port;
  await new Promise((done) => probe.close(done));

  const usage = await ollama.usage(fakeConfig(deadPort));
  assert.equal(usage.state, 'unavailable');
  assert.match(usage.message, /не отвечает/);
  assert.deepEqual(usage.bars, []);
});
