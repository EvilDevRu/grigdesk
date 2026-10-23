import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { AUTO_CONTINUE_PROMPT, continueAfterFailures } from '../../server/src/lib/chat/autoContinue.ts';
import { classifyTurnFailure } from '../../server/src/lib/chat/turnFailures.ts';
import { spawnDeepSeekBinary } from '../../server/src/lib/deepseek/binaryProcess.ts';
import { DeepSeekWebClient } from '../../server/src/lib/deepseek/serverClient.ts';
import { runDeepSeekServerTurn } from '../../server/src/lib/deepseek/serverTurn.ts';
import { DSH_TURN_FAILURE_RULES } from '../../server/src/lib/deepseek/turnFailureRules.ts';

import { chatAppFixture, saveChat, turnBody, waitFor } from './helpers/chat-turns.js';

const requireServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireServer('fastify');
const websocket = requireServer('@fastify/websocket');
const fixture = fileURLToPath(new URL('../fixtures/deepseek-harness/turnCleanup.mjs', import.meta.url));
const event = (type, data = {}) => ({ type: 'event', event: { type, data } });

/**
 * Отсутствие проверяется только для собственной группы и собственного критика.
 * Ошибка доступа не считается подтверждением завершения.
 */
function gone(pid, group = false) {
  try {
    process.kill(group ? -pid : pid, 0);

    return false;
  } catch (error) {
    if (error.code !== 'ESRCH') {
      throw error;
    }

    return true;
  }
}

/**
 * Настоящий сборщик и owner получают окончательный исход через локальный DSH-транспорт.
 * Критик жив в момент сбоя; модель, внешний API и реальные разговоры не используются.
 */
async function runWire(t, mode, { code = 'TRANSPORT', unknown = false, aborted = false, variant } = {}) {
  const owned = spawnDeepSeekBinary(process.execPath, [fixture, mode], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const app = Fastify();

  t.after(async () => {
    await owned.stop().catch(() => {});
    await app.close();
  });

  const [ready] = await once(owned.child.stdout, 'data');
  const { critic } = JSON.parse(String(ready));
  const subscriptions = new Map();
  const prompts = [];
  let criticAliveAtFailure = false;
  let stopped = false;

  await app.register(websocket);

  const send = (subscription, value) => subscription.socket.send(JSON.stringify({
    type: 'item',
    streamId: subscription.id,
    value,
  }));

  app.get('/', (_request, reply) => reply
    .header('set-cookie', 'fixture=valid; HttpOnly').code(303).send());
  app.post('/api/*', (request) => {
    const body = request.body;
    let value = {};

    if (body.method === 'session/create') {
      value = { sessionId: 'fixture-session' };
    }

    if (body.method === 'session/prompt') {
      prompts.push(body.args);
      value = { accepted: true };
      queueMicrotask(() => {
        const follow = subscriptions.get('session/follow');

        criticAliveAtFailure = !gone(critic);
        send(follow, event('turn/start'));
        send(follow, event('tool/call', {
          name: 'task',
          arguments: '{"description":"Критик"}',
          callId: 'critic-call',
        }));

        if (unknown) {
          follow.socket.close();

          return;
        }

        send(follow, event('turn/end', {
          reason: aborted ? { kind: 'aborted' }
            : { kind: 'error', error: { code, message: `${code}: ошибка модели` } },
        }));
      });
    }

    return {
      type: 'server-response',
      rpcId: body.rpcId,
      result: { ok: true, value },
    };
  });
  app.get('/api/remote.mux', { websocket: true }, (socket) => {
    socket.on('message', (raw) => {
      const frame = JSON.parse(String(raw));

      if (frame.type !== 'open') {
        return;
      }

      const subscription = { socket, id: frame.streamId };

      subscriptions.set(frame.endpoint, subscription);
      send(subscription, frame.endpoint === 'session/follow'
        ? { type: 'snapshot', records: [] } : { type: 'ready', clientId: 'fixture-client' });
    });
  });
  await app.listen({ host: '127.0.0.1', port: 0 });

  const client = await DeepSeekWebClient.authenticate(`${app.listeningOrigin}/?token=fixture`);
  let rejected = false;
  const result = await runDeepSeekServerTurn({
    bin: process.execPath,
    overlayPath: fixture,
    cwd: import.meta.dirname,
    env: {},
    message: 'Исходная задача.',
    signal: AbortSignal.timeout(15000),
    variant,
    startServer: async () => ({
      client,
      stop: async () => {
        await owned.stop();
        stopped = true;
      },
    }),
  }).catch((error) => {
    rejected = true;

    return error;
  });

  return {
    result,
    rejected,
    prompts,
    criticAliveAtFailure,
    owned,
    critic,
    stopped,
  };
}

/**
 * Следующую попытку заменяем локальным успехом, оставляя настоящую петлю и её допуск.
 * Даже ошибочно переданный в петлю cleanup не должен разрешить новый запуск.
 */
async function continueWire(wire) {
  let continued = 0;
  const result = await continueAfterFailures(wire.result, {
    isEnabled: () => true,
    rules: DSH_TURN_FAILURE_RULES,
    continueMessage: AUTO_CONTINUE_PROMPT,
    hasQueued: () => false,
    openWait: () => ({
      status: () => null,
      cancel() {},
      dispose() {},
      wait: async () => 'elapsed',
    }),
    beforeWait: async () => {},
    publishNote() {},
    onSummary() {},
    attemptSteps: () => [],
    run: async ({ message, sessionId }) => {
      assert.equal(wire.stopped, true);
      assert.equal(gone(wire.owned.child.pid, true), true);
      assert.equal(gone(wire.critic), true);
      assert.equal(sessionId, 'fixture-session');
      assert.equal(message, AUTO_CONTINUE_PROMPT);
      continued += 1;

      return {
        sessionId,
        reply: 'Готово.',
        steps: [],
      };
    },
  });

  return { result, continued };
}

for (const mode of ['0', '130', '75', 'signal', 'escalation']) {
  test(`TRANSPORT и активный критик: остановка ${mode}`, { timeout: 20000 }, async (t) => {
    const wire = await runWire(t, mode);
    const safe = ['0', '130'].includes(mode);

    assert.equal(wire.criticAliveAtFailure, true);
    assert.equal(wire.prompts.length, 1);
    assert.equal(wire.rejected, !safe);
    assert.equal(wire.result.sessionId, 'fixture-session');
    assert.equal(wire.result.steps.filter((step) => step.k === 'tool').length, 1);
    assert.equal(wire.result.turnFailure.code, 'TRANSPORT');
    assert.equal(wire.result.turnRecovery.canContinue, safe);
    assert.equal(wire.result.turnRecovery.madeProgress, true);

    if (!safe) {
      assert.equal(wire.result.code, 'deepseek_binary_cleanup');
      assert.equal(wire.result.retryState, 'post_prompt');
      assert.equal(wire.result.stopFailure.code, 'deepseek_binary_cleanup');
      assert.match(wire.result.message, /TRANSPORT/u);
      assert.match(wire.result.message, /cleanup/u);
      assert.equal(wire.result.stopDetails.groupGone, true);
      assert.equal(wire.result.stopDetails.escalated, mode === 'escalation');
      assert.deepEqual(wire.result.stopDetails.exit, await wire.owned.closed);
    }

    const next = await continueWire(wire);

    assert.equal(next.continued, safe ? 1 : 0);
    assert.equal(next.result.steps.filter((step) => step.k === 'tool').length, 1);
  });
}

for (const mode of ['0', '75']) {
  test(`нет turn/end, остановка ${mode}: исход остаётся неизвестным`, async (t) => {
    const wire = await runWire(t, mode, { unknown: true });

    assert.equal(wire.rejected, true);
    assert.equal(wire.result.turnRecovery, undefined);
    assert.equal(wire.result.turnFailure, undefined);
    assert.equal(wire.prompts.length, 1);

    if (mode === '75') {
      assert.match(wire.result.cause.message, /WebSocket/u);
      assert.match(wire.result.message, /WebSocket/u);
      assert.equal(wire.result.stopDetails.exit.code, 75);
    }

    assert.equal((await continueWire(wire)).continued, 0);
  });
}

for (const code of ['AUTH', 'QUOTA', 'CONTEXT_WINDOW_EXCEEDED', 'POLICY']) {
  test(`${code} с cleanup сохраняет окончательный вид ошибки`, async (t) => {
    const wire = await runWire(t, '75', { code });
    const verdict = classifyTurnFailure(wire.result.turnFailure, DSH_TURN_FAILURE_RULES);

    assert.notEqual(verdict.kind, 'network');
    assert.equal(verdict.continuable, false);
    assert.equal(wire.result.turnFailure.code, code);
    assert.equal((await continueWire(wire)).continued, 0);
  });
}

test('GLM: классифицированная причина и cleanup остаются раздельными', async (t) => {
  const primary = Object.assign(new Error('GLM: ошибка входа'), { code: 'glm_auth_failed' });
  const wire = await runWire(t, '75', {
    code: 'AUTH',
    variant: {
      labels: {
        stopped: 'Стоп',
        blocked: 'Блокировка',
        modelError: 'Ошибка',
        action: 'Шаг',
        source: 'GLM',
      },
      classifyModelError: () => primary,
      autoApprove: () => false,
    },
  });

  assert.equal(wire.rejected, true);
  assert.equal(wire.result.code, 'deepseek_binary_cleanup');
  assert.equal(wire.result.cause, primary);
  assert.equal(wire.result.cause.code, 'glm_auth_failed');
  assert.equal(wire.result.turnRecovery, undefined);
  assert.match(wire.result.message, /ошибка входа/u);
});

for (const mode of ['0', '75']) {
  test(`прерванный ход: ядро показывает исход остановки ${mode}`, async (t) => {
    const wire = await runWire(t, mode, { aborted: true });

    assert.equal(wire.rejected, true);
    assert.equal(wire.result.turnRecovery, undefined);

    const next = await continueWire(wire);

    assert.equal(next.continued, 0);

    let runs = 0;
    const executor = {
      id: 'test-provider',
      async run(options) {
        runs += 1;
        await options.onSessionCreated?.(wire.result.sessionId || 'fixture-session');

        throw wire.result;
      },
    };
    const { app } = await chatAppFixture(t, { executor });
    const chatKey = `stop-${mode}`;

    await saveChat(app, chatKey);

    const accepted = await app.inject({
      method: 'POST',
      url: '/api/chat',
      payload: turnBody(chatKey, `turn-stop-cleanup-${mode}`, 'Останови работу.'),
    });

    assert.equal(accepted.statusCode, 202);

    const pending = await waitFor(async () => {
      const reply = await app.inject({ method: 'GET', url: `/api/chat/pending?chatKey=${chatKey}` });
      const items = reply.json().pending;

      return items?.length ? items : null;
    });

    assert.equal(runs, 1);
    assert.equal(pending.length, 1);

    if (mode === '75') {
      assert.match(pending[0].reply, /cleanup/u, 'Человек должен видеть отказ остановки runtime');
      assert.equal(pending[0].role, 'error');
      assert.equal(wire.result.cause.stopped, true);
      assert.equal(wire.result.stopped, undefined);
    } else {
      assert.equal(pending[0].stopped, true);
      assert.match(pending[0].reply, /Ход остановлен/u);
    }
  });
}

test('owner: failedSpawn не подтверждает остановку', async () => {
  const owned = spawnDeepSeekBinary('/несуществующий-runtime-фикстуры', [], { stdio: 'ignore' });

  await owned.closed;
  await assert.rejects(owned.stop(), (error) => {
    assert.equal(error.code, 'deepseek_binary_cleanup');
    assert.equal(error.stopDetails.failedSpawn, true);

    return true;
  });
});

for (const hasExit of [true, false]) {
  test(`owner: группа остаётся, close известен: ${hasExit}`, { timeout: 12000 }, async (t) => {
    const child = new EventEmitter();
    const pgid = 2147483647;
    const signals = [];

    child.pid = pgid;
    child.exitCode = null;
    child.signalCode = null;
    child.kill = () => true;

    const kill = process.kill;

    t.mock.method(process, 'kill', (pid, signal) => {
      if (pid !== -pgid) {
        return kill(pid, signal);
      }

      signals.push(signal);

      return true;
    });

    const owned = spawnDeepSeekBinary('fixture', [], {}, () => child);

    if (hasExit) {
      child.emit('close', 0, null);
    }

    await assert.rejects(owned.stop(), (error) => {
      assert.equal(error.code, 'deepseek_binary_cleanup');
      assert.deepEqual(error.stopDetails.exit, hasExit ? { code: 0, signal: null } : null);
      assert.equal(error.stopDetails.groupGone, hasExit ? false : null);
      assert.equal(error.stopDetails.escalated, true);
      assert.ok(signals.includes('SIGKILL'));

      return true;
    });
  });
}
