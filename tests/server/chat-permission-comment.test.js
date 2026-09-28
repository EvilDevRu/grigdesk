// Пояснение к отказу: модалка «Доработать»/«Отклонить» шлёт comment, и сервер вкладывает
// его в deny-message агенту (тот же канал, что у ответов на вопросы). Без пояснения —
// прежний дефолтный текст.
//
// Второй половиной файла проверен ПРЯМОЙ канал (исполнитель ждёт ответа сам: ACP у Kimi,
// цикл инструментов у Ollama). Дойдёт ли свободный текст — свойство канала, а не вендора:
// ACP-outcome несёт только выбранный optionId, поэтому сервер отвечает окну
// commentDelivered/textDelivered:false, и текст уедет отдельным сообщением (см. стор чата).
import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import chatModule from '../../server/src/modules/chat/index.ts';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

async function apiFixture(t, executor = null) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-chat-perm-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const app = Fastify({ logger: false });
  const events = [];
  app.decorate('sse', { broadcast(name, payload) { events.push({ name, payload }); } });
  const config = {
    chatsDir: path.join(root, 'chats'),
    chatStoreLegacyPath: path.join(root, 'legacy.json'),
    chatBindingsDir: path.join(root, 'bindings'),
    rootDir: root,
    factoryHome: root,
    agentsDir: path.join(root, 'agents'),
    port: 18140,
  };

  await app.register(chatModule, {
    config,
    factoryState: { async readEnv() { return {}; } },
    prefs: {
      read() {
        return { providerSettings: {}, chatAutoCompactWindow: 0 };
      }
    },
    claudeAuth: null,
    internalToken: 'test',
    modelsRegistry: async () => ({
      claude: [{ id: 'claude-test', efforts: [] }],
      fake: [{ id: 'fake-1', efforts: [] }],
    }),
    executorResolver: async (provider) => (provider === 'fake' ? executor : null),
  });
  t.after(() => app.close());
  return { app, events };
}

// Поднимает запрос разрешения (висит, как в бою), находит его pid в «SSE»-трансляции
// и отвечает на него как браузер. Возвращает тело, которое получил агент, и ack фронту.
async function answerPermission(t, { tool, input, answer }) {
  const { app, events } = await apiFixture(t);
  const pending = app.inject({
    method: 'POST',
    url: '/api/chat/permission-request',
    payload: { tool_name: tool, input, chatKey: 'c1' },
  });
  let ev;
  for (let i = 0; i < 10 && !ev; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    ev = events.find((e) => e.name === 'chat-permission');
  }
  assert.ok(ev, 'запрос разрешения дошёл до окон');
  const ack = await app.inject({
    method: 'POST',
    url: `/api/chat/permission/${ev.payload.pid}`,
    payload: answer,
  });
  assert.equal(ack.statusCode, 200);
  const response = await pending;
  assert.equal(response.statusCode, 200);
  return { body: response.json(), ack: ack.json() };
}

test('план на доработку с пояснением: агент получает и причину, и текст замечания', async (t) => {
  const { body } = await answerPermission(t, {
    tool: 'ExitPlanMode',
    input: { plan: 'Шаг 1. Сделать' },
    answer: { allow: false, comment: 'убери лишний шаг' },
  });
  assert.equal(body.behavior, 'deny');
  assert.match(body.message, /на доработку/);
  assert.match(body.message, /убери лишний шаг/);
});

test('отклонение обычного действия с пояснением: пояснение в deny-message', async (t) => {
  const { body } = await answerPermission(t, {
    tool: 'Bash',
    input: { command: 'rm -rf build' },
    answer: { allow: false, comment: 'опасная команда' },
  });
  assert.equal(body.behavior, 'deny');
  assert.match(body.message, /отклонил действие/);
  assert.match(body.message, /опасная команда/);
});

test('отказ без пояснения: прежний дефолтный текст без изменений', async (t) => {
  const { body } = await answerPermission(t, {
    tool: 'ExitPlanMode',
    input: { plan: 'Шаг 1' },
    answer: { allow: false },
  });
  assert.deepEqual(body, { behavior: 'deny', message: 'Пользователь отклонил действие в кокпите' });
});

test('разрешение по-прежнему проходит в allow-ветку с updatedInput', async (t) => {
  const { body, ack } = await answerPermission(t, {
    tool: 'Bash',
    input: { command: 'ls' },
    answer: { allow: true },
  });
  assert.deepEqual(body, { behavior: 'allow', updatedInput: { command: 'ls' } });
  assert.deepEqual(ack, { ok: true });
});

// ── Прямой канал: исполнитель ждёт ответа сам (ACP Kimi, цикл инструментов Ollama) ──
// Локального MCP-процесса здесь нет, ответ возвращается прямо из onPermission. Форма
// ответа другая, и вместе с ней меняется главное: доедет ли до агента свободный текст.

/**
 * Поднимает ход поддельного исполнителя, который на старте спрашивает разрешение
 * (или задаёт вопрос) и возвращает полученный ответ. Тест отвечает на спрос так же,
 * как браузер: находит pid в «SSE»-трансляции и постит решение человека.
 */
async function askDirectly(t, { presentation, answer }) {
  let deliver = null;
  const asked = new Promise((resolve) => { deliver = resolve; });
  const executor = {
    id: 'fake',
    async run(args) {
      const outcome = await args.onPermission(presentation);
      deliver(outcome);
      return { reply: 'готово', sessionId: 'sess-1' };
    },
  };
  const { app, events } = await apiFixture(t, executor);
  const turn = app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: { message: 'сделай', modelRef: { provider: 'fake', model: 'fake-1' } },
  });
  const want = presentation.isQuestion ? 'chat-question' : 'chat-permission';
  let ev;

  for (let i = 0; i < 500 && !ev; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    ev = events.find((e) => e.name === want);
  }
  assert.ok(ev, `спрос дошёл до окон событием ${want}`);
  const ack = await app.inject({
    method: 'POST',
    url: `/api/chat/permission/${ev.payload.pid}`,
    payload: answer,
  });
  assert.equal(ack.statusCode, 200);
  const turnResponse = await turn;
  assert.equal(turnResponse.statusCode, 200);
  return { outcome: await asked, ack: ack.json(), event: ev.payload };
}

test('прямой канал: отказ отдаётся исполнителю решением, а не deny-сообщением', async (t) => {
  const { outcome, ack } = await askDirectly(t, {
    presentation: {
      tool: 'Bash',
      acceptsComment: true,
      input: { kind: 'execute', command: 'rm -rf build' },
    },
    answer: { allow: false, comment: 'опасная команда' },
  });
  assert.deepEqual(outcome, { allow: false, comment: 'опасная команда', remember: false, choice: '' });
  // Канал текст несёт — фронту дублировать пояснение сообщением не нужно.
  assert.deepEqual(ack, { ok: true });
});

test('прямой канал без текстового обратного хода: пояснение помечено недоставленным', async (t) => {
  const { outcome, ack } = await askDirectly(t, {
    presentation: {
      tool: 'Plan',
      acceptsComment: false, // ACP-outcome Kimi несёт только выбранный optionId
      input: { plan: 'Шаг 1', choices: [{ id: 'plan_revise', label: 'Revise plan', kind: 'reject_once' }] },
    },
    answer: { allow: false, comment: 'сначала тесты', choice: 'plan_revise' },
  });
  assert.equal(outcome.choice, 'plan_revise', 'нажатая кнопка плана доехала до исполнителя');
  assert.equal(outcome.comment, 'сначала тесты');
  assert.deepEqual(ack, { ok: true, commentDelivered: false },
    'фронт обязан узнать, что текст не доехал, и отправить его обычным сообщением');
});

test('прямой канал: «разрешать до конца сессии» едет вариантом ответа, а не политикой кокпита', async (t) => {
  const { outcome, ack } = await askDirectly(t, {
    presentation: { tool: 'Bash', acceptsComment: true, input: { kind: 'execute', command: 'ls' } },
    answer: { allow: true, remember: true },
  });
  assert.deepEqual(outcome, { allow: true, comment: '', remember: true, choice: '' });
  assert.deepEqual(ack, { ok: true });
});

test('вопрос по прямому каналу: свой текст без канала для него помечен недоставленным', async (t) => {
  const questions = [{
    question: 'Каким путём чинить?',
    header: 'Путь',
    options: [{ label: 'Первый' }, { label: 'Второй' }],
    multiSelect: false,
    allowFreeText: false,
    hint: 'ACP-мост Kimi принимает ровно один вариант',
  }];
  const { outcome, ack, event } = await askDirectly(t, {
    presentation: { isQuestion: true, acceptsText: false, questions },
    answer: { answers: [{ header: 'Путь', selected: ['Первый'], text: 'а лучше третий' }] },
  });
  // Ограничения канала обязаны доехать до окна: без них всплывашка нарисовала бы
  // и чекбоксы, и поле своего ответа, которых этот канал не поддерживает.
  assert.equal(event.questions[0].allowFreeText, false);
  assert.match(event.questions[0].hint, /один вариант/);
  assert.deepEqual(outcome, { selected: ['Первый'], text: 'а лучше третий' });
  assert.deepEqual(ack, { ok: true, textDelivered: false });
});

test('вопрос по прямому каналу с текстовым ходом: доставку не оспариваем', async (t) => {
  const { outcome, ack } = await askDirectly(t, {
    presentation: {
      isQuestion: true,
      questions: [{ question: 'Что дальше?', header: 'Шаг', options: [{ label: 'Тесты' }] }],
    },
    answer: { answers: [{ header: 'Шаг', selected: [], text: 'сначала прогони тесты' }] },
  });
  assert.deepEqual(outcome, { selected: [], text: 'сначала прогони тесты' });
  assert.deepEqual(ack, { ok: true });
});

test('структурированный прямой вопрос сохраняет typed value и явное действие', async (t) => {
  const questions = [
    {
      key: 'count', question: 'Сколько блоков?', header: 'Блоки', inputType: 'integer',
      required: true, minimum: 1, maximum: 12,
    },
    {
      key: 'theme', question: 'Какая тема?', header: 'Тема', inputType: 'choice',
      required: true, options: [{ value: 'dark', label: 'Тёмная' }],
    },
  ];
  const { outcome, event } = await askDirectly(t, {
    presentation: {
      isQuestion: true,
      structured: true,
      structuredAnswers: true,
      prompt: 'Параметры лендинга',
      source: 'MCP · Figma',
      actions: ['accept', 'cancel'],
      questions,
    },
    answer: {
      action: 'accept',
      answers: [{ key: 'count', value: 4 }, { key: 'theme', value: 'dark' }],
    },
  });
  assert.equal(event.structured, true);
  assert.equal(event.prompt, 'Параметры лендинга');
  assert.equal(event.source, 'MCP · Figma');
  assert.deepEqual(event.actions, ['accept', 'cancel']);
  assert.deepEqual(outcome, {
    action: 'accept',
    answers: [{ key: 'count', value: 4 }, { key: 'theme', value: 'dark' }],
  });
});

test('невалидный typed-ответ не снимает pending, после него можно ответить правильно', async (t) => {
  let deliver = null;
  const asked = new Promise((resolve) => { deliver = resolve; });
  const executor = {
    id: 'fake',
    async run(args) {
      deliver(await args.onPermission({
        isQuestion: true,
        structured: true,
        structuredAnswers: true,
        actions: ['accept', 'cancel'],
        questions: [{
          key: 'approved', question: 'Подтвердить?', header: 'Подтверждение',
          inputType: 'boolean', required: true,
        }],
      }));
      return { reply: 'готово', sessionId: 'sess-typed' };
    },
  };
  const { app, events } = await apiFixture(t, executor);
  const turn = app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: { message: 'спроси', modelRef: { provider: 'fake', model: 'fake-1' } },
  });
  let event;
  for (let i = 0; i < 50 && !event; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    event = events.find((entry) => entry.name === 'chat-question');
  }
  assert.ok(event);

  const invalid = await app.inject({
    method: 'POST',
    url: `/api/chat/permission/${event.payload.pid}`,
    payload: { action: 'accept', answers: [{ key: 'approved', value: 'да' }] },
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().error, 'invalid_answer_value');
  const waiting = (await app.inject({ method: 'GET', url: '/api/chat/waiting' })).json().waiting;
  assert.ok(waiting.some((entry) => entry.pid === event.payload.pid));

  const valid = await app.inject({
    method: 'POST',
    url: `/api/chat/permission/${event.payload.pid}`,
    payload: { action: 'accept', answers: [{ key: 'approved', value: true }] },
  });
  assert.equal(valid.statusCode, 200);
  assert.deepEqual(await asked, {
    action: 'accept',
    answers: [{ key: 'approved', value: true }],
  });
  assert.equal((await turn).statusCode, 200);
});

test('внешнее MCP-действие нельзя запомнить, ссылка остаётся отдельной от ответа', async (t) => {
  const { outcome, event } = await askDirectly(t, {
    presentation: {
      tool: 'Figma',
      canRemember: false,
      input: {
        kind: 'external_url',
        description: 'Установи приложение и вернись.',
        url: 'https://chatgpt.com/apps/figma',
        link_label: 'Открыть установку',
        approve_label: 'Готово',
        reject_label: 'Отклонить',
      },
    },
    answer: { allow: true, remember: true },
  });
  assert.equal(event.input.kind, 'external_url');
  assert.equal(event.canRemember, false);
  assert.deepEqual(outcome, { allow: true, comment: '', remember: false, choice: '' });
});

test('serverRequest/resolved снимает прямой MCP-спрос и запрещает поздний ответ', async (t) => {
  const controller = new AbortController();
  let deliver = null;
  const asked = new Promise((resolve) => { deliver = resolve; });
  const executor = {
    id: 'fake',
    async run(args) {
      deliver(await args.onPermission({
        signal: controller.signal,
        isQuestion: true,
        structured: true,
        structuredAnswers: true,
        actions: ['accept', 'cancel'],
        questions: [{
          key: 'node_id', question: 'Какой узел?', inputType: 'text', required: true,
        }],
      }));
      return { reply: 'запрос уже снят', sessionId: 'sess-resolved' };
    },
  };
  const { app, events } = await apiFixture(t, executor);
  const turn = app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: { message: 'открой макет', modelRef: { provider: 'fake', model: 'fake-1' } },
  });
  let event;
  for (let i = 0; i < 50 && !event; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    event = events.find((entry) => entry.name === 'chat-question');
  }
  assert.ok(event);

  controller.abort();
  assert.deepEqual(await asked, {
    action: 'cancel', outcome: { outcome: 'cancelled' }, allow: false,
  });
  assert.equal((await turn).statusCode, 200);
  const waiting = (await app.inject({ method: 'GET', url: '/api/chat/waiting' })).json().waiting;
  assert.equal(waiting.some((entry) => entry.pid === event.payload.pid), false);
  assert.ok(events.some((entry) => (
    entry.name === 'chat-permission-done' && entry.payload.pid === event.payload.pid
  )));

  const late = await app.inject({
    method: 'POST',
    url: `/api/chat/permission/${event.payload.pid}`,
    payload: { action: 'accept', answers: [{ key: 'node_id', value: '1:2' }] },
  });
  assert.equal(late.statusCode, 404);
});

test('висящий спрос называет чат: waiting отдаёт название и задачу из истории', async (t) => {
  const { app, events } = await apiFixture(t);
  // Клиент сохраняет чат до model POST, поэтому к моменту спроса шапка уже на диске.
  const saved = await app.inject({
    method: 'PUT',
    url: '/api/chat/store/chat',
    payload: {
      chat: {
        id: 'c-named',
        title: 'Телеграм-пульт мусор',
        taskId: '4187',
        messages: [],
        createdAt: Date.UTC(2026, 7, 19),
        updatedAt: Date.UTC(2026, 7, 19),
      },
      archived: false,
    },
  });
  assert.equal(saved.statusCode, 200);

  const pending = app.inject({
    method: 'POST',
    url: '/api/chat/permission-request',
    payload: {
      tool_name: 'AskUserQuestion',
      input: { questions: [{ header: 'Объём', question: 'Что именно выпиливаем?', options: [{ label: 'Всё' }] }] },
      chatKey: 'c-named',
    },
  });
  let ev;
  for (let i = 0; i < 10 && !ev; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    ev = events.find((e) => e.name === 'chat-question');
  }
  assert.ok(ev);

  const waiting = (await app.inject({ method: 'GET', url: '/api/chat/waiting' })).json().waiting;
  const item = waiting.find((w) => w.pid === ev.payload.pid);
  assert.equal(item.chatTitle, 'Телеграм-пульт мусор', 'внешнему пульту неоткуда узнать имя чата');
  assert.equal(item.taskId, '4187');
  assert.equal(item.questions[0].header, 'Объём');

  await app.inject({ method: 'POST', url: `/api/chat/permission/${ev.payload.pid}`, payload: { answers: [{ text: 'всё' }] } });
  await pending;
});

test('спрос по неизвестному чату не выдумывает названия', async (t) => {
  const { app, events } = await apiFixture(t);
  const pending = app.inject({
    method: 'POST',
    url: '/api/chat/permission-request',
    payload: { tool_name: 'Bash', input: { command: 'ls' }, chatKey: 'c-unknown' },
  });
  let ev;
  for (let i = 0; i < 10 && !ev; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    ev = events.find((e) => e.name === 'chat-permission');
  }
  const item = (await app.inject({ method: 'GET', url: '/api/chat/waiting' })).json()
    .waiting.find((w) => w.pid === ev.payload.pid);
  assert.equal(item.chatTitle, '');
  assert.equal(item.taskId, null);

  await app.inject({ method: 'POST', url: `/api/chat/permission/${ev.payload.pid}`, payload: { allow: true } });
  await pending;
});
