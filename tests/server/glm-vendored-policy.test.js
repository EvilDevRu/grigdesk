import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createGlmAdapter } from '../../server/src/lib/executors/glm.ts';
import { glmCompatibilityIdentity } from '../../server/src/lib/glm/contract.ts';
import { describeGlmGeneration } from '../../server/src/lib/glm/generation.ts';
import { artifactsPath } from '../../shared/runtime/dataHome.ts';
import { ensureTestDeepSeekArtifact } from '../helpers/deepseekRuntimeArtifact.mts';
import { runGlmTurn } from '../helpers/glmDriver.mts';
import { startGlmLoopback } from '../helpers/glmLoopback.mts';
import {
  GLM_SERVICE_KEY,
  glmHookEntries,
  glmTextReply,
  glmToolCall,
  startGlmProductionProcess,
  writeGlmEgressGuard,
} from '../helpers/glmProductionFixture.mts';

const ARTIFACTS = path.join(artifactsPath({ env: process.env, home: os.homedir() }), 'glm/G6/fixtures');
const MODEL = '["zai","glm-5.3"]';

/**
 * MCP-фикстура cockpit-work: инструмент echo, счётчик вызовов и имена своего окружения.
 * Пишет только в каталог стенда; значения окружения не сохраняются.
 */
async function workMcp(root) {
  const script = path.join(root, 'work-mcp.mjs');
  const calls = path.join(root, 'mcp-calls.log');
  const env = path.join(root, 'mcp-env.json');

  await fs.writeFile(script, [
    'import { appendFileSync, writeFileSync } from "node:fs";',
    'import { createInterface } from "node:readline";',
    'const [calls, env] = process.argv.slice(2);',
    'writeFileSync(env, JSON.stringify(Object.keys(process.env).sort()));',
    'createInterface({ input: process.stdin }).on("line", (line) => {',
    '  const request = JSON.parse(line);',
    '  if (request.id === undefined) return;',
    '  if (request.method === "tools/call") appendFileSync(calls, "call\\n");',
    '  const result = request.method === "initialize" ? {',
    '    protocolVersion: request.params.protocolVersion, capabilities: { tools: {} },',
    '    serverInfo: { name: "work", version: "1" },',
    '  } : request.method === "tools/list" ? { tools: [{',
    '    name: "echo", description: "echo", inputSchema: { type: "object", properties: {} },',
    '  }] } : { content: [{ type: "text", text: "work-result" }] };',
    '  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");',
    '});',
  ].join('\n'));
  await fs.writeFile(calls, '');

  return {
    server: {
      name: 'cockpit-work',
      command: process.execPath,
      args: [script, calls, env],
      env: [],
    },
    calls: async () => (await fs.readFile(calls, 'utf8')).split('\n').filter(Boolean).length,
    envNames: async () => JSON.parse(await fs.readFile(env, 'utf8')),
  };
}

/**
 * Стенд политики: настоящая generation, фейк Z.ai, cockpit-work и DI-адаптер с допуском
 * identity этой сборки. Запуск процесса можно перехватить, чтобы испортить файлы запуска.
 */
async function fixture(t, loopbackOptions = {}, { beforeSpawn } = {}) {
  const artifact = await ensureTestDeepSeekArtifact();

  await fs.mkdir(ARTIFACTS, { recursive: true });

  const root = await fs.mkdtemp(path.join(ARTIFACTS, 'policy-'));
  const project = path.join(root, 'project');
  const mock = await startGlmLoopback({
    expectedKey: GLM_SERVICE_KEY,
    ...loopbackOptions,
  });
  const work = await workMcp(root);
  const config = {
    rootDir: root,
    deepseekArtifactDir: artifact,
    deepseekRuntimeMode: 'embedded',
    glmRuntimeHome: path.join(root, 'glm-home'),
  };
  const identity = glmCompatibilityIdentity(describeGlmGeneration(config).runtime, 'api');
  const adapter = createGlmAdapter({
    env: {
      PATH: process.env.PATH,
      HOME: root,
      COCKPIT_GLM_API_MODE: 'api',
      ZAI_API_KEY: GLM_SERVICE_KEY,
    },
    admission: [{ mode: 'api', compatibility: identity }],
    catalog: [{ id: MODEL, efforts: ['low', 'high', 'max'] }],
    modelEndpoint: mock.endpoint,
    egressGuard: await writeGlmEgressGuard(path.join(root, 'guard')),
    spawn: (command, args, options) => {
      const overlay = args[args.indexOf('--patch') + 1];

      beforeSpawn?.(path.dirname(overlay));

      return spawn(command, args, options);
    },
  });

  await fs.mkdir(path.join(project, '.git'), { recursive: true });
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await mock.stop();
  });

  return {
    root,
    project,
    mock,
    work,
    run: (options = {}) => adapter.run({
      config,
      cwd: project,
      chatKey: 'fixture-chat',
      message: 'fixture-prompt',
      model: MODEL,
      onSessionCreated: async () => {},
      mcpServers: [work.server],
      workTools: { descriptors: [{ name: 'echo' }] },
      providerSettings: {
        blockDirectSsh: true,
        blockDirectDb: true,
      },
      signal: AbortSignal.timeout(60_000),
      ...options,
    }),
    /**
     * Тот же production-профиль, но ход через RPC-драйвер: тесту видны события hook/result.
     * Approval в этом режиме отклоняется драйвером.
     */
    async events(message) {
      const started = await startGlmProductionProcess({
        artifact,
        root,
        cwd: project,
        endpoint: mock.endpoint,
        launch: {
          mcpServers: [work.server],
          workTools: ['echo'],
        },
      });

      try {
        return await runGlmTurn(started.server, {
          cwd: project,
          message,
          model: 'glm-5.3',
        });
      } finally {
        await started.server.stop();
      }
    },
  };
}

function scripted(calls) {
  return (_payload, index) => index < calls.length
    ? glmToolCall(calls[index][0], calls[index][1], `call-${index}`)
    : glmTextReply('done');
}

async function exists(file) {
  return fs.stat(file).then(() => true, () => false);
}

test('настоящий запрещённый инструмент не выполняется, счётчик эффекта 0', async (t) => {
  let hits = 0;
  const counter = createServer((_request, response) => {
    hits += 1;
    response.end('counter');
  });

  await new Promise((resolve) => counter.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => counter.close(resolve)));

  const url = `http://127.0.0.1:${counter.address().port}/effect`;
  const f = await fixture(t, { respond: scripted([['web_fetch', { url }]]) });
  const turn = await f.events('forbidden');
  const entry = glmHookEntries(turn.events).find((item) => item.point === 'PreToolUse');

  assert.equal(entry.name, 'web_fetch');
  assert.equal(entry.decision, 'deny');
  assert.equal(hits, 0);
});

test('настоящие SSH и БД команды отклоняются до эффекта', async (t) => {
  const f = await fixture(t, { respond: scripted([
    ['bash', { command: 'ssh -p 9 x@127.0.0.1; echo effect > ssh.txt', description: 'ssh' }],
    ['bash', { command: 'mysql -h db.example -u root; echo effect > db.txt', description: 'db' }],
  ]) });
  const result = await f.run();

  assert.equal(result.reply, 'done');
  assert.equal(await exists(path.join(f.project, 'ssh.txt')), false);
  assert.equal(await exists(path.join(f.project, 'db.txt')), false);
  assert.match(JSON.stringify(f.mock.requests.at(-1).payload.messages), /прямой SSH запрещён/u);
});

test('настоящая запись внутри проекта проходит, вне проекта и через symlink — отклоняется', async (t) => {
  for (const kind of ['inside', 'outside', 'symlink']) {
    await t.test(kind, async (sub) => {
      let target;
      const f = await fixture(sub, { respond: (_payload, index) => index === 0
        ? glmToolCall('write', { file_path: target, content: 'written' })
        : glmTextReply('done') });

      target = kind === 'inside' ? path.join(f.project, 'inside.txt') : path.join(f.root, 'outside.txt');

      if (kind === 'symlink') {
        await fs.symlink(f.root, path.join(f.project, 'escape'));
        target = path.join(f.project, 'escape', 'outside.txt');
      }

      await f.run();

      assert.equal(await exists(kind === 'inside' ? target : path.join(f.root, 'outside.txt')),
        kind === 'inside');
    });
  }
});

test('настоящий approval allow выполняет действие один раз, deny — ни разу', async (t) => {
  for (const allow of [true, false]) {
    await t.test(String(allow), async (sub) => {
      let target;
      let asked = 0;
      const f = await fixture(sub, { respond: (_payload, index) => index === 0
        ? glmToolCall('write', {
          file_path: target,
          content: 'approved',
          sandbox_permissions: 'danger-full-access',
          justification: 'запись вне проекта',
        })
        : glmTextReply('done') });

      target = path.join(f.root, 'approved.txt');

      await f.run({ onPermission: async (presentation) => {
        asked += 1;
        assert.equal(presentation.requiresExplicitUser, true);
        assert.equal(presentation.canRemember, false);

        return { allow };
      } });

      assert.equal(asked, 1);
      assert.equal(await exists(target), allow);
    });
  }
});

test('настоящий стоп во время ожидания approval и поздний allow не дают эффекта', async (t) => {
  let target;
  const asked = Promise.withResolvers();
  const late = Promise.withResolvers();
  const f = await fixture(t, { respond: (_payload, index) => index === 0
    ? glmToolCall('write', {
      file_path: target,
      content: 'late',
      sandbox_permissions: 'danger-full-access',
      justification: 'запись вне проекта',
    })
    : glmTextReply('done') });
  const controller = new AbortController();

  target = path.join(f.root, 'late.txt');

  const running = f.run({
    signal: controller.signal,
    onPermission: () => {
      asked.resolve();

      return late.promise;
    },
  });

  await asked.promise;
  controller.abort();
  late.resolve({ allow: true });

  await assert.rejects(running, (error) => error.stopped === true);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(await exists(target), false);
});

test('настоящий hook с испорченным входом даёт отказ, а не пропуск', async (t) => {
  const f = await fixture(t, { respond: scripted([['write', { file_path: 'corrupt.txt', content: 'x' }]]) }, {
    beforeSpawn: (launchDir) => {
      // Испорченная политика запуска: hook обязан упасть в отказ (exit 2), а не пропустить вызов.
      writeFileSync(path.join(launchDir, 'glm-policy.json'), '{"workTools": [');
    },
  });

  // Факт G6: тот же hook на UserPromptSubmit отказывает первым — ход блокируется до модели.
  await assert.rejects(f.run(), { code: 'glm_turn_blocked' });
  assert.equal(f.mock.requests.length, 0);
  assert.equal(await exists(path.join(f.project, 'corrupt.txt')), false);
});

test('настоящий испорченный hooks.json останавливает ход до эффекта инструмента или сразу после него',
  async (t) => {
    const calls = [['write', { file_path: 'unhooked.txt', content: 'x' }]];
    const f = await fixture(t, { respond: scripted(calls) }, {
      beforeSpawn: (launchDir) => {
        writeFileSync(path.join(launchDir, 'hooks.json'), '{"hooks": [');
      },
    });

    await assert.rejects(f.run(), { code: 'glm_policy_hook_missing' });
    // Остаточный риск fail-open DSH: вызов мог успеть выполниться до cancel, но не больше одного.
    assert.ok(f.mock.requests.length <= 1);
  });

test('настоящие правка, команда и MCP-вызов проходят тот же hook', async (t) => {
  const f = await fixture(t, { respond: scripted([
    ['read', { file_path: 'note.txt' }],
    ['edit', {
      file_path: 'note.txt',
      old_string: 'before',
      new_string: 'after',
    }],
    ['bash', { command: 'echo shell > shell.txt', description: 'shell' }],
    ['mcp__cockpit-work__echo', {}],
  ]) });

  await fs.writeFile(path.join(f.project, 'note.txt'), 'before\n');

  const turn = await f.events('same-hook');
  const entries = glmHookEntries(turn.events).filter((item) => item.point === 'PreToolUse');

  assert.deepEqual(entries.map((entry) => [entry.name, entry.decision]), [
    ['read', 'allow'],
    ['edit', 'allow'],
    ['bash', 'allow'],
    ['mcp__cockpit-work__echo', 'allow'],
  ]);
  assert.equal(await fs.readFile(path.join(f.project, 'note.txt'), 'utf8'), 'after\n');
  assert.equal(await exists(path.join(f.project, 'shell.txt')), true);
  assert.equal(await f.work.calls(), 1);
});

test('настоящие shell и MCP процесса GLM не видят COCKPIT_GLM_ROUTE_KEY', async (t) => {
  const f = await fixture(t, { respond: scripted([
    ['bash', { command: 'env | cut -d= -f1 | sort > env-names.txt', description: 'env' }],
  ]) });

  await f.run();

  const shell = (await fs.readFile(path.join(f.project, 'env-names.txt'), 'utf8')).split('\n');
  const mcp = await f.work.envNames();

  assert.ok(shell.includes('PATH'), 'положительный контроль shell');
  assert.ok(mcp.includes('PATH'), 'положительный контроль MCP');

  for (const name of ['COCKPIT_GLM_ROUTE_KEY', 'ZAI_API_KEY', 'DEEPSEEK_API_KEY']) {
    assert.equal(shell.includes(name), false, `shell ${name}`);
    assert.equal(mcp.includes(name), false, `mcp ${name}`);
  }
});

test('настоящий вопрос агента проходит hook и доходит до onPermission', async (t) => {
  const f = await fixture(t, { respond: scripted([
    ['ask_user_question', { questions: [{ id: 'q1', question: 'fixture-question' }] }],
  ]) });
  let question;

  await f.run({ onPermission: async (presentation) => {
    question = presentation;

    return { allow: true, rawAnswers: [{ selected: [], text: 'fixture-answer' }] };
  } });

  assert.equal(question?.isQuestion, true);
  assert.equal(question.questions[0].question, 'fixture-question');
  assert.match(JSON.stringify(f.mock.requests.at(-1).payload.messages), /fixture-answer/u);
});

test('настоящие неразбираемые аргументы инструмента не дают успешного эффекта', async (t) => {
  const f = await fixture(t, { respond: (_payload, index) => index === 0
    ? {
      kind: 'stream',
      deltas: [{
        role: 'assistant',
        tool_calls: [{
          index: 0,
          id: 'call-broken',
          type: 'function',
          function: { name: 'write', arguments: '{"file_path": "broken.txt", "content": ' },
        }],
      }],
      finishReason: 'tool_calls',
    }
    : glmTextReply('done') });
  const result = await f.run();

  t.diagnostic(JSON.stringify(f.mock.requests.at(-1)?.payload.messages.at(-1)));
  assert.equal(result.reply, 'done');
  assert.equal(await exists(path.join(f.project, 'broken.txt')), false);
});

test('настоящее уточнение посреди команды доходит до модели тем же ходом, политика его пропускает',
  async (t) => {
    let markToolRequested;
    let markReady;
    const toolRequested = new Promise((resolve) => {
      markToolRequested = resolve;
    });
    const ready = new Promise((resolve) => {
      markReady = resolve;
    });
    const f = await fixture(t, { respond: (payload, index) => {
      if (index === 0) {
        markToolRequested();

        return glmToolCall('bash', { command: 'sleep 2; echo slept', description: 'wait' });
      }

      const seen = JSON.stringify(payload).includes('fixture-steer-text');

      return glmTextReply(seen ? 'steer-seen' : 'steer-missed');
    } });
    const running = f.run({ onInTurnReady: (port) => markReady(port) });
    const port = await Promise.race([ready, new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error('GLM не выдал порт уточнений')), 30_000).unref();
    })]);

    await toolRequested;
    await new Promise((resolve) => setTimeout(resolve, 500));

    const delivered = await port.deliver({ messageId: 'steer-message-1', text: 'fixture-steer-text' });
    const result = await running;
    const seen = f.mock.requests.filter((request) => JSON.stringify(request.payload)
      .includes('fixture-steer-text'));

    assert.deepEqual(delivered, { ok: true, state: 'forwarded' });
    assert.equal(result.reply, 'steer-seen');
    assert.ok(seen.length >= 1, 'текст уточнения дошёл до запроса модели');
  });
