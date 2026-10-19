import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { closeSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as waitFor } from 'node:timers/promises';

import { probeGrigDesk } from '../../shared/runtime/grigDeskReadiness.ts';
import { openServerLog, runVpnGate, spawnServer } from '../../desktop/src/serverProcess.ts';
import { createServerSupervisor, decideStart } from '../../desktop/src/serverSupervisor.ts';
import { freePort } from '../server/helpers/pluginBootFixture.js';

const RUNTIME = {
  root: '/fixture/project',
  node: '/fixture/node',
  serverCommand: '/fixture/node',
  serverArgs: ['/fixture/project/server/src/app.ts'],
  port: 9300,
  origin: 'http://127.0.0.1:9300',
  env: {},
  graceMs: 45_000,
  logPath: '/fixture/server.log',
};

class FakeChild extends EventEmitter {
  pid = 101;
  exitCode = null;
  signalCode = null;
  signals = [];

  kill(signal) {
    this.signals.push(signal);

    return true;
  }

  exit(code, signal = null) {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }
}

/**
 * Подменяет HTTP, службу, ворота, процесс и часы одним журналом вызовов.
 * Сон двигает явное время, поэтому срок старта проверяется без ожидания 90 секунд.
 */
function supervisorFixture(options = {}) {
  const calls = [];
  const logs = [];
  const controller = new AbortController();
  const child = options.child ?? new FakeChild();
  const probes = [...(options.probes ?? ['refused', 'refused', 'grigdesk'])];
  const units = [...(options.units ?? ['inactive'])];
  const gates = [...(options.gates ?? [{ code: 0, lastLine: '' }])];
  let now = 0;
  let probeIndex = 0;
  const adapters = {
    async loadRuntime() {
      calls.push('runtime');

      return options.loadRuntime ? options.loadRuntime() : { runtime: RUNTIME };
    },
    /**
     * Возвращает заданную последовательность или управляемую гонку процесса.
     * Индекс считает каждый снимок, включая финальный probe после раннего выхода.
     */
    async probe(signal) {
      calls.push('probe');

      if (options.probe) {
        return options.probe(probeIndex++, child, signal);
      }

      return probes.length > 1 ? probes.shift() : probes[0];
    },
    async unitState() {
      calls.push('unit');

      return units.length > 1 ? units.shift() : units[0];
    },
    async runGate() {
      calls.push('gate');

      return gates.length > 1 ? gates.shift() : gates[0];
    },
    spawnServer() {
      calls.push('spawn');

      return child;
    },
    async sleep(ms, signal) {
      calls.push(`sleep:${ms}`);
      now += ms;

      if (options.sleep) {
        await options.sleep(ms, signal);
      }
    },
    now: () => now,
    log: (message) => logs.push(message),
  };
  const supervisor = createServerSupervisor(adapters);

  return {
    supervisor,
    adapters,
    child,
    calls,
    logs,
    controller,
    run(input = {}) {
      return supervisor.ensure({
        origin: RUNTIME.origin,
        signal: controller.signal,
        deadline: options.deadline ?? 90_000,
        ...input,
      });
    },
  };
}

test('SV-01 таблица decideStart покрывает все строки Р7', () => {
  for (const state of ['active', 'activating', 'reloading', 'deactivating', 'inactive', 'failed', '',
    'unavailable', 'unknown']) {
    assert.equal(decideStart('grigdesk', state), 'connect');
    assert.equal(decideStart('other', state), 'conflict');
    assert.equal(decideStart('no_answer', state), 'wait');
    assert.equal(decideStart('refused', state),
      ['active', 'activating', 'reloading', 'deactivating'].includes(state) ? 'wait' : 'spawn');
  }
});

test('SV-02 готовый внешний сервер не требует runtime, ворот и spawn', async () => {
  const fixture = supervisorFixture({ probes: ['grigdesk'] });

  await fixture.run();

  assert.equal(fixture.supervisor.ownership, 'external');
  assert.equal(fixture.supervisor.generation, 0);
  assert.deepEqual(fixture.calls, ['probe']);
});

test('SV-03 activating и refused ждут службу, затем подключаются к внешнему', async () => {
  const fixture = supervisorFixture({
    probes: ['refused', 'grigdesk'],
    units: ['activating'],
  });

  await fixture.run();

  assert.equal(fixture.supervisor.ownership, 'external');
  assert.deepEqual(fixture.calls, ['probe', 'unit', 'sleep:500', 'probe']);
});

test('SV-04 свободный порт проходит runtime, ворота и повторную проверку перед spawn', async () => {
  const fixture = supervisorFixture();

  await fixture.run();

  assert.equal(fixture.supervisor.ownership, 'owned');
  assert.equal(fixture.supervisor.generation, 1);
  assert.equal(fixture.supervisor.waitReason, null);
  assert.deepEqual(fixture.calls, ['probe', 'unit', 'runtime', 'gate', 'probe', 'unit', 'spawn', 'probe']);
});

test('SV-05 чужой HTTP и срок no_answer дают отказ без запуска и сигналов', async () => {
  const conflict = supervisorFixture({ probes: ['other'] });

  await assert.rejects(conflict.run(), /Порт 9300 занят другой программой/);
  assert.equal(conflict.calls.includes('spawn'), false);
  assert.deepEqual(conflict.child.signals, []);

  const unavailable = supervisorFixture({
    probes: ['no_answer'],
    deadline: 1000,
  });

  await assert.rejects(unavailable.run(), /срок/);
  assert.equal(unavailable.calls.includes('spawn'), false);
  assert.deepEqual(unavailable.child.signals, []);
});

test('SV-06 проблема runtime и несовпадение origin дают точную причину до ворот', async () => {
  const broken = supervisorFixture({
    loadRuntime: () => ({
      problem: 'root',
      message: 'В установке нет сервера.',
    }),
  });

  await assert.rejects(broken.run(), { message: 'В установке нет сервера.' });
  assert.equal(broken.calls.includes('gate'), false);

  const mismatch = supervisorFixture();

  await assert.rejects(mismatch.run({ origin: 'http://127.0.0.1:9400' }), /9400.*порт 9300.*автозапуск/);
  assert.equal(mismatch.calls.includes('gate'), false);
});

test('SV-07 отказ VPN ждёт пять секунд и повторяет проверку, срок сохраняет строку ворот', async () => {
  const fixture = supervisorFixture({
    probes: ['refused', 'refused', 'refused', 'grigdesk'],
    gates: [{ code: 1, lastLine: 'нет туннеля' }, { code: 0, lastLine: '' }],
  });

  await fixture.run();

  assert.ok(fixture.calls.includes('sleep:5000'));
  assert.equal(fixture.calls.filter((call) => call === 'gate').length, 2);
  assert.equal(fixture.supervisor.ownership, 'owned');

  const expired = supervisorFixture({
    probes: ['refused'],
    gates: [{ code: 1, lastLine: 'последняя причина VPN' }],
    deadline: 4000,
  });

  await assert.rejects(expired.run(), /последняя причина VPN/);
  assert.equal(expired.calls.includes('spawn'), false);
});

test('SV-08 ручной сервер после ворот становится внешним без spawn', async () => {
  const fixture = supervisorFixture({ probes: ['refused', 'grigdesk'] });

  await fixture.run();

  assert.equal(fixture.supervisor.ownership, 'external');
  assert.equal(fixture.calls.includes('gate'), true);
  assert.equal(fixture.calls.includes('spawn'), false);
});

test('SV-09 свой процесс вышел до готовности, финальный probe находит внешний', async () => {
  const fixture = supervisorFixture({
    /**
     * Первый ответ после spawn совпадает с ранним выходом своего процесса.
     * Следующий ответ уже принадлежит серверу, который появился независимо от приложения.
     */
    probe(index, child) {
      if (index === 2) {
        child.exit(2);
      }

      return index === 3 ? 'grigdesk' : 'refused';
    },
  });

  await fixture.run();

  assert.equal(fixture.supervisor.ownership, 'external');
  assert.equal(fixture.calls.filter((call) => call === 'probe').length, 4);
  assert.deepEqual(fixture.child.signals, []);
});

test('SV-10 свой процесс вышел до готовности без сервера: отказ с кодом и журналом', async () => {
  const fixture = supervisorFixture({
    probe(index, child) {
      if (index === 2) {
        child.exit(2);
      }

      return 'refused';
    },
  });

  await assert.rejects(fixture.run(), /завершился при запуске.*код 2.*Журнал: \/fixture\/server.log/);
  assert.equal(fixture.supervisor.ownership, 'none');
});

test('SV-11 stop до старта и во время чтения runtime запрещает поздний spawn', async () => {
  const before = supervisorFixture();

  await before.supervisor.stop();
  await assert.rejects(before.run(), /отмен/);
  assert.deepEqual(before.calls, []);

  const entered = Promise.withResolvers();
  const loaded = Promise.withResolvers();
  const fixture = supervisorFixture({
    loadRuntime() {
      entered.resolve();

      return loaded.promise;
    },
  });
  const starting = assert.rejects(fixture.run(), /отмен/);

  await entered.promise;
  await fixture.supervisor.stop();
  loaded.resolve({ runtime: RUNTIME });
  await starting;
  assert.equal(fixture.calls.includes('spawn'), false);
  assert.equal(fixture.calls.includes('gate'), false);
});

test('SV-11 stop во время готовности гасит появившийся свой процесс и отменяет ожидание', async () => {
  const entered = Promise.withResolvers();
  const ready = Promise.withResolvers();
  const fixture = supervisorFixture({
    probe(index) {
      if (index === 2) {
        entered.resolve();

        return ready.promise;
      }

      return 'refused';
    },
  });

  fixture.child.kill = (signal) => {
    fixture.child.signals.push(signal);
    fixture.child.exit(0);

    return true;
  };

  const starting = assert.rejects(fixture.run(), /отмен/);

  await entered.promise;
  await fixture.supervisor.stop();
  ready.resolve('grigdesk');
  await starting;
  assert.deepEqual(fixture.child.signals, ['SIGTERM']);
  assert.equal(fixture.supervisor.ownership, 'none');
});

test('SV-11 срок обрывает зависший runtime и отсекает его позднее завершение', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const entered = Promise.withResolvers();
  const loaded = Promise.withResolvers();
  const fixture = supervisorFixture({
    deadline: 100,
    loadRuntime() {
      entered.resolve();

      return loaded.promise;
    },
  });
  const observed = fixture.run().then(() => 'успех', (error) => error.message);

  await entered.promise;
  fixture.adapters.now = () => 100;
  t.mock.timers.tick(100);
  await new Promise((resolve) => setImmediate(resolve));

  let timer;
  const outcome = await Promise.race([
    observed,
    new Promise((resolve) => {
      timer = setImmediate(() => resolve('ожидание не отменилось'));
    }),
  ]);

  clearImmediate(timer);
  loaded.resolve({ runtime: RUNTIME });
  await observed;
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(outcome, /срок/);
  assert.equal(fixture.calls.includes('gate'), false);
  assert.equal(fixture.calls.includes('spawn'), false);
});

test('SV-12 два stop ждут одно завершение и посылают один SIGTERM, external не трогают', async () => {
  const fixture = supervisorFixture();

  fixture.child.kill = (signal) => {
    fixture.child.signals.push(signal);
    fixture.child.exit(0);

    return true;
  };

  await fixture.run();

  const first = fixture.supervisor.stop();
  const second = fixture.supervisor.stop();

  assert.equal(second, first);
  await first;
  assert.deepEqual(fixture.child.signals, ['SIGTERM']);

  const external = supervisorFixture({ probes: ['grigdesk'] });

  await external.run();
  await external.supervisor.stop();
  assert.deepEqual(external.child.signals, []);
});

test('SV-13 бюджет слива приводит к SIGKILL только для ещё живого своего процесса', async () => {
  const fixture = supervisorFixture();

  fixture.child.kill = (signal) => {
    fixture.child.signals.push(signal);

    if (signal === 'SIGKILL') {
      fixture.child.exit(null, signal);
    }

    return true;
  };

  await fixture.run();
  await fixture.supervisor.stop();
  assert.deepEqual(fixture.child.signals, ['SIGTERM', 'SIGKILL']);
  assert.ok(fixture.calls.includes('sleep:45000'));

  const exited = supervisorFixture();

  await exited.run();
  exited.child.exit(0);
  await exited.supervisor.stop();
  assert.deepEqual(exited.child.signals, []);

  let gracefulChild;
  const graceful = supervisorFixture({
    sleep() {
      gracefulChild.exit(0);
    },
  });

  gracefulChild = graceful.child;

  await graceful.run();
  await graceful.supervisor.stop();
  assert.deepEqual(graceful.child.signals, ['SIGTERM']);
});

test('SV-14 код 75 проходит новый конвейер и читает runtime, во время stop не перезапускается', async () => {
  const fixture = supervisorFixture();

  await fixture.run();

  const second = new FakeChild();
  const probes = ['refused', 'refused', 'grigdesk'];
  const newRuntime = {
    ...RUNTIME,
    env: { RELOADED: 'новые настройки' },
  };

  fixture.adapters.probe = async () => {
    fixture.calls.push('probe');

    return probes.shift() ?? 'grigdesk';
  };
  fixture.adapters.loadRuntime = async () => {
    fixture.calls.push('runtime');

    return { runtime: newRuntime };
  };
  fixture.adapters.spawnServer = (runtime) => {
    fixture.calls.push('spawn');
    assert.equal(runtime, newRuntime);

    return second;
  };
  fixture.child.exit(75);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(fixture.supervisor.generation, 2);
  assert.equal(fixture.supervisor.ownership, 'owned');
  assert.equal(fixture.calls.filter((call) => call === 'gate').length, 2);
  assert.equal(fixture.calls.filter((call) => call === 'runtime').length, 2);
  fixture.child.pid = undefined;
  fixture.child.emit('error', new Error('поздняя ошибка старого поколения'));
  assert.equal(fixture.supervisor.ownership, 'owned');

  second.kill = (signal) => {
    second.signals.push(signal);
    second.exit(75);

    return true;
  };

  await fixture.supervisor.stop();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.supervisor.generation, 2);
  assert.equal(fixture.calls.filter((call) => call === 'spawn').length, 2);
});

test('SV-14 отказ нового поколения пишется в log без повторного старта', async () => {
  const fixture = supervisorFixture();

  await fixture.run();

  fixture.adapters.probe = async () => 'refused';
  fixture.adapters.loadRuntime = async () => ({
    problem: 'root',
    message: 'Новая установка недоступна.',
  });
  fixture.child.exit(75);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(fixture.logs.length, 1);
  assert.match(fixture.logs[0], /Новая установка недоступна/);
  assert.equal(fixture.supervisor.ownership, 'none');
});

test('SV-15 другой exit не перезапускает процесс, поздний сервер становится external', async () => {
  for (const code of [0, 1]) {
    const fixture = supervisorFixture();

    await fixture.run();
    fixture.child.exit(code);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fixture.supervisor.ownership, 'none');
    assert.equal(fixture.calls.filter((call) => call === 'spawn').length, 1);

    fixture.adapters.probe = async () => 'grigdesk';

    await fixture.run();
    assert.equal(fixture.supervisor.ownership, 'external');
    await fixture.supervisor.stop();
    assert.deepEqual(fixture.child.signals, []);
  }
});

test('SV-15 close и error с pid сохраняют владение, error без pid завершает его', async () => {
  const fixture = supervisorFixture();

  await fixture.run();
  fixture.child.emit('close', 0, null);
  fixture.child.emit('error', new Error('ошибка сигнала с живым pid'));
  assert.equal(fixture.supervisor.ownership, 'owned');

  const failed = supervisorFixture();

  await failed.run();
  failed.child.pid = undefined;
  failed.child.emit('error', new Error('процесс не создан'));
  assert.equal(failed.supervisor.ownership, 'none');
  await failed.supervisor.stop();
  assert.deepEqual(failed.child.signals, []);
});

test('SV-16 недоступный systemd позволяет использовать HTTP или запустить свой сервер', async () => {
  for (const probes of [['grigdesk'], ['refused', 'refused', 'grigdesk']]) {
    const fixture = supervisorFixture({
      probes,
      units: ['unavailable'],
    });

    await fixture.run();

    assert.equal(fixture.supervisor.ownership, probes.length === 1 ? 'external' : 'owned');
  }
});

test('SV-17 настоящий Node запускается и останавливается, соседний сервер остаётся жив (нестабильный)', {
  timeout: 60_000,
}, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-supervisor-node-'));
  const port = await freePort();
  const peer = createServer((_request, response) => {
    response.end('соседняя фикстура');
  });
  let child;
  let exited;
  let supervisor;

  t.after(async () => {
    await supervisor?.stop();

    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await exited;
    }

    if (peer.listening) {
      await new Promise((resolve) => peer.close(resolve));
    }

    await rm(root, { recursive: true, force: true });
  });

  await new Promise((resolve) => peer.listen(0, '127.0.0.1', resolve));
  await mkdir(path.join(root, 'server/src'), { recursive: true });
  await mkdir(path.join(root, 'deploy'));
  await writeFile(path.join(root, 'server/package.json'), '{"type":"module"}\n');
  await writeFile(path.join(root, 'server/src/app.ts'), [
    "import { createServer } from 'node:http';",
    '',
    '// Фикстура отвечает схемой auth/state только на своём порту.',
    '// Штатный сигнал закрывает HTTP и завершает именно этот процесс.',
    'const server = createServer((request, response) => {',
    "  if (request.url !== '/api/auth/state') {",
    '    response.writeHead(404);',
    '    response.end();',
    '    return;',
    '  }',
    '',
    "  response.writeHead(200, { 'content-type': 'application/json' });",
    '  response.end(JSON.stringify({',
    '    configured: true,',
    '    authenticated: false,',
    '  }));',
    '});',
    '',
    "server.listen(Number(process.env.GRIGDESK_PORT), '127.0.0.1');",
    "process.once('SIGTERM', () => {",
    '  server.close(() => process.exit(0));',
    '});',
    '',
  ].join('\n'));
  await writeFile(path.join(root, 'deploy/require-vpn.sh'), '#!/usr/bin/env bash\nexit 0\n');

  const runtime = {
    ...RUNTIME,
    root,
    node: process.execPath,
    serverCommand: process.execPath,
    serverArgs: [path.join(root, 'server/src/app.ts')],
    port,
    origin: `http://127.0.0.1:${port}`,
    env: {
      PATH: '/usr/bin:/bin',
      GRIGDESK_PORT: String(port),
    },
    logPath: path.join(root, 'server.log'),
  };

  supervisor = createServerSupervisor({
    loadRuntime: async () => ({ runtime }),
    probe: (signal) => probeGrigDesk(runtime.origin, {
      signal,
      timeoutMs: 500,
    }),
    unitState: async () => 'unavailable',
    runGate: (selected, signal) => runVpnGate(selected, signal),
    spawnServer(selected) {
      const fd = openServerLog(selected.logPath);

      try {
        child = spawnServer(selected, fd);
        exited = once(child, 'exit');

        return child;
      } finally {
        closeSync(fd);
      }
    },
    sleep: (ms, signal) => waitFor(ms, undefined, { signal }),
    now: () => Date.now(),
    log: (message) => assert.fail(message),
  });

  await supervisor.ensure({
    origin: runtime.origin,
    signal: new AbortController().signal,
    deadline: Date.now() + 10_000,
  });
  assert.equal(supervisor.ownership, 'owned');
  await supervisor.stop();
  assert.deepEqual(await exited, [0, null]);
  assert.equal(await probeGrigDesk(runtime.origin), 'refused');

  const response = await fetch(`http://127.0.0.1:${peer.address().port}`, {
    signal: AbortSignal.timeout(1000),
  });

  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'соседняя фикстура');
});

test('SV-18 строка ворот со своим префиксом «VPN-ворота:» не дублирует его в причине ожидания', async () => {
  const reasons = [];
  const fixture = supervisorFixture({
    probes: ['refused', 'refused', 'refused', 'grigdesk'],
    gates: [
      {
        code: 1,
        lastLine: 'VPN-ворота: нет маршрута до 1.1.1.1 — запуск запрещён',
      },
      {
        code: 0,
        lastLine: '',
      },
    ],
    sleep: async (ms) => {
      if (ms === 5000) {
        reasons.push(fixture.supervisor.waitReason);
      }
    },
  });

  await fixture.run();
  assert.deepEqual(reasons, ['VPN-ворота: нет маршрута до 1.1.1.1 — запуск запрещён']);

  const bare = supervisorFixture({
    probes: ['refused'],
    gates: [
      {
        code: 1,
        lastLine: 'нет туннеля',
      },
    ],
    deadline: 4000,
  });

  await assert.rejects(bare.run(), /VPN-ворота: нет туннеля/u);
});
