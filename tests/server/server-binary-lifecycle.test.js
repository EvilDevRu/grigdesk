import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { constants } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { build } from '../../server/node_modules/esbuild/lib/main.js';
import { runLauncherWorker, workerEnvironment } from '../../server/src/binary/worker.ts';
import { runServerBinary } from '../../server/src/binary/main.ts';
import { createServerManifest, serverManifestBytes } from '../../server/src/binary/metadata.ts';

const source = path.resolve(import.meta.dirname, '../..');

const payload = {
  entries: [],
  size: 22,
  sha256: 'a'.repeat(64),
};
const manifest = createServerManifest(payload, {
  launcherSha256: 'b'.repeat(64),
  engineSha256: 'c'.repeat(64),
  buildInputs: {},
});
const assets = {
  manifest: () => ({ bytes: serverManifestBytes(manifest), packageId: manifest.packageId }),
  license: () => 'fixture NODE license',
  archive: function* () {},
};

test('SB21: metadata/argv не вычисляют D/HOME/cache и не читают ZIP', async () => {
  let output = '';
  const forbidden = () => {
    throw new Error('metadata вызвала fs port');
  };
  const input = {
    assets: { ...assets, archive: forbidden },
    home: forbidden,
    binary: forbidden,
    writeOut: (text) => {
      output += text;
    },
    writeError: () => {},
  };

  assert.equal(await runServerBinary(['--runtime-info', '--json'], input), 0);
  assert.equal(JSON.parse(output || '{}').packageId, manifest.packageId);
  assert.equal(output.includes('entries'), false);
  output = '';
  assert.equal(await runServerBinary(['--license'], input), 0);
  assert.equal(output, 'fixture NODE license\n');
  assert.equal(await runServerBinary(['--eval', 'bad'], {
    ...input, assets: { ...assets, manifest: forbidden },
  }), 2);
});

test('SB21: .env CA до spawn, packaged PATH и lease owners до запуска worker', async (t) => {
  const options = await fixture(t, 'fixture');
  const data = path.join(options.cwd, 'data');
  const root = path.join(data, 'runtimes/server/packages', manifest.packageId);
  const calls = [];
  const owner = { pid: process.pid, starttime: 'fixture' };
  const lease = {
    format: 1,
    packageId: manifest.packageId,
    kind: 'server',
    token: '11111111-2222-4333-8444-555555555555',
    owners: [owner],
  };

  await mkdir(data, { mode: 0o700 });
  await writeFile(path.join(data, '.env'), 'NODE_EXTRA_CA_CERTS=/fixture/CA.pem\nNODE_OPTIONS=bad\n');

  const code = await runServerBinary([], {
    assets,
    env: {
      HOME: options.cwd,
      GRIGDESK_HOME: data,
      GRIGDESK_DESKTOP_CHILD: '1',
    },
    home: () => options.cwd,
    binary: () => options.binary,
    cwd: () => options.cwd,
    externalParent: false,
    leases: {
      materializeWithLease: async () => {
        calls.push('lease');

        return { root, lease };
      },
      addRuntimeLeaseOwner: async () => {
        calls.push('worker-owner');

        return { ...lease, owners: [...lease.owners, { pid: 1234, starttime: 'fixture' }] };
      },
      readProcessOwner: async (pid) => ({ pid, starttime: 'fixture' }),
      releaseRuntimeLeaseOwner: async () => {
        calls.push('release');
      },
    },
    worker: async (input) => {
      assert.equal(input.env.NODE_EXTRA_CA_CERTS, '/fixture/CA.pem');
      assert.equal(input.env.NODE_OPTIONS, undefined);
      assert.equal(input.env.GRIGDESK_DESKTOP_CHILD, undefined);
      assert.equal(input.env.PATH.split(':')[0], path.dirname(options.binary));
      await input.onSpawn({ pid: 1234 });
      calls.push('worker-start');

      return {
        code: 75,
        stdout: '',
        stderr: '',
      };
    },
    writeOut: () => {},
    writeError: () => {},
  });

  assert.equal(code, 75);
  assert.deepEqual(calls, ['lease', 'worker-owner', 'worker-start', 'release', 'release']);
});

/**
 * Worker работает настоящим ordinary Node из R, без запуска полной сборки ELF.
 * Fixture имеет отдельные cwd, HOME и payload, не наследует настоящее окружение.
 */
async function fixture(t, contents) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'server-worker-'));
  const root = path.join(temporary, 'payload with space');
  const node = path.join(root, 'runtime/node/bin/node');
  const entry = path.join(root, 'server/payload.cjs');
  const binary = path.join(temporary, 'installation/bin/server elf');

  t.after(() => rm(temporary, { recursive: true, force: true }));
  await mkdir(path.dirname(node), { recursive: true });
  await mkdir(path.dirname(entry), { recursive: true });
  await mkdir(path.dirname(binary), { recursive: true });
  await copyFile(process.execPath, node, constants.COPYFILE_FICLONE);
  await writeFile(binary, 'fixture ELF');
  await writeFile(entry, contents);
  await build({
    absWorkingDir: source,
    entryPoints: ['server/src/binary/workerBootstrap.ts'],
    outfile: path.join(root, 'server/worker-bootstrap.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    logLevel: 'silent',
  });

  return {
    root,
    binary,
    cwd: temporary,
    env: { PATH: '', HOME: temporary },
    capture: true,
  };
}

test('SB21: ordinary Node получает argv/cwd/env, все exit codes сохраняются', async (t) => {
  for (const code of [0, 75, 78, 1]) {
    const options = await fixture(t, [
      'exports.startPayloadServer = async (binary) => {',
      '  console.log(JSON.stringify({node:process.execPath,argv:process.argv,cwd:process.cwd(),',
      '    path:process.env.PATH,coverage:process.env.NODE_V8_COVERAGE,binary}));',
      `  process.exitCode = ${code};`,
      '};',
    ].join('\n'));
    const result = await runLauncherWorker(options);

    assert.equal(result.code, code);

    const details = JSON.parse(result.stdout || '{}');

    assert.equal(details.node, path.join(options.root, 'runtime/node/bin/node'));
    assert.deepEqual(details.argv, [details.node, path.join(options.root, 'server/payload.cjs')]);
    assert.equal(details.cwd, options.cwd);
    assert.equal(details.binary, options.binary);
    assert.equal(details.coverage, '');
    assert.equal(details.path, '');
  }
});

test('SB21: loader inputs очищены, NODE_EXTRA_CA_CERTS сохранён', () => {
  const env = workerEnvironment({
    PATH: '',
    NODE_OPTIONS: '--require=/fixture/injected.cjs',
    NODE_PATH: '/fixture/modules',
    NODE_COMPILE_CACHE: '/fixture/cache',
    NODE_REDIRECT_WARNINGS: '/fixture/warnings',
    OPENSSL_CONF: '/fixture/openssl',
    NODE_V8_COVERAGE: '/fixture/coverage',
    NODE_EXTRA_CA_CERTS: '/fixture/CA.pem',
  });

  assert.equal(env.NODE_EXTRA_CA_CERTS, '/fixture/CA.pem');
  assert.equal(env.NODE_V8_COVERAGE, '');

  for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'NODE_COMPILE_CACHE',
    'NODE_REDIRECT_WARNINGS', 'OPENSSL_CONF']) {
    assert.equal(env[name], undefined);
  }
});

test('SB21: потерянный parent до spawn не оставляет worker', async () => {
  let spawned = 0;
  const result = await runLauncherWorker({
    root: '/missing',
    binary: '/missing',
    cwd: '/',
    env: {},
    externalParent: true,
    parentAlive: () => false,
    onSpawn: async () => {
      spawned += 1;
    },
  });

  assert.equal(result.code, 0);
  assert.equal(spawned, 0);
});

/**
 * Launcher fixture пересылает IPC настоящего worker, не подменяя lifecycle порт.
 * Готовность означает занятый loopback port и собственный lock, cleanup проверяет оба.
 */
async function runningFixture(t) {
  const options = await fixture(t, [
    'const fs = require("node:fs");',
    'const net = require("node:net");',
    'const {spawn} = require("node:child_process");',
    'exports.startPayloadServer = async () => {',
    '  const lock = process.cwd() + "/worker.lock";',
    '  const signals = process.cwd() + "/signals";',
    '  fs.writeFileSync(lock, String(process.pid));',
    '  const server = net.createServer();',
    '  const factory = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"],',
    '    {detached:true,stdio:"ignore",env:{PATH:""}});',
    '  factory.unref();',
    '  const stop = (signal) => {',
    '    fs.appendFileSync(signals, signal + "\\n");',
    '    fs.unlinkSync(lock);',
    '    server.close(() => process.exit(0));',
    '  };',
    '  process.on("SIGTERM", () => stop("SIGTERM"));',
    '  process.on("SIGINT", () => stop("SIGINT"));',
    '  server.listen(0, "127.0.0.1", () => {',
    '    process.send({type:"fixture-ready",pid:process.pid,',
    '      port:server.address().port,factory:factory.pid});',
    '  });',
    '};',
  ].join('\n'));
  const runner = path.join(options.cwd, 'runner.mjs');
  const module = path.join(source, 'server/src/binary/worker.ts');

  await writeFile(runner, [
    `import { runLauncherWorker } from ${JSON.stringify(module)};`,
    `const options = ${JSON.stringify({ ...options, externalParent: true })};`,
    'const result = await runLauncherWorker(options);',
    'process.exitCode = result.code;',
  ].join('\n'));

  const child = spawn(process.execPath, [runner], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { PATH: '' },
  });
  const closed = once(child, 'exit');

  t.after(() => child.kill('SIGKILL'));
  child.stderr.on('data', (bytes) => t.diagnostic(bytes.toString()));

  const [ready] = await once(child, 'message');

  assert.equal(ready.type, 'fixture-ready');
  t.after(() => {
    for (const pid of [ready.pid, ready.factory]) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
  });

  return {
    options,
    child,
    ready,
    closed,
  };
}

/**
 * Ограниченное ожидание относится только к собственному fixture lock.
 * Живые процессы машины и их состояние тест не рассматривает.
 */
async function waitCleanup(file) {
  const deadline = Date.now() + 5000;

  while (Date.now() < deadline) {
    if (await readFile(file).then(() => false, () => true)) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  assert.fail('worker lock не снят после потери launcher');
}

test('SB21: TERM/INT пересылаются один раз, disconnect и SIGKILL launcher закрывают worker',
  { timeout: 15000 }, async (t) => {
    for (const action of ['SIGTERM', 'SIGINT', 'disconnect', 'SIGKILL']) {
      t.diagnostic(`fixture action=${action}`);

      const item = await runningFixture(t);

      if (action === 'disconnect') {
        item.child.disconnect();
      } else {
        item.child.kill(action);
      }

      await Promise.race([
        item.closed,
        new Promise((_resolve, reject) => {
          const timer = setTimeout(async () => {
            const signals = await readFile(path.join(item.options.cwd, 'signals'), 'utf8')
              .catch(() => 'missing');

            reject(new Error(`launcher не завершился: ${action}, signals=${signals}`));
          }, 3000);

          timer.unref();
        }),
      ]);
      await waitCleanup(path.join(item.options.cwd, 'worker.lock'));

      const signals = await readFile(path.join(item.options.cwd, 'signals'), 'utf8');

      assert.equal(signals, `${action === 'SIGINT' ? 'SIGINT' : 'SIGTERM'}\n`);
      assert.doesNotThrow(() => process.kill(item.ready.factory, 0),
        'detached фабрика должна пережить сервер');
    }
  });

test('SB21: production deadline остановки не сокращается ниже 45 секунд', async () => {
  await assert.rejects(runLauncherWorker({
    root: '/missing',
    binary: '/missing',
    env: {},
    cwd: '/',
    stopGraceMs: 1,
  }), /45000/);
});

test('SB21-G: adoption/ACK/worker owner упорядочены, release A не читает assets B', async (t) => {
  const options = await fixture(t, 'fixture');
  const data = path.join(options.cwd, 'data');
  const root = path.join(data, 'runtimes/server/packages', manifest.packageId);
  const calls = [];
  const token = '11111111-2222-4333-8444-555555555555';
  const launcher = { pid: process.pid, starttime: 'fixture' };
  const lease = {
    format: 1,
    kind: 'server',
    packageId: manifest.packageId,
    token,
    owners: [launcher],
  };
  const input = {
    assets,
    env: { HOME: options.cwd, GRIGDESK_HOME: data },
    home: () => options.cwd,
    binary: () => options.binary,
    cwd: () => options.cwd,
    externalParent: true,
    parentAlive: () => true,
    send: async (message) => {
      assert.deepEqual(message, {
        type: 'grigdesk:preparation-adopted',
        packageId: manifest.packageId,
        token,
      });
      calls.push('ack');
    },
    leases: {
      adoptPreparation: async () => {
        calls.push('adopt');

        return lease;
      },
      addRuntimeLeaseOwner: async () => {
        calls.push('owner');

        return { ...lease, owners: [...lease.owners, { pid: 1234, starttime: 'fixture' }] };
      },
      readProcessOwner: async (pid) => ({ pid, starttime: 'fixture' }),
      releaseRuntimeLeaseOwner: async (location) => {
        calls.push(`release:${location.packageId}`);
      },
    },
    materialize: async () => {
      calls.push('verified');

      return root;
    },
    worker: async (worker) => {
      assert.equal(worker.env.GRIGDESK_DESKTOP_CHILD, '1');
      await worker.onSpawn({ pid: 1234 });
      calls.push('start');

      return {
        code: 78,
        stdout: '',
        stderr: '',
      };
    },
    writeOut: () => {},
    writeError: (message) => assert.fail(message),
  };

  assert.equal(await runServerBinary(['--expect-package-id', manifest.packageId,
    '--preparation-token', token], input), 78);
  assert.deepEqual(calls, ['adopt', 'ack', 'verified', 'owner', 'start',
    `release:${manifest.packageId}`, `release:${manifest.packageId}`]);
  calls.length = 0;

  const oldId = '3'.repeat(64);

  assert.equal(await runServerBinary(['--release-preparation', token, '--package-id', oldId, '--json'], {
    ...input,
    assets: { ...assets, manifest: () => assert.fail('release читает assets B') },
  }), 0);
  assert.deepEqual(calls, [`release:${oldId}`]);
});

test('SB21-GC: default manual prune подключён к A без boot/ZIP', async (t) => {
  const options = await fixture(t, 'fixture');
  const data = path.join(options.cwd, 'data');
  let output = '';

  const code = await runServerBinary(['--cache-prune', '--json'], {
    assets: { ...assets, archive: () => assert.fail('prune читает ZIP') },
    env: { HOME: options.cwd, GRIGDESK_HOME: data },
    home: () => options.cwd,
    binary: () => options.binary,
    worker: () => assert.fail('prune запускает worker'),
    writeOut: (text) => {
      output += text;
    },
    writeError: () => {},
  });

  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(output), {
    deleted: [],
    retained: [],
    unknown: [],
  });
});

test('SB21: настоящий desktop shutdown получает один запрос при разрыве IPC', async (t) => {
  const parentModule = path.join(source, 'server/src/lib/desktopParent.ts');
  const shutdownModule = path.join(source, 'server/src/lib/shutdown.ts');
  const options = await fixture(t, [
    `const {attachDesktopParent} = require(${JSON.stringify(parentModule)});`,
    `const {createShutdownCoordinator} = require(${JSON.stringify(shutdownModule)});`,
    'exports.startPayloadServer = async () => {',
    '  const timer = setInterval(() => {}, 1000);',
    '  const parent = attachDesktopParent({env:process.env,channel:process,exit:process.exit});',
    '  const shutdown = createShutdownCoordinator({',
    '    timeoutMs:1000,',
    '    close: async () => {',
    '      await new Promise((resolve) => setTimeout(resolve, 25));',
    '      clearInterval(timer);',
    '    },',
    '  });',
    '  parent.bindShutdown((reason) => shutdown.begin(reason));',
    '  shutdown.arm();',
    '  process.send({type:"fixture-ready",pid:process.pid});',
    '};',
  ].join('\n'));
  const runner = path.join(options.cwd, 'desktop-runner.mjs');

  await writeFile(runner, [
    `import {runLauncherWorker} from ${JSON.stringify(path.join(source, 'server/src/binary/worker.ts'))};`,
    `const options = ${JSON.stringify(options)};`,
    'options.externalParent = true;',
    'options.env.GRIGDESK_DESKTOP_CHILD = "1";',
    'process.exitCode = (await runLauncherWorker(options)).code;',
  ].join('\n'));

  const child = spawn(process.execPath, [runner], {
    env: { PATH: '' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const exited = once(child, 'exit');

  t.after(() => child.kill('SIGKILL'));

  const [ready] = await once(child, 'message');

  t.after(() => {
    try {
      process.kill(ready.pid, 'SIGKILL');
    } catch {}
  });
  child.disconnect();

  const [code] = await exited;

  assert.equal(code, 0, 'bootstrap не дублирует desktop disconnect сигналом SIGTERM');
});

test('SB21: запрещённый D в .env отказывает78 до ordinary Node', async (t) => {
  const options = await fixture(t, 'fixture');
  const data = path.join(options.cwd, '.grigdesk');
  const root = path.join(data, 'runtimes/server/packages', manifest.packageId);
  let workerHome;
  let failure;

  await mkdir(data, { mode: 0o700 });
  await writeFile(path.join(data, '.env'), 'GRIGDESK_HOME=/fixture/other-data\n');

  const code = await runServerBinary([], {
    assets,
    env: { HOME: options.cwd },
    home: () => options.cwd,
    binary: () => options.binary,
    externalParent: false,
    recordUsage: async () => {},
    leases: {
      materializeWithLease: async () => ({
        root,
        lease: {
          format: 1,
          kind: 'server',
          packageId: manifest.packageId,
          token: '11111111-2222-4333-8444-555555555555',
          owners: [{ pid: process.pid, starttime: 'fixture' }],
        },
      }),
      releaseRuntimeLeaseOwner: async () => {},
    },
    worker: async (input) => {
      workerHome = input.env.GRIGDESK_HOME;

      return {
        code: 0,
        stdout: '',
        stderr: '',
      };
    },
    writeError: (message) => {
      failure = message;
    },
  });

  assert.equal(code, 78);
  assert.equal(workerHome, undefined);
  assert.match(failure, /Ключ GRIGDESK_HOME запрещён/);
});

test('SB21-G: prepare фиксирует PID coordinator до асинхронного materialize', async (t) => {
  const options = await fixture(t, 'fixture');
  const data = path.join(options.cwd, 'data');
  const root = path.join(data, 'runtimes/server/packages', manifest.packageId);
  let owner;
  let output = '';

  const code = await runServerBinary(['--prepare', '--json'], {
    assets,
    env: { HOME: options.cwd, GRIGDESK_HOME: data },
    home: () => options.cwd,
    binary: () => options.binary,
    recordUsage: async () => {},
    leases: {
      materializeWithLease: async (_extraction, options) => {
        owner = options;

        return {
          root,
          lease: { token: '11111111-2222-4333-8444-555555555555' },
        };
      },
    },
    writeOut: (text) => {
      output += text;
    },
    writeError: (message) => assert.fail(message),
  });

  assert.equal(code, 0);
  assert.equal(owner.kind, 'prepare');
  assert.equal(owner.ownerPid, process.ppid, 'родитель не определяется заново после распаковки');
  assert.equal(JSON.parse(output).packageId, manifest.packageId);
});
