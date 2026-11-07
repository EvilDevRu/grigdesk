import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createSocket } from 'node:dgram';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { AUTO_CONTINUE_PROMPT } from '../../server/src/lib/chat/autoContinue.ts';
import { startDeepSeekServer } from '../../server/src/lib/deepseek/serverRuntime.ts';
import { runDeepSeekServerTurn } from '../../server/src/lib/deepseek/serverTurn.ts';
import { DSH_TURN_FAILURE_RULES } from '../../server/src/lib/deepseek/turnFailureRules.ts';
import { ensureTestDeepSeekBinary } from '../helpers/deepseekBinary.mts';
import { writeDeepSeekLoopbackOverlay } from '../helpers/deepseekLoopback.mts';
import { webFixture } from '../helpers/deepseekWebLifecycle.mjs';
import { chatAppFixture, saveChat, turnBody, waitFor } from './helpers/chat-turns.js';

const run = promisify(execFile);
const source = fileURLToPath(import.meta.url);
const criticPrompt = 'ПРОВЕРКА_DNS: проверь план';

/**
 * Единственный изменяемый resolv.conf смонтирован внутри нового mount/net namespace.
 * DNS принимает запрос настоящего getaddrinfo и намеренно оставляет его без ответа.
 */
async function silentDns(t, root) {
  const resolv = path.join(root, 'resolv.conf');

  await fs.writeFile(resolv, 'nameserver 127.0.0.1\noptions timeout:30 attempts:2\n');
  execFileSync('ip', ['link', 'set', 'lo', 'up']);
  execFileSync('mount', ['--bind', resolv, '/etc/resolv.conf']);

  const server = createSocket('udp4');
  const questions = [];

  server.on('message', (packet) => {
    let offset = 12;
    const labels = [];

    while (packet[offset]) {
      const length = packet[offset++];

      labels.push(packet.subarray(offset, offset + length).toString());
      offset += length;
    }

    questions.push(labels.join('.'));
  });
  await new Promise((resolve) => server.bind(53, '127.0.0.1', resolve));
  t.after(() => server.close());

  return questions;
}

/**
 * Настоящий Harness вызывает task; родитель исчерпывает пять повторов только после
 * наблюдения DNS или MCP-вызова критика. Ответ продолжения отдаётся локальной моделью.
 */
async function modelFixture(t, mode, root, questions) {
  const requests = [];
  let taskCalls = 0;

  const server = createServer(async (request, response) => {
    let body = '';

    for await (const chunk of request) {
      body += String(chunk);
    }

    const payload = JSON.parse(body);
    const users = payload.messages.filter((message) => message.role === 'user');

    requests.push(payload);

    if (users.some((message) => typeof message.content === 'string'
      && message.content.includes(AUTO_CONTINUE_PROMPT))) {
      completion(response, { content: 'Работа продолжена.' }, 'stop');
    } else if (users.some((message) => JSON.stringify(message.content).includes(criticPrompt))) {
      const tool = payload.tools.find((row) => row.function.name.endsWith('__hold'));

      assert.ok(tool, 'Критику предоставлен настоящий MCP-инструмент');
      completion(response, { tool_calls: [{
        index: 0,
        id: 'mcp-call',
        type: 'function',
        function: { name: tool.function.name, arguments: '{}' },
      }] }, 'tool_calls');
    } else if (requests.length === 1) {
      taskCalls++;
      completion(response, { tool_calls: [{
        index: 0,
        id: 'critic-call',
        type: 'function',
        function: { name: 'task', arguments: JSON.stringify({
          description: 'Проверка плана',
          prompt: criticPrompt,
          run_in_background: true,
        }) },
      }] }, 'tool_calls');
    } else {
      await waitFor(async () => mode === 'mcp'
        ? (await fs.readFile(path.join(root, 'mcp.jsonl'), 'utf8').catch(() => '')).includes('tool-start')
        : questions.includes('api.deepseek.com'), { timeoutMs: 20000, what: 'живой критик' });
      request.socket.destroy();
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  return {
    endpoint: `http://127.0.0.1:${server.address().port}`,
    requests,
    taskCalls: () => taskCalls,
  };
}

/**
 * SSE проходит через production translate, включая настоящий вызов инструмента.
 * Ни ошибка TRANSPORT, ни успешный результат не подставляются сборщику напрямую.
 */
function completion(response, delta, finishReason) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write(`data: ${JSON.stringify({ choices: [{
    index: 0,
    delta,
    finish_reason: null,
  }] })}\n\n`);
  response.write(`data: ${JSON.stringify({ choices: [{
    index: 0,
    delta: {},
    finish_reason: finishReason,
  }] })}\n\n`);
  response.end('data: [DONE]\n\n');
}

/**
 * Профиль использует штатные provider, subagents и MCP; меняются только локальные входы.
 * DNS у критика настоящий, а exit-наблюдатель лишь записывает активные native requests.
 */
async function overlayFixture(input, endpoint, mode) {
  const { root, options } = input;
  const cache = options.runtime.prefixArgs[options.runtime.prefixArgs.indexOf('--cache-dir') + 1];
  const artifact = path.join(cache, 'packages',
    options.runtime.metadata.packageId, 'generation');
  const document = path.join(root, 'settings.yaml');

  await fs.writeFile(document, '{}\n');

  const overlay = await writeDeepSeekLoopbackOverlay({
    root,
    artifact,
    endpoint,
    document,
  });
  const preset = path.join(root, 'home/.agent-presets/transport-probe');

  await fs.cp(path.join(artifact, 'packages/preset/agent-presets/presets/standard'),
    preset, { recursive: true });
  await fs.chmod(preset, 0o700);

  for (const entry of await fs.readdir(preset, { recursive: true, withFileTypes: true })) {
    await fs.chmod(path.join(entry.parentPath, entry.name), entry.isDirectory() ? 0o700 : 0o600);
  }

  const presetFile = path.join(preset, 'agent.cordis.yml');

  await fs.writeFile(presetFile, (await fs.readFile(presetFile, 'utf8'))
    .replace('toolName: subagent\n', 'toolName: task\n'));
  await fs.writeFile(path.join(root, 'loopback-host.mjs'), `
import { writeFileSync } from 'node:fs';
export const name = 'изолированная-модель';
export const inject = ['settings'];
export function apply() {
  const original = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    let url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
    const body = JSON.parse(init?.body ?? '{}');
    const critic = body.messages?.some(row => row.role === 'user'
      && JSON.stringify(row.content).includes(${JSON.stringify(criticPrompt)}));
    if (critic && ${JSON.stringify(mode)} !== 'mcp') {
      url = new URL(url.pathname, 'https://api.deepseek.com');
    } else if (url.hostname !== '127.0.0.1') {
      throw new Error('Разрешён только loopback');
    }
    return original(url, init);
  };
  process.once('exit', code => writeFileSync(${JSON.stringify(path.join(root, 'worker-exit.json'))},
    JSON.stringify({ code, requests: process._getActiveRequests().map(row => row.constructor.name) })));
}
`);

  const mcp = fileURLToPath(new URL('../fixtures/deepseek-harness/slowMcp.mjs', import.meta.url));
  const mcpOverlay = mode === 'mcp' ? `- insert:
    - id: mcp-fixture
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: grigdesk-work
        transport: stdio
        command: ${JSON.stringify(process.execPath)}
        args: ${JSON.stringify([mcp, path.join(root, 'mcp.jsonl'), 'slow'])}
        failOnStartupError: true
` : '';
  const content = (await fs.readFile(overlay, 'utf8')).replace('maxRetries: 0',
    'maxRetries: 5\n      backoff:\n        initialDelayMs: 20\n        maxDelayMs: 40\n'
    + '        jitterRatio: 0');

  await fs.writeFile(overlay, mcpOverlay + '- id: agent-presets\n  config:\n    default: transport-probe\n'
    + content + await fs.readFile(options.overlayPath, 'utf8'));

  return overlay;
}

/**
 * Настоящее ядро принимает один turn и само вызывает существующую петлю восстановления.
 * Перед вторым ELF проверяются закрытые stdio, исчезновение группы и прежняя сессия.
 */
async function namespaceCase(mode) {
  const cleanups = [];
  const t = { after: (callback) => cleanups.push(callback) };

  try {
    const input = await webFixture(t);
    const questions = await silentDns(t, input.root);
    const model = await modelFixture(t, mode, input.root, questions);
    const overlayPath = await overlayFixture(input, model.endpoint, mode);
    const runs = [];
    const outcomes = [];
    const stops = [];
    const workerExits = [];
    let sessionId;
    let failure;

    /**
     * Запуски делит настоящее ядро; адаптер сохраняет переданные sessionId и runId.
     * Следующий процесс допускается только после проверенной остановки предыдущего.
     */
    const adapter = async (turn) => {
      if (runs.length) {
        assert.equal(input.launcher().exitCode, 0);
        assert.throws(() => process.kill(-input.launcher().pid, 0), { code: 'ESRCH' });
      }

      runs.push({
        message: turn.message,
        sessionId: turn.sessionId,
        attachments: turn.attachmentPaths,
      });

      try {
        const result = await runDeepSeekServerTurn({
          ...input.options,
          ...turn,
          overlayPath,
          env: { ...input.options.env, DEEPSEEK_API_KEY: 'synthetic-loopback-key' },
          model: '["deepseek-official","deepseek-v4-flash"]',
          effort: 'off',
          onSessionCreated: async (id) => {
            sessionId = id;
            await turn.onSessionCreated?.(id);
          },
          onPermission: async () => ({ allow: true }),
          startServer: async (options) => {
            const server = await startDeepSeekServer({ ...options,
              spawnProcess: input.options.spawnProcess });

            const pids = await input.ready();

            return { ...server, stop: async () => {
              try {
                await server.stop();
                assert.throws(() => process.kill(pids.worker, 0), { code: 'ESRCH' });
                assert.throws(() => process.kill(pids.shell, 0), { code: 'ESRCH' });
              } finally {
                const child = input.launcher();

                stops.push({ code: child.exitCode, signal: child.signalCode });
                workerExits.push(JSON.parse(await fs.readFile(
                  path.join(input.root, 'worker-exit.json'), 'utf8')));
              }
            } };
          },
        });

        outcomes.push(result);

        return result;
      } catch (error) {
        failure = error;

        throw error;
      }
    };
    const app = await chatAppFixture(t, {
      executor: {
        id: 'test-provider',
        turnFailureRules: DSH_TURN_FAILURE_RULES,
        run: adapter,
      },
      autoContinueDelaysMs: { network: [5, 5, 5] },
    });

    await saveChat(app.app, 'dns-recovery');

    const accepted = await app.app.inject({
      method: 'POST',
      url: '/api/chat',
      payload: turnBody('dns-recovery', 'turn-dns-recovery', 'Исходная задача: запусти критика плана.'),
    });

    assert.equal(accepted.statusCode, 202);

    if (mode === 'stop') {
      await waitFor(() => questions.includes('api.deepseek.com'), { timeoutMs: 20000, what: 'DNS критика' });
      await app.app.inject({
        method: 'POST',
        url: '/api/chat/stop',
        payload: { chatKey: 'dns-recovery' },
      });
    }

    const result = await waitFor(async () => {
      const pending = (await app.app.inject({ method: 'GET',
        url: '/api/chat/pending?chatKey=dns-recovery' })).json().pending;

      assert.ok(!pending || pending.length <= 1);

      return pending?.[0];
    }, { timeoutMs: 60000, what: 'единственный итог ELF' });

    console.log(JSON.stringify({
      mode,
      stops,
      runs: runs.map((turn) => ({
        continuation: turn.message === AUTO_CONTINUE_PROMPT,
        sessionId: turn.sessionId,
      })),
      workerExits,
      autoContinued: result.autoContinued ?? 0,
      failure: failure && {
        code: failure.code,
        turnFailure: failure.turnFailure,
        stopDetails: failure.stopDetails,
      },
    }));
    assert.equal(result.turnId, 'turn-dns-recovery');
    assert.equal(model.taskCalls(), 1, 'Действие task не повторяется');
    assert.throws(() => process.kill(-input.launcher().pid, 0), { code: 'ESRCH' });

    if (mode === 'dns') {
      assert.ifError(failure);
      assert.ok(workerExits[0].requests.includes('GetAddrInfoReqWrap'));
      assert.equal(workerExits[0].code, 0);
      assert.equal(outcomes[0].turnFailure.code, 'TRANSPORT');
      assert.equal(result.autoContinued, 1);
      assert.equal(runs.length, 2);
      assert.equal(runs[1].message, AUTO_CONTINUE_PROMPT);
      assert.equal(runs[1].sessionId, sessionId);
      assert.deepEqual(runs[1].attachments, []);
      assert.equal(result.steps.filter((step) => step.name === 'task').length, 1);
      assert.match(result.reply, /Работа продолжена/u);
      assert.ok(model.requests.length >= 8, 'Родитель прошёл пять внутренних повторов');

      const runIds = new Set();

      JSON.stringify(app.events, (_key, value) => {
        if (value && typeof value === 'object' && typeof value.runId === 'string') {
          runIds.add(value.runId);
        }

        return value;
      });
      assert.deepEqual([...runIds], [result.runId], 'Ядро сохранило один runId');
    } else {
      assert.equal(result.autoContinued ?? 0, 0);
      assert.equal(runs.length, 1);

      if (mode === 'mcp') {
        assert.equal(failure.code, 'deepseek_binary_cleanup');
        assert.equal(failure.turnFailure.code, 'TRANSPORT');
        assert.equal(failure.stopDetails.exit.code, 75);
        assert.equal(failure.turnRecovery.canContinue, false);
        assert.match(result.reply, /cleanup/u);
      } else {
        assert.equal(result.stopped, true);
        assert.equal(stops[0].code, 0);
      }
    }
  } finally {
    for (const cleanup of cleanups.reverse()) {
      await cleanup();
    }
  }
}

if (process.argv[2] === '--namespace-case') {
  await namespaceCase(process.argv[3]);
} else {
  for (const mode of ['dns', 'mcp', 'stop']) {
    test(`ELF: ${mode}, живой критик и прежнее автопродолжение`, { timeout: 150000 }, async (t) => {
      try {
        await run('unshare', ['-rmn', 'true']);
      } catch (error) {
        t.skip(`User/mount/net namespaces недоступны: ${error.message}`);

        return;
      }

      let candidate;

      if (!process.env.GRIGDESK_TEST_DEEPSEEK_BINARY) {
        t.skip('Нужен подготовленный тестовый ELF: задайте GRIGDESK_TEST_DEEPSEEK_BINARY');

        return;
      }

      try {
        candidate = await ensureTestDeepSeekBinary();
      } catch (error) {
        if (/ENOENT/u.test(error.message)) {
          t.skip(`Тестовый ELF недоступен: ${error.message}`);

          return;
        }

        throw error;
      }

      const result = await run('unshare', ['-rmn', process.execPath, '--experimental-strip-types',
        source, '--namespace-case', mode], {
        env: {
          ...process.env,
          GRIGDESK_TEST_DEEPSEEK_BINARY: candidate.binary,
          GRIGDESK_TEST_DEEPSEEK_CACHE_DIR: candidate.cacheDir,
        },
        timeout: 120000,
        maxBuffer: 4 * 1024 * 1024,
      }).catch((error) => {
        assert.fail(`${error.message}\n${error.stdout}\n${error.stderr}`);
      });

      t.diagnostic(result.stdout.trim());
    });
  }
}
