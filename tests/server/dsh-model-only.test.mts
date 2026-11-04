import { setTimeout as pause } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';
import { createRequire } from 'node:module';

import { runtimeInfoFixture } from '../helpers/deepseekMetadataFixture.mts';
import { writeDeepSeekBinaryStub } from '../helpers/deepseekBinaryStub.mts';
import * as dsh from '../../server/src/lib/executors/scopedDsh.ts';
import { buildDeepSeekChildEnv } from '../../server/src/lib/deepseek/env.ts';
import { resolveDeepSeekRuntimeAsync } from '../../server/src/lib/deepseek/runtimeProcess.ts';
import { startDeepSeekServer } from '../../server/src/lib/deepseek/serverRuntime.ts';
import { ensureGlmTestRuntime } from '../helpers/glmTestRuntime.mts';
import { startDeepSeekLoopback } from '../helpers/deepseekLoopback.mts';
import { writeGlmEgressGuard } from '../helpers/glmEgressGuard.mts';

const requireServer = createRequire(new URL('../../server/package.json', import.meta.url));
const WebSocket = requireServer('ws');

// Optional entry даёт assertion RED на отсутствующем поведении вместо import/TypeError.
const api = dsh as unknown as {
  runModelOnlyDsh?: (...args: any[]) => Promise<any>;
};
const invoke = async (input: unknown, route: unknown) => api.runModelOnlyDsh
  ? api.runModelOnlyDsh(input, route) : {
    reply: null
  };
/**
 * Настоящий ELF и production server transport; заменён только vendor endpoint.
 * Все ключи synthetic, guard запрещает внешний fetch, каталоги принадлежат тесту.
 */
async function fixture(t: TestContext, respond?: any) {
  const selected = await ensureGlmTestRuntime();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-model-only-test-'));
  const mock = await startDeepSeekLoopback({
    respond
  });
  const runtime = await resolveDeepSeekRuntimeAsync(selected.config);
  const guard = await writeGlmEgressGuard(root);
  const launches: any[] = [];

  await fs.writeFile(path.join(root, 'AGENTS.md'), 'PRIVATE_RULES_POISON');
  await fs.writeFile(path.join(root, '.mcp.json'), 'PRIVATE_MCP_POISON');
  t.after(async () => {
    await mock.stop();
    await fs.rm(root, {
      recursive: true,
      force: true
    });
  });

  const route = {
    runtime,
    childEnv: (home: string) => buildDeepSeekChildEnv({
      source: {
        PATH: process.env.PATH,
        HOME: root,
        DEEPSEEK_API_KEY: 'synthetic'
      },
      dshHome: home,
    }),
    rows: [{
      id: 'llm-deepseek',
      config: {
        baseURL: mock.endpoint,
        retryPolicy: {
          mode: 'normal',
          maxRetries: 0
        }
      }
    }],
    insert: [{
      id: 'loopback-only',
      name: pathToFileURL(guard).href
    }],
    startServer: async (input: any) => {
      launches.push(input);

      return startDeepSeekServer(input);
    },
  };

  return {
    root,
    mock,
    route,
    launches
  };
}

const input = {
  model: '["deepseek-official","deepseek-v4-flash"]',
  effort: 'high',
  message: 'Return a text answer.',
  timeoutMs: 30000
};
/**
 * Меняется только обратный wire snapshot, реальный выбор модели и ELF сохраняются.
 * Защита должна отказаться до prompt именно по прочитанному подтверждению.
 */
function rewriteModelSnapshot(t: TestContext, field: string) {
  const emit = WebSocket.prototype.emit;

  t.mock.method(WebSocket.prototype, 'emit', function(this: any, name: string, ...args: any[]) {
    if (name === 'message') {
      const frame = JSON.parse(String(args[0]));
      const next = frame.value?.type === 'snapshot'
        ? frame.value.projections?.values?.modelSelection?.next : null;

      if (next) {
        next[field] = 'PRIVATE_SNAPSHOT_POISON';
        args[0] = Buffer.from(JSON.stringify(frame));
      }
    }

    return emit.call(this, name, ...args);
  });
}

test('DSH-MODEL: завершённый текст, private cwd, ноль tools и никакого poison', async (t) => {
  const f = await fixture(t);
  const value = await invoke({
    ...input,
    cwd: f.root,
    sessionId: 'foreign'
  }, f.route);

  assert.equal(value.reply, 'loopback-ok');
  assert.equal(value.sessionId, null);
  assert.equal(value.cost, null);
  assert.equal(f.mock.payloads.length, 1);
  assert.equal((f.mock.payloads[0]!.tools ?? []).length, 0);
  assert.doesNotMatch(JSON.stringify(f.mock.payloads), /PRIVATE_RULES_POISON|PRIVATE_MCP_POISON/);
  assert.notEqual(f.launches[0].cwd, f.root);
  await assert.rejects(fs.access(f.launches[0].cwd), {
    code: 'ENOENT'
  });
});
test('DSH-MODEL: навязанный shell не исполняется и не вызывает второй запрос', async (t) => {
  const marker = path.join(os.tmpdir(), `forbidden-dsh-${process.pid}-${Date.now()}`);

  t.after(() => fs.rm(marker, {
    force: true
  }));

  const f = await fixture(t, async () => ({
    deltas: [{
      tool_calls: [{
        index: 0,
        id: 'attack',
        type: 'function',
        function: {
          name: 'bash',
          arguments: JSON.stringify({
            command: `touch ${marker}`
          })
        }
      }]
    }],
    finishReason: 'tool_calls'
  }));

  await assert.rejects(invoke(input, f.route));
  await assert.rejects(fs.access(marker), {
    code: 'ENOENT'
  });
  assert.equal(f.mock.payloads.length, 1);
});
test('DSH-MODEL: чужой proof закрывает процесс до создания сессии', async (t) => {
  const f = await fixture(t);
  let created = false;
  let stopped = false;
  const start = f.route.startServer;

  f.route.startServer = async (launch: any) => {
    const server = await start(launch);
    const rows = JSON.parse(await fs.readFile(launch.overlayPath, 'utf8'));
    const guard = rows.find((row: any) => row.insert).insert
      .find((row: any) => row.id === 'grigdesk-model-only-guard');

    await fs.writeFile(guard.config.proofPath, JSON.stringify({
      nonce: 'foreign',
      allowed: []
    }));

    const stop = server.stop.bind(server);

    server.client.createSession = async () => {
      created = true;

      throw new Error('no session');
    };
    server.stop = async () => {
      stopped = true;
      await stop();
    };

    return server;
  };
  await assert.rejects(invoke(input, f.route), {
    code: 'unsafe_model_provider'
  });
  assert.equal(created, false);
  assert.equal(stopped, true);
  assert.equal(f.mock.payloads.length, 0);
});
test('DSH-MODEL: ранний abort и images не достигают runtime', async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();

  controller.abort();
  await assert.rejects(invoke({
    ...input,
    signal: controller.signal
  }, f.route));
  await assert.rejects(invoke({
    ...input,
    images: [{}]
  }, f.route), {
    code: 'unsupported_media'
  });
  await assert.rejects(invoke({
    ...input,
    images: {}
  }, f.route), {
    code: 'unsupported_media'
  });

  for (const timeoutMs of [0, 900001, Number.POSITIVE_INFINITY]) {
    await assert.rejects(invoke({ ...input, timeoutMs }, f.route), { code: 'model_timeout_invalid' });
  }

  assert.equal(f.launches.length, 0);
});
test('DSH-MODEL: отмена после запроса, пустой и чрезмерный ответ не дают успех', async (t) => {
  const controller = new AbortController();
  const f = await fixture(t, async () => {
    controller.abort();

    return {
      deltas: [{
        content: 'partial'
      }]
    };
  });

  await assert.rejects(invoke({
    ...input,
    signal: controller.signal
  }, f.route), {
    code: 'model_run_aborted'
  });
  await assert.rejects(fs.access(f.launches[0].cwd), {
    code: 'ENOENT'
  });

  const empty = await fixture(t, async () => ({
    deltas: []
  }));

  await assert.rejects(invoke(input, empty.route), {
    code: 'model_run_failed'
  });

  const large = await fixture(t, async () => ({
    deltas: [{
      content: 'x'.repeat(140000)
    }]
  }));

  await assert.rejects(invoke(input, large.route), {
    code: 'model_run_failed'
  });
});
test('DSH-MODEL: собственный срок до prompt, повторов нет', async (t) => {
  const f = await fixture(t);

  await assert.rejects(invoke({
    ...input,
    timeoutMs: 1
  }, f.route), {
    code: 'model_run_aborted'
  });
  assert.equal(f.mock.payloads.length, 0);

  for (const launch of f.launches) {
    await assert.rejects(fs.access(launch.cwd), {
      code: 'ENOENT'
    });
  }
});
test('DSH-MODEL: параллельные вызовы не разделяют home/cwd', async (t) => {
  const f = await fixture(t);
  const values = await Promise.all([invoke(input, f.route), invoke(input, f.route)]);

  assert.deepEqual(values.map((value) => value.reply), ['loopback-ok', 'loopback-ok']);
  assert.notEqual(f.launches[0].cwd, f.launches[1].cwd);

  for (const launch of f.launches) {
    await assert.rejects(fs.access(launch.cwd), {
      code: 'ENOENT'
    });
  }
});

for (const field of ['provider', 'model', 'reasoningEffort']) {
  test(`DSH-MODEL: неверный snapshot ${field}, нет prompt и утечки ошибки`, async (t) => {
    const f = await fixture(t);

    rewriteModelSnapshot(t, field);

    let created = false;
    let stopped = false;
    const start = f.route.startServer;

    f.route.startServer = async (launch: any) => {
      const server = await start(launch);
      const create = server.client.createSession.bind(server.client);
      const stop = server.stop.bind(server);

      server.client.createSession = async (...args: Parameters<typeof create>) => {
        created = true;

        return create(...args);
      };
      server.stop = async () => {
        stopped = true;
        await stop();
      };

      return server;
    };
    await assert.rejects(invoke(input, f.route), (error: any) => {
      assert.equal(error.code, 'unsafe_model_provider');
      assert.equal(error.message, 'Не удалось выполнить изолированный вызов модели.');
      assert.equal('sessionId' in error, false);
      assert.equal('steps' in error, false);
      assert.equal('cause' in error, false);
      assert.doesNotMatch(String(error.stack), /PRIVATE_SNAPSHOT_POISON|token=/);

      return true;
    });
    assert.equal(created, true);
    assert.equal(stopped, true);
    assert.equal(f.mock.payloads.length, 0);
    await assert.rejects(fs.access(f.launches[0].cwd), {
      code: 'ENOENT'
    });
  });
}
for (const finishReason of ['length', 'tool_calls']) {
  test(`DSH-MODEL: partial + ${finishReason} не считается успехом`, async (t) => {
    const f = await fixture(t, async () => ({
      deltas: [{
        role: 'assistant',
        content: 'partial-text'
      }],
      finishReason,
    }));

    await assert.rejects(invoke(input, f.route), {
      code: 'model_run_failed'
    });
    assert.equal(f.mock.payloads.length, 1);
    await assert.rejects(fs.access(f.launches[0].cwd), {
      code: 'ENOENT'
    });
  });
}
for (const cancellation of ['deadline', 'parent-abort']) {
  test(`DSH-MODEL: ${cancellation} охватывает удержанную подготовку route`, async (t) => {
    const f = await fixture(t);
    const controller = new AbortController();
    let prepared!: () => void;
    const entered = new Promise<void>((resolve) => {
      prepared = resolve;
    });
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = invoke({
      ...input,
      timeoutMs: cancellation === 'deadline' ? 30 : 30000,
      signal: controller.signal,
    }, async (signal: AbortSignal) => {
      prepared();
      await barrier;
      signal.throwIfAborted();

      return f.route;
    });
    // Observer прикрепляется до abort, чтобы ранняя ошибка не была unhandled.
    const rejected = assert.rejects(pending, {
      code: 'model_run_aborted'
    });

    try {
      // На базе без export вызов уже завершился RED; не ждать невызванную фабрику.
      await Promise.race([entered, pending]);

      if (cancellation === 'parent-abort') {
        controller.abort();
      }

      await rejected;
      assert.equal(f.launches.length, 0);
      assert.equal(f.mock.payloads.length, 0);
    }
    finally {
      release();
    }
  });
}

for (const cancellation of ['parent-abort', 'deadline']) {
  test(`DSH-MODEL: ${cancellation} во время повторной startup verification`, {
    timeout: 15000
  }, async (t) => {
    const { root, binary } = await writeDeepSeekBinaryStub(t, '');
    const hold = path.join(root, 'hold');
    const entered = path.join(root, 'entered');
    const release = path.join(root, 'release');
    const info = runtimeInfoFixture();
    const body = `#!${process.execPath}\n`
      + `const fs = require('node:fs');\n`
      + `const finish = () => process.stdout.write(${JSON.stringify(JSON.stringify(info))});\n`
      + `if (fs.existsSync(${JSON.stringify(hold)})) {\n`
      + `  fs.writeFileSync(${JSON.stringify(entered)}, 'entered');\n`
      + `  const timer = setInterval(() => {\n`
      + `    if (fs.existsSync(${JSON.stringify(release)})) { clearInterval(timer); finish(); }\n`
      + `  }, 10);\n`
      + `} else { finish(); }\n`;

    await fs.writeFile(binary, body, {
      mode: 0o755
    });

    const config = {
      deepseekRuntimeMode: 'binary' as const,
      deepseekBin: binary,
      deepseekCacheDir: path.join(root, 'cache'),
    };
    const runtime = await resolveDeepSeekRuntimeAsync(config);

    await fs.writeFile(hold, 'hold');
    // Новый signature/SHA заставляет startup повторить probe уже после подготовки descriptor.
    await fs.appendFile(binary, '\n// replacement signature\n');

    const controller = new AbortController();
    const launches: any[] = [];
    let webSpawns = 0;
    let watchdogReleased = false;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let sharedSettled = false;
    let shared: Promise<unknown> | undefined;
    const pending = invoke({
      ...input,
      timeoutMs: cancellation === 'deadline' ? 2000 : 10000,
      signal: controller.signal,
    }, {
      runtime,
      childEnv: () => ({}),
      startServer: (launch: any) => {
        launches.push(launch);

        return startDeepSeekServer({
          ...launch,
          spawnProcess: () => {
            webSpawns++;

            throw new Error('Startup verification must reject before web spawn');
          },
        });
      },
    });
    const rejected = assert.rejects(pending, {
      code: 'model_run_aborted'
    });

    void rejected.catch(() => {
    });

    try {
      const deadline = Date.now() + 5000;

      while (!await fs.access(entered).then(() => true, () => false)) {
        assert.ok(Date.now() < deadline, 'Повторная metadata verification не началась');
        await pause(10);
      }

      shared = resolveDeepSeekRuntimeAsync(config).then((value) => {
        sharedSettled = true;

        return value;
      });
      // Только предохранитель RED: прежний код ждёт metadata до release.
      watchdog = setTimeout(() => {
        watchdogReleased = true;
        void fs.writeFile(release, 'release');
      }, 5000);

      if (cancellation === 'parent-abort') {
        controller.abort();
      }

      await rejected;
      assert.equal(watchdogReleased, false);
      assert.equal(sharedSettled, false);
      assert.equal(webSpawns, 0);
      assert.equal(launches.length, 1);
      await assert.rejects(fs.access(launches[0].cwd), {
        code: 'ENOENT'
      });
    }
    finally {
      clearTimeout(watchdog);
      await fs.writeFile(release, 'release');
      await shared;
      await rejected.catch(() => {
      });
    }

    assert.equal(sharedSettled, true);
    assert.equal(webSpawns, 0);
  });
}

test('DSH-MODEL: неверный вход и попытка переключить триаж не достигают runtime', async () => {
  let prepared = false;
  const route = async () => {
    prepared = true;

    throw new Error('Маршрут не должен готовиться');
  };

  for (const extra of [
    { message: 'x'.repeat(131073) },
    { message: null },
    { model: 'invalid-json' },
    { model: '["deepseek-official",1]' },
    { model: '["deepseek-official",""]' },
  ]) {
    await assert.rejects(invoke({ ...input, ...extra }, route), { code: 'model_input_invalid' });
  }

  await assert.rejects(dsh.runScopedDsh({
    ...input,
    cwd: '/unused',
    workspaceAccess: null,
    modelOnly: true,
  } as any, {} as any));
  assert.equal(prepared, false);
});

test('DSH-MODEL: ошибка подготовки пересоздаётся без секретов и служебных полей', async () => {
  const upstream = Object.assign(new Error('SYNTHETIC_PRIVATE_ERROR'), {
    code: 'glm_key_missing',
    sessionId: 'SYNTHETIC_PRIVATE_SESSION',
    steps: ['SYNTHETIC_PRIVATE_STEP'],
    cause: new Error('SYNTHETIC_PRIVATE_CAUSE'),
  });

  await assert.rejects(invoke(input, async () => {
    throw upstream;
  }), (error: any) => {
    assert.notEqual(error, upstream);
    assert.equal(error.code, 'glm_key_missing');
    assert.equal(error.message, 'Не удалось выполнить изолированный вызов модели.');
    assert.equal('sessionId' in error, false);
    assert.equal('steps' in error, false);
    assert.equal('cause' in error, false);
    assert.doesNotMatch(String(error.stack), /SYNTHETIC_PRIVATE/);

    return true;
  });
});

test('DSH-MODEL: чрезмерное размышление закрывает stream после одного запроса', async (t) => {
  const f = await fixture(t, async () => ({
    deltas: [{
      reasoning_content: 'x'.repeat(2100000),
    }],
  }));

  await assert.rejects(invoke(input, f.route), { code: 'model_run_failed' });
  assert.equal(f.mock.payloads.length, 1);
  await assert.rejects(fs.access(f.launches[0].cwd), { code: 'ENOENT' });
});
