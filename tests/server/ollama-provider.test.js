import assert from 'node:assert/strict';
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

// Stub демона Ollama: /api/version, /api/tags, /api/show и NDJSON-стрим /api/chat.
// Тела запросов к /api/chat складываем в массив — тесты проверяют, что ушло демону.
// tagsSize/showModelInfo/digestPrefix — для сценариев оценки памяти (кэш /api/show
// keyed по digest, поэтому тест с другим model_info берёт и свой префикс digest).
function startOllamaStub(t, { chatBehavior, tagsSize, showModelInfo, digestPrefix = 'sha256:' } = {}) {
  const chatRequests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://stub');
    if (req.method === 'GET' && url.pathname === '/api/version') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ version: '0.6.2' }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/tags') {
      const size = tagsSize ? { size: tagsSize } : {};
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        models: [
          { name: 'qwen3:14b', digest: `${digestPrefix}aaa`, ...size, details: { family: 'qwen3', parameter_size: '14.8B', quantization_level: 'Q4_K_M' } },
          { name: 'qwen3:7b', digest: `${digestPrefix}bbb`, ...size, details: { family: 'qwen3', parameter_size: '7B' } },
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
  // Простой чат: режимов прав, эффорта, слэш-команд и автообновления нет намеренно.
  assert.equal(ollama.modes, undefined);
  assert.equal(ollama.commands, undefined);
  assert.equal(ollama.updateCmd, undefined);

  const declared = await ollama.settings(config); // settings — async-функция (контракт)
  const host = declared.find((s) => s.id === 'host');
  const numCtx = declared.find((s) => s.id === 'numCtx');
  assert.equal(host.kind, 'text');
  assert.equal(numCtx.kind, 'range');
  assert.equal(numCtx.value, 32768);
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
  assert.deepEqual(sent.messages, [
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

  assert.deepEqual(chatRequests[0].messages, [{ role: 'user', content: 'свежий вопрос' }]);
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

test('Ollama settings: numCtx — ползунок с потолком, вычисленным от памяти и весов', async (t) => {
  const { port } = await startOllamaStub(t);
  const mem = await systemMemory();
  const declared = await ollama.settings(fakeConfig(port));
  assert.deepEqual(declared.map((s) => [s.id, s.kind]), [['host', 'text'], ['numCtx', 'range']]);
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

test('Ollama run: num_ctx клампится по per-model оценке памяти, note + contextWindow', async (t) => {
  // Веса заведомо не влезают в память любой машины → потолок схлопывается до минимума
  // ползунка независимо от железа, на котором гоняют тест.
  const { port, chatRequests } = await startOllamaStub(t, {
    tagsSize: 500 * 1024 ** 3,
    showModelInfo: QWEN35MOE_INFO,
    digestPrefix: 'sha256:clamp-',
  });
  const steps = [];
  const out = await ollama.run({
    config: fakeConfig(port),
    chatKey: 'chat-clamp',
    message: 'вопрос',
    model: 'qwen3:14b',
    sessionId: null,
    providerSettings: { numCtx: 65536 },
    chatHistory: [],
    onStep: (step) => steps.push(step),
  });

  assert.equal(chatRequests[0].options.num_ctx, 2048); // настройка 65536 обрезана оценкой
  assert.equal(out.contextWindow, 2048);               // кольцо контекста — от фактического
  const note = steps.find((s) => s.k === 'note');
  assert.ok(note, 'в ленте хода есть note о клампе');
  assert.match(note.text, /num_ctx ограничен до 2048/);
});
