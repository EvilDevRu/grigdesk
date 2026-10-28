// Синтетический DSH web wire для HTTP + WebSocket regression tests.
// Запускается из repo-файла через shell-обёртку, чтобы зависимости искались в server/.
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import nativeSettingsDescription from '../executor-settings/deepseek.json' with { type: 'json' };
import { glmNativeProtocol } from './glmNativeProtocol.mjs';

const requireServer = createRequire(new URL('../../../server/package.json', import.meta.url));
const Fastify = requireServer('fastify');
const websocket = requireServer('@fastify/websocket');
const args = process.argv.slice(2);
const glmNative = await glmNativeProtocol(args);
const arg = (name, fallback = '') => args[args.indexOf(name) + 1] || fallback;
const port = Number(arg('--port', '0'));
const scenarioFile = arg('--scenario');
const logFile = arg('--log');
const app = Fastify({ logger: false });
await app.register(websocket);
let follow;
let events;
let turn = 0;
let seq = -1;
let pendingApproval = null;
let pendingQuestion = null;
let pendingCancel = false;
let pendingSteer = false;
let selection = null;
let rootSessionId = '';
const eventAgentId = () => args.includes('--grigdesk-tool-policy') ? rootSessionId : 'fake-agent';
const nativeSettings = structuredClone(nativeSettingsDescription);
const log = async (value) => appendFile(logFile, `${JSON.stringify(value)}\n`);
const send = (socket, streamId, value) => {
  socket.send(JSON.stringify({ type: 'item', streamId, value }));
};
const emit = (type, data) => {
  if (!follow) return;
  send(follow.socket, follow.streamId, {
    type: 'event', event: { type, seq: ++seq, time: Date.now(), data },
  });
};
let attemptPrefix = 'attempt';
/**
 * Текстовый блок ответа как live-поток DSH: start, дельта и block-end.
 * Настоящий DSH даёт attemptId вида `<sessionId>:<номер>`; сценарий может его воспроизвести.
 */
const streamText = (value) => {
  if (!follow) {
    return;
  }

  const attemptId = attemptPrefix === 'attempt'
    ? `attempt-${turn}-${seq}`
    : `${attemptPrefix}:${turn}`;

  send(follow.socket, follow.streamId, {
    type: 'assistant-stream', frame: { type: 'start', attemptId, revision: 1 },
  });
  for (const chunk of [
    { type: 'text-delta', index: 0, text: value },
    { type: 'block-end', index: 0, block: { type: 'text', text: value } },
  ]) {
    send(follow.socket, follow.streamId, {
      type: 'assistant-stream', frame: { type: 'chunk', attemptId, chunk },
    });
  }
};
const finish = (reason = { kind: 'completed' }) => emit('turn/end', { turn, reason });
// Необязательные сценарии GLM: задержки RPC, обратное чтение выбора модели, обрывы и ошибки.
const readScenario = async () => JSON.parse(await readFile(scenarioFile, 'utf8'));
/**
 * Канонический JSON как у политики GLM: ключи объектов отсортированы рекурсивно.
 * Нужен для хэша аргументов в дескрипторе hook.
 */
function canonical(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    const fields = Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`);

    return `{${fields.join(',')}}`;
  }

  return JSON.stringify(value);
}

// События hooks как у настоящего DSH с GLM-политикой: маркер хода и дескриптор вызова.
const hookResult = (point, descriptor) => emit('hook/result', {
  turn,
  point,
  handlerId: `fake:${point}`,
  decision: 'pass',
  exitCode: 0,
  stderrSummary: `GLM-POLICY ${JSON.stringify(descriptor)}`,
});

/**
 * Блок размышления как live-поток DSH: start, reasoning-дельта и block-end reasoning.
 * Нормализатор GrigDesk превращает его в шаг think.
 */
function streamThought(value) {
  if (!follow) {
    return;
  }

  const attemptId = `attempt-${turn}-${seq}`;
  const chunks = [
    {
      type: 'reasoning-delta',
      index: 0,
      text: value,
    },
    {
      type: 'block-end',
      index: 0,
      block: { type: 'reasoning', text: value },
    },
  ];

  send(follow.socket, follow.streamId, {
    type: 'assistant-stream',
    frame: {
      type: 'start',
      attemptId,
      revision: 1,
    },
  });

  for (const chunk of chunks) {
    send(follow.socket, follow.streamId, {
      type: 'assistant-stream',
      frame: {
        type: 'chunk',
        attemptId,
        chunk,
      },
    });
  }
}

/**
 * Обновления сценария одного хода: текст, вызовы инструментов, их результаты и размышления,
 * а при `hooks` — события hook/result, как у DSH с политикой GLM. true — ход оборван здесь.
 */
function playUpdates(scenario) {
  const hooked = Boolean(scenario.hooks);

  emit('turn/start', { turn });

  if (hooked && scenario.hooks !== 'no-marker') {
    hookResult('UserPromptSubmit', { event: 'UserPromptSubmit', marker: 'hooks-alive' });
  }

  for (const update of scenario.updates || []) {
    playUpdate(update, hooked && scenario.hooks !== 'no-descriptor');
  }

  if (scenario.closeAfterPrompt) {
    follow?.socket.close();

    return true;
  }

  if (scenario.question && events) {
    const eventId = `question-${turn}`;
    const callId = `question-call-${turn}`;
    const input = { questions: scenario.question.questions };
    const proof = glmNative?.proof(turn, callId, 'ask_user_question', input);

    if (proof) {
      emit('tool/call', { turn, step: 1, callId, name: 'ask_user_question', arguments: JSON.stringify(input) });
      emit('grigdesk/glm-policy', proof);
    }

    pendingQuestion = { eventId };
    send(events.socket, events.streamId, {
      type: 'waterfall',
      event: 'user-questions/request',
      eventId,
      agentId: eventAgentId(),
      request: { ...input, ...(proof ? { grigdeskGlm: proof } : {}) },
    });

    return true;
  }

  return false;
}

/**
 * Одно обновление сценария в событиях follow; дескриптор hook — до результата инструмента.
 * Хэш аргументов совпадает с тем, что посчитал бы настоящий hook политики.
 */
function playUpdate(update, describe) {
  if (update.sessionUpdate === 'agent_message_chunk') {
    streamText(String(update.content?.text || ''));
  }

  if (update.sessionUpdate === 'usage') {
    send(follow.socket, follow.streamId, {
      type: 'assistant-stream',
      frame: {
        type: 'chunk',
        attemptId: update.attemptId || `usage-${turn}`,
        chunk: { type: 'usage', usage: update.usage },
      },
    });
  }

  if (update.sessionUpdate === 'tool_call') {
    emit('tool/call', {
      turn,
      step: 1,
      callId: update.toolCallId,
      name: update.title,
      arguments: JSON.stringify(update.rawInput || {}),
    });
  }

  if (update.sessionUpdate === 'tool_call' && describe) {
    if (glmNative) {
      emit('grigdesk/glm-policy', glmNative.proof(
        turn, update.toolCallId, update.title, update.rawInput || {},
      ));
    }

    hookResult('PreToolUse', {
      event: 'PreToolUse',
      tool_use_id: update.toolCallId,
      name: update.title,
      sha256: createHash('sha256').update(canonical(update.rawInput || {})).digest('hex'),
      kind: 'other',
      decision: 'allow',
    });
  }

  // Форма настоящего DSH: id вызова — в source сообщения и в блоке tool-result,
  // исход — в `isError` блока; верхних `toolCallId` и `isError` у сообщения нет.
  if (update.sessionUpdate === 'tool_result') {
    emit('tool/result', {
      turn,
      step: 1,
      message: {
        id: `result-${update.toolCallId}`,
        role: 'user',
        source: {
          kind: 'tool',
          callId: update.toolCallId,
        },
        content: [{
          type: 'tool-result',
          toolCallId: update.toolCallId,
          content: update.content || [],
          ...(update.isError ? { isError: true } : {}),
        }],
      },
    });
  }

  if (update.sessionUpdate === 'agent_thought_chunk') {
    streamThought(String(update.content?.text || ''));
  }
}

/**
 * Snapshot follow с проекцией выбора модели — обратное чтение до prompt.
 * Сценарий может задержать его или подменить подтверждённый выбор.
 */
async function sendSnapshot(socket, streamId, address) {
  const options = await readScenario().catch(() => ({}));
  const delay = Number(options.delay?.['session/follow'] || 0);
  const next = options.readback === undefined ? selection : options.readback;

  if (delay > 0) {
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  send(socket, streamId, {
    type: 'snapshot',
    header: { id: address.sessionId },
    cursor: seq,
    records: [],
    projections: { values: { modelSelection: { lastUsed: null, next } } },
  });

  if (glmNative && options.hooks !== 'no-marker') {
    emit('grigdesk/glm-ready', glmNative.ready(address.sessionId));
  }
}

/**
 * Журнал сессии там же, где его пишет DSH: `$DSH_HOME/sessions/<projectKey(cwd)>/<id>`.
 * Без DSH_HOME (старые стенды DeepSeek) журнал не пишется.
 */
async function writeJournal(cwd, sessionId) {
  if (!process.env.DSH_HOME || !cwd) {
    return;
  }

  const readable = String(cwd).replace(/[/\\:]+/g, '-').replace(/^-+/, '') || 'root';
  const directory = path.join(process.env.DSH_HOME, 'sessions', `--${readable.slice(0, 251)}--`, sessionId);

  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'session.v3.jsonl.zstd'), 'fake-journal');
}

app.get('/', (_request, reply) => reply.header('set-cookie', 'dsh_fixture=valid; HttpOnly').code(303).send());
app.post('/api/*', async (request) => {
  if (request.headers.cookie !== 'dsh_fixture=valid') {
    return { type: 'server-response', rpcId: request.body?.rpcId, result: {
      ok: false, error: { code: 'unauthorized', message: 'cookie missing', details: {} },
    } };
  }
  const body = request.body;
  const method = body.method;
  const params = body.payload.args;
  await log({ kind: 'request', message: { method, params } });
  let value = {};
  const options = await readScenario().catch(() => ({}));
  const delay = Number(options.delay?.[method] || 0);

  if (delay > 0) {
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  if (options.rpcError?.[method]) {
    return {
      type: 'server-response',
      rpcId: body.rpcId,
      result: { ok: false, error: options.rpcError[method] },
    };
  }

  if (method === 'session/prompt' && options.dropPrompt) {
    request.raw.destroy();

    return new Promise(() => {});
  }

  if (method === 'settings/describe') {
    value = nativeSettings;
  } else if (method === 'settings/mutate') {
    const namespace = nativeSettings.namespaces.find((entry) => entry.ns === params.ns);

    for (const operation of params.ops) {
      namespace.value[operation.path[0]] = operation.value;
    }

    namespace.revision += 1;
    value = namespace;
  } else if (method === 'session/create') {
    value = { sessionId: params.request.sessionId || `fake-session-${Date.now()}-${Math.random()}` };
    rootSessionId = value.sessionId;
    await writeJournal(params.request.cwd, value.sessionId);
  } else if (method === 'session/selectModel') {
    const { sessionId: _sessionId, ...selected } = params.request;

    selection = selected;
    value = { selected: params.request };
  } else if (method === 'session/prompt' && params.request?.mode === 'steer') {
    const scenario = JSON.parse(await readFile(scenarioFile, 'utf8'));

    value = { accepted: true };

    // Как настоящий DSH: уточнение встаёт в следующий шаг того же хода, хук приёма запроса
    // срабатывает снова с тем же номером хода, затем модель отвечает и ход заканчивается.
    if (pendingSteer) {
      pendingSteer = false;
      queueMicrotask(() => {
        if (scenario.hooks && scenario.hooks !== 'no-marker') {
          hookResult('UserPromptSubmit', { event: 'UserPromptSubmit', marker: 'hooks-alive' });
        }

        streamText(String(scenario.steer?.reply || 'steer-answer'));
        finish();
      });
    }
  } else if (method === 'session/prompt') {
    const scenario = JSON.parse(await readFile(scenarioFile, 'utf8'));

    attemptPrefix = scenario.attemptPrefix || 'attempt';
    value = { accepted: true };

    // Зависший процесс: не реагирует ни на cancel, ни на SIGTERM — остаётся только SIGKILL.
    if (scenario.hang) {
      process.removeAllListeners('SIGTERM');
      process.on('SIGTERM', () => {});
    }

    turn += 1;
    queueMicrotask(() => {
      if (playUpdates(scenario)) {
        return;
      }

      if (scenario.permission && events) {
        const eventId = `approval-${turn}`;
        pendingApproval = { eventId };
        send(events.socket, events.streamId, {
          type: 'waterfall',
          event: 'approval/request',
          eventId,
          agentId: eventAgentId(),
          request: {
            toolName: scenario.permission.toolName || 'bash',
            callId: scenario.permission.toolCallId,
            reason: 'boundary check',
          },
        });
      } else if (scenario.promptError) {
        finish({ kind: 'error', error: { code: 'network', message: scenario.promptError.message } });
      } else if (scenario.blocked) {
        finish({ kind: 'blocked' });
      } else if (scenario.turnError) {
        finish({ kind: 'error', error: scenario.turnError });
      } else if (scenario.waitForCancel) {
        pendingCancel = true;
      } else if (scenario.steer) {
        // Ход остаётся открытым, пока не придёт уточнение.
        pendingSteer = true;
      } else {
        finish();
      }
    });
  } else if (method === '$events/result') {
    if (pendingQuestion && params.eventId === pendingQuestion.eventId) {
      await log({ kind: 'question_response', message: { result: params.outcome } });
      pendingQuestion = null;
      queueMicrotask(() => finish());
    }
    if (pendingApproval && params.eventId === pendingApproval.eventId) {
      await log({ kind: 'permission_response', message: { result: params.outcome } });
      pendingApproval = null;
      queueMicrotask(() => finish());
    }
  } else if (method === 'session/cancel') {
    if (pendingCancel && !options.hang) {
      pendingCancel = false;
      queueMicrotask(() => finish({ kind: 'interrupted' }));
    }
    value = { accepted: true };
  }
  return { type: 'server-response', rpcId: body.rpcId, result: { ok: true, value } };
});
app.get('/api/remote.mux', { websocket: true }, (socket) => {
  socket.on('message', (raw) => {
    const frame = JSON.parse(String(raw));
    if (frame.type !== 'open') return;

    void log({ kind: 'open', message: { endpoint: frame.endpoint } });

    if (frame.endpoint === 'session/follow') {
      follow = { socket, streamId: frame.streamId };
      void sendSnapshot(socket, frame.streamId, frame.payload.args.request.address);
    } else if (frame.endpoint === '$events') {
      events = { socket, streamId: frame.streamId };
      send(socket, frame.streamId, { type: 'ready', clientId: 'fake-client' });
    }
  });
});
await app.listen({ host: '127.0.0.1', port });
console.log(`dsh web: http://127.0.0.1:${port}/?token=synthetic-fixture`);
process.on('SIGTERM', () => { void app.close().then(() => process.exit(0)); });
