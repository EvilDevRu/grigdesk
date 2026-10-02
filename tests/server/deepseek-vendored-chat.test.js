import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { spawn } from 'node:child_process';

import deepseek from '../../server/src/lib/executors/deepseek.ts';
import { runDeepSeekWebTurn } from '../../server/src/lib/deepseek/webRuntime.ts';
import { startDeepSeekServer } from '../../server/src/lib/deepseek/serverRuntime.ts';
import { prepareChatNativeSettings } from '../../server/src/lib/executorSettings/launch.ts';
import { PrefsStore } from '../../server/src/lib/prefsStore.ts';
import { ensureTestDeepSeekArtifact } from '../helpers/deepseekRuntimeArtifact.mts';
import { startDeepSeekLoopback, writeDeepSeekLoopbackOverlay } from '../helpers/deepseekLoopback.mts';

// Корень репозитория не зависит от cwd: `npm test` запускает набор из server/.
const REPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

/**
 * Стенд запускает production web overlay с настоящими hooks и файловой песочницей.
 * Только endpoint и ответы модели заменены loopback fixture с запретом внешнего fetch.
 */
async function fixture(t, mockOptions, { outsideTemp = false } = {}) {
  const artifact = await ensureTestDeepSeekArtifact();
  const parent = outsideTemp
    ? path.join(REPO_ROOT, '.state/artifacts/deepseek-vendoring/fs-fixtures') : os.tmpdir();

  await fs.mkdir(parent, { recursive: true });

  const root = await fs.mkdtemp(path.join(parent, 'deepseek-built-chat-'));
  const cwd = path.join(root, 'project', 'nested');
  const projectRoot = path.dirname(cwd);
  const mock = await startDeepSeekLoopback(mockOptions);

  await fs.mkdir(cwd, { recursive: true });
  // Upstream ищет инструкции от корня git до cwd, а вне git корнем считает сам cwd.
  // Файл в cwd доставляется при любом TMPDIR: и в /tmp, и внутри git-дерева репозитория.
  await fs.writeFile(path.join(cwd, 'CLAUDE.md'), 'fixture-instructions-in-cwd\n');

  t.after(async () => {
    await mock.stop();
    await fs.rm(root, { recursive: true, force: true });
  });

  const config = {
    rootDir: REPO_ROOT,
    deepseekBin: '/no-global-dsh',
    deepseekArtifactDir: artifact,
    deepseekRuntimeHome: path.join(root, 'runtime-home'),
  };
  const launches = [];

  /**
   * Дополнительный private patch сохраняет исходный sandbox и server-owned hooks.
   * Settings document принадлежит этому ходу и не меняет общий home.
   */
  const startServer = async (options) => {
    const launchDir = path.dirname(options.overlayPath);
    const original = await fs.readFile(options.overlayPath, 'utf8');
    const document = path.join(launchDir, 'native-settings.yaml');

    await fs.writeFile(document, '{}\n', { mode: 0o600, flag: 'wx' }).catch((error) => {
      if (error.code !== 'EEXIST') {
        throw error;
      }
    });

    const patch = await writeDeepSeekLoopbackOverlay({
      root: launchDir,
      artifact,
      endpoint: mock.endpoint,
      document,
    });
    const combined = path.join(launchDir, 'combined.yml');

    await fs.writeFile(combined, original + await fs.readFile(patch, 'utf8'), { mode: 0o600 });
    launches.push({
      launchDir,
      home: options.env.DSH_HOME,
      overlay: original,
    });

    let diagnostics = '';

    return startDeepSeekServer({
      ...options,
      overlayPath: combined,
      spawnProcess: (...args) => {
        const child = spawn(...args);

        child.stderr.on('data', (chunk) => {
          diagnostics = (diagnostics + String(chunk)).slice(-16_384);
        });

        return child;
      },
    }).catch((error) => {
      throw new Error(error.message + '\n' + diagnostics.replace(/token=\S+/g, 'token=<redacted>'));
    });
  };
  const run = (options = {}) => runDeepSeekWebTurn({
    config,
    cwd,
    projectRoot,
    chatKey: 'fixture-chat',
    message: 'first-fixture-prompt',
    model: '["deepseek-official","deepseek-v4-flash"]',
    effort: 'off',
    env: {
      PATH: process.env.PATH,
      HOME: root,
      DEEPSEEK_API_KEY: 'cockpit-loopback-only',
      COCKPIT_PROVIDER_PREFS_PATH: '/private-host-pref-sentinel',
    },
    signal: AbortSignal.timeout(45_000),
    startServer,
    ...options,
  });

  return {
    root,
    cwd,
    projectRoot,
    mock,
    config,
    launches,
    run,
  };
}

/**
 * Ответ соответствует настоящему streaming tool-call протоколу DeepSeek.
 * Payload следующего запроса доказывает выполнение инструмента исходным runtime.
 */
function toolResponse(name, args) {
  return {
    deltas: [{
      role: 'assistant',
      tool_calls: [{
        index: 0,
        id: 'fixture-tool-call',
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      }],
    }],
    finishReason: 'tool_calls',
  };
}

test('настоящий чат resume сохраняет память, инструкции, model/effort и поток reasoning', async (t) => {
  const f = await fixture(t, { respond: async () => ({
    deltas: [
      { role: 'assistant', reasoning_content: 'fixture-thought' },
      ...Array.from({ length: 20 }, () => ({ content: 'x' })),
    ],
  }) });
  const first = await f.run();
  const second = await f.run({
    sessionId: first.sessionId,
    message: 'second-fixture-prompt',
    effort: 'high',
  });
  const payload = f.mock.payloads.at(-1);

  assert.equal(second.sessionId, first.sessionId);
  assert.equal(second.reply, 'x'.repeat(20));
  assert.equal(payload.model, 'deepseek-v4-flash');
  assert.deepEqual(payload.thinking, { type: 'enabled' });
  assert.equal(payload.reasoning_effort, 'high');
  assert.match(JSON.stringify(payload.messages), /first-fixture-prompt/);
  assert.match(JSON.stringify(payload.messages), /fixture-instructions-in-cwd/);
  assert.match(JSON.stringify(payload.messages), /second-fixture-prompt/);
  assert.equal(second.contextMetric, 'unavailable');
  assert.ok(second.steps.length < 12, 'Дельты не размножают шаги ленты');
  assert.equal(f.launches[0].home, f.launches[1].home);
  assert.notEqual(f.launches[0].launchDir, f.launches[1].launchDir);

  for (const launch of f.launches) {
    await assert.rejects(fs.stat(launch.launchDir), { code: 'ENOENT' });
  }
});

test('настоящий чат busy сохраняет снимок, следующий ход получает save и unset', async (t) => {
  const arrived = Promise.withResolvers();
  const release = Promise.withResolvers();
  const f = await fixture(t, { respond: async (_payload, index) => {
    if (index === 0) {
      arrived.resolve();
      await release.promise;
    }

    return { deltas: [{ role: 'assistant', content: 'loopback-ok' }] };
  } });
  const prefs = new PrefsStore({ prefsPath: path.join(f.root, 'prefs.json') });
  const save = (value, revision) => prefs.write({ providerSettings: { deepseek: {
    nativeSettings: {
      format: 1,
      revision,
      overrides: value === undefined ? {} : {
        '["llm-deepseek","maxTokens"]': { path: ['llm-deepseek', 'maxTokens'], value },
      },
    },
  } } });

  t.after(() => release.resolve());
  save(64, 1);

  const snapshot = await prepareChatNativeSettings(deepseek, f.config, f.cwd,
    prefs.readStored().providerSettings);
  const busy = f.run({ nativeSettings: snapshot });

  busy.catch(arrived.reject);

  await arrived.promise;
  save(128, 2);
  release.resolve();

  const first = await busy;
  const next = await prepareChatNativeSettings(deepseek, f.config, f.cwd,
    prefs.readStored().providerSettings);
  const second = await f.run({ sessionId: first.sessionId, nativeSettings: next });

  save(undefined, 3);

  const unset = await prepareChatNativeSettings(deepseek, f.config, f.cwd,
    prefs.readStored().providerSettings);

  await f.run({ sessionId: second.sessionId, nativeSettings: unset });

  assert.equal(snapshot.accepted[0].value, 64);
  assert.deepEqual(f.mock.payloads.slice(0, 2).map((payload) => payload.max_tokens), [64, 128]);
  assert.notEqual(f.mock.payloads[2].max_tokens, 128);
  assert.equal(unset, undefined);
});

test('настоящий write сохраняет workspace boundary, read-only и symlink escape', async (t) => {
  for (const kind of ['allowed', 'read-only', 'parent', 'symlink']) {
    await t.test(kind, async (scenario) => {
      let target;
      const f = await fixture(scenario, { respond: async (_payload, index) => index === 0
        ? toolResponse('write', { file_path: target, content: 'fixture-written' })
        : { deltas: [{ role: 'assistant', content: 'loopback-ok' }] } }, { outsideTemp: true });

      target = kind === 'parent'
        ? path.join(f.projectRoot, 'outside.txt') : path.join(f.cwd, 'inside.txt');

      if (kind === 'symlink') {
        await fs.symlink(f.projectRoot, path.join(f.cwd, 'escape'));
        target = path.join(f.cwd, 'escape', 'outside.txt');
      }

      const result = await f.run({ permissionMode: kind === 'read-only' ? 'read-only' : 'default' });

      assert.equal(result.reply, 'loopback-ok');
      assert.equal(f.mock.payloads.length, 2);

      if (kind === 'allowed') {
        assert.equal(await fs.readFile(target, 'utf8'), 'fixture-written');
      } else {
        await assert.rejects(fs.stat(target), { code: 'ENOENT' });
        assert.match(JSON.stringify(f.mock.payloads[1].messages), /denied|sandbox|permission/i);
      }
    });
  }
});

test('настоящий чат передаёт вопрос через host и останавливает ожидающий API ход', async (t) => {
  await t.test('question', async (scenario) => {
    const f = await fixture(scenario, { respond: async (_payload, index) => index === 0
      ? toolResponse('ask_user_question', { questions: [{ id: 'q1', question: 'fixture-question' }] })
      : { deltas: [{ role: 'assistant', content: 'loopback-ok' }] } });
    let question;

    const result = await f.run({ onPermission: async (value) => {
      question = value;

      return { allow: true, rawAnswers: [{ text: 'fixture-answer', selected: [] }] };
    } });

    assert.equal(result.reply, 'loopback-ok');
    assert.equal(question.isQuestion, true);
    assert.match(JSON.stringify(f.mock.payloads[1].messages), /fixture-answer/);
  });

  await t.test('stop', async (scenario) => {
    const arrived = Promise.withResolvers();
    const release = Promise.withResolvers();
    const f = await fixture(scenario, { respond: async () => {
      arrived.resolve();
      await release.promise;

      return { deltas: [{ content: 'too-late' }] };
    } });
    const controller = new AbortController();
    const running = f.run({ signal: controller.signal });

    running.catch(arrived.reject);

    const rejected = assert.rejects(running, (error) => error.stopped === true);

    scenario.after(() => release.resolve());
    await arrived.promise;
    controller.abort();
    await rejected;
    release.resolve();

    assert.equal(f.mock.payloads.length, 1);
    await assert.rejects(fs.stat(f.launches[0].launchDir), { code: 'ENOENT' });
  });
});

test('настоящие одновременные чаты и steer удерживают отдельные homes и память', async (t) => {
  const arrived = Promise.withResolvers();
  const release = Promise.withResolvers();
  const f = await fixture(t, { respond: async (_payload, index) => {
    if (index === 0) {
      arrived.resolve();
      await release.promise;
    }

    return { deltas: [{ content: 'loopback-ok' }] };
  } });
  let port;
  const first = f.run({ onInTurnReady: (value) => {
    port = value;
  } });

  first.catch(arrived.reject);
  t.after(() => release.resolve());
  await arrived.promise;

  assert.ok(port);

  const accepted = await port.deliver({ messageId: 'fixture-steer', text: 'fixture-live-clarification' });
  const concurrent = f.run({ chatKey: 'another-fixture-chat', message: 'other-fixture-prompt' });

  assert.equal(accepted.ok, true);
  release.resolve();

  const results = await Promise.all([first, concurrent]);

  assert.equal(results.every((result) => result.reply === 'loopback-ok'), true);
  assert.notEqual(f.launches[0].home, f.launches[1].home);
  assert.match(JSON.stringify(f.mock.payloads), /fixture-live-clarification/);
  assert.notEqual(results[0].sessionId, results[1].sessionId);
});

test('настоящие host hooks блокируют прямые SSH и DB команды', async (t) => {
  for (const command of [
    'ssh -oBatchMode=yes -oConnectTimeout=1 -p 9 fixture@127.0.0.1',
    'mysql --help',
  ]) {
    await t.test(command.split(' ')[0], async (scenario) => {
      const f = await fixture(scenario, { respond: async (_payload, index) => index === 0
        ? toolResponse('bash', { command, description: 'fixture hook proof' })
        : { deltas: [{ content: 'loopback-ok' }] } });

      await f.run({ providerSettings: { blockDirectSsh: true, blockDirectDb: true } });

      assert.equal(f.mock.payloads.length, 2);
      assert.match(JSON.stringify(f.mock.payloads[1].messages), /blocked|denied|запрещ|запрет/i);
    });
  }
});

test('настоящий host MCP вызывается и не наследует API key или canonical prefs path', async (t) => {
  let advertised;
  const f = await fixture(t, { respond: async (payload, index) => {
    advertised ||= payload.tools.find((tool) => tool.function.name.includes('fixture'));

    return index === 0 ? toolResponse(advertised?.function.name || 'missing-fixture-tool', {})
      : { deltas: [{ content: 'loopback-ok' }] };
  } });
  const server = path.join(f.root, 'fixture-mcp.mjs');
  const envProof = path.join(f.root, 'mcp-env.json');

  await fs.writeFile(server, [
    'import { createInterface } from "node:readline";',
    'import { writeFileSync } from "node:fs";',
    'writeFileSync(process.argv[2], JSON.stringify({',
    '  hasKey: Object.hasOwn(process.env, "DEEPSEEK_API_KEY"),',
    '  hasPrefs: Object.hasOwn(process.env, "COCKPIT_PROVIDER_PREFS_PATH"),',
    '}));',
    'createInterface({ input: process.stdin }).on("line", line => {',
    '  const request = JSON.parse(line);',
    '  if (request.id === undefined) return;',
    '  const result = request.method === "initialize" ? {',
    '    protocolVersion: request.params.protocolVersion, capabilities: { tools: {} },',
    '    serverInfo: { name: "fixture", version: "1" },',
    '  } : request.method === "tools/list" ? { tools: [{',
    '    name: "fixture_ping", description: "fixture ping",',
    '    inputSchema: { type: "object", properties: {} },',
    '  }] } : request.method === "tools/call" ? {',
    '    content: [{ type: "text", text: "fixture-mcp-result" }],',
    '  } : {};',
    '  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");',
    '});',
  ].join('\n'), { mode: 0o600 });

  const result = await f.run({ mcpServers: [{
    name: 'fixture',
    command: process.execPath,
    args: [server, envProof],
    env: [],
  }] });

  assert.ok(advertised, 'MCP tool присутствует в фактическом HTTP payload');
  assert.equal(result.reply, 'loopback-ok');
  assert.match(JSON.stringify(f.mock.payloads[1].messages), /fixture-mcp-result/);
  assert.deepEqual(JSON.parse(await fs.readFile(envProof, 'utf8')), { hasKey: false, hasPrefs: false });
});

test('настоящая approval allow/reject управляет явной эскалацией write', async (t) => {
  for (const allow of [true, false]) {
    await t.test(String(allow), async (scenario) => {
      let target;
      let approvals = 0;
      const f = await fixture(scenario, { respond: async (_payload, index) => index === 0
        ? toolResponse('write', {
          file_path: target,
          content: 'fixture-approved',
          sandbox_permissions: 'danger-full-access',
          justification: 'Fixture вне cwd в одноразовом каталоге',
        }) : { deltas: [{ content: 'loopback-ok' }] } }, { outsideTemp: true });

      target = path.join(f.projectRoot, 'approved.txt');

      await f.run({ onPermission: async () => {
        approvals += 1;

        return { allow };
      } });

      assert.equal(approvals, 1);

      if (allow) {
        assert.equal(await fs.readFile(target, 'utf8'), 'fixture-approved');
      } else {
        await assert.rejects(fs.stat(target), { code: 'ENOENT' });
      }
    });
  }
});
