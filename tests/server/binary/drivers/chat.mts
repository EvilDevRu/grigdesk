import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { promisify } from 'node:util';
import type { ChildProcess } from 'node:child_process';

import { startDeepSeekLoopback } from '../../../helpers/deepseekLoopback.mts';
import { startGlmLoopback } from '../../../helpers/glmLoopback.mts';
import { writeGlmEgressGuard } from '../../../helpers/glmEgressGuard.mts';
import type { BinaryIsolationPaths } from '../isolation.mts';
import { bootApi } from './api.mts';
import { deepSeekChatPort, glmDeps, loadCompiledApi } from './providerPorts.mjs';

const execute = promisify(execFile);
const paths = JSON.parse(process.argv[2]!) as BinaryIsolationPaths;
const bundle = path.join(paths.runtime, 'server/payload.cjs');
const exists = async (file: string) => access(file).then(() => true, () => false);

/**
 * Хешируются CJS и все helpers, уже сверенные полным verifier с защищённым индексом ELF.
 * Проверка до и после ходов не доверяет копии manifest внутри распакованного R.
 */
async function protectedHashes() {
  const directory = path.join(paths.runtime, 'server/runtime/helpers');
  const hashes: Record<string, string> = {};

  for (const file of [bundle, ...(await readdir(directory)).map((name) => path.join(directory, name))]) {
    hashes[path.relative(paths.runtime, file)] = createHash('sha256')
      .update(await readFile(file)).digest('hex');
  }

  return hashes;
}

/**
 * Реальный ELF verifier проверяет целое дерево по защищённому manifest из SEA assets.
 * Запуск не импортирует source и не наследует ключи владельца стенда.
 */
async function verify() {
  const result = await execute(paths.binary, ['--verify', '--json'], {
    env: {
      PATH: '',
      HOME: paths.home,
      GRIGDESK_HOME: paths.data,
    },
    cwd: '/',
    timeout: 120000,
    maxBuffer: 65536,
  });
  const report = JSON.parse(result.stdout);

  assert.equal(report.verified, true);
  assert.equal(report.packageId, paths.packageId);

  return report;
}

/**
 * Только чтение настоящих WS кадров: исходный emit получает прежние аргументы и результат.
 * Наблюдение доказывает hook/result и terminal events без замены adapter или runTurn.
 */
function observeWireEvents() {
  const WebSocket = createRequire(import.meta.url)(path.join(paths.runtime, 'server/node_modules/ws'));
  const original = WebSocket.prototype.emit;
  const events: any[] = [];

  WebSocket.prototype.emit = function (name: string, ...args: any[]) {
    if (name === 'message') {
      try {
        const frame = JSON.parse(String(args[0]));

        if (frame.type === 'item' && frame.value?.type === 'event') {
          events.push(frame.value.event);
        }
      } catch {}
    }

    return original.call(this, name, ...args);
  };

  return {
    events,
    restore: () => {
      WebSocket.prototype.emit = original;
    },
  };
}

/**
 * Ответ инструмента использует настоящий streaming tool-call протокол провайдера.
 * Следующий модельный запрос и файловый эффект доказывают исполнение production runtime.
 */
function toolCall(name: string, args: Record<string, unknown>, id: string) {
  return {
    kind: 'stream' as const,
    deltas: [{
      role: 'assistant',
      tool_calls: [{
        index: 0,
        id,
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      }],
    }],
    finishReason: 'tool_calls',
  };
}

/**
 * Настоящий web adapter запускает отдельный DeepSeek ELF и сохраняет память второго prompt.
 * DI меняет лишь endpoint, а инструкции, helper-команды и sandbox берутся из payload R.
 */
async function deepseekChat(api: any) {
  const mock = await startDeepSeekLoopback({ respond: async () => ({
    deltas: [{ role: 'assistant', content: 'S25-DEEPSEEK-REPLY' }],
  }) });
  const config = {
    rootDir: paths.runtime,
    deepseekRuntimeMode: 'binary',
    deepseekBin: paths.deepseek,
    deepseekCacheDir: paths.deepseekCache,
    deepseekRuntimeHome: path.join(paths.fixtures, 'deepseek-home'),
  };
  const launches: any[] = [];
  const start = deepSeekChatPort(api, config, mock.endpoint);
  const options = {
    config,
    cwd: paths.project,
    projectRoot: paths.project,
    chatKey: 's25-deepseek-chat',
    message: 's25-deepseek-first-prompt',
    model: '["deepseek-official","deepseek-v4-flash"]',
    effort: 'off',
    env: {
      PATH: process.env.PATH,
      HOME: paths.home,
      DEEPSEEK_API_KEY: 'synthetic-deepseek-s25',
    },
    signal: AbortSignal.timeout(60000),
    startServer: async (input: any) => {
      launches.push({
        envNames: Object.keys(input.env),
        overlay: await readFile(input.overlayPath, 'utf8'),
        hooks: await readFile(path.join(path.dirname(input.overlayPath), 'hooks.json'), 'utf8'),
      });

      return start(input);
    },
  };

  try {
    const first = await api.runDeepSeekWebTurn(options);
    const second = await api.runDeepSeekWebTurn({
      ...options,
      sessionId: first.sessionId,
      message: 's25-deepseek-second-prompt',
    });
    const messages = JSON.stringify(mock.payloads.at(-1)?.messages);

    assert.equal(first.reply, 'S25-DEEPSEEK-REPLY');
    assert.equal(second.reply, first.reply);
    assert.ok(first.sessionId);
    assert.equal(second.sessionId, first.sessionId);
    assert.equal(mock.payloads.length, 2);

    for (const marker of ['S25-INSTRUCTIONS-FROM-CLAUDE', 's25-deepseek-first-prompt',
      's25-deepseek-second-prompt']) {
      assert.ok(messages.includes(marker), marker);
    }

    for (const launch of launches) {
      assert.ok(launch.hooks.includes(`${paths.runtime}/server/runtime/helpers/`));
      assert.ok(launch.hooks.includes(`${paths.runtime}/runtime/node/bin/node`));
      assert.equal(launch.overlay.includes(paths.source), false);
      assert.equal(launch.envNames.includes('ZAI_API_KEY'), false);
    }

    return {
      reply: second.reply,
      sessionId: second.sessionId,
      requests: mock.payloads.length,
      instructions: true,
      resumed: true,
      helpersFromR: true,
    };
  } finally {
    await mock.stop();
  }
}

/**
 * GLM использует compiled adapter, synthetic admission и неизменный настоящий policy hook.
 * Сценарий проверяет запись в cwd, отказ снаружи, resume и отмену долгого инструмента.
 */
async function glmChat(api: any, wire: any[]) {
  const key = 'synthetic-zai-service-s25';
  const model = '["zai","glm-5.3"]';
  const children: ChildProcess[] = [];
  const launches: any[] = [];
  const inside = path.join(paths.project, 'glm-inside.txt');
  const outside = path.join(paths.fixtures, 'glm-outside.txt');
  const mock = await startGlmLoopback({
    expectedKey: key,
    respond: (_payload, index) => {
      if (index === 0) {
        return toolCall('write', { file_path: inside, content: 'S25-WRITTEN' }, 's25-in');
      }
      if (index === 1) {
        return toolCall('write', { file_path: outside, content: 'FORBIDDEN' }, 's25-out');
      }
      if (index === 4) {
        return toolCall('bash', {
          command: 'echo started > s25-started; sleep 30; echo forbidden > s25-after-stop',
          description: 'fixture cancellation',
        }, 's25-stop');
      }

      return { kind: 'stream', deltas: [{ role: 'assistant', content: 'S25-GLM-REPLY' }] };
    },
  });
  const info = JSON.parse((await execute(paths.deepseek, ['--runtime-info', '--json'], {
    env: { PATH: '' },
    timeout: 10000,
    maxBuffer: 65536,
  })).stdout);
  const deps = glmDeps(api, info, mock.endpoint,
    await writeGlmEgressGuard(path.join(paths.fixtures, 'guard')), {
      PATH: process.env.PATH,
      HOME: paths.home,
      GRIGDESK_GLM_API_MODE: 'api',
      ZAI_API_KEY: key,
    }, model);
  const adapter = api.createGlmAdapter({
    ...deps,
    spawn: (...args: Parameters<typeof spawn>) => {
      const child = spawn(...args);

      children.push(child);
      launches.push({ command: args[0], envNames: Object.keys(args[2]?.env ?? {}) });

      return child;
    },
  });
  const options = {
    config: {
      rootDir: paths.runtime,
      deepseekRuntimeMode: 'binary',
      deepseekBin: paths.deepseek,
      deepseekCacheDir: paths.deepseekCache,
      glmRuntimeHome: path.join(paths.fixtures, 'glm-home'),
    },
    cwd: paths.project,
    chatKey: 's25-glm-chat',
    message: 's25-glm-first-prompt',
    model,
    effort: 'high',
    onSessionCreated: async () => {},
    onPermission: async () => ({ allow: false }),
    signal: AbortSignal.timeout(60000),
  };

  try {
    const first = await adapter.run(options);
    const second = await adapter.run({
      ...options,
      sessionId: first.sessionId,
      message: 's25-glm-second-prompt',
    });

    assert.equal(first.reply, 'S25-GLM-REPLY');
    assert.equal(second.reply, first.reply);
    assert.equal(second.sessionId, first.sessionId);
    assert.equal(await readFile(inside, 'utf8'), 'S25-WRITTEN');
    assert.equal(await exists(outside), false);

    const memory = JSON.stringify(mock.requests[3]!.payload.messages);

    for (const marker of ['s25-glm-first-prompt', 's25-glm-second-prompt', 'S25-INSTRUCTIONS-FROM-CLAUDE']) {
      assert.ok(memory.includes(marker), marker);
    }

    assert.equal(await exists(path.join(paths.project, 'foreign-mcp-effect')), false);

    const tools = JSON.stringify(mock.requests.map((request) => request.payload.tools));

    assert.equal(tools.includes('foreign-evil'), false);

    const controller = new AbortController();
    const running = adapter.run({
      ...options,
      message: 's25-glm-stop',
      signal: controller.signal,
    });

    void running.catch(() => {});

    const deadline = Date.now() + 30000;

    while (!await exists(path.join(paths.project, 's25-started')) && Date.now() < deadline) {
      await pause(20);
    }

    assert.equal(await exists(path.join(paths.project, 's25-started')), true, 'Долгий инструмент начался');
    controller.abort();
    await assert.rejects(running, (error: any) => error.stopped === true);
    assert.equal(await exists(path.join(paths.project, 's25-after-stop')), false);
    assert.ok(children.every((child) => child.exitCode !== null || child.signalCode !== null));
    assert.ok(launches.every((launch) => launch.command === paths.deepseek));
    assert.equal(mock.requests.length, 5);

    for (const request of mock.requests) {
      assert.equal(request.path, '/api/paas/v4/chat/completions');
      assert.equal(request.authorizationMatches, true);
      assert.equal(request.model, 'glm-5.3');
    }

    const hooks = wire.filter((event) => event.type === 'hook/result').flatMap((event) =>
      String(event.data?.stderrSummary ?? '').split('\n').filter((line) => line.startsWith('GLM-POLICY '))
        .map((line) => JSON.parse(line.slice('GLM-POLICY '.length))));
    const alive = hooks.filter((hook) => hook.marker === 'hooks-alive');

    assert.ok(alive.length >= 3, 'Каждый настоящий GLM ход подтвердил hooks-alive');

    for (const hook of alive) {
      assert.ok(hook.envNames.includes('CLAUDE_PROJECT_DIR'));

      for (const name of ['ZAI_API_KEY', 'ZAI_CODING_API_KEY', 'DEEPSEEK_API_KEY',
        'GRIGDESK_GLM_ROUTE_KEY']) {
        assert.equal(hook.envNames.includes(name), false, `Hook не наследует ${name}`);
      }
    }

    assert.ok(hooks.some((hook) => hook.event === 'PreToolUse' && hook.name === 'write'));

    return {
      reply: second.reply,
      sessionId: second.sessionId,
      requests: mock.requests.length,
      hooksAlive: alive.length,
      resumed: true,
      insideWritten: true,
      outsideDenied: true,
      foreignMcpAbsent: true,
      stopped: true,
      workersClosed: true,
      hookEnvNames: alive[0].envNames,
    };
  } finally {
    await mock.stop();
    mock.assertComplete();
  }
}

assert.equal(await exists(paths.source), false);
assert.equal(await exists(paths.hostHome), false);
await mkdir(path.join(paths.project, '.git'), { recursive: true });
await writeFile(path.join(paths.project, 'CLAUDE.md'), 'S25-INSTRUCTIONS-FROM-CLAUDE\n');
await writeFile(path.join(paths.project, '.mcp.json'), JSON.stringify({ mcpServers: {
  'foreign-evil': { command: '/bin/sh', args: ['-c', 'echo forbidden > foreign-mcp-effect'] },
} }));

const beforeVerified = await verify();
const before = await protectedHashes();
const api = await loadCompiledApi(bundle, paths.binary);
const wire = observeWireEvents();

try {
  const http = await bootApi({
    binary: paths.binary,
    data: paths.data,
    packageId: paths.packageId,
    preflight: true,
    windowSession: true,
  });
  const deepseek = await deepseekChat(api);
  const glm = await glmChat(api, wire.events);
  const after = await protectedHashes();
  const afterVerified = await verify();

  assert.deepEqual(after, before);
  assert.equal(await exists('/D/host-node-attempts'), false);
  assert.ok(wire.events.some((event) => event.type === 'turn/end'
    && event.data?.reason?.kind === 'completed'));

  console.log('BINARY_REPORT ' + JSON.stringify({
    providers: ['deepseek', 'glm'],
    api: http,
    deepseek,
    glm,
    integrity: {
      unchanged: true,
      before,
      after,
      beforeVerified,
      afterVerified,
    },
    hostNodeAttempts: 0,
    sourceAbsent: true,
    networkNamespace: 'isolated-loopback',
    terminalEvents: wire.events.filter((event) => event.type === 'turn/end')
      .map((event) => event.data.reason.kind),
  }));
} finally {
  wire.restore();
}
