import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { createGlmAdapter } from '../../server/src/lib/executors/glm.ts';
import { glmCompatibilityIdentity } from '../../server/src/lib/glm/contract.ts';
import { describeGlmGeneration } from '../../server/src/lib/glm/generation.ts';
import { ensureTestDeepSeekArtifact } from '../helpers/deepseekRuntimeArtifact.mts';
import { startGlmLoopback } from '../helpers/glmLoopback.mts';
import {
  GLM_SERVICE_KEY,
  glmTextReply,
  glmToolCall,
  writeGlmEgressGuard,
} from '../helpers/glmProductionFixture.mts';

const ARTIFACTS = path.resolve(import.meta.dirname, '../../.state/artifacts/glm/G7/fixtures');
const MODEL = '["zai","glm-5.3"]';

/**
 * Скрипт MCP-фикстуры: журнал этапов и вызовов в файл, поведение — режимом из argv.
 * broken — отказ initialize; die — выход после tools/list; late — инструмент late после echo.
 */
const MCP_SCRIPT = [
  'import { appendFileSync } from "node:fs";',
  'import { createInterface } from "node:readline";',
  'const [journal, mode, ...names] = process.argv.slice(2);',
  'const schema = { type: "object", properties: {} };',
  'const tools = names.map((name) => ({ name, description: name, inputSchema: schema }));',
  'const mark = (value) => appendFileSync(journal, value + "\\n");',
  'const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");',
  'mark("spawn");',
  'createInterface({ input: process.stdin }).on("line", (line) => {',
  '  const request = JSON.parse(line);',
  '  if (request.id === undefined) return;',
  '  if (request.method === "initialize" && mode === "broken") {',
  '    send({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: "broken" } });',
  '    return;',
  '  }',
  '  mark(request.method === "tools/call" ? `call:${request.params.name}` : request.method);',
  '  const result = request.method === "initialize" ? {',
  '    protocolVersion: request.params.protocolVersion, capabilities: { tools: { listChanged: true } },',
  '    serverInfo: { name: "fixture", version: "1" },',
  '  } : request.method === "tools/list" ? { tools } : { content: [{ type: "text", text: "mcp-result" }] };',
  '  send({ jsonrpc: "2.0", id: request.id, result });',
  '  if (request.method === "tools/list" && mode === "die") setTimeout(() => process.exit(0), 200);',
  '  if (request.method === "tools/call" && mode === "late" && !names.includes("late")) {',
  '    names.push("late");',
  '    tools.push({ name: "late", description: "late", inputSchema: { type: "object", properties: {} } });',
  '    send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });',
  '  }',
  '});',
].join('\n');

/**
 * Стенд MCP: DI-адаптер на настоящей generation, фейк Z.ai и MCP-фикстура cockpit-work.
 * Журнал фикстуры показывает этапы готовности и каждый вызов инструмента.
 */
async function fixture(t, loopbackOptions = {}) {
  const artifact = await ensureTestDeepSeekArtifact();

  await fs.mkdir(ARTIFACTS, { recursive: true });

  const root = await fs.mkdtemp(path.join(ARTIFACTS, 'mcp-'));
  const project = path.join(root, 'project');
  const script = path.join(root, 'fixture-mcp.mjs');
  const mock = await startGlmLoopback({
    expectedKey: GLM_SERVICE_KEY,
    ...loopbackOptions,
  });
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
  });

  await fs.mkdir(path.join(project, '.git'), { recursive: true });
  await fs.writeFile(script, MCP_SCRIPT);
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await mock.stop();
  });

  /**
   * Сервер MCP с режимом и инструментами; журнал — отдельный файл на сервер.
   * Возвращает описание для чата и чтение журнала.
   */
  const mcp = (name, mode, tools) => {
    const journal = path.join(root, `${name}.log`);

    return {
      server: {
        name,
        command: process.execPath,
        args: [script, journal, mode, ...tools],
        env: [],
      },
      journal,
      lines: () => {
        try {
          return readFileSync(journal, 'utf8').split('\n').filter(Boolean);
        } catch {
          return [];
        }
      },
    };
  };

  return {
    root,
    project,
    mock,
    mcp,
    run: (work, workTools, options = {}) => adapter.run({
      config,
      cwd: project,
      chatKey: 'fixture-chat',
      message: 'fixture-prompt',
      model: MODEL,
      onSessionCreated: async () => {},
      mcpServers: [work.server],
      workTools: { descriptors: workTools.map((name) => ({ name })) },
      signal: AbortSignal.timeout(60_000),
      ...options,
    }),
  };
}

const READY_TEST = 'настоящий cockpit-work готов до prompt; '
  + 'сломанный initialize даёт glm_mcp_not_ready без prompt';

test(READY_TEST, async (t) => {
  await t.test('ready', async (sub) => {
    let atPrompt;
    let work;
    const f = await fixture(sub, { respond: () => {
      atPrompt ??= work.lines();

      return glmTextReply();
    } });

    work = f.mcp('cockpit-work', 'ok', ['echo']);
    await f.run(work, ['echo']);

    const names = f.mock.requests[0].payload.tools.map((tool) => tool.function.name);

    assert.deepEqual(atPrompt, ['spawn', 'initialize', 'tools/list']);
    assert.ok(names.includes('mcp__cockpit-work__echo'));
  });

  await t.test('broken', async (sub) => {
    const f = await fixture(sub, { scenarios: [] });
    const work = f.mcp('cockpit-work', 'broken', ['echo']);

    await assert.rejects(f.run(work, ['echo']), { code: 'glm_mcp_not_ready' });
    assert.equal(f.mock.requests.length, 0);
  });
});

const LOSS_TEST = 'настоящая потеря cockpit-work после готовности '
  + 'даёт glm_mcp_not_ready и запрещает действие';

test(LOSS_TEST, async (t) => {
  const f = await fixture(t, { respond: async (_payload, index) => {
    if (index === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1500));

      return glmToolCall('mcp__cockpit-work__echo', {});
    }

    return glmTextReply();
  } });
  const work = f.mcp('cockpit-work', 'die', ['echo']);
  const outcome = await f.run(work, ['echo']).then((value) => ({ reply: value.reply }), (error) => ({
    code: error.code,
  }));

  // Факт G7: с переподключением DSH перезапустил бы сервер и выполнил вызов — оно выключено.
  t.diagnostic(JSON.stringify({
    outcome,
    journal: work.lines(),
  }));
  assert.equal(outcome.code, 'glm_mcp_not_ready');
  assert.equal(work.lines().filter((line) => line.startsWith('call:')).length, 0);
});

test('настоящий исключённый сервер не получает ни одного вызова', async (t) => {
  const f = await fixture(t, { respond: (_payload, index) => index === 0
    ? glmToolCall('mcp__project__ping', {})
    : glmTextReply() });
  const work = f.mcp('cockpit-work', 'ok', ['echo']);
  const project = f.mcp('project', 'ok', ['ping']);

  await fs.writeFile(path.join(f.project, '.mcp.json'), JSON.stringify({ mcpServers: {
    project: {
      command: project.server.command,
      args: project.server.args,
    },
  } }));

  const warnings = [];

  await f.run(work, ['echo'], { log: { warn: (_value, message) => warnings.push(message) } });

  const names = f.mock.requests[0].payload.tools.map((tool) => tool.function.name);

  assert.deepEqual(project.lines(), []);
  assert.ok(names.every((name) => !name.startsWith('mcp__project__')));
  assert.ok(warnings.some((warning) => /«project» не подключается к GLM/u.test(warning)));
});

test('настоящий инструмент cockpit-work, объявленный после старта, не выполняется', async (t) => {
  const f = await fixture(t, { respond: (_payload, index) => [
    glmToolCall('mcp__cockpit-work__echo', {}, 'call-0'),
    glmToolCall('mcp__cockpit-work__late', {}, 'call-1'),
  ][index] ?? glmTextReply() });
  const work = f.mcp('cockpit-work', 'late', ['echo']);

  await f.run(work, ['echo']);

  const calls = work.lines().filter((line) => line.startsWith('call:'));

  t.diagnostic(JSON.stringify(f.mock.requests.map((request) => request.payload.tools
    .map((tool) => tool.function.name).filter((name) => name.startsWith('mcp__')))));
  assert.deepEqual(calls, ['call:echo']);
  assert.match(JSON.stringify(f.mock.requests[2].payload.messages), /запрещён политикой Cockpit/u);
});

// Факт G2 (F13): проектные MCP в поставку не входят, поэтому их поздних инструментов тоже нет.
test('настоящий поздний инструмент проектного сервера уходит к человеку', async (t) => {
  const f = await fixture(t, { respond: (_payload, index) => index === 0
    ? glmToolCall('mcp__project__late', {})
    : glmTextReply() });
  const work = f.mcp('cockpit-work', 'ok', ['echo']);
  const project = f.mcp('project', 'late', ['ping']);
  let asked = 0;

  await fs.writeFile(path.join(f.project, '.mcp.json'), JSON.stringify({ mcpServers: {
    project: {
      command: project.server.command,
      args: project.server.args,
    },
  } }));

  await f.run(work, ['echo'], { onPermission: async () => {
    asked += 1;

    return { allow: true };
  } });

  assert.equal(asked, 0);
  assert.deepEqual(project.lines(), []);
});

test('настоящий resume применяет текущий набор MCP, прежний инструмент недоступен', async (t) => {
  const f = await fixture(t, { respond: (_payload, index) => index === 1
    ? glmToolCall('mcp__cockpit-work__echo', {})
    : glmTextReply() });
  const first = f.mcp('cockpit-work', 'ok', ['echo']);
  const second = f.mcp('cockpit-work', 'ok', ['other']);
  const opened = await f.run(first, ['echo']);

  await f.run(second, ['other'], { sessionId: opened.sessionId, message: 'second-prompt' });

  const names = f.mock.requests[1].payload.tools.map((tool) => tool.function.name);

  assert.ok(names.includes('mcp__cockpit-work__other'));
  assert.equal(names.includes('mcp__cockpit-work__echo'), false);
  assert.deepEqual(second.lines().filter((line) => line.startsWith('call:')), []);
  assert.deepEqual(first.lines().filter((line) => line.startsWith('call:')), []);
});
