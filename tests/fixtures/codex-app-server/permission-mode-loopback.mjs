import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';

import codex from '../../../server/src/lib/executors/codex.ts';
import { externalCliAdapter } from '../../../server/src/lib/providerInstall/externalCliAdapter.ts';

/**
 * Ответчик заменяет только модель: опубликованные инструменты и их эффекты исполняет CLI.
 * Собственные home/workspace не содержат авторизации, пользовательских hooks или MCP.
 */
export async function nativeModeProbe({
  directory, policy, sandbox, call, decision = 'decline', setup, adapterMode, startConfig, cleanTerminals,
  binary = process.env.CODEX_BIN || 'codex',
}) {
  const root = await mkdtemp(path.join(directory, 'native-'));
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'workspace');

  await mkdir(home, { mode: 0o700 });
  await mkdir(cwd);

  await setup?.({
    root,
    cwd,
    home
  });

  const requests = [];
  const events = [];
  let stderr = '';
  const server = createServer(async (request, response) => {
    let body = '';

    for await (const chunk of request) {
      body += chunk;
    }

    const input = JSON.parse(body);

    requests.push(input);

    const item = requests.length === 1
      ? call(input, { root, cwd })
      : {
        type: 'message',
        id: 'answer',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'probe completed' }],
      };
    const output = [
      {
        type: 'response.output_item.done',
        output_index: 0,
        item
      },
      {
        type: 'response.completed',
        response: {
          id: 'response',
          output: [item],
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            total_tokens: 2
          }
        },
      },
    ];

    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(output.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  await writeFile(path.join(home, 'config.toml'), [
    'model_provider="contract"',
    '[model_providers.contract]',
    'name="contract"',
    `base_url="http://127.0.0.1:${server.address().port}"`,
    'wire_api="responses"',
    'requires_openai_auth=false',
    'request_max_retries=0',
    'stream_max_retries=0',
    '',
  ].join('\n'));

  if (adapterMode) {
    const config = {
      codexBin: binary,
      dataHome: path.join(root, 'data'),
      artifactsDir: root
    };
    const adapter = externalCliAdapter(codex, {
      PATH: process.env.PATH,
      HOME: home,
      CODEX_HOME: home,
      TMPDIR: root,
      XDG_RUNTIME_DIR: root,
      SHELL: '/bin/bash'
    });
    const modeSelection = {
      provider: 'codex',
      id: adapterMode,
      revision: 1,
      chatId: 'fixture'
    };
    let session;

    try {
      const prepare = () => adapter.prepareRuntime(config, { signal: AbortSignal.timeout(15_000),
        permissionModeContext: {
          mode: adapterMode,
          provider: 'codex',
          chatId: 'fixture',
          cwd,
          extraDirs: [],
          modeSelection
        } });
      const preparedRuntime = await prepare();
      const spec = {
        config,
        cwd,
        extraDirs: [],
        permissionMode: adapterMode,
        modeSelection,
        preparedRuntime,
        runtimeProfileFingerprint: adapter.runtimeProfileFingerprint(preparedRuntime),
        providerSettings: { blockDirectSsh: false },
        model: 'gpt-6-astra',
        tokenInfoReader: async () => null
      };

      session = await adapter.session.open(spec);

      const result = await session.send({
        ...spec,
        message: 'Execute the fixture probe.',
        onStep: (step) => events.push(step)
      });
      const next = await prepare();

      await session.send({
        ...spec,
        message: 'Continue the fixture.',
        preparedRuntime: next,
        runtimeProfileFingerprint: adapter.runtimeProfileFingerprint(next)
      });
      await session.prepareTransition({ permissionMode: 'auto' });
      await writeFile(path.join(root, 'adapter-trace.json'), JSON.stringify({
        result,
        events,
        requests
      }));

      return {
        root,
        cwd,
        result,
        events,
        requests
      };
    } finally {
      await session?.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }

  const child = spawn(binary, ['app-server'], {
    cwd,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      CODEX_HOME: home,
      TMPDIR: root,
      XDG_RUNTIME_DIR: root
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });
  const pending = new Map();
  let sequence = 0;
  let failure;
  const closed = new Promise((resolve) => child.once('close', resolve));
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const rpc = (method, params) => new Promise((resolve, reject) => {
    if (failure) {
      reject(failure);

      return;
    }

    const id = ++sequence;

    pending.set(id, { resolve, reject });
    send({
      id,
      method,
      params
    });
  });
  let complete;
  const completed = new Promise((resolve) => {
    complete = resolve;
  });

  /**
   * Ошибка запуска и общий срок прерывают также текущий RPC, а не только ожидание turn.
   * Иначе незавершённый initialize удерживает HTTP-ответчик после провала теста.
   */
  function fail(error) {
    failure = error;

    for (const waiter of pending.values()) {
      waiter.reject(error);
    }

    pending.clear();
    complete({ error });
  }

  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  child.once('error', fail);
  child.on('exit', () => {
    fail(new Error(`CLI exited: ${stderr.slice(-1000)}`));
  });
  createInterface({ input: child.stdout }).on('line', (line) => {
    const event = JSON.parse(line);

    events.push(event);

    if (!event.method && pending.has(event.id)) {
      const waiter = pending.get(event.id);

      pending.delete(event.id);

      if (event.error) {
        waiter.reject(new Error(JSON.stringify(event.error)));
      } else {
        waiter.resolve(event.result);
      }
    } else if (event.method && event.id !== undefined) {
      send({ id: event.id, result: { decision } });
    } else if (event.method === 'turn/completed') {
      complete(event.params);
    }
  });

  const timer = setTimeout(() => fail(new Error('Native Codex probe timed out')), 25_000);

  try {
    await rpc('initialize', {
      clientInfo: { name: 'grigdesk-native-mode-probe', version: '1' },
      capabilities: { experimentalApi: true },
    });
    send({ method: 'initialized', params: {} });

    const requirements = await rpc('configRequirements/read', {});
    const ready = await rpc('thread/start', {
      cwd,
      model: 'gpt-6-astra',
      approvalPolicy: policy,
      approvalsReviewer: 'user',
      sandbox,
      ephemeral: true,
      ...(startConfig ? { config: startConfig({ root, cwd }) } : {}),
    });

    await rpc('turn/start', {
      threadId: ready.thread.id,
      input: [{
        type: 'text',
        text: 'Execute the fixture probe.',
        text_elements: []
      }],
      approvalPolicy: policy,
      approvalsReviewer: 'user',
      sandboxPolicy: sandbox === 'danger-full-access'
        ? { type: 'dangerFullAccess' }
        : sandbox === 'read-only'
        ? { type: 'readOnly', networkAccess: false }
        : {
          type: 'workspaceWrite',
          writableRoots: [cwd],
          networkAccess: false,
          excludeTmpdirEnvVar: true,
          excludeSlashTmp: true
        },
    });

    const result = await completed;

    if (failure) {
      throw failure;
    }

    const terminals = cleanTerminals ? await (async () => {
      await rpc('thread/backgroundTerminals/clean', { threadId: ready.thread.id });

      return rpc('thread/backgroundTerminals/list', { threadId: ready.thread.id });
    })() : undefined;

    await writeFile(path.join(root, 'trace.json'), JSON.stringify({
      requests,
      events,
      ready,
      requirements,
      result,
      stderr
    }, null, 2));

    return {
      root,
      cwd,
      requests,
      events,
      ready,
      requirements,
      result,
      terminals
    };
  } finally {
    clearTimeout(timer);

    // detached=true создаёт собственную группу: чужие процессы сюда не входят.
    if (child.pid) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') {
          throw error;
        }
      }
    }

    await closed;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
