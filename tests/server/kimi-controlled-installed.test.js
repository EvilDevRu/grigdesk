import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { sendAnthropicMessage as sendMessage } from '../helpers/anthropicLoopback.mts';

import { createKimiCommandChannel } from '../../server/src/lib/kimi/commandChannel.ts';
import { COMMAND_NAME } from '../../server/src/lib/kimi/commandProfile.ts';
import { checkKimiNativeShellPolicy } from '../../server/src/lib/kimi/commandNativePolicy.ts';
import { buildKimiHostWebHome } from '../../server/src/lib/kimi/hostWebHome.ts';
import { runKimiServerTurn } from '../../server/src/lib/kimi/serverTurn.ts';

const bin = process.env.GRIGDESK_TEST_KIMI_CONTROLLED_BIN;
const CHILD_REPLY = 'Дочерняя проверка завершена: команда отклонена, marker не создан. '.repeat(4);

test('установленный Kimi соблюдает command broker без обращения к модели', {
  skip: !bin,
  timeout: 480_000,
}, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kimi-controlled-native-'));
  const home = path.join(root, 'user');
  const cwd = path.join(root, 'workspace');
  const shims = path.join(root, 'bin');
  const env = {
    PATH: `${shims}:${process.env.PATH}`,
    HOME: root,
    KIMI_DISABLE_TELEMETRY: '1',
  };
  let script = [];
  let requests = [];
  let httpFailure = null;
  let route = null;

  await fs.mkdir(path.join(home, 'sessions'), { recursive: true });
  await fs.mkdir(cwd);
  await fs.mkdir(shims);
  await fs.writeFile(path.join(shims, 'mysql'), '#!/bin/sh\nprintf unsafe > db-marker\n', { mode: 0o700 });

  const http = createServer(async (request, response) => {
    try {
      let body = '';

      for await (const chunk of request) {
        body += chunk;
      }

      const input = JSON.parse(body);

      assert.match(request.url, /\/messages$/);
      requests.push(input);

      const item = route ? await route(input) : script.shift();

      assert.ok(item, 'Неожиданный дополнительный запрос к модели');
      sendMessage(response, item);
    } catch (error) {
      httpFailure = error;
      response.writeHead(500);
      response.end('fixture failure');
    }
  });

  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    http.closeAllConnections();
    await new Promise((resolve) => http.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });

  const source = [
    'default_model = "fixture"',
    'telemetry = false',
    '[providers.fixture]',
    'type = "anthropic"',
    `base_url = "http://127.0.0.1:${http.address().port}"`,
    'api_key = "synthetic"',
    '[models.fixture]',
    'provider = "fixture"',
    'model = "fixture"',
    'max_context_size = 32000',
    'capabilities = ["tool_use"]',
    '[model_catalog]',
    'refresh_on_start = false',
    'refresh_interval_ms = 0',
    '',
  ].join('\n');

  await fs.writeFile(path.join(home, 'config.toml'), source, { mode: 0o600 });

  /**
   * Каждый ход получает новый private home и новый канал с теми же исходными sessions.
   * Идентификатор прежней сессии передаётся настоящему Kimi, fake transport не используется.
   */
  async function turn(items, sessionId, permissionMode = 'yolo', configure, router) {
    script = [...items];
    requests = [];
    httpFailure = null;
    route = router ?? null;

    let channel;
    let commandContext;
    const overlay = await buildKimiHostWebHome({
      kimiHome: home,
      runtimeHome: path.join(root, 'runtime'),
      mcpServers: [],
      controlledCommands: true,
      commandMcpFactory: async (profile) => {
        channel = await createKimiCommandChannel({
          cwd,
          env,
          settings: { blockDirectDb: true, blockDirectSsh: true },
          permissionMode,
          commandsAllowed: profile.commandsAllowed,
          authorize: async () => ({ allow: true }),
          nativeGuard: async () => Boolean(commandContext)
            && await checkKimiNativeShellPolicy(commandContext.client, commandContext.sessionId),
        });

        return channel.mcpServer;
      },
    });

    try {
      const result = await runKimiServerTurn({
        bin,
        home: overlay.home,
        cwd,
        env,
        model: 'fixture',
        message: 'fixture',
        permissionMode,
        controlledCommands: true,
        sessionId,
        signal: AbortSignal.timeout(45_000),
        onApproval: async (_approval, respond) => respond({ decision: 'approved' }),
        onCommandContext: async (client, currentSessionId) => {
          commandContext = { client, sessionId: currentSessionId };
          await configure?.(client, currentSessionId);
        },
      });

      assert.equal(httpFailure, null);
      assert.equal(script.length, 0, 'Kimi не выполнил весь сценарий');
      assert.equal(result.reply, 'Ответ.');
      assert.equal(await fs.readFile(path.join(home, 'config.toml'), 'utf8'), source);

      return result;
    } finally {
      await channel?.close();
      await overlay.cleanup();
    }
  }

  /**
   * Проверяет tool_result конкретного запроса, исключая старую историю resume.
   * Одного отсутствия файла мало: tool должен получить явный отказ.
   */
  function resultOf(id) {
    const results = requests.flatMap((request) => request.messages ?? [])
      .flatMap((message) => Array.isArray(message.content) ? message.content : []);
    const result = results.find((item) => item.type === 'tool_result' && item.tool_use_id === id);

    assert.ok(result, `Отсутствует tool_result ${id}`);

    return result;
  }

  const first = await turn([{}]);

  await turn([
    {
      id: 'fresh-bash',
      name: 'Bash',
      input: { command: 'printf unsafe > fresh-marker' },
    },
    {},
  ]);
  assert.match(JSON.stringify(resultOf('fresh-bash')), /Bash.*disabled by the active tool policy/);
  await assert.rejects(fs.access(path.join(cwd, 'fresh-marker')), { code: 'ENOENT' });

  const resumed = await turn([
    {
      id: 'native-bash',
      name: 'Bash',
      input: { command: 'printf unsafe > native-marker' },
    },
    {},
  ], first.sessionId);

  assert.equal(resumed.sessionId, first.sessionId);
  assert.match(JSON.stringify(resultOf('native-bash')), /Bash.*disabled by the active tool policy/);
  await assert.rejects(fs.access(path.join(cwd, 'native-marker')), { code: 'ENOENT' });

  await turn([
    {
      id: 'safe-command',
      name: COMMAND_NAME,
      input: { command: 'printf ok > safe-marker' },
    },
    {},
  ], undefined, 'manual');
  assert.equal(await fs.readFile(path.join(cwd, 'safe-marker'), 'utf8'), 'ok');
  assert.match(JSON.stringify(resultOf('safe-command')), /"ok"|\\"ok\\"/);

  await turn([
    {
      id: 'denied-db',
      name: COMMAND_NAME,
      input: { command: 'mysql -h db.example.invalid' },
    },
    {},
  ]);
  assert.match(JSON.stringify(resultOf('denied-db')), /direct_command_denied/);
  await assert.rejects(fs.access(path.join(cwd, 'db-marker')), { code: 'ENOENT' });

  for (const policy of ['session', 'profile', 'rules']) {
    await turn([
      {
        id: `native-${policy}`,
        name: COMMAND_NAME,
        input: { command: `printf unsafe > ${policy}-marker` },
      },
      {},
    ], undefined, 'yolo', async (client, sessionId) => {
      const base = `/api/v1/debug/session/${encodeURIComponent(sessionId)}`;

      if (policy === 'session') {
        await client.settingsRequest('POST', `${base}/sessionToolPolicy/setDisabledTools`, [['Bash']]);
      } else if (policy === 'rules') {
        await client.settingsRequest('POST', `${base}/agent/main/agentPermissionRulesService/addRules`, [[{
          decision: 'deny',
          scope: 'session-runtime',
          pattern: 'Bash',
        }]]);
      } else {
        await client.settingsRequest('POST', `${base}/agent/main/agentProfileService/setModel`, 'fixture');
        await client.settingsRequest('POST', `${base}/agent/main/agentProfileService/update`, {
          disallowedTools: ['Bash'],
        });
      }
    });
    assert.match(JSON.stringify(resultOf(`native-${policy}`)), /native_shell_policy_denied/);
    await assert.rejects(fs.access(path.join(cwd, `${policy}-marker`)), { code: 'ENOENT' });
  }

  for (const detached of [false, true]) {
    const marker = detached ? 'detached-marker' : 'background-marker';
    const childTag = `fixture-child-${marker}`;
    let client;
    let currentSessionId;
    let mainCalls = 0;
    let childCalls = 0;
    let childFinished;
    const childResult = new Promise((resolve) => {
      childFinished = resolve;
    });

    await turn([], undefined, 'yolo', async (nativeClient, sessionId) => {
      client = nativeClient;
      currentSessionId = sessionId;
    }, async (request) => {
      const firstUser = request.messages.find((message) => message.role === 'user');
      const isChild = Array.isArray(firstUser?.content) && firstUser.content.some((part) =>
        part.type === 'text' && String(part.text).includes(childTag));

      if (!isChild) {
        mainCalls += 1;

        if (mainCalls === 1) {
          return {
            id: `agent-${marker}`,
            name: 'Agent',
            input: {
              prompt: childTag,
              description: 'Проверить фоновую команду',
              run_in_background: !detached,
            },
          };
        }

        await childResult;

        return {};
      }

      childCalls += 1;

      if (childCalls === 1) {
        if (detached) {
          const base = `/api/v1/debug/session/${encodeURIComponent(currentSessionId)}`;
          const tasks = await client.settingsRequest('GET', `${base}/agent/main/agentTaskService/list`);

          assert.ok(Array.isArray(tasks));

          const task = tasks.find((item) => item.kind === 'agent' && item.status === 'running');

          assert.ok(task, 'Нет foreground task для проверки detach');
          await client.settingsRequest('POST', `${base}/agent/main/agentTaskService/detach`, task.taskId);
        }

        return {
          id: marker,
          name: COMMAND_NAME,
          input: { command: `printf unsafe > ${marker}` },
        };
      }

      childFinished();

      return { text: CHILD_REPLY };
    });
    assert.ok(mainCalls >= 2);
    assert.equal(childCalls, 2);
    assert.match(JSON.stringify(resultOf(marker)), /native_shell_policy_denied/);
    await assert.rejects(fs.access(path.join(cwd, marker)), { code: 'ENOENT' });
  }

  await turn([
    {
      id: 'delegate-command',
      name: 'Agent',
      input: {
        prompt: 'fixture child command',
        description: 'Проверить запрет дочерней команды',
        run_in_background: false,
      },
    },
    {
      id: 'child-command',
      name: COMMAND_NAME,
      input: { command: 'printf unsafe > child-command-marker' },
    },
    { text: CHILD_REPLY },
    {},
  ]);
  assert.match(JSON.stringify(resultOf('child-command')), /native_shell_policy_denied/);
  await assert.rejects(fs.access(path.join(cwd, 'child-command-marker')), { code: 'ENOENT' });

  const withChild = await turn([
    {
      id: 'delegate',
      name: 'Agent',
      input: {
        prompt: 'fixture child',
        description: 'Проверить запрет команд',
        run_in_background: false,
      },
    },
    {
      id: 'child-bash',
      name: 'Bash',
      input: { command: 'printf unsafe > child-marker' },
    },
    { text: CHILD_REPLY },
    {},
  ]);

  assert.match(JSON.stringify(resultOf('child-bash')), /Bash.*disabled by the active tool policy/);
  await assert.rejects(fs.access(path.join(cwd, 'child-marker')), { code: 'ENOENT' });

  await turn([
    {
      id: 'safe-next-turn',
      name: COMMAND_NAME,
      input: { command: 'printf restored > restored-marker' },
    },
    {},
  ], withChild.sessionId);
  assert.equal(await fs.readFile(path.join(cwd, 'restored-marker'), 'utf8'), 'restored');

  const pluginRoot = path.join(root, 'fixture-plugin');

  await fs.mkdir(pluginRoot);
  await fs.mkdir(path.join(home, 'plugins'));
  await fs.writeFile(path.join(pluginRoot, 'kimi.plugin.json'), JSON.stringify({
    name: 'fixture-policy',
    hooks: [{
      event: 'PreToolUse',
      matcher: '^Bash$',
      command: 'exit 2',
    }],
  }));
  await fs.writeFile(path.join(home, 'plugins', 'installed.json'), JSON.stringify({
    version: 1,
    plugins: [{
      id: 'fixture-policy',
      root: pluginRoot,
      source: 'local-path',
      enabled: true,
      installedAt: '2026-01-01T00:00:00Z',
    }],
  }));
  await turn([
    {
      id: 'plugin-hook',
      name: COMMAND_NAME,
      input: { command: 'printf unsafe > plugin-marker' },
    },
    {},
  ]);
  assert.match(JSON.stringify(resultOf('plugin-hook')), /native_shell_policy_denied/);
  await assert.rejects(fs.access(path.join(cwd, 'plugin-marker')), { code: 'ENOENT' });
});
