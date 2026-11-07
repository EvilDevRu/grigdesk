import assert from 'node:assert/strict';
import {
  execFile,
  spawn
} from 'node:child_process';
import {
  promisify
} from 'node:util';
import {
  promises as fs
} from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  runGigaCodeTurn,
  readGigaCodeMetadata
} from '../../server/src/lib/gigacode/runtime.ts';
import {
  makeGigaCodeFixture,
  MODEL_A,
  MODEL_B
} from '../helpers/gigacode/fixture.mjs';
import {
  waitFor
} from './helpers/chat-turns.js';
import { createWorkIpc } from '../../server/src/lib/executors/workIpc.ts';

/**
 * Подменяется только создание внешнего процесса для чтения его собственного журнала.
 * Фактические bwrap, CLI, JSON-RPC и lifecycle остаются производственными.
 */
function recorder(config) {
  const requests = [];
  const children = [];

  return {
    requests,
    children,
    deps: {
      /**
       * Запускается тот же процесс; private log читается до удаления его home.
       * Перехват не подменяет ACP, namespace или обработку сигналов.
       */
      spawn(command, args, options) {
        const child = spawn(command, args, options);
        const index = args.indexOf('HOME');
        const home = args[index + 1];

        children.push(child);
        child.once('exit', () => {
          requests.push(fs.readFile(path.join(home, 'requests.jsonl'), 'utf8')
            .then((raw) => raw.trim().split('\n').map(JSON.parse), () => []));
        });

        return child;
      },
      termTimeoutMs: 50,
    },
  };
}

test('каталог точный, без effort; metadata не отправляет prompt и authenticate', async (t) => {
  const fixture = await makeGigaCodeFixture(t);
  const capture = recorder(fixture.config);
  const metadata = await readGigaCodeMetadata(fixture.config, capture.deps);
  const requests = (await Promise.all(capture.requests)).flat();

  assert.deepEqual(metadata.models.map((model) => model.id), [MODEL_A, MODEL_B]);
  assert.deepEqual(metadata.models[0].efforts, []);
  assert.equal(metadata.models[0].context, 8192);
  assert.equal(requests.some((entry) => /prompt|authenticate/u.test(entry.message?.method || '')),
    false);
});

test('новая версия CLI с ACP v1 запускается и сообщает фактическую версию в metadata', async (t) => {
  const fixture = await makeGigaCodeFixture(t, {
    cliVersion: '26.8.0',
    packageVersion: '0.14.0',
  });
  const metadata = [];

  await runGigaCodeTurn({
    config: fixture.config,
    cwd: fixture.workspace,
    model: MODEL_A,
    message: 'synthetic updated CLI',
    onRunMetadata: (value) => metadata.push(value),
  });

  assert.equal(metadata[0].cliVersion, '26.8.0');

  const scenario = JSON.parse(await fs.readFile(fixture.scenarioFile, 'utf8'));

  scenario.initialize.protocolVersion = 2;
  await fs.writeFile(fixture.scenarioFile, JSON.stringify(scenario));
  await assert.rejects(runGigaCodeTurn({
    config: fixture.config,
    cwd: fixture.workspace,
    model: MODEL_A,
    message: 'unsupported ACP',
  }), { code: 'gigacode_protocol_unsupported' });
});

test('поток tools/text, выбранная модель и fresh replay доставлены ровно один раз', async (t) => {
  const fixture = await makeGigaCodeFixture(t, {
    updates: [{
        sessionUpdate: 'tool_call',
        toolCallId: 'one',
        title: 'run_shell_command',
        rawInput: {
          command: 'echo fixture'
        }
      },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'one',
        status: 'completed',
        content: [{
          type: 'content',
          content: {
            type: 'text',
            text: '401 quota exceeded'
          }
        }]
      },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'one',
        status: 'completed'
      },
      {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: 'При'
        }
      },
      {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: 'вет'
        }
      },
    ],
  });
  const capture = recorder(fixture.config);
  const steps = [];
  const result = await runGigaCodeTurn({
    config: fixture.config,
    cwd: fixture.workspace,
    model: MODEL_B,
    message: 'Текущий запрос $(данные)',
    chatHistory: [{
      role: 'user',
      text: 'Прошлый запрос'
    }, {
      role: 'assistant',
      text: 'Прошлый ответ'
    }],
    onStep: (step) => steps.push(step),
  }, capture.deps);
  const requests = (await Promise.all(capture.requests)).flat();
  const prompt = requests.find((entry) => entry.message?.method === 'session/prompt').message
    .params;
  const selection = requests.find((entry) => entry.message?.method ===
    'session/set_config_option');

  assert.equal(result.text, 'Привет');
  assert.equal(result.sessionId, null);
  assert.equal(result.actualModelId, MODEL_B);
  assert.equal(selection.message.params.value, MODEL_B);
  assert.match(prompt.prompt[0].text, /Прошлый ответ/u);
  assert.equal(prompt.prompt[0].text.split('Текущий запрос').length, 2);
  assert.equal(steps.filter((step) => step.k === 'tool').length, 1);
  assert.equal(steps.filter((step) => step.k === 'res').length, 1);
  assert.equal(steps.find((step) => step.k === 'tool').name, 'Bash');
  assert.deepEqual(await fs.readdir(fixture.config.gigacodeRuntimeHome), []);
});

for (const scenario of [{
      stopReason: 'unknown_terminal'
    }, {
      eof: 'before_prompt_response'
    },
    {
      promptError: {
        code: -32603,
        message: 'Synthetic failure'
      }
    }
  ]) {
  test(`повреждённый итог сохраняет частичный ответ: ${JSON.stringify(scenario)}`, async (t) => {
    const fixture = await makeGigaCodeFixture(t, scenario);

    await assert.rejects(runGigaCodeTurn({
      config: fixture.config,
      cwd: fixture.workspace,
      model: MODEL_A,
      message: 'hello',
    }), (error) => {
      assert.equal(error.text, 'Ответ fixture');
      assert.ok(error.steps.length);

      return true;
    });
  });
}

test('неизвестная модель и effort не подменяются; mandatory MCP нужен до prompt', async (t) => {
  const fixture = await makeGigaCodeFixture(t, {
    discoverMcp: false
  });
  const base = {
    config: fixture.config,
    cwd: fixture.workspace,
    message: 'hello',
    model: MODEL_A
  };

  await assert.rejects(runGigaCodeTurn({
    ...base,
    effort: 'high'
  }), /усили/u);
  await assert.rejects(runGigaCodeTurn({
    ...base,
    model: 'invented'
  }), /модел/u);
  await assert.rejects(runGigaCodeTurn({
    ...base,
    workTools: {
      descriptors: [],
      invoke: async () => ({})
    },
    metadataTimeoutMs: 1000,
  }), /MCP/u);
});

test('MCP проходит через namespace и deny permission не даёт побочного эффекта', async (t) => {
  const fixture = await makeGigaCodeFixture(t);
  const sideEffect = path.join(fixture.workspace, 'should-not-exist');
  const scenario = JSON.parse(await fs.readFile(fixture.scenarioFile, 'utf8'));
  let invoked = 0;
  let asked = 0;

  await fs.writeFile(fixture.scenarioFile, JSON.stringify({
    ...scenario,
    mcpCalls: [{
      tool: 'own_tool',
      arguments: {}
    }],
    permission: {},
    sideEffectOnAllow: sideEffect,
  }));

  await runGigaCodeTurn({
    config: fixture.config,
    cwd: fixture.workspace,
    model: MODEL_A,
    message: 'hello',
    workTools: {
      descriptors: [{
        name: 'own_tool',
        description: 'Synthetic',
        inputSchema: {
          type: 'object'
        }
      }],
      invoke: async () => {
        invoked += 1;

        return {
          ok: true
        };
      },
    },
    onPermission: async () => {
      asked += 1;

      return {
        allow: false
      };
    },
  });

  assert.equal(invoked, 1);
  assert.equal(asked, 1);
  assert.equal(await fs.stat(sideEffect).then(() => true, () => false), false);
});

test('команда MCP вне workspace доступна в namespace вместе с её аргументами', async (t) => {
  const fixture = await makeGigaCodeFixture(t, {
    mcpCalls: [{
      tool: 'own_tool',
      arguments: {},
    }],
  });
  const helper = path.join(fixture.root, 'mcp-command');
  let invoked = 0;

  await fs.writeFile(helper, `#!/bin/sh\nexec '${process.execPath}' "$@"\n`, { mode: 0o700 });
  await runGigaCodeTurn({
    config: fixture.config,
    cwd: fixture.workspace,
    model: MODEL_A,
    message: 'synthetic MCP command',
    metadataTimeoutMs: 1000,
    workTools: {
      descriptors: [{
        name: 'own_tool',
        inputSchema: { type: 'object' },
      }],
      invoke: async () => {
        invoked += 1;

        return { ok: true };
      },
    },
  }, {
    createWorkIpc: async (options) => {
      const ipc = await createWorkIpc(options);

      ipc.mcpServer.command = helper;

      return ipc;
    },
  });

  assert.equal(invoked, 1);
});

test('Stop ограничивает TERM/KILL и не останавливает параллельный ход', async (t) => {
  const first = await makeGigaCodeFixture(t, {
    waitForCancel: true,
    ignoreTerm: true,
    hangOnClose: true
  });
  const second = await makeGigaCodeFixture(t);
  const controller = new AbortController();
  const capture = recorder(first.config);
  const pending = runGigaCodeTurn({
    config: first.config,
    cwd: first.workspace,
    model: MODEL_A,
    message: 'stop',
    signal: controller.signal,
    onStep: () => controller.abort(),
  }, capture.deps);
  const other = runGigaCodeTurn({
    config: second.config,
    cwd: second.workspace,
    model: MODEL_A,
    message: 'continue',
  });

  await assert.rejects(pending, (error) => error.stopped === true);
  assert.equal((await other).text, 'Ответ fixture');
  assert.ok(capture.children[0].signalCode);
  assert.throws(() => process.kill(capture.children[0].pid, 0), {
    code: 'ESRCH'
  });
  assert.deepEqual(await fs.readdir(first.config.gigacodeRuntimeHome), []);
});

test('Stop уничтожает detached tool descendant из собственного namespace', async (t) => {
  const marker = `giga-owned-child-${process.pid}-${Date.now()}`;
  const fixture = await makeGigaCodeFixture(t, {
    waitForCancel: true,
    ignoreTerm: true,
    hangOnClose: true,
    spawnSleepMarker: marker,
    leaveChildOnCancel: true,
  });
  const controller = new AbortController();
  const execute = promisify(execFile);
  const pending = runGigaCodeTurn({
    config: fixture.config,
    cwd: fixture.workspace,
    model: MODEL_A,
    message: 'spawn descendant',
    signal: controller.signal,
  });
  const outcome = assert.rejects(pending, (error) => error.stopped === true);
  const listed = await waitFor(async () => execute('/usr/bin/pgrep', ['-f', marker])
    .then((result) => result.stdout.trim(), () => ''), {
      what: 'собственный detached child'
    });
  const pids = listed.split('\n').map(Number);

  controller.abort();
  await outcome;
  await waitFor(async () => {
    const living = await Promise.all(pids.map((pid) => fs.readFile(`/proc/${pid}/stat`,
        'utf8')
      .then((raw) => raw.split(') ')[1][0] !== 'Z', () => false)));

    return living.every((alive) => !alive);
  }, {
    what: 'всё собственное дерево завершено'
  });
});

test('известный credential snapshot не попадает в текст, шаги и ошибку', async (t) => {
  const fixture = await makeGigaCodeFixture(t, {
    updates: [{
      sessionUpdate: 'agent_message_chunk',
      content: {
        type: 'text',
        text: 'synthetic-native-fixture-token',
      }
    }],
    promptError: {
      code: -32603,
      message: 'Failure synthetic-native-fixture-token'
    },
  });

  await assert.rejects(runGigaCodeTurn({
    config: fixture.config,
    cwd: fixture.workspace,
    model: MODEL_A,
    message: 'hello',
  }), (error) => {
    assert.doesNotMatch(JSON.stringify({
        message: error.message,
        text: error.text,
        steps: error.steps
      }),
      /synthetic-native-fixture-token/u);

    return true;
  });
});

test('Stop во время permission не ждёт поздний ответ человека', async (t) => {
  const fixture = await makeGigaCodeFixture(t, {
    permission: {}
  });
  const controller = new AbortController();

  await assert.rejects(runGigaCodeTurn({
    config: fixture.config,
    cwd: fixture.workspace,
    model: MODEL_A,
    message: 'hello',
    signal: controller.signal,
    onPermission: () => {
      controller.abort();

      return new Promise(() => {});
    },
  }), (error) => error.stopped === true);
});

for (const ending of ['success', 'error', 'stop']) {
  test(`credential в нескольких chunks скрыт перед всеми sinks: ${ending}`, async (t) => {
    const fixture = await makeGigaCodeFixture(t, {
      updates: ['agent_message_chunk', 'agent_thought_chunk'].flatMap((sessionUpdate) =>
        ['Начало synthetic-native-', 'fixture-token конец'].map((text) => ({
          sessionUpdate,
          content: { type: 'text', text },
        }))),
      ...(ending === 'error' ? { promptError: { code: -32603, message: 'Synthetic' } } : {}),
      waitForCancel: ending === 'stop',
    });
    const controller = new AbortController();
    const raw = [];
    const steps = [];
    const pending = runGigaCodeTurn({
      config: fixture.config,
      cwd: fixture.workspace,
      model: MODEL_A,
      message: 'hello',
      signal: controller.signal,
      onRawUpdate: (update) => {
        raw.push(update);

        if (ending === 'stop' && raw.length === 4) {
          controller.abort();
        }
      },
      onStep: (step) => steps.push(step),
    });
    const result = ending === 'success' ? await pending : await pending.catch((error) => error);

    assert.doesNotMatch(JSON.stringify({
      result,
      raw,
      steps,
    }), /synthetic-native-fixture-token/u);
    assert.doesNotMatch(raw.filter((update) => update.sessionUpdate === 'agent_message_chunk')
      .map((update) => update.content.text).join(''), /synthetic-native-fixture-token/u);
    assert.equal(result.text, 'Начало [скрыто] конец');
  });
}

test('Stop не ждёт незавершённый host workTools.invoke', { timeout: 5000 }, async (t) => {
  const fixture = await makeGigaCodeFixture(t, {
    mcpCalls: [{ tool: 'own_tool', arguments: {} }],
  });
  const controller = new AbortController();
  let invoked = false;

  await assert.rejects(runGigaCodeTurn({
    config: fixture.config,
    cwd: fixture.workspace,
    model: MODEL_A,
    message: 'hello',
    signal: controller.signal,
    workTools: {
      descriptors: [{
        name: 'own_tool',
        description: 'Synthetic',
        inputSchema: { type: 'object' },
      }],
      invoke: () => {
        invoked = true;
        controller.abort();

        return new Promise(() => {});
      },
    },
  }), (error) => error.stopped === true);

  assert.equal(invoked, true);
  assert.deepEqual(await fs.readdir(fixture.config.gigacodeRuntimeHome), []);
});

test('stderr-only причина сохраняется обезличенной без замены структурированной ошибки', async (t) => {
  const fixture = await makeGigaCodeFixture(t, {
    eof: 'before_prompt_response',
    promptStderr: '\u001b[31mNative transport unavailable '
      + 'synthetic-native-fixture-token token=hidden\u001b[0m',
  });

  await assert.rejects(runGigaCodeTurn({
    config: fixture.config,
    cwd: fixture.workspace,
    model: MODEL_A,
    message: 'hello',
  }), (error) => {
    assert.match(error.message, /Native transport unavailable/u);
    assert.doesNotMatch(error.message, /synthetic-native-fixture-token|hidden|\u001b/u);
    assert.ok(error.message.length <= 500);

    return true;
  });
});

for (const blocked of [true, false]) {
  test(`прямой DB-доступ закрывает также native HTTP fetch: ${blocked}`, async (t) => {
    const fixture = await makeGigaCodeFixture(t, { captureRequests: true });

    await runGigaCodeTurn({
      config: fixture.config,
      cwd: fixture.workspace,
      model: MODEL_A,
      message: 'hello',
      providerSettings: { blockDirectSsh: false, blockDirectDb: blocked },
    });

    const entries = (await fs.readFile(path.join(fixture.workspace, 'requests.jsonl'), 'utf8'))
      .trim().split('\n').map(JSON.parse);
    const startup = entries.find((entry) => entry.kind === 'startup');
    const excluded = startup.argv.find((arg) => arg.startsWith('--exclude-tools='))
      .slice('--exclude-tools='.length).split(',');

    assert.equal(excluded.includes('run_shell_command'), blocked);
    assert.equal(excluded.includes('web_fetch'), blocked);
  });
}

test('совокупный tool output ограничен даже при допустимом размере каждого frame', async (t) => {
  const fixture = await makeGigaCodeFixture(t, {
    updates: Array.from({ length: 20 }, () => ({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'one',
      status: 'in_progress',
      content: [{
        type: 'content',
        content: { type: 'text', text: 'x'.repeat(900000) },
      }],
    })),
  });

  await assert.rejects(runGigaCodeTurn({
    config: fixture.config,
    cwd: fixture.workspace,
    model: MODEL_A,
    message: 'hello',
  }), (error) => error.code === 'gigacode_output_limit');
});
