import assert from 'node:assert/strict';
import { closeSync } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { createClientRuntime } from '../../../desktop/src/clientRuntime.ts';
import { createPortableRuntime } from '../../../desktop/src/portableRuntime.ts';
import { loadServerRuntime, runtimeDependencies } from '../../../desktop/src/runtimeConfig.ts';
import { createServerSupervisor } from '../../../desktop/src/serverSupervisor.ts';
import { openServerLog, spawnServer } from '../../../desktop/src/serverProcess.ts';
import { Profiles } from '../../../desktop/src/profiles.ts';
import { readSettings, writeSettings } from '../../../desktop/src/settings.ts';
import { createShellApi } from '../../../desktop/src/pipe/shellApi.ts';
import { desktopRuntimePath } from '../../../shared/desktop/desktopRuntime.ts';
import { probeGrigDesk } from '../../../shared/runtime/grigDeskReadiness.ts';
import { processStarttime } from '../../../server/src/lib/dataHomeBoot.ts';

const input = JSON.parse(process.argv[2]);
const env = { ...process.env };
const home = env.HOME;
const settingsFile = '/D/userData/settings.json';
const runtimePath = desktopRuntimePath({ env, home });
const settings = await readSettings(settingsFile);
const profiles = new Profiles({ settings, save: () => writeSettings(settingsFile, settings) });
const notices = [];
const processes = [];
let supervisor;
let origin;
let shellServer;
let shell;
let client;

/**
 * Адрес берётся из той же D/.env, которую затем читает настоящий runtimeConfig.
 * Случайный порт выбирается внутри namespace, без обращения к владельцу машины.
 */
async function configurePort() {
  try {
    await fs.stat('/D/.env');

    return;
  } catch (error) {
    assert.equal(error.code, 'ENOENT');
  }

  const reserve = http.createServer();

  await new Promise((resolve) => reserve.listen(0, '127.0.0.1', resolve));

  const port = reserve.address().port;

  await new Promise((resolve) => reserve.close(resolve));
  await fs.writeFile('/D/.env', `GRIGDESK_PORT=${port}\nGRIGDESK_HOST=127.0.0.1\n`);
}

/**
 * Проверяется настоящий путь запуска и /proc ребёнка, а не только совпавший HTTP origin.
 * Каждый ручной переход создаёт новый supervisor, поскольку stop предыдущего терминален.
 */
async function start(binary) {
  const inspected = await loadServerRuntime({
    purpose: 'inspect',
    env,
    home,
    deps: runtimeDependencies,
    bundledUi: true,
  });

  assert.ok('inspection' in inspected);
  origin = inspected.inspection.origin;
  supervisor = createServerSupervisor({
    loadRuntime: ({ purpose }) => loadServerRuntime({
      purpose,
      env,
      home,
      deps: runtimeDependencies,
      bundledUi: true,
    }),
    probe: (signal) => probeGrigDesk(origin, { signal }),
    unitState: async () => 'inactive',
    runGate: async () => ({ code: 0, lastLine: '' }),
    spawnServer(runtime) {
      assert.equal(runtime.serverCommand, binary);

      const fd = openServerLog(runtime.logPath);

      try {
        const child = spawnServer(runtime, fd);

        processes.push({ child, binary });

        return child;
      } finally {
        closeSync(fd);
      }
    },
    sleep: (ms, signal) => delay(ms, undefined, { signal }),
    now: () => Date.now(),
    log: (message) => process.stderr.write(message + '\n'),
  });
  await supervisor.ensure({
    origin,
    signal: new AbortController().signal,
    deadline: Date.now() + 180000,
  });
  assert.equal(supervisor.ownership, 'owned');

  const current = processes.at(-1);

  assert.equal(await fs.realpath(`/proc/${current.child.pid}/exe`), binary);
  assert.equal(await probeGrigDesk(origin), 'grigdesk');
}

/**
 * Настоящий shell HTTP-router выполняет private hook до записи выбранного профиля.
 * Никаких сетевых транспортов старого UI этот headless driver не подменяет.
 */
async function selectThroughShell(coordinator, id) {
  if (!shellServer) {
    shell = createShellApi({
      profiles,
      pairing: { addByPairing: async () => assert.fail('pairing не нужен') },
      localAvailable: () => true,
      localAddress: () => origin,
      beforeSelect: (profile) => coordinator.activate(profile),
      navigate: async () => {},
      upstream: () => ({
        request() {},
        upgrade() {},
        close() {},
        probe: async () => {},
      }),
    });
    shellServer = http.createServer((req, res) => shell.handle(req, res));
    await new Promise((resolve) => shellServer.listen(0, '127.0.0.1', resolve));
  }

  return fetch(`http://127.0.0.1:${shellServer.address().port}/__shell/select`, {
    method: 'POST',
    body: JSON.stringify({ id }),
  });
}

await configurePort();

for (const hidden of [input.checkout, input.ownerHome]) {
  await assert.rejects(fs.stat(hidden), { code: 'ENOENT' });
}

await fs.mkdir(home, { recursive: true });
await fs.mkdir('/D/chats', { recursive: true });

const history = '/D/chats/portable-sentinel';

if (input.mode === 'cold' || input.mode === 'existing') {
  await fs.writeFile(history, 'история и вложения остаются в D');
}

if (input.mode === 'existing') {
  await fs.mkdir(path.dirname(runtimePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(runtimePath, JSON.stringify({
    version: 4,
    kind: 'binary',
    binary: '/A/bin/grigdesk-server',
    home: '/D',
    cliPaths: [],
  }));
  await fs.writeFile(path.join(path.dirname(runtimePath), 'runtime-version'), '4\n');

  const local = await profiles.add({
    kind: 'local',
    name: 'Прежний настоящий сервер',
    address: 'http://127.0.0.1',
    fp: null,
  });

  await profiles.select(local.id);
  await start('/A/bin/grigdesk-server');
}

const coordinator = createPortableRuntime({
  isPackaged: true,
  execPath: '/tmp/.mount_GrigDesk/usr/grigdesk',
  env: { ...env, APPIMAGE: `${input.mount}/GrigDesk` },
  home,
  profiles,
  ownsServer: () => supervisor?.ownership === 'owned',
  startServer: start,
  stopServer: async () => supervisor?.stop(),
  notify: async (message) => notices.push(message),
  report: () => {},
});

try {
  const previous = input.mode === 'existing' ? await fs.readFile(runtimePath, 'utf8') : null;
  const previousId = settings.selected;
  const inspection = await coordinator.discover();

  assert.equal(inspection.localAvailable, true);

  if (input.mode === 'existing') {
    assert.equal(await fs.readFile(runtimePath, 'utf8'), previous);
    assert.equal(settings.selected, previousId);
    assert.equal(processes.length, 1);

    const candidate = settings.profiles.find((profile) =>
      profile.serverBinary === `${input.mount}/bin/grigdesk-server`);

    assert.ok(candidate);
    assert.equal((await selectThroughShell(coordinator, candidate.id)).status, 200);
    assert.equal(settings.selected, candidate.id);
  } else {
    let preparing;

    client = createClientRuntime({
      settings,
      save: () => writeSettings(settingsFile, settings),
      uiDir: '/suite',
      secret: 'portable-acceptance-only',
      identity: { load: async () => assert.fail('cold local не читает remote identity') },
      identityDirectory: '/D/identity',
      localAvailable: () => inspection.localAvailable,
      localAddress: () => inspection.address,
      windowKey: async () => '',
      prepareLocal: (profile) => {
        preparing = coordinator.prepareLocal(profile);

        return preparing;
      },
      onOrigin: () => {},
      navigate: async () => {},
    });
    await client.start();
    assert.ok(preparing, 'первый local автоматически готовится через clientRuntime');
    await preparing;
  }

  const descriptor = JSON.parse(await fs.readFile(runtimePath, 'utf8'));

  assert.equal(descriptor.version, 4);
  assert.equal(descriptor.binary, `${input.mount}/bin/grigdesk-server`);
  assert.equal(descriptor.home, '/D');
  assert.equal(await probeGrigDesk(origin), 'grigdesk');
  assert.equal(await fs.readFile(history, 'utf8'), 'история и вложения остаются в D');
  assert.equal(notices.length, input.mode === 'relocate' ? 1 : 0);
  await writeSettings(settingsFile, settings);
  await supervisor.stop();

  const selected = settings.selected;
  const before = await fs.readFile(runtimePath, 'utf8');
  const invalid = '/D/bad-neighbor';

  await fs.mkdir(path.join(invalid, 'bin'), { recursive: true });
  await fs.copyFile(`${input.mount}/bin/bundle.json`, path.join(invalid, 'bin/bundle.json'));
  await fs.writeFile(path.join(invalid, 'GrigDesk'), 'fixture');
  await fs.writeFile(path.join(invalid, 'bin/grigdesk-server'), 'not ELF', { mode: 0o755 });

  const bad = createPortableRuntime({
    isPackaged: true,
    execPath: `${invalid}/GrigDesk`,
    env: { ...env, APPIMAGE: `${invalid}/GrigDesk` },
    home,
    profiles,
    startServer: async () => assert.fail('плохой сосед не запускается'),
    stopServer: async () => assert.fail('плохой сосед не останавливает прежний сервер'),
    notify: async () => {},
    report: () => {},
  });

  await bad.discover().catch(() => {});
  assert.equal(await fs.readFile(runtimePath, 'utf8'), before);
  assert.equal(settings.selected, selected);
  await bad.close();
  await fs.mkdir('/D/state', { recursive: true });
  await fs.writeFile('/D/state/server.lock', JSON.stringify({
    pid: process.pid,
    starttime: processStarttime(process.pid),
  }));

  const busyCandidate = settings.profiles.find((profile) => profile.id !== selected
    && profile.kind === 'local');

  if (busyCandidate) {
    await assert.rejects(coordinator.activate(busyCandidate));
    assert.equal(await fs.readFile(runtimePath, 'utf8'), before);
    assert.equal(settings.selected, selected);
  }

  await fs.rm('/D/state/server.lock');
  await assert.rejects(fs.stat('/D/host-node-attempts'), { code: 'ENOENT' });
  process.stdout.write('PORTABLE_REPORT ' + JSON.stringify({
    descriptor,
    selected,
    notices: notices.length,
    binaries: processes.map((item) => item.binary),
    api: 'grigdesk',
    ownStopped: processes.every((item) => item.child.exitCode === 0),
  }) + '\n');
} finally {
  await client?.close();
  shell?.close();

  if (shellServer) {
    shellServer.closeAllConnections();
    await new Promise((resolve) => shellServer.close(resolve));
  }

  await coordinator.close();
  await supervisor?.stop();
}
