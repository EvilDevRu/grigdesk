import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { createAcpClient } from '../../server/src/lib/acp/client.ts';

export const QWEN_KEY = 'synthetic-qwen-secret-0123456789';
export const SECOND_KEY = 'synthetic-secondary-secret-9876543210';
export const QWEN_TEST_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVR4nGP4z8BA'
    + 'EiJN9aiGUQ1DSgMAkPn/Afnh+ngAAAAASUVORK5CYII=', 'base64',
);

/**
 * Изображение лежит вне workspace, как обычное вложение разговора.
 * Собственные байты позволяют проверить доставку в API без настоящего ключа.
 */
export async function qwenImage(fixture) {
  const root = path.join(fixture.dataHome, 'attachments');
  const file = path.join(root, 'image.png');

  await mkdir(root, { recursive: true });
  await writeFile(file, QWEN_TEST_PNG);

  return { root, file };
}

/**
 * Настройки повторяют modelProviders настоящего CLI, включая opaque native id.
 * Оба маршрута намеренно используют одинаковое bare имя модели.
 */
export function sourceSettings(baseUrl = 'http://127.0.0.1:9/v1') {
  return {
    telemetry: { enabled: false },
    general: { enableAutoUpdate: false },
    security: { auth: { selectedType: 'openai' } },
    model: { name: 'shared-model' },
    modelProviders: {
      openai: [{
        id: 'shared-model',
        name: 'Локальная модель',
        envKey: 'QWEN_TEST_KEY',
        baseUrl,
        generationConfig: { contextWindowSize: 32768, temperature: 0.25 },
      }],
      anthropic: [{
        id: 'shared-model',
        name: 'Второй маршрут',
        envKey: 'SECOND_QWEN_KEY',
        baseUrl: 'http://127.0.0.1:9/anthropic',
      }],
    },
  };
}

/**
 * Одноразовые home/data/workspace исключают доступ к данным владельца.
 * Переменные процесса нужны существующей обёртке externalCli, а не подмене адаптера.
 */
export async function qwenFixture(t, { native = false, settings = sourceSettings() } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-qwen-'));
  const workspace = path.join(root, 'workspace');
  const home = path.join(root, 'home');
  const qwenHome = path.join(root, 'source-qwen');
  const dataHome = path.join(root, 'data');
  const stateDir = path.join(root, 'state');
  const saved = { ...process.env };
  const nativeBin = process.env.GRIGDESK_QWEN_BIN;

  await Promise.all([workspace, home, qwenHome, dataHome, stateDir]
    .map((dir) => mkdir(dir, { recursive: true })));
  t.after(async () => {
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) {
        delete process.env[key];
      }
    }

    Object.assign(process.env, saved);
    await rm(root, { recursive: true, force: true });
  });

  const bin = native ? nativeBin : path.join(root, 'qwen-cli.mjs');

  if (native) {
    assert.ok(bin && path.isAbsolute(bin), 'environment: передайте настоящий CLI через --qwen-cli');
    await access(bin);

    const version = spawnSync(process.execPath, [bin, '--version'], { encoding: 'utf8', timeout: 15000 });

    assert.equal(version.status, 0, `environment: CLI не запускается: ${version.stderr}`);
  }

  Object.assign(process.env, {
    HOME: home,
    GRIGDESK_HOME: dataHome,
    GRIGDESK_ARTIFACTS_DIR: path.join(dataHome, 'artifacts'),
    QWEN_HOME: qwenHome,
    GRIGDESK_QWEN_HOME: qwenHome,
    GRIGDESK_QWEN_BIN: bin,
    QWEN_CODE_SYSTEM_SETTINGS_PATH: path.join(root, 'system.json'),
    QWEN_CODE_SYSTEM_DEFAULTS_PATH: path.join(root, 'defaults.json'),
    QWEN_TEST_KEY: QWEN_KEY,
    SECOND_QWEN_KEY: SECOND_KEY,
    DASHSCOPE_API_KEY: QWEN_KEY,
    CI: '1',
    NO_COLOR: '1',
  });
  await writeFile(path.join(root, 'system.json'), '{}');
  await writeFile(path.join(root, 'defaults.json'), '{}');

  const file = path.join(qwenHome, 'settings.json');
  const trace = path.join(workspace, 'fake-trace.jsonl');
  const config = {
    rootDir: workspace,
    dataHome,
    stateDir,
    qwenBin: bin,
    qwenHome,
    qwenRuntimeHome: path.join(dataHome, 'qwen-runtime'),
    artifactsDir: path.join(dataHome, 'artifacts'),
    envPath: path.join(dataHome, '.env'),
    modelsPath: path.join(dataHome, 'models.json'),
    providerUsageSeenPath: path.join(dataHome, 'usage-seen.json'),
    prefsPath: path.join(dataHome, 'prefs.json'),
  };

  await writeFile(file, JSON.stringify(settings));
  await writeFile(config.envPath, '# временные ключи\n', { mode: 0o600 });
  await writeFile(config.modelsPath, 'sentinel-owner-registry');
  await writeFile(config.prefsPath, '{}');

  const { config: singletonConfig } = await import('../../server/src/config.ts');
  const savedConfig = { ...singletonConfig };

  Object.assign(singletonConfig, config);
  t.after(() => Object.assign(singletonConfig, savedConfig));

  const fixture = {
    root,
    workspace,
    home,
    qwenHome,
    dataHome,
    stateDir,
    bin,
    file,
    trace,
    config,
    settings,
    env: { ...process.env },
    async writeSettings(value) {
      await writeFile(file, typeof value === 'string' ? value : JSON.stringify(value));
    },
    async fake(options = {}) {
      await writeFile(bin, fakeCliSource({ trace, ...options }), { mode: 0o700 });

      const checked = spawnSync(process.execPath, ['--check', bin], { encoding: 'utf8', timeout: 5000 });

      assert.equal(checked.status, 0, `Фикстура ACP содержит неверный JavaScript: ${checked.stderr}`);
    },
    async records() {
      const text = await readFile(this.trace, 'utf8').catch((error) => {
        if (error.code === 'ENOENT') {
          return '';
        }

        throw error;
      });

      return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    },
  };

  if (!native) {
    await fixture.fake();
    await validateFakeAcp(fixture);
  }

  return fixture;
}

/**
 * Фикстура проверяется настоящим reader до проверки отсутствующего адаптера.
 * Ошибка генерации или протокола таким образом не прячется за ожидаемым RED карточки.
 */
async function validateFakeAcp(fixture) {
  const child = spawn(fixture.bin, ['--acp'], {
    cwd: fixture.workspace,
    env: fixture.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const closed = new Promise((resolve) => child.once('close', resolve));
  const client = createAcpClient(child, { requestTimeoutMs: 3000 });

  try {
    const initialized = await client.request('initialize', { protocolVersion: 1 });

    assert.equal(initialized.protocolVersion, 1);

    const session = await client.request('session/new', { cwd: fixture.workspace, mcpServers: [] });
    const result = await client.request('session/prompt', {
      sessionId: session.sessionId, prompt: [{ type: 'text', text: 'Проверка фикстуры' }],
    });

    assert.equal(result.stopReason, 'end_turn');
  } finally {
    client.close();
    child.stdin.end();
    child.kill('SIGTERM');
    await closed;
    await rm(fixture.trace, { force: true });
  }
}

/**
 * Используется публичный реестр: отсутствие интеграции является assertion RED.
 * Прямого импорта ещё не существующего qwen.ts нет.
 */
export async function qwenAdapter({ runnable = false } = {}) {
  const { getProviderAdapters, getExecutors } = await import('../../server/src/lib/executors/index.ts');
  const adapters = runnable ? await getExecutors() : await getProviderAdapters();
  const adapter = adapters.get('qwen');

  assert.ok(adapter, runnable ? 'Qwen отсутствует среди чатовых исполнителей' : 'Нет карточки Qwen');

  return adapter;
}

/**
 * Каталог возвращает проверенный native id, которым затем пользуется run.
 * Выбор по имени из настроек не заменяется догадкой о wire-id адаптера.
 */
export async function selectedModel(adapter, fixture, name = 'Локальная модель') {
  assert.equal(typeof adapter.catalog, 'function', 'Нет живого каталога Qwen');

  const models = await adapter.catalog(fixture.config);
  const model = models.find((item) => item.name === name || item.label === name);

  assert.ok(model, `Каталог не вернул ${name}`);

  return model.id;
}

/**
 * Ход всегда имеет свой chatKey и конечный срок; callbacks можно уточнить сценарием.
 * Итог с deliveryFailure остаётся отказом даже при наличии частичного текста.
 */
export function runInput(fixture, model, extra = {}) {
  const signal = extra.signal
    ? AbortSignal.any([extra.signal, AbortSignal.timeout(45000)]) : AbortSignal.timeout(12000);

  return {
    config: fixture.config,
    cwd: fixture.workspace,
    model,
    message: 'Ответь одной строкой.',
    chatKey: 'qwen-test-chat',
    permissionMode: 'default',
    env: fixture.env,
    onPermission: async () => ({ allow: false }),
    ...extra,
    signal,
  };
}

export const successful = (result) => !result.deliveryFailure && !result.turnFailure;

/**
 * Ограниченное ожидание наблюдаемого события не скрывает отказ продюсера.
 * Срок используется только как аварийный выход, порядок задаётся самим событием.
 */
export async function until(check, label, milliseconds = 8000) {
  const end = Date.now() + milliseconds;

  while (Date.now() < end) {
    const value = await check();

    if (value) {
      return value;
    }

    await delay(20);
  }

  assert.fail(`Не дождались: ${label}`);
}

/**
 * Отказом считается исключение либо терминальный failure, но не пустой успех.
 * Чувствительные значения проверяет вызывающий тест на наблюдаемом сообщении.
 */
export async function rejectedTurn(action) {
  try {
    const result = await action();

    assert.equal(successful(result), false, 'Нельзя завершать отказ успешным ходом');

    return JSON.stringify(result);
  } catch (error) {
    if (error.code === 'ERR_ASSERTION') {
      throw error;
    }

    return String(error.message);
  }
}

/**
 * Fake говорит NDJSON ACP через настоящие stdin/stdout и читает settings CLI.
 * Запись canary выполняется самим child лишь после ответа final guard.
 */
function fakeCliSource(options) {
  return `#!${process.execPath}
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
const options = ${JSON.stringify(options)};
if (process.argv.includes('--version')) {
  console.log(options.version || '0.27.2');
  process.exit(0);
}
if (options.stderr) process.stderr.write(options.stderr);
const log = (value) => appendFileSync(options.trace, JSON.stringify(value) + '\\n');
const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\\n');
const reply = (id, result) => send({ id, result });
const notify = (update) => send({ method: 'session/update', params: { sessionId, update } });
const settingsPath = path.join(process.env.QWEN_HOME || process.env.GRIGDESK_QWEN_HOME, 'settings.json');
const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
const availableModels = Object.entries(settings.modelProviders || {}).flatMap(([authType, entries]) =>
  entries.map((entry) => ({ modelId: entry.id + '(' + authType + ')', name: entry.name || entry.id,
    _meta: { contextLimit: options.metadata?.[entry.id + '(' + authType + ')']?.context } })));
const models = { availableModels, currentModelId: availableModels[0]?.modelId };
const modes = { currentModeId: 'default', availableModes: (options.modes ||
  ['default', 'auto', 'plan', 'yolo']).map((id) =>
  ({ id, name: id })) };
let sessionId = '11111111-2222-4333-8444-555555555555';
let prompt = null;
let reverse = null;
let count = 0;
let statusServer;
let effort = '';
// Metadata меняется вместе с выбранной моделью, как у настоящего ACP.
// Общий список уровней намеренно не подставляется неизвестной модели.
const configOptions = () => {
  if (!options.metadata) {
    return undefined;
  }
  const profile = options.metadata[models.currentModelId];
  return [{ id: 'model', type: 'select', currentValue: models.currentModelId,
    options: availableModels.map((model) => ({ value: model.modelId })) },
    ...(profile?.efforts ? [{ id: 'reasoning_effort', type: 'select',
      currentValue: effort || profile.defaultEffort || profile.efforts[0],
      _meta: { 'qwenCode/reasoning': { defaultEffort: profile.defaultEffort } },
      options: profile.efforts.map((value) => ({ value })) }] : [])];
};
const instance = randomUUID();
log({ event: 'spawn', instance, argv: process.argv.slice(2), cwd: process.cwd() });
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const frame = JSON.parse(line);
  log({ event: 'frame', instance, frame });
  if (frame.method === 'initialize') {
    log({ event: 'handshake',
      matched: Boolean(frame.params._meta?.['qwen-code/private-parent-capability']) &&
        frame.params._meta['qwen-code/private-parent-capability'] ===
          process.env.QWEN_CODE_PRIVATE_ACP_CAPABILITY,
      guard: process.env.QWEN_CODE_PRIVATE_EXTERNAL_TOOL_GUARD,
      provider: process.env.QWEN_CODE_PRIVATE_EXTERNAL_TOOL_GUARD_PROVIDER,
    });
    reply(frame.id, { protocolVersion: 1, agentCapabilities: { loadSession: true,
      promptCapabilities: { image: options.images !== false } },
      agentInfo: { name: 'qwen-code', version: '0.27.2' },
      _meta: options.noAck ? {} : { 'qwen-code/external-tool-guard-ready': 'required-v1' } });
  } else if (frame.method === 'craft/midTurnSendNow') {
    if (options.midTurnError) {
      send({ id: frame.id, error: { code: -32601, message: 'synthetic unsupported send-now' } });
      return;
    }
    reply(frame.id, {});
    send({ id: 'foreign-mid-turn-drain', method: 'craft/drainMidTurnQueue', params: {
      sessionId, promptId: 'foreign-prompt',
    } });
  } else if (frame.id === 'foreign-mid-turn-drain') {
    log({ event: 'foreign-drain', result: frame.result });
    send({ id: 'mid-turn-drain', method: 'craft/drainMidTurnQueue', params: {
      sessionId, promptId: prompt.params._meta?.['qwen-code/invocation']?.promptId,
    } });
  } else if (frame.id === 'mid-turn-drain') {
    log({ event: 'mid-turn-drain', result: frame.result });
    finish();
  } else if (frame.method === 'session/new' || frame.method === 'session/load') {
    sessionId = frame.params.sessionId || sessionId;
    statusServer = frame.params.mcpServers?.find((server) => server.name === 'factory-status');
    if (frame.method === 'session/load') {
      notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OLD_REPLAY' } });
    }
    reply(frame.id, { sessionId, models, modes, configOptions: configOptions() });
  } else if (frame.method === 'session/set_config_option') {
    if (frame.params.configId === 'model') {
      models.currentModelId = frame.params.value;
      effort = '';
    } else if (frame.params.configId === 'reasoning_effort' && !options.unconfirmedEffort) {
      effort = frame.params.value === 'default' ? '' : frame.params.value;
    }
    reply(frame.id, { configOptions: configOptions() });
  } else if (frame.method === 'session/set_model' || frame.method === 'session/set_mode') {
    if (frame.method === 'session/set_model' && options.modelUpdate) {
      send({ method: 'qwen/notify/session/model-update', params: {
        sessionId: options.foreignModelUpdate ? 'foreign-session' : sessionId,
        currentModelId: options.modelUpdate,
      } });
    }
    reply(frame.id, {});
  } else if (frame.method === 'session/prompt') {
    prompt = frame;
    count += 1;
    for (const file of options.readMasks || []) {
      try {
        log({ event: 'mask', file, text: readFileSync(file, 'utf8') });
      } catch (error) {
        log({ event: 'mask', file, code: error.code });
      }
    }
    if (options.bounds) {
      for (const file of options.bounds.allowed) {
        writeFileSync(file, 'allowed');
      }
      for (const file of options.bounds.denied) {
        try {
          writeFileSync(file, 'BAD');
          log({ event: 'bounds', file, denied: false });
        } catch {
          log({ event: 'bounds', file, denied: true });
        }
      }
    }
    if (options.brokenJson) {
      process.stdout.write('{broken\\n');
      process.exit(9);
    }
    if (options.error) {
      send({ id: frame.id, error: { code: -32001,
        message: typeof options.error === 'string' ? options.error : 'synthetic upstream failure' } });
      return;
    }
    if (options.eof) {
      process.exit(7);
    }
    if (options.hold) {
      notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Начало' } });
      return;
    }
    if (options.ask) {
      send({ id: 'permission-1', method: 'session/request_permission', params: {
        sessionId, toolCall: { toolCallId: 'tool-1', title: options.tool.name,
          kind: 'execute', rawInput: options.tool.args },
        options: [{ optionId: 'allow_once', name: 'Разрешить', kind: 'allow_once' },
          { optionId: 'reject_once', name: 'Запретить', kind: 'reject_once' }],
      } });
    } else if (options.tool) {
      guard();
    } else {
      finish();
    }
  } else if (frame.method === 'session/cancel') {
    if (prompt && !options.ignoreCancel) {
      const finishCancel = () => {
        log({ event: 'cancel-flushed' });
        reply(prompt.id, { stopReason: 'cancelled' });
      };

      if (options.cancelDelayMs) {
        setTimeout(finishCancel, options.cancelDelayMs);
      } else {
        finishCancel();
      }
    }
  } else if (frame.id === 'permission-1') {
    if (frame.result?.outcome?.optionId === 'allow_once') {
      guard();
    } else {
      if (options.askDeniedContinues) {
        finish();
      } else {
        reply(prompt.id, { stopReason: 'cancelled' });
      }
    }
  } else if (frame.id === reverse) {
    const allowed = frame.result?.allowed === true;
    log({ event: 'guard', allowed });
    if (allowed && options.effect) {
      writeFileSync(options.effect, 'effect');
    }
    notify({ sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: options.tool.name,
      kind: 'execute', status: 'in_progress', rawInput: options.tool.args });
    notify({ sessionUpdate: 'tool_call_update', toolCallId: 'tool-1',
      status: allowed ? 'completed' : 'failed', content: [{ type: 'content',
        content: { type: 'text', text: allowed ? 'Готово' : 'Запрещено' } }] });
    if (options.eofAfterTool) {
      process.exit(7);
    }
    finish();
  } else if (frame.method && Object.hasOwn(frame, 'id')) {
    reply(frame.id, {});
  }
});
function guard() {
  reverse = 'guard-' + count;
  send({ id: reverse, method: 'qwen/control/external_tool_guard/prepare', params: {
    sessionId: options.foreignSession ? 'foreign-session' : sessionId,
    promptId: prompt.params._meta?.['qwen-code/invocation']?.promptId,
    toolCallId: 'tool-1', toolName: options.tool.name, arguments: options.tool.args,
    permissionChecked: true, invocationCwd: process.cwd(),
  } });
}
async function finish() {
  if (options.status) {
    await publishStatus();
  }
  for (const update of options.stream || [
    { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Думаю' } },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Новый ответ' } },
  ]) {
    notify(update);
  }
  if (options.streamError) {
    send({ id: prompt.id, error: { code: -32001, message: 'synthetic stream failure' } });
    return;
  }
  reply(prompt.id, { stopReason: 'end_turn' });
}
async function publishStatus() {
  if (!statusServer) throw new Error('wrapper did not provide factory-status MCP');
  const env = { ...process.env };
  for (const entry of statusServer.env || []) env[entry.name] = entry.value;
  const child = spawn(statusServer.command, statusServer.args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  const output = readline.createInterface({ input: child.stdout });
  output.on('line', (line) => {
    const response = JSON.parse(line);
    pending.get(response.id)?.(response);
  });
  const request = (id, method, params) => new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\\n');
  });
  await request(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {},
    clientInfo: { name: 'qwen-fixture', version: '1' } });
  const bad = await request(2, 'tools/call', { name: 'stage_result', arguments: {
    result: 'done', runId: 'stale-run' } });
  log({ event: 'status-stale', response: bad });
  if (!bad.error && !bad.result?.isError) throw new Error('stale identity accepted');
  const good = await request(3, 'tools/call', { name: 'stage_result', arguments: {
    result: 'done', comment: 'qwen fixture completed' } });
  log({ event: 'status-current', response: good });
  child.stdin.end();
  await new Promise((resolve) => child.once('close', resolve));
}
`;
}

/**
 * Процесс тестовой оболочки принадлежит только этой фикстуре.
 * Таймер завершает свою process group и не затрагивает соседние сессии.
 */
export async function shellRun(script, { cwd, env, timeout = 20000 } = {}) {
  const child = spawn('bash', ['-c', script], {
    cwd,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  const timer = setTimeout(() => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // Процесс мог завершиться перед таймером.
    }
  }, timeout);

  child.stdout.on('data', (part) => {
    stdout += part;
  });
  child.stderr.on('data', (part) => {
    stderr += part;
  });

  try {
    const status = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });

    return {
      status,
      stdout,
      stderr,
      pid: child.pid,
    };
  } finally {
    clearTimeout(timer);
  }
}
