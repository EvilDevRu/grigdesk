// Десять одновременных ходов в разных чатах через настоящий HTTP/1.1-сокет и пул
// соединений размером с лимит браузера на хост (шесть, один из них — общий SSE вкладки).
// Раньше каждый POST хода держал соединение до конца работы агента: пятый ход забирал
// последний сокет, и метрики, «стоп» и ответы на спросы вставали в очередь браузера.
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import {
  chatAppFixture,
  controlledExecutor,
  TEST_MODEL_REF,
  turnBody,
  waitFor,
} from './helpers/chat-turns.js';

// Chrome держит не больше шести соединений HTTP/1.1 на один хост.
const BROWSER_SOCKETS_PER_HOST = 6;

/**
 * Мини-клиент поверх общего пула соединений, как вкладка браузера поверх своего:
 * запросы сверх шести ждут свободного сокета в очереди агента, а не уходят сразу.
 */
function browserLikeClient(port) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: BROWSER_SOCKETS_PER_HOST });

  function request(method, url, body) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
      const req = http.request({
        host: '127.0.0.1',
        port,
        method,
        path: url,
        agent,
        headers: payload
          ? { 'content-type': 'application/json', 'content-length': payload.length }
          : {},
      }, (res) => {
        const chunks = [];

        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');

          resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null });
        });
      });

      req.on('error', reject);

      if (payload) {
        req.write(payload);
      }

      req.end();
    });
  }

  /**
   * Общий поток событий вкладки: держит одно соединение пула всё время. События
   * копятся в events, hello разрешается с первым приветствием сервера.
   */
  function stream(url) {
    const events = [];
    let resolveHello;
    const hello = new Promise((resolve) => {
      resolveHello = resolve;
    });
    const options = {
      host: '127.0.0.1',
      port,
      method: 'GET',
      path: url,
      agent,
    };
    const req = http.request(options, (res) => {
      let buffer = '';

      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;

        const blocks = buffer.split('\n\n');

        buffer = blocks.pop();

        for (const block of blocks) {
          const name = block.match(/^event: (.+)$/m)?.[1];
          const data = block.match(/^data: (.+)$/m)?.[1];

          if (!name) {
            continue;
          }

          events.push({ event: name, data: data ? JSON.parse(data) : null });

          if (name === 'hello') {
            resolveHello();
          }
        }
      });
    });

    req.on('error', () => {});
    req.end();

    return { events, hello };
  }

  return {
    request,
    stream,
    close: () => agent.destroy(),
  };
}

// Ждать ответа не дольше ms: зависший запрос превращается в понятную ошибку с именем
// ожидаемого, а время ответа возвращается вместе со значением.
async function within(promise, ms, what) {
  let timer;
  const started = Date.now();
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: нет ответа за ${ms} мс`)), ms);
  });

  try {
    const value = await Promise.race([promise, timeout]);

    return { value, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

test('десять перекрывающихся ходов: метрики, стоп, спросы доступны во время работы', async (t) => {
  const { executor, runs, waitForRuns } = controlledExecutor();
  const { app, events } = await chatAppFixture(t, {
    executor,
    withSsePlugin: true,
    extraRoutes: async (instance) => {
      instance.get('/api/system', async () => ({ cpu: { percent: 7 }, mem: { percent: 30 } }));
    },
  });

  await app.listen({ port: 0, host: '127.0.0.1' });

  const client = browserLikeClient(app.server.address().port);

  t.after(() => client.close());

  const tab = client.stream('/api/events');

  await within(tab.hello, 2000, 'hello общего потока');

  const chats = Array.from({ length: 10 }, (_, index) => `par-${index}`);
  const sends = chats.map(async (chatKey, index) => {
    const saved = await client.request('PUT', '/api/chat/store/chat', {
      chat: {
        id: chatKey,
        title: `Параллельный ${index}`,
        model: TEST_MODEL_REF.model,
        modelRef: TEST_MODEL_REF,
        messages: [{
          role: 'user',
          text: `вопрос ${index}`,
          sentAt: Date.now(),
        }],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        revision: 0,
      },
    });

    assert.equal(saved.status, 200);

    const body = turnBody(chatKey, `turn-par-${index}-000`, `вопрос ${index}`);

    return client.request('POST', '/api/chat', body);
  });

  const { value: accepted } = await within(Promise.all(sends), 3000, 'приём десяти ходов');

  assert.deepEqual(accepted.map((response) => response.status), Array(10).fill(202));
  await waitForRuns(10);

  const metrics = await within(client.request('GET', '/api/system'), 1000, 'метрики во время ходов');

  assert.equal(metrics.value.status, 200);
  assert.equal(metrics.value.body.cpu.percent, 7);

  // Запуски стартуют в порядке приёма, а не номеров чатов: ищем ход по его чату.
  const runOf = (chatKey) => runs.find((run) => run.chatKey === chatKey);
  const permission = runOf('par-3').ask({ tool: 'Bash', input: { command: 'ls' } });
  const question = runOf('par-4').ask({
    isQuestion: true,
    questions: [{ question: 'Какой вариант?', options: [{ label: 'Первый' }, { label: 'Второй' }] }],
  });
  const waiting = await within(client.request('GET', '/api/chat/waiting'), 1000, 'список спросов');
  const byChat = Object.fromEntries(waiting.value.body.waiting.map((item) => [item.chatKey, item]));

  assert.ok(byChat['par-3'] && byChat['par-4'], 'оба спроса видны окну');

  const allowed = await within(
    client.request('POST', `/api/chat/permission/${byChat['par-3'].pid}`, { allow: true }),
    1000,
    'ответ на разрешение',
  );

  assert.equal(allowed.value.status, 200);
  assert.equal((await permission).allow, true);

  const answered = await within(
    client.request('POST', `/api/chat/permission/${byChat['par-4'].pid}`, {
      answers: [{ question: 'Какой вариант?', selected: ['Второй'] }],
    }),
    1000,
    'ответ на вопрос',
  );

  assert.equal(answered.value.status, 200);
  assert.deepEqual((await question).selected, ['Второй']);

  const stopped = await within(client.request('POST', '/api/chat/stop', { chatKey: 'par-0' }), 1000, 'стоп');

  assert.equal(stopped.value.body.ok, true);

  for (const run of runs.filter((item) => item.chatKey !== 'par-0')) {
    run.release(`Ответ ${run.chatKey}`);
  }

  const pending = await waitFor(async () => {
    const response = await client.request('GET', '/api/chat/pending');

    return response.body.pending.length === 10 ? response.body.pending : null;
  }, { what: 'десять итогов' });

  assert.deepEqual(
    pending.map((item) => item.chatKey).sort(),
    [...chats].sort(),
    'у каждого чата ровно один итог',
  );
  assert.equal(pending.find((item) => item.chatKey === 'par-0').stopped, true);
  await waitFor(
    () => tab.events.filter((entry) => entry.event === 'chat-done').length === 10,
    { what: 'chat-done по всем ходам в общем потоке' },
  );
  assert.equal(events.filter((entry) => entry.event === 'chat-turn-start').length, 10);
});
