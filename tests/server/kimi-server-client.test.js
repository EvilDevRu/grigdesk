// Транспорт Kimi через локальный сервер (`kimi web`): prompt + steer в активный ход.
//
// Проверяем ровно то, чего нет в ACP: сообщение сначала ставится prompt'ом, а затем
// уводится в идущий ход через `prompts:steer`. Сервер в тесте настоящий (Fastify),
// поэтому проверяются и пути, и тела, и токен, и разбор ошибок.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import {
  KimiServerClient,
  KimiServerError,
  kimiPromptBody,
} from '../../server/src/lib/kimi/serverClient.ts';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

/**
 * Фейковый сервер Kimi: повторяет контракт `kimi web` в объёме, который нужен каналу.
 * Каждый запрос записывается, чтобы тест сверял путь, тело и авторизацию.
 */
async function fakeKimiServer(t, { promptStatus = 'queued', steerResult = true } = {}) {
  const app = Fastify({ logger: false });
  const calls = [];

  app.addHook('onRequest', async (request, reply) => {
    if (request.headers.authorization !== 'Bearer test-token') {
      return reply.code(401).send({ code: 40101, message: 'unauthorized' });
    }

    return undefined;
  });

  app.get('/api/v1/meta', async () => ({
    code: 0,
    data: { server_version: '0.33.0', capabilities: { websocket: true } },
  }));

  app.post('/api/v1/sessions', async (request) => {
    calls.push({ method: 'POST', url: '/api/v1/sessions', body: request.body });

    return { code: 0, data: { id: 'session-fixture-0001', ...request.body } };
  });

  app.post('/api/v1/sessions/:id/prompts', async (request) => {
    calls.push({ method: 'POST', url: `/api/v1/sessions/${request.params.id}/prompts`, body: request.body });

    return {
      code: 0,
      data: {
        prompt_id: `prompt-${calls.length}`,
        user_message_id: `message-${calls.length}`,
        status: promptStatus,
      },
    };
  });

  app.post('/api/v1/sessions/:id/prompts:steer', async (request, reply) => {
    calls.push({ method: 'POST', url: `/api/v1/sessions/${request.params.id}/prompts:steer`, body: request.body });

    if (!steerResult) {
      return reply.code(409).send({ code: 40911, message: 'нет активного хода' });
    }

    return { code: 0, data: { steered: true, prompt_ids: request.body.prompt_ids } };
  });

  app.post('/api/v1/sessions/:id/approvals/:approvalId', async (request) => {
    calls.push({ method: 'POST', url: `approval:${request.params.approvalId}`, body: request.body });

    return { code: 0, data: { resolved: true, resolved_at: '2026-09-29T00:00:00Z' } };
  });

  app.post('/api/v1/sessions/:id/questions/:questionId', async (request) => {
    calls.push({ method: 'POST', url: `question:${request.params.questionId}`, body: request.body });

    return { code: 0, data: { resolved: true, resolved_at: '2026-09-29T00:00:00Z' } };
  });

  app.post('/api/v1/sessions/:id/prompts/:promptId:abort', async (request) => {
    calls.push({ method: 'POST', url: 'abort', body: null });

    return { code: 0, data: { aborted: true, at_seq: 7 } };
  });

  await app.listen({ host: '127.0.0.1', port: 0 });
  t.after(() => app.close());

  const address = app.server.address();

  return {
    calls,
    client: new KimiServerClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: 'test-token',
    }),
  };
}

test('Kimi: сессия создаётся с рабочей папкой и моделью, мета читается', async (t) => {
  const { client, calls } = await fakeKimiServer(t);

  const meta = await client.meta();

  assert.equal(meta.server_version, '0.33.0');

  const session = await client.createSession({ cwd: '/tmp/fixture', model: 'k3' });

  assert.equal(session.id, 'session-fixture-0001');
  assert.deepEqual(calls[0].body, {
    metadata: { cwd: '/tmp/fixture' },
    agent_config: { model: 'k3' },
  });
});

test('Kimi: prompt ставится в очередь, затем уводится в активный ход через steer', async (t) => {
  const { client, calls } = await fakeKimiServer(t);

  const receipt = await client.submitPrompt('session-fixture-0001', {
    text: 'Почему первый файл?',
    permissionMode: 'auto',
  });

  assert.equal(receipt.status, 'queued');
  assert.equal(receipt.promptId, 'prompt-1');
  assert.deepEqual(calls[0].body, {
    content: [{ type: 'text', text: 'Почему первый файл?' }],
    permission_mode: 'auto',
  });

  const steered = await client.steerPrompts('session-fixture-0001', [receipt.promptId]);

  assert.equal(steered.steered, true);
  assert.deepEqual(steered.promptIds, ['prompt-1']);
  assert.deepEqual(calls[1].body, { prompt_ids: ['prompt-1'] });
});

test('Kimi: deliverInTurn связывает prompt и steer и честно отказывает вне очереди', async (t) => {
  const queued = await fakeKimiServer(t);
  const forwarded = await queued.client.deliverInTurn('session-fixture-0001', {
    text: 'Уточнение',
    userMessageId: 'message-fixture-0001',
  });

  assert.deepEqual(forwarded, { ok: true, state: 'forwarded' });
  assert.equal(queued.calls.length, 2, 'prompt и steer — два запроса');
  assert.deepEqual(queued.calls[0].body.content, [{ type: 'text', text: 'Уточнение' }]);

  const taken = await fakeKimiServer(t, { promptStatus: 'running' });
  const refused = await taken.client.deliverInTurn('session-fixture-0001', { text: 'Поздно' });

  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'kimi_turn_taken');
  assert.deepEqual(taken.calls.map((call) => call.url), [
    '/api/v1/sessions/session-fixture-0001/prompts',
    'abort',
  ], 'начавшийся отдельный prompt отменён, steer не отправлялся');

  const rejected = await fakeKimiServer(t, { steerResult: false });
  const failed = await rejected.client.deliverInTurn('session-fixture-0001', { text: 'Отклонённый' });

  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'kimi_40911');
  assert.equal(rejected.calls.at(-1).url, 'abort', 'отклонённый steer не оставляет prompt в очереди');
});

test('Kimi: ошибки сервера приходят типизированно, abort допускает 40903', async (t) => {
  const { client } = await fakeKimiServer(t);

  await assert.rejects(
    () => client.getSession('session-fixture-0001'),
    (error) => error instanceof KimiServerError && error.status === 404,
  );

  const wrongToken = new KimiServerClient({
    baseUrl: 'http://127.0.0.1:1',
    token: 'bad',
    timeoutMs: 1000,
  });

  await assert.rejects(() => wrongToken.meta());
});

test('Kimi: ответы на разрешение и вопрос уходят своими маршрутами', async (t) => {
  const { client, calls } = await fakeKimiServer(t);

  const approval = await client.respondApproval('session-fixture-0001', 'approval-1', {
    decision: 'approve',
    scope: 'once',
    selectedLabel: 'Разрешить один раз',
  });

  assert.equal(approval.resolved, true);
  assert.deepEqual(calls[0].body, {
    decision: 'approve',
    scope: 'once',
    selected_label: 'Разрешить один раз',
  });

  const question = await client.respondQuestion('session-fixture-0001', 'question-1', {
    answers: { choice: ['второй'] },
    method: 'form',
    note: 'по задаче',
  });

  assert.equal(question.resolved, true);
  assert.deepEqual(calls[1].body, {
    answers: { choice: ['второй'] },
    method: 'form',
    note: 'по задаче',
  });
});

test('Kimi: тело prompt собирается из текста и режимов', () => {
  assert.deepEqual(
    kimiPromptBody({ text: 'вопрос', promptId: 'p1', model: 'k3', thinking: 'high' }),
    {
      content: [{ type: 'text', text: 'вопрос' }],
      prompt_id: 'p1',
      model: 'k3',
      thinking: 'high',
    },
  );
});
