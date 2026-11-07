import assert from 'node:assert/strict';
import {
  promises as fs
} from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import adapter from '../../server/src/lib/executors/gigacode.ts';
import { launch } from '../helpers/gigacode/factory.mjs';
import {
  makeGigaCodeFixture,
  MODEL_A
} from '../helpers/gigacode/fixture.mjs';
import {
  chatAppFixture,
  saveChat,
  turnBody,
  waitFor
} from './helpers/chat-turns.js';
import {
  chatStoreFixture,
  sseOf
} from '../web/helpers/chat-store.js';

const modelRef = {
  provider: 'gigacode',
  model: MODEL_A
};

/**
 * Поднимается настоящий chat module с настоящим адаптером; подмена только внешний CLI.
 * Каталог внедрён явно, чтобы тест не обнаруживал соседние установленные провайдеры.
 */
async function world(t, scenario = {}) {
  const fixture = await makeGigaCodeFixture(t, {
    captureRequests: true,
    ...scenario
  });
  const windows = new Set();
  const api = await chatAppFixture(t, {
    executor: adapter,
    auth: scenario.authGuard ? {
      authStore: {
        isConfigured: () => true,
        isValidSession: () => false
      },
    } : null,
    root: fixture.root,
    configOverrides: fixture.config,
    modelsRegistry: async () => ({
      gigacode: [{
        id: MODEL_A,
        efforts: []
      }]
    }),
    onEvent: (event, data) => {
      for (const receive of windows) {
        setImmediate(() => receive(event, structuredClone(data)));
      }
    },
  });

  /**
   * Каждый запрос проходит стандартный API и его JSON-контракт ошибок.
   * Store после F5 читает общую историю и pending тем же путём, что рабочее окно.
   */
  async function request(method, url, body) {
    const response = await api.app.inject({
      method,
      url,
      ...(body ? {
        payload: body
      } : {})
    });
    const data = response.json();

    if (response.statusCode >= 400) {
      throw Object.assign(new Error(data.message || data.error), {
        status: response.statusCode,
        data
      });
    }

    return data;
  }

  return {
    ...fixture,
    ...api,
    requests: async () => {
      const raw = await fs.readFile(path.join(fixture.workspace, 'requests.jsonl'), 'utf8').catch(
        () => '');

      return raw.trim().split('\n').filter(Boolean).map(JSON.parse);
    },
    openWindow: async () => {
      const store = await chatStoreFixture({}, {
        fromServer: true,
        api: {
          get: (url) => request('GET', url),
          post: (url, body) => request('POST', url, body),
          put: (url, body) => request('PUT', url, body),
          del: (url, body) => request('DELETE', url, body),
        },
      });
      const receive = sseOf(store);

      windows.add(receive);

      return {
        store,
        close: () => windows.delete(receive)
      };
    },
  };
}

test('обновлённый CLI сохраняет фактическую версию в metadata чатового хода', async (t) => {
  const w = await world(t, {
    cliVersion: '26.8.0',
    packageVersion: '0.14.0',
  });

  await saveChat(w.app, 'gigacode-version', {
    modelRef,
    model: MODEL_A,
    workdir: {
      kind: 'path',
      path: w.workspace,
    },
  });

  const response = await w.app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: turnBody('gigacode-version', 'synthetic-version-turn', 'synthetic version', {
      modelRef,
      model: MODEL_A,
      cwd: w.workspace,
    }),
  });

  assert.equal(response.statusCode, 202, response.body);
  await waitFor(() => w.events.some((entry) => entry.event === 'chat-run-metadata'
    || entry.event === 'chat-done'));

  const metadata = w.events.find((entry) => entry.event === 'chat-run-metadata');

  assert.ok(metadata, JSON.stringify(w.events));
  assert.equal(metadata.data.snapshot.cliVersion, '26.8.0');
  await waitFor(() => w.events.some((entry) => entry.event === 'chat-done'));
});

test('очередь A→B без окна и ACK передаёт актуальный ответ A в prompt B ровно один раз', async (t) => {
  const w = await world(t, {
    delays: {
      'session/prompt': 300
    }
  });

  await saveChat(w.app, 'gigacode-queue', {
    modelRef,
    model: MODEL_A,
    workdir: {
      kind: 'path',
      path: w.workspace
    },
  });

  const send = (turnId, message) => w.app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: turnBody('gigacode-queue', turnId, message, {
      modelRef,
      model: MODEL_A,
      cwd: w.workspace
    }),
  });
  const accepted = await send('synthetic-turn-a', 'Вопрос A');

  assert.equal(accepted.statusCode, 202, accepted.body);
  assert.equal((await send('synthetic-turn-b', 'Вопрос B')).statusCode, 202);
  assert.equal((await send('synthetic-turn-b', 'Вопрос B')).statusCode, 202);

  await waitFor(async () => {
    const pending = (await w.app.inject({
      method: 'GET',
      url: '/api/chat/pending'
    })).json().pending;

    return pending.length === 2;
  }, {
    timeoutMs: 10000,
    what: 'два завершённых хода'
  });

  const prompts = (await w.requests()).filter((entry) => entry.message?.method ===
    'session/prompt');
  const second = prompts[1].message.params.prompt[0].text;

  assert.equal(prompts.length, 2);
  assert.equal(second.split('Ответ fixture').length, 2);
  assert.equal(second.split('Вопрос B').length, 2);
  assert.match(second, /Вопрос A/u);
});

test('F5: настоящий store получает pending, убирает «Пишет» и не дублирует историю', async (t) => {
  const w = await world(t, {
    delays: {
      'session/prompt': 300
    }
  });

  await saveChat(w.app, 'gigacode-f5', {
    modelRef,
    model: MODEL_A,
    workdir: {
      kind: 'path',
      path: w.workspace
    },
  });

  const first = await w.openWindow();

  await first.store.send('gigacode-f5', 'Первый вопрос');
  first.close();

  await waitFor(async () => (await w.requests()).some((entry) => entry.message?.method ===
    'session/prompt'), {
    what: 'CLI получил prompt',
  });
  await waitFor(async () => {
    const result = await w.app.inject({
      method: 'GET',
      url: '/api/chat/pending'
    });

    return result.json().pending.length === 1;
  }, {
    what: 'итог в pending'
  });

  const reloaded = await w.openWindow();

  t.after(() => reloaded.close());
  await waitFor(() => reloaded.store.session('gigacode-f5').messages
    .some((message) => message.role === 'assistant' && message.text === 'Ответ fixture'), {
      what: 'ответ после F5',
    });
  assert.equal(reloaded.store.session('gigacode-f5').sending, false);
  assert.equal(reloaded.store.session('gigacode-f5').messages
    .filter((message) => message.role === 'assistant').length, 1);
});

test('общий auth guard отклоняет GigaCode API до создания CLI', async (t) => {
  const w = await world(t, {
    authGuard: true
  });
  const response = await w.app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: turnBody('synthetic-auth', 'synthetic-auth-turn', 'hello', {
      modelRef,
      model: MODEL_A
    }),
  });

  assert.equal(response.statusCode, 401);
  assert.deepEqual(await w.requests(), []);
  assert.equal(w.events.length, 0);
});

test('ошибка после текста сохраняется в pending вместе с частичной лентой', async (t) => {
  const w = await world(t, {
    promptError: {
      code: -32603,
      message: 'Synthetic failure after text'
    }
  });

  await saveChat(w.app, 'gigacode-error', {
    modelRef,
    model: MODEL_A,
    workdir: {
      kind: 'path',
      path: w.workspace
    },
  });
  await w.app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: turnBody('gigacode-error', 'synthetic-error-turn', 'hello', {
      modelRef,
      model: MODEL_A
    }),
  });

  const pending = await waitFor(async () => {
    const records = (await w.app.inject({
      method: 'GET',
      url: '/api/chat/pending'
    })).json().pending;

    return records[0];
  }, {
    what: 'ошибка в pending'
  });

  assert.equal(pending.role, 'error');
  assert.match(pending.reply, /Synthetic failure after text/u);
  assert.ok(pending.steps.some((step) => step.k === 'text' && step.text === 'Ответ fixture'));
});

test('API Stop чата не затрагивает параллельную Factory; следующий ход завершается', async (t) => {
  const w = await world(t, {
    waitForCancel: true,
    ignoreTerm: true,
    hangOnClose: true,
  });
  const chatKey = 'gigacode-stop';

  await saveChat(w.app, chatKey, {
    modelRef,
    model: MODEL_A,
    workdir: { kind: 'path', path: w.workspace },
  });

  const accepted = await w.app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: turnBody(chatKey, 'synthetic-stop-turn', 'Остановить этот ход', { modelRef, model: MODEL_A }),
  });

  assert.equal(accepted.statusCode, 202, accepted.body);
  await waitFor(async () => (await w.requests()).some((entry) =>
    entry.message?.method === 'session/prompt'));

  let factoryStarted = false;
  const factory = launch(t, {
    updates: [{
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Ответ стадии' },
    }],
    mcpCalls: [{
      tool: 'stage_result',
      arguments: { result: 'done' },
      delayAfterMs: 1000,
    }],
  }, {}, {
    onObserve: (entry) => {
      if (entry.method === 'session/prompt') {
        factoryStarted = true;
      }
    },
  });

  await waitFor(() => factoryStarted);

  const stopped = await w.app.inject({
    method: 'POST',
    url: '/api/chat/stop',
    payload: { chatKey },
  });

  assert.equal(stopped.json().ok, true, stopped.body);
  await waitFor(() => w.events.some((entry) => entry.event === 'chat-done'));
  assert.deepEqual((await w.app.inject('/api/chat/active')).json().active, []);

  const stage = await factory;

  assert.equal(stage.result.code, undefined, `${stage.result.stdout}\n${stage.result.stderr}`);
  assert.match(stage.result.stdout, /^RESULT=done$/mu);
  assert.equal(stage.last, 'Ответ стадии');

  const chatSession = (await w.requests()).find((entry) => entry.message?.method === 'session/new');
  const stageSession = stage.requests.find((entry) => entry.message?.method === 'session/new');

  assert.notEqual(chatSession.message.params.cwd, stageSession.message.params.cwd);
  assert.notEqual(stage.root, w.root);

  const chatPrompt = (await w.requests()).find((entry) => entry.message?.method === 'session/prompt');
  const stagePrompt = stage.requests.find((entry) => entry.message?.method === 'session/prompt');

  assert.notEqual(chatPrompt.message.params.sessionId, stagePrompt.message.params.sessionId);
  assert.equal(stageSession.message.params.mcpServers[0].name, 'factory-status');
  assert.equal(chatSession.message.params.mcpServers.some((server) =>
    server.name === 'factory-status'), false);

  const scenario = JSON.parse(await fs.readFile(w.scenarioFile, 'utf8'));

  await fs.writeFile(w.scenarioFile, JSON.stringify({
    ...scenario,
    waitForCancel: false,
    ignoreTerm: false,
    hangOnClose: false,
  }));
  await w.app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: turnBody(chatKey, 'synthetic-after-stop', 'Продолжить', { modelRef, model: MODEL_A }),
  });
  await waitFor(() => w.events.filter((entry) => entry.event === 'chat-done').length === 2);
  assert.deepEqual((await w.app.inject('/api/chat/active')).json().active, []);

  const pending = (await w.app.inject('/api/chat/pending')).json().pending;

  assert.equal(pending.length, 2);
  assert.equal(pending.find((entry) => entry.turnId === 'synthetic-after-stop').reply, 'Ответ fixture');
  assert.equal((await w.requests()).filter((entry) => entry.message?.method === 'session/prompt').length, 2);
});
