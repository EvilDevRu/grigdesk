import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import http from 'node:http';

import {
  BUSY_UNKNOWN,
  PluginAdmission,
  askPluginBusy,
  createPluginLifecycle,
} from '../../server/src/modules/plugins/lifecycle.ts';

test('B1: lifecycle начинается с null hooks, отсутствие объекта диагностически свободно', async () => {
  const lifecycle = createPluginLifecycle();

  assert.equal(lifecycle.busyReason, null);
  assert.equal(lifecycle.prepareReplace, null);
  assert.equal(await askPluginBusy(), null);
  assert.equal(await askPluginBusy(lifecycle), null);
});

test('B2: busy hook принимает только trimmed string/null/false и безопасно отвергает прочие значения',
  async () => {
    const lifecycle = createPluginLifecycle();

    for (const [value, expected] of [
      ['  занят замером  ', 'занят замером'], ['', null], ['  ', null], [null, null], [false, null],
      [true, BUSY_UNKNOWN], [42, BUSY_UNKNOWN], [{}, BUSY_UNKNOWN], [undefined, BUSY_UNKNOWN],
    ]) {
      lifecycle.busyReason = () => value;
      assert.equal(await askPluginBusy(lifecycle), expected);
      assert.equal(lifecycle.prepareReplace, null, 'busyReason не предоставляет replacement lease');
    }
  });

test('B3: исключение busy hook скрывает fixture-secret и возвращает BUSY_UNKNOWN', async () => {
  const lifecycle = createPluginLifecycle();

  lifecycle.busyReason = () => {
    throw new Error('fixture-secret diagnostic error');
  };
  assert.equal(await askPluginBusy(lifecycle), BUSY_UNKNOWN);
  assert.equal(BUSY_UNKNOWN.includes('fixture-secret'), false);
});

test('B4: зависший busy hook ограничен 5 секундами, таймер снят, event loop жив', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const clear = t.mock.method(globalThis, 'clearTimeout');
  const lifecycle = createPluginLifecycle();
  let finished = false;

  lifecycle.busyReason = () => new Promise(() => {});

  const pending = askPluginBusy(lifecycle).then((value) => {
    finished = true;

    return value;
  });

  await Promise.resolve();
  await Promise.resolve();
  assert.equal(finished, false, 'неизвестный исход не публикуется до timeout');
  t.mock.timers.tick(4999);
  await Promise.resolve();
  assert.equal(finished, false);
  t.mock.timers.tick(1);
  assert.equal(await pending, BUSY_UNKNOWN);
  assert.equal(clear.mock.callCount(), 1);
});

test('B5: асинхронная причина работает, busyReason не выдаёт lease и таймер всегда снят', async (t) => {
  const clear = t.mock.method(globalThis, 'clearTimeout');
  const lifecycle = createPluginLifecycle();

  lifecycle.busyReason = async () => '  выполняется задача  ';
  assert.equal(await askPluginBusy(lifecycle), 'выполняется задача');
  assert.equal(lifecycle.prepareReplace, null);
  assert.equal(clear.mock.callCount(), 1);
  lifecycle.busyReason = async () => {
    throw new Error('fixture-secret');
  };
  assert.equal(await askPluginBusy(lifecycle), BUSY_UNKNOWN);
  assert.equal(clear.mock.callCount(), 2);
});

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));

/**
 * Слушающий fixture использует настоящий response stream и scope hook.
 * Его socket и временная static папка закрываются до удаления root.
 */
async function admissionFixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-admission-'));
  const app = requireFromServer('fastify')({ logger: false });
  const lifecycle = createPluginLifecycle();
  const gate = new PluginAdmission({
    lifecycle,
    hasServer: false,
    ...options,
  });
  const stream = new PassThrough();

  await writeFile(path.join(root, 'index.html'), 'fixture static');
  await app.register(requireFromServer('@fastify/websocket'));
  app.get('/health', async () => ({ ok: true }));
  await app.register(async (scope) => {
    scope.addHook('onRequest', async (request, reply) => {
      gate.admit(request, reply);
    });
    scope.get('/value', async () => ({ ok: true }));
    scope.get('/stream', async (_request, reply) => {
      reply.type('text/plain').send(stream);
      stream.write('held\n');
    });
    scope.get('/ws', { websocket: true }, (socket) => {
      socket.send('held');
    });
    await scope.register(requireFromServer('@fastify/static'), {
      root,
      prefix: '/web/',
      decorateReply: false,
    });
  }, { prefix: '/api/ext/demo' });

  const address = await app.listen({ host: '127.0.0.1', port: 0 });

  t.after(async () => {
    stream.end();
    await app.close();
    await rm(root, { recursive: true, force: true });
  });

  return {
    app,
    gate,
    lifecycle,
    stream,
    address,
  };
}

/**
 * HTTP helper дожидается ответа сервера, включая отклонённый upgrade handshake.
 * Headers задаются caller, чтобы проверять тот же gate для разных transports.
 */
function nativeResponse(url, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get(url, { headers }, resolve).on('error', reject);
  });
}

test('B6: gate до handler закрывает API/static/upgrade и ждёт завершения native stream ровно один раз',
  async (t) => {
    const fixture = await admissionFixture(t);
    const response = await nativeResponse(`${fixture.address}/api/ext/demo/stream`);
    let settled = false;

    response.resume();

    const pending = fixture.gate.prepare(new AbortController().signal).then((lease) => {
      settled = true;

      return lease;
    });

    try {
      for (const url of ['/value', '/web/']) {
        assert.equal((await fixture.app.inject(`/api/ext/demo${url}`)).statusCode, 409);
      }

      const upgrade = await nativeResponse(`${fixture.address}/api/ext/demo/ws`, {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': Buffer.alloc(16, 1).toString('base64'),
      });

      upgrade.resume();
      assert.equal(upgrade.statusCode, 409);
      assert.equal((await fixture.app.inject('/health')).statusCode, 200);
      assert.equal(settled, false, 'handler вернулся, но stream ещё держит drain');
    } finally {
      fixture.stream.end();
      await (await pending).finish('reverted');
    }

    assert.equal((await fixture.app.inject('/api/ext/demo/value')).statusCode, 200);
    assert.equal(fixture.gate.active, 0, 'finish и close не уменьшают счётчик дважды');
  });

test('B7: drain timeout не убивает действующий stream/WS и допускает повтор после их окончания',
  async (t) => {
    for (const websocket of [false, true]) {
      const fixture = await admissionFixture(t, { timeoutMs: 50 });
      let client;

      if (websocket) {
        const WebSocket = requireFromServer('ws');

        client = new WebSocket(fixture.address.replace('http:', 'ws:') + '/api/ext/demo/ws');
        await new Promise((resolve, reject) => {
          client.once('open', resolve);
          client.once('error', reject);
        });
      } else {
        client = await nativeResponse(`${fixture.address}/api/ext/demo/stream`);
        client.resume();
      }

      const pending = fixture.gate.prepare(new AbortController().signal).catch((error) => error);
      let limit;

      try {
        const result = await Promise.race([
          pending,
          new Promise((resolve) => {
            limit = setTimeout(() => resolve({ code: 'fixture_not_finished' }), 250);
          }),
        ]);

        assert.equal(result.code, 'plugin_busy', 'timeout должен завершить попытку замены');
        assert.equal(websocket ? client.readyState : Number(client.readableEnded), websocket ? 1 : 0);
        assert.equal((await fixture.app.inject('/health')).statusCode, 200);
        assert.equal((await fixture.app.inject('/api/ext/demo/value')).statusCode, 200);
      } finally {
        clearTimeout(limit);

        if (websocket) {
          await new Promise((resolve) => {
            client.once('close', resolve);
            client.close();
          });
        } else {
          fixture.stream.end();
        }

        const result = await pending;

        if (result.finish) {
          await result.finish('reverted');
        }
      }

      await (await fixture.gate.prepare(new AbortController().signal)).finish('reverted');
      assert.equal(fixture.gate.active, 0);
    }
  });

test('B8: loaded server без prepareReplace требует остановки, static-only получает lease', async (t) => {
  const fixture = await admissionFixture(t, { hasServer: true });

  assert.equal(await askPluginBusy(fixture.lifecycle), null);
  await assert.rejects(fixture.gate.prepare(new AbortController().signal), { code: 'plugin_stop_required' });
  assert.equal((await fixture.app.inject('/api/ext/demo/value')).statusCode, 200);

  const dormant = new PluginAdmission({ lifecycle: createPluginLifecycle(), hasServer: false });

  await (await dormant.prepare(new AbortController().signal)).finish('reverted');
  assert.equal(dormant.phase, 'open');
});

/**
 * Hook barrier показывает момент перед выдачей lease без wall-clock задержки.
 * Каждый тест освобождает свой barrier даже при неудачном assert.
 */
function hookBarrier() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });

  return { promise, release };
}

test('B9: lease останавливает timer, installed/blocked держат gate, reverted возобновляет', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });

  for (const outcome of ['installed', 'blocked', 'reverted']) {
    const lifecycle = createPluginLifecycle();
    const gate = new PluginAdmission({ lifecycle, hasServer: true });
    const held = hookBarrier();
    const finishes = [];
    let marker = 0;
    let timer = setInterval(() => marker += 1, 10);

    lifecycle.prepareReplace = async () => {
      await held.promise;
      clearInterval(timer);

      return {
        finish: async (value) => {
          finishes.push(value);

          if (value === 'reverted') {
            timer = setInterval(() => marker += 1, 10);
          }
        },
      };
    };

    const pending = gate.prepare(new AbortController().signal);
    let leased = false;

    pending.then(() => leased = true);
    await Promise.resolve();
    await Promise.resolve();

    try {
      t.mock.timers.tick(20);
      assert.equal(marker, 2, 'фон работает до завершения hook');
      assert.equal(leased, false, 'busyReason не выдаёт право замены вместо hook');
    } finally {
      held.release();
    }

    const lease = await pending;

    t.mock.timers.tick(20);
    assert.equal(marker, 2, 'полученный lease действительно остановил фон');
    await lease.finish(outcome);
    assert.deepEqual(finishes, [outcome]);
    t.mock.timers.tick(20);
    assert.equal(marker, outcome === 'reverted' ? 4 : 2);
    assert.equal(gate.phase, outcome === 'reverted' ? 'open' : outcome);
    clearInterval(timer);
  }
});

test('B10: timeout/abort сохраняет gate до cleanup; поздний lease reverted ровно один раз', async (t) => {
  for (const abort of [false, true]) {
    const fixture = await admissionFixture(t, { hasServer: true, timeoutMs: 40 });
    const entered = hookBarrier();
    const held = hookBarrier();
    const cleanup = hookBarrier();
    const cleaned = hookBarrier();
    const controller = new AbortController();
    const finishes = [];
    let calls = 0;
    let hookSignal;

    fixture.lifecycle.prepareReplace = async (signal) => {
      calls += 1;
      hookSignal = signal;
      entered.release();
      await held.promise;

      return {
        finish: async (outcome) => {
          finishes.push(outcome);
          await cleanup.promise;
          cleaned.release();
        },
      };
    };

    const pending = fixture.gate.prepare(controller.signal).catch((error) => error);

    await entered.promise;

    if (abort) {
      controller.abort();
    }

    let limit;

    try {
      const result = await Promise.race([
        pending,
        new Promise((resolve) => {
          limit = setTimeout(() => resolve({ code: 'fixture_not_finished' }), 250);
        }),
      ]);

      assert.equal(result.code, abort ? 'cancelled' : 'plugin_busy');
      assert.equal(hookSignal.aborted, true);
      assert.equal((await fixture.app.inject('/api/ext/demo/value')).statusCode, 409);
      await assert.rejects(fixture.gate.prepare(new AbortController().signal), { code: 'plugin_busy' });
      assert.equal(calls, 1);
      held.release();
      await Promise.resolve();
      assert.equal((await fixture.app.inject('/api/ext/demo/value')).statusCode, 409);
      assert.deepEqual(finishes, ['reverted']);
      cleanup.release();
      await cleaned.promise;
      assert.equal((await fixture.app.inject('/api/ext/demo/value')).statusCode, 200);
    } finally {
      clearTimeout(limit);
      held.release();
      cleanup.release();

      const result = await pending;

      if (result.finish) {
        await result.finish('reverted');
      }
    }
  }
});

test('B11: failed reverted finish держит gate, повтор finish не открывает installed/blocked', async (t) => {
  for (const outcome of ['reverted', 'installed', 'blocked']) {
    const fixture = await admissionFixture(t, { hasServer: true });
    let finishes = 0;

    fixture.lifecycle.prepareReplace = async () => ({
      finish: async (value) => {
        finishes += 1;

        if (value === 'reverted') {
          throw new Error('fixture cleanup not confirmed');
        }
      },
    });

    const lease = await fixture.gate.prepare(new AbortController().signal);

    if (outcome === 'reverted') {
      await assert.rejects(lease.finish(outcome));
      await assert.rejects(lease.finish(outcome));
    } else {
      await lease.finish(outcome);
      await lease.finish('reverted');
    }

    assert.equal(finishes, 1, 'finish имеет единственный подтверждённый outcome');
    assert.equal((await fixture.app.inject('/api/ext/demo/value')).statusCode,
      outcome === 'blocked' ? 503 : 409);
  }
});

test('B12: старт HTTP между busyReason и lease не проходит admission', async (t) => {
  const fixture = await admissionFixture(t, { hasServer: true });
  const entered = hookBarrier();
  const held = hookBarrier();
  let hooks = 0;

  fixture.lifecycle.busyReason = async () => {
    entered.release(true);
    await held.promise;

    return null;
  };
  fixture.lifecycle.prepareReplace = async () => {
    hooks += 1;

    return { async finish() {} };
  };

  const pending = fixture.gate.prepare(new AbortController().signal);

  try {
    assert.equal(await Promise.race([entered.promise, pending.then(() => false)]), true,
      'diagnostic исполняется под закрытым admission');
    assert.equal((await fixture.app.inject('/api/ext/demo/value')).statusCode, 409);
    assert.equal(hooks, 0, 'новая работа не пересекается с промежутком до lease');
  } finally {
    held.release();
    await (await pending).finish('reverted');
  }

  assert.equal(hooks, 1);
  assert.equal((await fixture.app.inject('/api/ext/demo/value')).statusCode, 200);
});

test('B13: failed import/register остаётся potentially loaded, marker не разрешает замену', async (t) => {
  const { default: pluginsModule } = await import('../../server/src/modules/plugins/index.ts');
  const { installPortFixture } = await import('./helpers/pluginInstallHttpFixture.js');

  for (const registerFailure of [false, true]) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-failed-user-runtime-'));
    const pluginsDir = path.join(root, 'plugins');
    const boomDir = path.join(pluginsDir, 'boom');
    const marker = path.join(root, 'marker.txt');
    const timerKey = `fixture_plugin_timer_${path.basename(root)}`;
    const app = requireFromServer('fastify')({ logger: false });
    let runtime;
    const installs = {
      ...installPortFixture().port,
      recover: async () => ({ blockedIds: [], error: null }),
      bindRuntime: (value) => runtime = value,
      describe: async () => null,
    };

    await import('node:fs/promises').then(({ mkdir }) => mkdir(boomDir, { recursive: true }));
    await writeFile(path.join(boomDir, 'plugin.json'), JSON.stringify({ id: 'boom', version: '1.0.0' }));
    await writeFile(path.join(boomDir, 'server.js'), `
      import { appendFileSync } from 'node:fs';
      const marker = ${JSON.stringify(marker)};
      const start = () => {
        appendFileSync(marker, 'started\\n');
        globalThis[${JSON.stringify(timerKey)}] = setInterval(() => appendFileSync(marker, 'tick\\n'), 10);
      };
      ${registerFailure ? '' : "start(); throw new Error('fixture import failure');"}
      export default async function plugin(_app, options) {
        options.lifecycle.prepareReplace = async () => ({ async finish() {} });
        start();
        throw new Error('fixture register failure');
      }
    `);

    t.after(async () => {
      clearInterval(globalThis[timerKey]);
      delete globalThis[timerKey];
      await app.close();
      await rm(root, { recursive: true, force: true });
    });

    await app.register(pluginsModule, {
      config: { userPluginsDir: pluginsDir, userPluginsDataDir: path.join(root, 'data') },
      prefs: { read: () => ({ plugins: { boom: true } }), write() {} },
      installs,
    });

    assert.equal(Boolean(runtime), true, 'module связывает runtime с installer');
    assert.equal(runtime.isLoaded('boom'), true, 'попытка выполнения помечена до import/register');
    assert.match(await import('node:fs/promises').then(({ readFile }) => readFile(marker, 'utf8')),
      /started/);
    await assert.rejects(runtime.prepareReplace('boom', new AbortController().signal),
      { code: 'plugin_stop_required' });
    assert.equal((await app.inject('/api/plugins')).statusCode, 200, 'ошибка user module не рушит ядро');
    clearInterval(globalThis[timerKey]);
  }
});
