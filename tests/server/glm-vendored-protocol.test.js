import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ensureTestDeepSeekArtifact } from '../helpers/deepseekRuntimeArtifact.mts';
import { startGlmLoopback } from '../helpers/glmLoopback.mts';
import { GLM_RESEARCH_KEY, writeGlmResearchOverlay } from '../helpers/glmResearchOverlay.mts';
import { glmResearchEnv, runGlmTurn, startGlmAcp, startGlmWeb } from '../helpers/glmDriver.mts';
import { openDeepSeekStream } from '../../server/src/lib/deepseek/serverEvents.ts';
import { artifactsPath } from '../../shared/runtime/dataHome.ts';

const ARTIFACTS = path.join(artifactsPath({ env: process.env, home: os.homedir() }), 'glm/G2/fixtures');

/**
 * Стенд факта: настоящая generation, фейк Z.ai на loopback и отдельные каталоги.
 * Всё созданное удаляется после теста; фейк проверяет полноту сценария при остановке.
 */
async function fixture(t, loopbackOptions = {}) {
  const artifact = await ensureTestDeepSeekArtifact();

  await fs.mkdir(ARTIFACTS, { recursive: true });

  const root = await fs.mkdtemp(path.join(ARTIFACTS, 'protocol-'));
  const cwd = path.join(root, 'project');
  const home = path.join(root, 'home');
  const launch = path.join(root, 'launch');
  const mock = await startGlmLoopback({
    expectedKey: GLM_RESEARCH_KEY,
    ...loopbackOptions,
  });
  const servers = [];

  await fs.mkdir(path.join(cwd, '.git'), { recursive: true });
  await fs.mkdir(home, { mode: 0o700 });

  t.after(async () => {
    for (const server of servers) {
      await server.stop();
    }

    await fs.rm(root, { recursive: true, force: true });
    await mock.stop();
  });

  return {
    artifact,
    root,
    cwd,
    home,
    launch,
    mock,
    env: glmResearchEnv(home),
    /**
     * Web-процесс получает свой overlay; остановка регистрируется заранее.
     * Тест может передать дополнительные строки маршрута и hooks.
     */
    async web(overlayOptions = {}) {
      const overlayPath = await writeGlmResearchOverlay({
        root: launch,
        endpoint: mock.endpoint,
        transport: 'web',
        workspaceRoot: cwd,
        ...overlayOptions,
      });
      const server = await startGlmWeb({
        artifact,
        overlayPath,
        cwd,
        env: glmResearchEnv(home, overlayOptions.env),
      });

      servers.push(server);

      return server;
    },
    /**
     * ACP-процесс для каталожных фактов: тот же overlay, но без рабочей области.
     * Остановка тоже регистрируется заранее и выполняется после теста.
     */
    async acp(overlayOptions = {}) {
      const overlayPath = await writeGlmResearchOverlay({
        root: launch,
        endpoint: mock.endpoint,
        transport: 'acp',
        ...overlayOptions,
      });
      const server = await startGlmAcp({
        artifact,
        overlayPath,
        cwd,
        env: glmResearchEnv(home),
      });

      servers.push(server);

      return server;
    },
  };
}

function textReply(text = 'glm-ok') {
  return {
    kind: 'stream',
    deltas: [{ role: 'assistant', content: text }],
  };
}

test('настоящий ACP session/new с выключенным llm-deepseek и моделью zai/glm-5.3 возвращает эту модель',
  async (t) => {
    const f = await fixture(t);
    const acp = await f.acp();
    const created = await acp.client.request('session/new', {
      cwd: f.cwd,
      mcpServers: [],
    });
    const model = created.configOptions.find((option) => option.id === 'model'
      || option.category === 'model');

    assert.equal(model.currentValue, JSON.stringify(['zai', 'glm-5.3']));
    assert.equal(f.mock.requests.length, 0);
  });

test('настоящий ход отправляет в фейк Z.ai модель, Authorization и путь маршрута', async (t) => {
  const f = await fixture(t, { scenarios: [textReply()] });
  const server = await f.web();
  const turn = await runGlmTurn(server, {
    cwd: f.cwd,
    message: 'fixture-prompt',
    model: 'glm-5.3',
  });

  assert.equal(turn.turnEnd.data.reason.kind, 'completed');
  assert.equal(f.mock.requests.length, 1);
  assert.equal(f.mock.requests[0].path, '/api/paas/v4/chat/completions');
  assert.equal(f.mock.requests[0].model, 'glm-5.3');
  assert.equal(f.mock.requests[0].authorizationMatches, true);
});

const GLM_MODELS = ['glm-4.7', 'glm-5-turbo', 'glm-5.2', 'glm-5.2-highspeed', 'glm-5.3', 'glm-5.3-flash',
  'glm-5.3-highspeed'];

/**
 * Опции ACP сводятся к значениям выбора: вложенные группы раскрываются в один список.
 * Так читаются и модели, и уровни reasoning без знания формы группы.
 */
function optionValues(option) {
  const values = [];
  /**
   * Обход раскрывает вложенные группы выбора в порядке ACP.
   * Записи без строкового значения пропускаются, их потомки — нет.
   */
  const visit = (entries) => {
    for (const entry of entries ?? []) {
      if (typeof entry?.value === 'string') {
        values.push(entry.value);
      }

      visit(entry?.options);
    }
  };

  visit(option?.options);

  return values;
}

test('настоящий маршрут с переопределённым baseURL сохраняет tool_stream и thinking zai', async (t) => {
  const f = await fixture(t, { scenarios: [textReply()] });
  const server = await f.web();

  await runGlmTurn(server, {
    cwd: f.cwd,
    message: 'fixture-prompt',
    model: 'glm-5.3',
    effort: 'high',
  });

  const payload = f.mock.requests[0].payload;

  assert.equal(payload.tool_stream, true);
  assert.deepEqual(payload.thinking, { type: 'enabled', clear_thinking: false });
  assert.ok(Array.isArray(payload.tools) && payload.tools.length > 0);
});

test('настоящее чтение reasoning_effort каждой из семи моделей', async (t) => {
  const f = await fixture(t, { respond: () => textReply() });
  const acp = await f.acp();
  const created = await acp.client.request('session/new', {
    cwd: f.cwd,
    mcpServers: [],
  });
  const models = optionValues(created.configOptions.find((option) => option.id === 'model'));
  const efforts = {};

  assert.deepEqual(models, GLM_MODELS.map((model) => JSON.stringify(['zai', model])));

  for (const model of GLM_MODELS) {
    const changed = await acp.client.request('session/set_config_option', {
      sessionId: created.sessionId,
      configId: 'model',
      value: JSON.stringify(['zai', model]),
    });

    efforts[model] = optionValues(changed.configOptions.find((option) => option.id === 'reasoning_effort'));
  }

  await acp.stop();

  const server = await f.web();
  const wire = {};

  for (const model of GLM_MODELS) {
    const before = f.mock.requests.length;

    await runGlmTurn(server, {
      cwd: f.cwd,
      message: `no-effort-${model}`,
      model,
    });
    wire[model] = f.mock.requests.slice(before).map((request) => request.thinking);
  }

  t.diagnostic(JSON.stringify({ efforts, wire }));
  // Факт G2: план ждал xhigh у 4.7/5-turbo; DSH отдаёт off и пустой «Provider default».
  assert.deepEqual(efforts, {
    'glm-4.7': ['', 'off', 'minimal', 'low', 'medium', 'high'],
    'glm-5-turbo': ['', 'off', 'minimal', 'low', 'medium', 'high'],
    'glm-5.2': ['', 'off', 'high', 'max'],
    'glm-5.2-highspeed': ['', 'off', 'high', 'max'],
    'glm-5.3': ['', 'low', 'high', 'max'],
    'glm-5.3-flash': ['', 'low', 'high', 'max'],
    'glm-5.3-highspeed': ['', 'low', 'high', 'max'],
  });

  for (const model of GLM_MODELS) {
    assert.deepEqual(wire[model], [{ type: 'disabled' }], model);
  }
});

const MCP_ECHO = path.resolve(import.meta.dirname, '../fixtures/deepseek-harness/fakeMcpEcho.mts');

/**
 * Ответ модели с вызовом инструмента; аргументы дробятся на два кусочка, как у Z.ai.
 * id вызова задаётся тестом, чтобы сверять его с событиями DSH и журналом hook.
 */
function toolCall(name, args, id = 'call-1') {
  const encoded = JSON.stringify(args);
  const half = Math.floor(encoded.length / 2);

  return {
    kind: 'stream',
    deltas: [
      {
        role: 'assistant',
        tool_calls: [{
          index: 0,
          id,
          type: 'function',
          function: { name, arguments: encoded.slice(0, half) },
        }],
      },
      { tool_calls: [{ index: 0, function: { arguments: encoded.slice(half) } }] },
    ],
    finishReason: 'tool_calls',
  };
}

/**
 * Исследовательский hook отдаёт вход события и имена окружения строкой stderr.
 * Hook исполняется в песочнице DSH: вне рабочей области файл ему не записать,
 * а stderr Кокпит видит в событии hook/result. Поведение задаётся аргументом.
 */
async function researchHooks(root, { behavior = '0', timeout = 3, broken = false } = {}) {
  const script = path.join(root, 'research-hook.mjs');
  const hooksPath = path.join(root, 'hooks.json');

  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(script, [
    'let input = "";',
    'process.stdin.on("data", (chunk) => { input += chunk; });',
    'process.stdin.on("end", () => {',
    '  const payload = JSON.parse(input || "{}");',
    '  process.stderr.write("GLM-HOOK " + JSON.stringify({',
    '    event: payload.hook_event_name,',
    '    tool_name: payload.tool_name,',
    '    tool_input: payload.tool_input,',
    '    tool_use_id: payload.tool_use_id,',
    '    envNames: Object.keys(process.env).sort(),',
    '  }) + "\\n");',
    '  const behavior = process.argv[2];',
    '  if (behavior === "crash") throw new Error("research hook crash");',
    '  if (behavior === "hang") { setTimeout(() => {}, 600000); return; }',
    '  process.exit(Number(behavior));',
    '});',
  ].join('\n'));

  const command = (value) => `'${process.execPath}' '${script}' ${value}`;
  const document = {
    hooks: {
      PreToolUse: [{
        matcher: '*',
        hooks: [{
          type: 'command',
          command: command(behavior),
          timeout,
        }],
      }],
      UserPromptSubmit: [{
        hooks: [{
          type: 'command',
          command: command('0'),
          timeout,
        }],
      }],
    },
  };

  await fs.writeFile(hooksPath, broken ? '{"hooks": [' : JSON.stringify(document));

  return { hooksPath };
}

/**
 * Записи hook восстанавливаются из событий хода: stderr лежит в hook/result.
 * Индекс события сохраняется, чтобы сверять порядок с tool/call и approval.
 */
function hookEntries(events) {
  const entries = [];

  events.forEach((event, index) => {
    const summary = String(event.data?.stderrSummary ?? '');

    if (event.type === 'hook/result' && summary.startsWith('GLM-HOOK ')) {
      entries.push({
        index,
        exitCode: event.data.exitCode,
        decision: event.data.decision,
        ...JSON.parse(summary.slice('GLM-HOOK '.length).split('\n')[0]),
      });
    }
  });

  return entries;
}

const F5_TEST = 'настоящий PreToolUse с matcher * получает точное имя и аргументы '
  + 'read, edit, shell и MCP';

test(F5_TEST, async (t) => {
  let mcpName;
  const calls = [
    ['read', { file_path: 'note.txt' }],
    ['edit', {
      file_path: 'note.txt',
      old_string: 'before',
      new_string: 'after',
    }],
    ['bash', { command: 'echo shell-proof', description: 'Echo proof' }],
    ['mcp', { text: 'mcp-proof' }],
  ];
  const f = await fixture(t, { respond: (payload, index) => {
    mcpName ??= payload.tools.find((tool) => tool.function.name.startsWith('mcp__'))?.function.name;

    if (index >= calls.length) {
      return textReply();
    }

    const [name, args] = calls[index];

    return toolCall(name === 'mcp' ? mcpName : name, args, `call-${index}`);
  } });
  const hooks = await researchHooks(path.join(f.root, 'hooks'));

  await fs.writeFile(path.join(f.cwd, 'note.txt'), 'before\n');

  const server = await f.web({
    hooksPath: hooks.hooksPath,
    projectDir: f.cwd,
    mcpServers: [{
      name: 'fixture',
      command: process.execPath,
      args: [MCP_ECHO],
    }],
  });

  const turn = await runGlmTurn(server, {
    cwd: f.cwd,
    message: 'fixture-tools',
    model: 'glm-5.3',
    onWaterfall: (item) => item.event === 'approval/request'
      ? { kind: 'result', value: 'allowed-once' }
      : { kind: 'next' },
  });

  const pre = hookEntries(turn.events).filter((entry) => entry.event === 'PreToolUse');

  assert.equal(mcpName, 'mcp__fixture__echo');
  assert.deepEqual(pre.map((entry) => [entry.tool_name, entry.tool_input, entry.tool_use_id]), calls.map(
    ([name, args], index) => [name === 'mcp' ? mcpName : name, args, `call-${index}`],
  ));
  assert.equal(await fs.readFile(path.join(f.cwd, 'note.txt'), 'utf8'), 'after\n');
});

const F6_TEST = 'настоящий PreToolUse и approval одного вызова: '
  + 'порядок и совпадение tool_use_id с callId';

test(F6_TEST, async (t) => {
  let target;
  const f = await fixture(t, { respond: (_payload, index) => index === 0
    ? toolCall('write', {
      file_path: target,
      content: 'approved',
      sandbox_permissions: 'danger-full-access',
      justification: 'Fixture вне рабочей области',
    }, 'call-approval')
    : textReply() });
  const hooks = await researchHooks(path.join(f.root, 'hooks'));
  const approvals = [];

  target = path.join(f.root, 'outside.txt');

  const server = await f.web({ hooksPath: hooks.hooksPath, projectDir: f.cwd });

  const turn = await runGlmTurn(server, {
    cwd: f.cwd,
    message: 'fixture-approval',
    model: 'glm-5.3',
    onWaterfall: async (item, record) => {
      if (item.event !== 'approval/request') {
        return { kind: 'next' };
      }

      approvals.push({ request: item.request, hookSeen: hookEntries(record.events).length });

      return { kind: 'result', value: 'allowed-once' };
    },
  });

  const pre = hookEntries(turn.events).filter((entry) => entry.event === 'PreToolUse');

  t.diagnostic(JSON.stringify({ approvals, pre }));
  assert.equal(approvals.length, 1);
  assert.equal(pre.length, 1);
  assert.equal(approvals[0].hookSeen, 2, 'hook PreToolUse завершён раньше approval');
  assert.equal(pre[0].tool_use_id, 'call-approval');
  assert.equal(approvals[0].request.callId, 'call-approval');
  assert.equal(await fs.readFile(target, 'utf8'), 'approved');
});

test('настоящий hook с exit 1, падением и таймаутом пропускает вызов, с exit 2 — блокирует', async (t) => {
  const outcomes = {};

  for (const behavior of ['1', 'crash', 'hang', '2']) {
    await t.test(behavior, async (scenario) => {
      const f = await fixture(scenario, { respond: (_payload, index) => index === 0
        ? toolCall('write', { file_path: 'effect.txt', content: behavior })
        : textReply() });
      const hooks = await researchHooks(path.join(f.root, 'hooks'), { behavior, timeout: 2 });
      const server = await f.web({ hooksPath: hooks.hooksPath, projectDir: f.cwd });

      await runGlmTurn(server, {
        cwd: f.cwd,
        message: `hook-${behavior}`,
        model: 'glm-5.3',
      });
      outcomes[behavior] = await fs.readFile(path.join(f.cwd, 'effect.txt'), 'utf8').then(() => 'ran',
        () => 'blocked');
    });
  }

  assert.deepEqual(outcomes, {
    1: 'ran',
    crash: 'ran',
    hang: 'ran',
    2: 'blocked',
  });
});

test('настоящие approval/request в workspace-write: какие инструменты спрашивают', async (t) => {
  let mcpName;
  const calls = [
    ['read', { file_path: 'note.txt' }],
    ['write', { file_path: 'inside.txt', content: 'inside' }],
    ['bash', { command: 'echo shell-proof > shell.txt', description: 'Write proof' }],
    ['mcp', { text: 'mcp-proof' }],
  ];
  const f = await fixture(t, { respond: (payload, index) => {
    mcpName ??= payload.tools.find((tool) => tool.function.name.startsWith('mcp__'))?.function.name;

    if (index >= calls.length) {
      return textReply();
    }

    const [name, args] = calls[index];

    return toolCall(name === 'mcp' ? mcpName : name, args, `call-${index}`);
  } });

  await fs.writeFile(path.join(f.cwd, 'note.txt'), 'note\n');

  const server = await f.web({
    mcpServers: [{
      name: 'fixture',
      command: process.execPath,
      args: [MCP_ECHO],
    }],
  });
  const turn = await runGlmTurn(server, {
    cwd: f.cwd,
    message: 'fixture-approvals',
    model: 'glm-5.3',
    onWaterfall: (item) => item.event === 'approval/request'
      ? { kind: 'result', value: 'allowed-once' }
      : { kind: 'next' },
  });
  const asked = turn.waterfalls.filter((item) => item.event === 'approval/request')
    .map((item) => item.request.toolName);

  t.diagnostic(JSON.stringify(asked));
  // Факт G2: в workspace-write DSH не спрашивает approval ни для shell, ни для MCP.
  // По Р8 проектные MCP не входят в первую поставку; эффект MCP-вызова виден в ответе.
  assert.deepEqual(asked, []);
  assert.match(JSON.stringify(f.mock.requests.at(-1).payload.messages), /mcp-proof/);
  assert.equal(await fs.readFile(path.join(f.cwd, 'shell.txt'), 'utf8'), 'shell-proof\n');
});

const F16_TEST = 'настоящий маркер UserPromptSubmit пишется до первого tool/call, '
  + 'а испорченный hooks.json не регистрирует hooks';

test(F16_TEST,
  async (t) => {
    const observed = {};

    for (const broken of [false, true]) {
      await t.test(broken ? 'broken' : 'valid', async (scenario) => {
        const f = await fixture(scenario, { respond: (_payload, index) => index === 0
          ? toolCall('write', { file_path: 'effect.txt', content: 'effect' })
          : textReply() });
        const hooks = await researchHooks(path.join(f.root, 'hooks'), { behavior: '2', broken });
        const server = await f.web({ hooksPath: hooks.hooksPath, projectDir: f.cwd });
        const turn = await runGlmTurn(server, {
          cwd: f.cwd,
          message: 'marker',
          model: 'glm-5.3',
        });
        const call = turn.events.findIndex((event) => event.type === 'tool/call');
        const markers = hookEntries(turn.events).filter((entry) => entry.event === 'UserPromptSubmit');

        observed[broken ? 'broken' : 'valid'] = {
          markerBeforeCall: markers.some((entry) => entry.index < call),
          markers: markers.length,
          effect: await fs.stat(path.join(f.cwd, 'effect.txt')).then(() => true, () => false),
        };
      });
    }

    t.diagnostic(JSON.stringify(observed));
    assert.deepEqual(observed, {
      valid: {
        markerBeforeCall: true,
        markers: 1,
        effect: false,
      },
      broken: {
        markerBeforeCall: false,
        markers: 0,
        effect: true,
      },
    });
  });

/**
 * MCP-фикстура с именами инструментов из argv: формула имён DSH проверяется
 * на коллизии разделителя и на длинном имени. Отвечает только initialize/tools.
 */
async function namedMcpServer(root) {
  const script = path.join(root, 'named-mcp.mjs');

  await fs.writeFile(script, [
    'import { createInterface } from "node:readline";',
    'const tools = process.argv.slice(2);',
    'createInterface({ input: process.stdin }).on("line", (line) => {',
    '  const request = JSON.parse(line);',
    '  if (request.id === undefined) return;',
    '  const result = request.method === "initialize" ? {',
    '    protocolVersion: request.params.protocolVersion, capabilities: { tools: {} },',
    '    serverInfo: { name: "named", version: "1" },',
    '  } : request.method === "tools/list" ? { tools: tools.map((name) => ({',
    '    name, description: "named", inputSchema: { type: "object", properties: {} },',
    '  })) } : { content: [{ type: "text", text: "named-result" }] };',
    '  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");',
    '});',
  ].join('\n'));

  return script;
}

test('настоящий web-профиль стартует с выключенными web, web-search-deepseek, web-fetch-http', async (t) => {
  const f = await fixture(t);
  const server = await f.web({ disableWebRows: true });

  // Факт G2: процесс стартует, но штатный preset не монтируется — tool-web ждёт сервис web.
  // Поэтому строки web остаются в профиле, а их инструменты запрещает hook (Р7).
  await assert.rejects(server.client.createSession(f.cwd), (error) => {
    assert.equal(error.code, 'agent-preset/invalid');
    assert.match(error.message, /tool-web .*waiting for web/u);

    return true;
  });
  assert.equal(f.mock.requests.length, 0);
});

test('настоящий settings-документ с секцией llm-pi-ai переопределяет маршрут', async (t) => {
  const other = await startGlmLoopback({ expectedKey: GLM_RESEARCH_KEY, scenarios: [textReply('other')] });
  const f = await fixture(t);

  t.after(() => other.stop());

  const document = path.join(f.root, 'settings.yaml');

  await fs.writeFile(document, JSON.stringify({
    'llm-pi-ai': { providers: { zai: { baseURL: other.endpoint } } },
  }));

  const server = await f.web({ document });

  await runGlmTurn(server, {
    cwd: f.cwd,
    message: 'settings-route',
    model: 'glm-5.3',
  });

  assert.equal(f.mock.requests.length, 0);
  assert.equal(other.requests.length, 1);
});

test('настоящий ответ 429 и обрыв потока дают ровно один запрос при maxRetries 0', async (t) => {
  const observed = {};

  for (const scenario of [
    {
      kind: 'http-error',
      status: 429,
      code: '1302',
      message: 'Rate limit reached for requests',
    },
    { kind: 'disconnect', deltas: [{ role: 'assistant', content: 'partial' }] },
  ]) {
    await t.test(scenario.kind, async (sub) => {
      const f = await fixture(sub, { scenarios: [scenario] });
      const server = await f.web();
      const turn = await runGlmTurn(server, {
        cwd: f.cwd,
        message: 'retry',
        model: 'glm-5.3',
      });

      // Повтор после turn/end тоже был бы виден: фейк отверг бы запрос вне сценария.
      await new Promise((resolve) => setTimeout(resolve, 1000));
      observed[scenario.kind] = {
        requests: f.mock.requests.length,
        reason: turn.turnEnd.data.reason.kind,
        code: turn.turnEnd.data.reason.error?.code,
      };
    });
  }

  t.diagnostic(JSON.stringify(observed));
  assert.deepEqual(observed, {
    'http-error': {
      requests: 1,
      reason: 'error',
      code: 'RATE_LIMIT',
    },
    disconnect: {
      requests: 1,
      reason: 'error',
      code: 'TRANSPORT',
    },
  });
});

test('настоящие имена MCP a__b+c и a+b__c и длинное имя', async (t) => {
  const f = await fixture(t, { respond: () => textReply() });
  const script = await namedMcpServer(f.root);
  const long = 'x'.repeat(70);
  const server = await f.web({
    mcpServers: [
      {
        name: 'a__b',
        command: process.execPath,
        args: [script, 'c'],
      },
      {
        name: 'a',
        command: process.execPath,
        args: [script, 'b__c'],
      },
      {
        name: 'long',
        command: process.execPath,
        args: [script, long],
      },
    ],
  });

  await runGlmTurn(server, {
    cwd: f.cwd,
    message: 'names',
    model: 'glm-5.3',
  });

  const names = f.mock.requests[0].payload.tools.map((tool) => tool.function.name)
    .filter((name) => name.startsWith('mcp__')).sort();

  t.diagnostic(JSON.stringify(names));
  assert.deepEqual(names.filter((name) => name === 'mcp__a__b__c').length, 1, 'коллизия даёт одно имя');
  assert.ok(names.every((name) => name.length <= 64 && /^[A-Za-z0-9_-]+$/u.test(name)));
  assert.ok(names.some((name) => name.startsWith('mcp__long__') && name.length === 64));
});

test('настоящий запрос несёт user-agent клиента', async (t) => {
  const f = await fixture(t, { scenarios: [textReply()] });
  const server = await f.web();

  await runGlmTurn(server, {
    cwd: f.cwd,
    message: 'user-agent',
    model: 'glm-5.3',
  });

  t.diagnostic(f.mock.requests[0].userAgent);
  assert.match(f.mock.requests[0].userAgent, /^deepseek-harness\//u);
});

test('настоящий сигнал готовности MCP-сервера до prompt', async (t) => {
  const marker = path.join(ARTIFACTS, `mcp-marker-${process.pid}.log`);
  const script = path.join(ARTIFACTS, `mcp-ready-${process.pid}.mjs`);

  await fs.mkdir(ARTIFACTS, { recursive: true });
  t.after(() => Promise.all([fs.rm(marker, { force: true }), fs.rm(script, { force: true })]));
  await fs.writeFile(script, [
    'import { appendFileSync } from "node:fs";',
    'import { createInterface } from "node:readline";',
    'const [marker, mode] = process.argv.slice(2);',
    'createInterface({ input: process.stdin }).on("line", async (line) => {',
    '  const request = JSON.parse(line);',
    '  if (request.id === undefined) return;',
    '  if (request.method === "initialize" && mode === "broken") {',
    '    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id,',
    '      error: { code: -32603, message: "broken" } }) + "\\n");',
    '    return;',
    '  }',
    '  if (request.method === "tools/list") await new Promise((resolve) => setTimeout(resolve, 2000));',
    '  appendFileSync(marker, request.method + "\\n");',
    '  const result = request.method === "initialize" ? {',
    '    protocolVersion: request.params.protocolVersion, capabilities: { tools: {} },',
    '    serverInfo: { name: "ready", version: "1" },',
    '  } : { tools: [{ name: "ping", description: "ping", inputSchema: { type: "object" } }] };',
    '  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");',
    '});',
  ].join('\n'));

  await t.test('ready', async (sub) => {
    const f = await fixture(sub);

    await fs.writeFile(marker, '');
    await f.web({ mcpServers: [{
      name: 'ready',
      command: process.execPath,
      args: [script, marker, 'ok'],
    }] });

    // Адрес web выдаётся только после initialize и медленного tools/list.
    const methods = (await fs.readFile(marker, 'utf8')).split('\n').filter(Boolean);

    assert.deepEqual(methods, ['initialize', 'tools/list']);
  });

  await t.test('broken', async (sub) => {
    const f = await fixture(sub);
    const overlayPath = await writeGlmResearchOverlay({
      root: f.launch,
      endpoint: f.mock.endpoint,
      transport: 'web',
      workspaceRoot: f.cwd,
      mcpServers: [{
        name: 'ready',
        command: process.execPath,
        args: [script, marker, 'broken'],
      }],
    });
    const rows = JSON.parse(await fs.readFile(overlayPath, 'utf8'));

    rows.at(-1).insert.at(-1).config.failOnStartupError = true;
    await fs.writeFile(overlayPath, JSON.stringify(rows));

    await assert.rejects(startGlmWeb({
      artifact: f.artifact,
      overlayPath,
      cwd: f.cwd,
      env: f.env,
    }), /mcp-client\(ready\): initial connection or tool synchronization failed/u);
    assert.equal(f.mock.requests.length, 0);
  });
});

test('настоящие ответы 401, 402, 403 и 429 фейка дают в turn/end ошибку с code', async (t) => {
  const codes = {};

  for (const [label, status, message] of [
    ['401', 401, 'Authentication parameter not received in Header'],
    ['402', 402, 'Insufficient balance or no resource package. Please recharge.'],
    ['403', 403, 'Access denied for this API'],
    ['429', 429, 'Rate limit reached for requests'],
    ['429-balance', 429, 'Insufficient balance or no resource package. Please recharge.'],
  ]) {
    await t.test(label, async (sub) => {
      const f = await fixture(sub, { scenarios: [{
        kind: 'http-error',
        status,
        code: '1000',
        message,
      }] });
      const server = await f.web();
      const turn = await runGlmTurn(server, {
        cwd: f.cwd,
        message: `status-${label}`,
        model: 'glm-5.3',
      });

      codes[label] = turn.turnEnd.data.reason.kind === 'error' ? turn.turnEnd.data.reason.error.code : null;
    });
  }

  t.diagnostic(JSON.stringify(codes));
  assert.deepEqual(codes, {
    401: 'AUTH',
    402: 'QUOTA',
    403: 'AUTH',
    429: 'RATE_LIMIT',
    '429-balance': 'QUOTA',
  });
});

test('настоящие web-RPC выбора модели и effort и их обратное чтение в сессии', async (t) => {
  const f = await fixture(t);
  const server = await f.web();
  const sessionId = await server.client.createSession(f.cwd);
  const selected = await server.client.rpc('session/selectModel', {
    request: {
      sessionId,
      provider: 'zai',
      model: 'glm-5.3',
      reasoningEffort: 'high',
    },
  });

  const expected = {
    provider: 'zai',
    model: 'glm-5.3',
    reasoningEffort: 'high',
  };

  assert.deepEqual(selected, { selected: expected });

  for (const request of [
    { model: 'glm-5.3', reasoningEffort: 'minimal' },
    { model: 'glm-unknown', reasoningEffort: 'high' },
  ]) {
    await assert.rejects(server.client.rpc('session/selectModel', {
      request: {
        sessionId,
        provider: 'zai',
        ...request,
      },
    }), (error) => error.code === 'session/model-unavailable');
  }

  const snapshot = await new Promise((resolve, reject) => {
    const stream = openDeepSeekStream({
      client: server.client,
      endpoint: 'session/follow',
      args: { request: { address: { kind: 'session', sessionId }, assistantStream: true } },
      onItem: (item) => {
        if (item.type === 'snapshot') {
          stream.close();
          resolve(item);
        }
      },
      onClose: reject,
    });
  });

  assert.deepEqual(snapshot.projections.values.modelSelection, {
    lastUsed: null,
    next: expected,
  });
  assert.equal(f.mock.requests.length, 0);
});
