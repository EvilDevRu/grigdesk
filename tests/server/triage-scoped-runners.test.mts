import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';

import deepseek from '../../server/src/lib/executors/deepseek.ts';
import kimi from '../../server/src/lib/executors/kimi.ts';
import { createGlmAdapter } from '../../server/src/lib/executors/glm.ts';
import { runScopedKimi } from '../../server/src/lib/kimi/scopedTurn.ts';
import { startKimiServer } from '../../server/src/lib/kimi/serverRuntime.ts';
import { startDeepSeekServer } from '../../server/src/lib/deepseek/serverRuntime.ts';
import { ensureGlmTestRuntime } from '../helpers/glmTestRuntime.mts';
import { startGlmLoopback } from '../helpers/glmLoopback.mts';
import { startDeepSeekLoopback } from '../helpers/deepseekLoopback.mts';
import { glmTextReply, glmToolCall } from '../helpers/glmProductionFixture.mts';
import { writeGlmEgressGuard } from '../helpers/glmEgressGuard.mts';
import { sendAnthropicMessage } from '../helpers/anthropicLoopback.mts';
import { isRecord } from '../../shared/lib/objects.ts';

const execute = promisify(execFile);
const requireServer = createRequire(new URL('../../server/package.json', import.meta.url));
const { parse, stringify } = requireServer('smol-toml');
const TOOL_PREFIX = 'mcp__grigdesk-work__';

/**
 * У каждого настоящего процесса свои код, результат и закрытый сосед.
 * Ни один тест не использует ключи, home или сессии пользователя.
 */
async function workspace(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'triage-runtime-'));
  const repo = path.join(root, 'repo');
  const output = path.join(root, 'output');

  await Promise.all([fs.mkdir(repo), fs.mkdir(output)]);
  await fs.writeFile(path.join(repo, 'source.ts'), 'export const answer = 42;');
  await fs.writeFile(path.join(root, 'private.txt'), 'SYNTHETIC_PRIVATE');
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  return {
    root,
    repo,
    output,
    result: path.join(output, 'analysis.json'),
    scope: {
      readableRoots: [repo],
      writableRoots: [output],
      networkAccess: false,
    },
  };
}

for (const provider of ['deepseek', 'glm'] as const) {
  test(`настоящий ${provider} читает код и пишет оценку через изолированный MCP`, {
    timeout: 90_000,
  }, async (t) => {
    const selection = await ensureGlmTestRuntime();
    const f = await workspace(t);
    /**
     * Ответчик пробует скрытый shell, затем задаёт чтение → запись → завершение runtime.
     * Модель не подменяется фальшивым исполнением инструментов внутри адаптера GrigDesk.
     */
    const reply = (_payload: unknown, index: number) => {
      if (index === 0) {
        return glmToolCall('bash', {
          command: 'printf forbidden > native-marker',
          description: 'Этот штатный инструмент должен быть недоступен.',
        }, 'forbidden-native');
      }
      if (index === 1) {
        return glmToolCall(`${TOOL_PREFIX}read_file`, { path: path.join(f.repo, 'source.ts') }, 'read-code');
      }
      if (index === 2) {
        return glmToolCall(`${TOOL_PREFIX}write_file`, {
          path: f.result, content: '{"task":1,"risk":1}',
        }, 'write-result');
      }

      return glmTextReply('triage-complete');
    };
    const mock = provider === 'glm'
      ? await startGlmLoopback({ expectedKey: 'synthetic', respond: reply })
      : await startDeepSeekLoopback({ respond: async (payload, index) => reply(payload, index) });

    t.after(() => mock.stop());

    const guard = await writeGlmEgressGuard(f.root);
    const config = {
      ...selection.config,
      deepseekBin: String(selection.config.deepseekBin),
      deepseekRuntimeHome: path.join(f.root, 'unused-deepseek-home'),
    };
    let payloads: unknown[];

    if (provider === 'glm') {
      const adapter = createGlmAdapter({
        env: {
          PATH: process.env.PATH,
          HOME: f.root,
          GRIGDESK_GLM_API_MODE: 'api',
          ZAI_API_KEY: 'synthetic',
        },
        admission: [{ mode: 'api', compatibility: selection.identity }],
        modelEndpoint: mock.endpoint,
        egressGuard: guard,
      });

      assert.ok(adapter.run);
      assert.equal(await adapter.scopedWorkspace?.(config), true);

      const result = await adapter.run({
        config,
        cwd: f.output,
        model: '["zai","glm-5.3"]',
        effort: 'high',
        message: 'Оцени код и запиши результат.',
        workspaceAccess: f.scope,
        signal: AbortSignal.timeout(60_000),
      });

      assert.equal(result.reply, 'triage-complete');
      payloads = 'requests' in mock ? mock.requests.map((entry) => entry.payload) : [];
    } else {
      assert.equal(await deepseek.scopedWorkspace(config), true);

      const result = await deepseek.run({
        config,
        cwd: f.output,
        model: '["deepseek-official","deepseek-v4-flash"]',
        effort: 'high',
        message: 'Оцени код и запиши результат.',
        workspaceAccess: f.scope,
        env: {
          PATH: process.env.PATH,
          HOME: f.root,
          DEEPSEEK_API_KEY: 'synthetic',
        },
        signal: AbortSignal.timeout(60_000),
        startServer: async (input) => {
          const rows = JSON.parse(await fs.readFile(input.overlayPath, 'utf8'));

          rows.push({ id: 'llm-deepseek', config: { baseURL: mock.endpoint } });
          rows.find((row: { insert?: unknown }) => row.insert).insert.push({
            id: 'loopback-only', name: pathToFileURL(guard).href,
          });
          await fs.writeFile(input.overlayPath, JSON.stringify(rows));

          return startDeepSeekServer(input);
        },
      });

      assert.equal(result.reply, 'triage-complete');
      payloads = 'payloads' in mock ? mock.payloads : [];
    }

    assert.equal(await fs.readFile(f.result, 'utf8'), '{"task":1,"risk":1}');
    assert.equal(await fs.readFile(path.join(f.repo, 'source.ts'), 'utf8'), 'export const answer = 42;');
    assert.equal(payloads.length, 4);
    await assert.rejects(fs.access(path.join(f.output, 'native-marker')), { code: 'ENOENT' });
    assert.doesNotMatch(JSON.stringify(payloads), /SYNTHETIC_PRIVATE/u);

    for (const payload of payloads) {
      assert.ok(isRecord(payload) && Array.isArray(payload.tools));
      assert.equal(payload.model, provider === 'glm' ? 'glm-5.3' : 'deepseek-v4-flash');

      const names = payload.tools.map((tool) => String(tool.function?.name));

      assert.equal(names.length, 5);
      assert.ok(names.every((name) => name.startsWith(TOOL_PREFIX)));
    }
  });
}

/**
 * Официальный CLI получает только synthetic provider с loopback-адресом и тестовый credential-файл.
 * Подмена конфигурации ограничена seam запуска; весь REST, WS и MCP исполняются настоящим Kimi.
 */
async function kimiFixture(t: TestContext) {
  const bin = process.env.GRIGDESK_TEST_KIMI_CONTROLLED_BIN || process.env.GRIGDESK_KIMI_BIN || 'kimi';

  try {
    await execute(bin, ['--version'], { timeout: 5000 });
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') {
      t.skip('Kimi CLI не установлен.');

      return null;
    }

    throw error;
  }

  const f = await workspace(t);
  const home = path.join(f.root, 'source-home');

  await fs.mkdir(path.join(home, 'credentials'), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(home, 'credentials', 'kimi-code.json'), '{}', { mode: 0o600 });

  return {
    ...f,
    bin,
    home,
  };
}

test('настоящий Kimi выбирает модель, читает код и пишет результат без native tools', {
  timeout: 60_000,
}, async (t) => {
  const f = await kimiFixture(t);

  if (!f) {
    return;
  }

  const payloads: Record<string, unknown>[] = [];
  let failure: unknown;
  const server = createServer(async (request, response) => {
    try {
      let body = '';

      for await (const chunk of request) {
        body += chunk;
      }

      const payload = JSON.parse(body);
      const index = payloads.length;

      payloads.push(payload);
      assert.match(new URL(request.url || '', 'http://127.0.0.1').pathname, /\/messages$/u);

      const item = index === 0 ? {
        id: 'forbidden-native',
        name: 'Bash',
        input: { command: 'printf forbidden > native-marker' },
      } : index === 1 ? {
        id: 'read-code',
        name: `${TOOL_PREFIX}read_file`,
        input: { path: path.join(f.repo, 'source.ts') },
      } : index === 2 ? {
        id: 'write-result',
        name: `${TOOL_PREFIX}write_file`,
        input: { path: f.result, content: '{"task":1,"risk":1}' },
      } : { text: 'triage-complete' };

      sendAnthropicMessage(response, item);
    } catch (error) {
      failure = error;
      response.writeHead(500).end();
    }
  });

  t.after(() => assert.equal(failure, undefined));

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const result = await kimi.run({
    config: {
      kimiBin: f.bin,
      kimiHome: f.home,
      kimiRuntimeHome: path.join(f.root, 'unused-kimi-runtime'),
      chatsDir: path.join(f.root, 'unused-chats'),
    },
    cwd: f.output,
    model: 'kimi-code/k3',
    effort: 'high',
    message: 'Оцени код и запиши результат.',
    workspaceAccess: f.scope,
    signal: AbortSignal.timeout(45_000),
    deps: {
      startServer: async (input) => {
        const configPath = path.join(input.home, 'config.toml');
        const document = parse(await fs.readFile(configPath, 'utf8'));

        document.providers['managed:kimi-code'] = {
          type: 'anthropic',
          base_url: endpoint,
          api_key: 'synthetic',
        };
        await fs.writeFile(configPath, stringify(document));

        return startKimiServer(input);
      },
    },
  });

  assert.equal(failure, undefined);
  assert.equal(result.reply, 'triage-complete');
  assert.equal(await fs.readFile(f.result, 'utf8'), '{"task":1,"risk":1}');
  assert.equal(payloads.length, 4);
  await assert.rejects(fs.access(path.join(f.output, 'native-marker')), { code: 'ENOENT' });
  assert.ok(payloads.every((payload) => payload.model === 'k3'));
  assert.doesNotMatch(JSON.stringify(payloads), /SYNTHETIC_PRIVATE/u);

  for (const payload of payloads) {
    assert.ok(Array.isArray(payload.tools));
    assert.ok(payload.tools.every((tool) => String(tool.name).startsWith(TOOL_PREFIX)));
  }
});

test('DSH с чужим подтверждением guard останавливается до создания сессии', async (t) => {
  const selection = await ensureGlmTestRuntime();
  const f = await workspace(t);
  let created = false;
  let stopped = false;

  await assert.rejects(deepseek.run({
    config: {
      ...selection.config,
      deepseekBin: String(selection.config.deepseekBin),
      deepseekRuntimeHome: path.join(f.root, 'unused-deepseek-home'),
    },
    cwd: f.output,
    model: '["deepseek-official","deepseek-v4-flash"]',
    message: 'Этот prompt не должен попасть в модель.',
    workspaceAccess: f.scope,
    env: { DEEPSEEK_API_KEY: 'synthetic' },
    signal: AbortSignal.timeout(30_000),
    startServer: async (input) => {
      const server = await startDeepSeekServer(input);
      const stop = server.stop.bind(server);
      const rows = JSON.parse(await fs.readFile(input.overlayPath, 'utf8'));
      const guard = rows.find((row: { insert?: unknown }) => row.insert).insert
        .find((entry: { id: string }) => entry.id === 'grigdesk-triage-guard');

      await fs.writeFile(guard.config.proofPath, JSON.stringify({ nonce: 'wrong', allowed: [] }));
      server.client.createSession = async () => {
        created = true;

        throw new Error('Сессия не должна создаваться до проверки guard.');
      };
      server.stop = async () => {
        stopped = true;
        await stop();
      };

      return server;
    },
  }), /не подтвердил ограниченные инструменты/u);
  assert.equal(created, false);
  assert.equal(stopped, true);
});

test('Kimi с активным штатным инструментом останавливается до prompt', async (t) => {
  const f = await kimiFixture(t);

  if (!f) {
    return;
  }

  let submitted = false;
  let stopped = false;

  await assert.rejects(runScopedKimi({
    config: { kimiBin: f.bin, kimiHome: f.home },
    cwd: f.output,
    model: 'kimi-code/k3',
    message: 'Этот prompt не должен попасть в модель.',
    workspaceAccess: f.scope,
    signal: AbortSignal.timeout(30_000),
    startServer: async (input) => {
      const server = await startKimiServer(input);
      const stop = server.stop.bind(server);

      server.client.tools = async () => ({ tools: [{ name: 'Bash', active: true }] });
      server.client.submitPrompt = async () => {
        submitted = true;

        throw new Error('Prompt не должен уходить с доступным Bash.');
      };
      server.stop = async () => {
        stopped = true;
        await stop();
      };

      return server;
    },
  }), /инструмент вне области триажа/u);
  assert.equal(submitted, false);
  assert.equal(stopped, true);
});
