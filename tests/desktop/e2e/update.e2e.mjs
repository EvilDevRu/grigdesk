import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { setTimeout as pause } from 'node:timers/promises';
import test from 'node:test';

import { _electron } from '../../../desktop/node_modules/playwright-core/index.mjs';
import { build } from '../../../web/node_modules/esbuild/lib/main.js';
import { installedFixture, installedRelease, pinnedKeyHook } from '../../helpers/installedUpdateFixture.mjs';
import { updateProcessAlive } from '../../../shared/node/installedServer.ts';

const repository = path.resolve(import.meta.dirname, '../../..');
const electron = path.join(repository, 'desktop/node_modules/electron/dist/electron');

/**
 * Собирает минимальный Electron-host с настоящими updater и clientRuntime.
 * Дорогая официальная упаковка заменена; exit, cookies, профиль и новый main выполняются реально.
 */
async function electronHost(directory, box) {
  const source = `
    import { app, BrowserWindow, session } from 'electron';
    import fs from 'node:fs/promises';
    import path from 'node:path';
    import { createInstalledApplication } from './desktop/src/installedApplication.ts';
    import { createClientRuntime } from './desktop/src/clientRuntime.ts';
    const root = ${JSON.stringify(box.root)};
    const profileDir = ${JSON.stringify(box.receipt.userData)};
    const stateFile = path.join(profileDir, 'settings.json');
    const version = app.getVersion();
    const identity = ${JSON.stringify(box.release.identity)};
    identity.version = version;
    identity.releaseId = identity.channel + '/' + version + '/' + identity.commit;
    app.setPath('userData', profileDir);
    globalThis.fetch = async (url) => {
      if (String(url).endsWith('.json')) {
        return new Response(${JSON.stringify(JSON.stringify(box.release.index))});
      }
      const component = String(url).includes('desktop') ? 'desktop' : 'server';
      return new Response(await fs.readFile(${JSON.stringify(box.temporary)} + '/' + component + '.tar.gz'));
    };
    await app.whenReady();
    const settings = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    const runtime = createClientRuntime({
      settings,
      save: () => fs.writeFile(stateFile, JSON.stringify(settings)),
      uiDir: ${JSON.stringify(directory)},
      secret: 'fixture-secret',
      identity: { load: async () => { throw new Error('Фикстурная личность offline'); } },
      identityDirectory: profileDir,
      localAvailable: () => false,
      localAddress: () => 'http://127.0.0.1:1',
      windowKey: async () => '',
      prepareLocal: async () => { throw new Error('Запрещённый local spawn'); },
      onOrigin() {}, navigate: async () => {},
    });
    await runtime.start();
    globalThis.fixtureUpdater = await createInstalledApplication({
      executable: root + '/generations/' + version + '/desktop/GrigDesk',
      identity,
      localSelected: () => false,
      ownsLocal: () => false,
      remoteApi: () => ({ major: 0, minor: 1 }),
      confirm: async () => true,
      drainLogs: async () => {},
      save: async () => { await runtime.close(); },
      flushCookies: () => session.defaultSession.cookies.flushStore(),
      exit: async () => { app.exit(0); },
    });
    globalThis.fixtureProfile = runtime.shell.state().profile;
    await globalThis.fixtureUpdater.bootProof();
    await fs.writeFile(${JSON.stringify(path.join(box.root, 'update'))} + '/boot-' + version + '.json',
      JSON.stringify({ version, selected: settings.selected, fp: settings.profiles[0].fp,
        cookies: await session.defaultSession.cookies.get({ url: 'https://fixture.example' }) }));
    const window = new BrowserWindow({ show: false });
    await window.loadURL('data:text/html,fixture');
  `;

  for (const version of ['0.2.0', box.release.identity.version]) {
    const appDirectory = path.join(directory, version);

    await fs.mkdir(appDirectory, { recursive: true });
    await fs.writeFile(path.join(appDirectory, 'package.json'), JSON.stringify({
      name: 'grigdesk-update-fixture',
      version,
      main: 'main.cjs',
    }));
    await build({
      stdin: {
        contents: source.replace('    const root =', '    (async () => {\n    const root =')
          + '\n})().catch((error) => { console.error(error); process.exit(1); });',
        loader: 'ts',
        resolveDir: repository,
      },
      outfile: path.join(appDirectory, 'main.cjs'),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['electron'],
      logLevel: 'silent',
      plugins: [{
        name: 'fixture-pinned-key',
        setup(builder) {
          builder.onLoad({ filter: /releaseChannelContracts\.ts$/ }, async ({ path: file }) => ({
            contents: (await fs.readFile(file, 'utf8')).replace(
              /export const RELEASE_SIGNING_PUBLIC_KEY = [^;]+;/u,
              `export const RELEASE_SIGNING_PUBLIC_KEY = ${JSON.stringify(box.release.publicKeyPem)};`,
            ),
            loader: 'ts',
            resolveDir: path.dirname(file),
          }));
        },
      }],
    });
  }
}

test('A6: настоящий Electron обновляется после своего exit, сохраняет remote и cookies', {
  timeout: 60000,
}, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'electron-update-'));

  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const release = installedRelease({
    script: (component, identity, defaultText) => component !== 'desktop' ? defaultText : [
      '#!/bin/sh',
      'if [ "$1" = "--grigdesk-release-probe" ]; then',
      `  printf '%s\\n' '${JSON.stringify(identity)}'`,
      'else',
      `  exec '${electron}' '${directory}/${identity.version}' --no-sandbox --password-store=basic`,
      'fi',
    ].join('\n'),
  });
  const box = await installedFixture(t, { mode: 'remote', release });
  const settings = {
    version: 2,
    profiles: [{
      id: 'remote',
      name: 'Remote fixture',
      kind: 'remote',
      address: 'https://offline.example:443',
      fp: 'a'.repeat(64),
      port: 47921,
      createdAt: 0,
    }],
    selected: 'remote',
    window: {
      width: 900,
      height: 700,
      maximized: false,
    },
  };

  await fs.writeFile(path.join(box.receipt.userData, 'settings.json'), JSON.stringify(settings));
  await fs.writeFile(path.join(box.root, box.previous.desktop, 'GrigDesk'), '#!/bin/sh\nexit 0\n', {
    mode: 0o555,
  });
  await electronHost(directory, box);

  const hook = await pinnedKeyHook(box.temporary, release.publicKeyPem);
  const helper = path.join(box.temporary, 'worker.mjs');
  const workerUrl = new URL('../../../shared/node/installedUpdateWorker.ts', import.meta.url).href;
  const serviceUrl = new URL('../../../shared/node/installedUpdateService.ts', import.meta.url).href;
  const layoutUrl = new URL('../../../shared/node/installedLayout.ts', import.meta.url).href;

  for (const component of ['desktop', 'server']) {
    await fs.writeFile(path.join(box.temporary, `${component}.tar.gz`),
      release.archives.get(release.envelope.payload.artifacts[component].url));
  }

  await fs.writeFile(helper, [
    `import { runInstalledUpdateWorker } from ${JSON.stringify(workerUrl)};`,
    `import { InstalledUpdateService } from ${JSON.stringify(serviceUrl)};`,
    `import { readInstallationJson } from ${JSON.stringify(layoutUrl)};`,
    "import { spawn } from 'node:child_process';",
    "import fs from 'node:fs/promises';",
    `const root = ${JSON.stringify(box.root)};`,
    "globalThis.fetch = async (url) => new Response(await fs.readFile(",
    `  ${JSON.stringify(box.temporary)} + '/' + (String(url).includes('desktop') ? 'desktop' : 'server')`,
    "  + '.tar.gz'));",
    "if (process.argv[2] === 'prepare') {",
    '  await new InstalledUpdateService(root).manager().prepare(process.argv[3]);',
    "} else if (process.argv[2] === 'launch') {",
    "  const pointer = await readInstallationJson(root, 'current.json');",
    "  const child = spawn(root + '/' + pointer.desktop + '/GrigDesk', [], {",
    "    detached: true, stdio: 'ignore', env: process.env,",
    '  });',
    '  child.unref();',
    '} else { await runInstalledUpdateWorker(root, process.argv[3]); }',
  ].join('\n'));
  await fs.writeFile(path.join(box.root, 'update/maintenance'), [
    '#!/bin/sh', `exec '${process.execPath}' --import '${hook}' '${helper}' "$@"`,
  ].join('\n'), { mode: 0o700 });

  const bin = path.join(directory, 'bin');

  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, 'systemctl'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });

  const app = await _electron.launch({
    executablePath: electron,
    args: [path.join(directory, '0.2.0'), '--no-sandbox', '--password-store=basic'],
    env: {
      HOME: box.temporary,
      DISPLAY: process.env.DISPLAY,
      XAUTHORITY: process.env.XAUTHORITY,
      PATH: `${bin}:/usr/bin:/bin`,
      LANG: 'C.UTF-8',
    },
    timeout: 15000,
  });

  const errors = [];
  const electronProcess = app.process();

  electronProcess.stderr.on('data', (bytes) => {
    errors.push(bytes.toString());
  });
  box.onCleanup(async () => {
    const closed = app.close().catch(() => {});

    await Promise.race([closed, pause(1000)]);
    electronProcess.kill('SIGKILL');

    for (const name of ['desktop-boot.json', 'worker-process.json']) {
      const marker = await fs.readFile(path.join(box.root, 'update', name), 'utf8')
        .then(JSON.parse, () => null);

      if (marker?.process && await updateProcessAlive(marker.process)) {
        process.kill(marker.process.pid, 'SIGTERM');
      }
    }
  });

  try {
    await app.firstWindow({ timeout: 8000 });
  } catch (error) {
    throw new Error(errors.join(''), { cause: error });
  }

  assert.equal(await app.evaluate(({ app }) => app.getVersion()), '0.2.0');
  await app.evaluate(async () => {
    await globalThis.fixtureUpdater.port.action('check', {});
    await globalThis.fixtureUpdater.port.action('prepare', {});
  }).catch(async (error) => {
    throw error;
  });

  const deadline = Date.now() + 15000;

  while ((await box.job())?.stage !== 'ready' && Date.now() < deadline) {
    await pause(30);
  }

  assert.equal((await box.job())?.stage, 'ready');
  assert.deepEqual(await box.pointer(), box.previous);
  await app.evaluate(({ session }) => session.defaultSession.cookies.set({
    url: 'https://fixture.example',
    name: 'preserved',
    value: 'yes',
    expirationDate: Date.now() / 1000 + 3600,
  }));

  const exited = once(electronProcess, 'exit');

  void app.evaluate(async () => globalThis.fixtureUpdater.port.action('apply', { confirmed: true }))
    .catch(() => {});
  await exited;

  const completedDeadline = Date.now() + 20000;

  while ((await box.job())?.stage !== 'completed' && Date.now() < completedDeadline) {
    await pause(50);
  }

  const job = await box.job();

  assert.equal(job.stage, 'completed', JSON.stringify(job.error));
  assert.deepEqual(await box.pointer(), job.target);

  const boot = JSON.parse(await fs.readFile(path.join(box.root, 'update/boot-0.3.0.json'), 'utf8'));
  const saved = JSON.parse(await fs.readFile(path.join(box.receipt.userData, 'settings.json'), 'utf8'));

  assert.equal(boot.version, '0.3.0');
  assert.equal(boot.selected, 'remote');
  assert.equal(boot.fp, settings.profiles[0].fp);
  assert.ok(boot.cookies.some((cookie) => cookie.name === 'preserved' && cookie.value === 'yes'));
  assert.equal(saved.selected, settings.selected);
  assert.equal(saved.profiles[0].fp, settings.profiles[0].fp);
  assert.equal(job.target.server, null);
});

const { installedPair } = await import('../../helpers/installedPairFixture.mjs');

/**
 * Один lifecycle проверяет успешную пару и откат после реального отказа нового сервера.
 * Оба desktop — Electron с версией своего пакета; worker подтверждает их живые boot proofs.
 */
async function electronPair(t, rollback = false) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'electron-pair-'));

  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const box = await installedPair(t, {
    failTargetServer: rollback,
    expectedStage: rollback ? 'rolled_back' : 'completed',
    waitMs: rollback ? 115000 : 12000,
    env: { DISPLAY: process.env.DISPLAY, XAUTHORITY: process.env.XAUTHORITY },
    desktopScript: (identity) => [
      '#!/bin/sh',
      'if [ "$1" = "--grigdesk-release-probe" ]; then',
      `  printf '%s\\n' '${JSON.stringify(identity)}'`,
      'else',
      `  exec '${electron}' '${directory}/${identity.version}' --no-sandbox --password-store=basic`,
      'fi',
    ].join('\n'),
    beforeLaunch: async (fixture) => {
      const source = `
        import { app, BrowserWindow, session } from 'electron';
        import fs from 'node:fs/promises';
        import { spawn } from 'node:child_process';
        import { once } from 'node:events';
        import { createInstalledApplication } from './desktop/src/installedApplication.ts';
        import { readInstallation, readInstalledPointer } from './shared/node/installedLayout.ts';
        import { inspectInstalledServer } from './shared/node/installedServer.ts';
        (async () => {
          const root = ${JSON.stringify(fixture.root)};
          const nativeFetch = globalThis.fetch;
          globalThis.fetch = async (url, options) => String(url).startsWith('https://grigdesk.')
            ? new Response(${JSON.stringify(JSON.stringify(fixture.release.index))})
            : nativeFetch(url, options);
          const version = app.getVersion();
          const identity = ${JSON.stringify(fixture.release.identity)};
          identity.version = version;
          identity.releaseId = identity.channel + '/' + version + '/' + identity.commit;
          app.setPath('userData', ${JSON.stringify(fixture.receipt.userData)});
          await app.whenReady();
          const receipt = await readInstallation(root);
          const pointer = await readInstalledPointer(receipt);
          const child = spawn(root + '/' + pointer.server + '/bin/grigdesk-server', [], {
            stdio: ['ignore', 'pipe', 'pipe'], env: process.env,
          });
          const closed = once(child, 'close');
          let tail = '';
          child.stdout.on('data', (bytes) => { tail += bytes; });
          for (let retry = 0; retry < 100; retry++) {
            try { if ((await inspectInstalledServer(receipt)).running) break; } catch {}
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          const updater = await createInstalledApplication({
            executable: root + '/generations/' + version + '/desktop/GrigDesk', identity,
            localSelected: () => true, ownsLocal: () => true, remoteApi: () => null,
            confirm: async () => true, save: async () => {},
            flushCookies: () => session.defaultSession.cookies.flushStore(),
            drainLogs: async () => {
              await closed;
              await fs.writeFile(root + '/update/log-tail', tail);
            },
            exit: async () => { app.exit(0); },
          });
          const window = new BrowserWindow({ show: false });
          await window.loadURL('data:text/html,fixture');
          await updater.bootProof();
          await fs.writeFile(root + '/update/electron-' + version, version);
          if (version === '0.2.0' && updater.port.state().job?.stage === 'ready') {
            await updater.port.action('apply', { confirmed: true });
          }
        })().catch((error) => { console.error(error); app.exit(1); });
      `;

      for (const version of ['0.2.0', fixture.release.identity.version]) {
        const appDirectory = path.join(directory, version);

        await fs.mkdir(appDirectory, { recursive: true });
        await fs.writeFile(path.join(appDirectory, 'package.json'), JSON.stringify({
          name: 'grigdesk-pair-fixture',
          version,
          main: 'main.cjs',
        }));
        await build({
          stdin: {
            contents: source,
            loader: 'ts',
            resolveDir: repository,
          },
          outfile: path.join(appDirectory, 'main.cjs'),
          bundle: true,
          platform: 'node',
          format: 'cjs',
          external: ['electron'],
          logLevel: 'silent',
          plugins: [{
            name: 'pair-pinned-key',
            setup(builder) {
              builder.onLoad({ filter: /releaseChannelContracts\.ts$/ }, async ({ path: file }) => ({
                contents: (await fs.readFile(file, 'utf8')).replace(
                  /export const RELEASE_SIGNING_PUBLIC_KEY = [^;]+;/u,
                  'export const RELEASE_SIGNING_PUBLIC_KEY = '
                    + JSON.stringify(fixture.release.publicKeyPem) + ';',
                ),
                loader: 'ts',
                resolveDir: path.dirname(file),
              }));
            },
          }],
        });
      }
    },
  });
  const job = await box.job();

  assert.equal(job.stage, rollback ? 'rolled_back' : 'completed', JSON.stringify(job.error));
  assert.equal(await fs.readFile(path.join(box.root, 'update/electron-0.2.0'), 'utf8'), '0.2.0');
  assert.equal(await fs.readFile(path.join(box.root, 'update/electron-0.3.0'), 'utf8'), '0.3.0');
  assert.match(await fs.readFile(path.join(box.root, 'update/log-tail'), 'utf8'), /LAST_LOG/);
  assert.deepEqual(await box.pointer(), rollback ? job.previous : job.target);
  await box.preserved();
}

test('A4: Electron local-пары, штатный drain, tail и запуск B', { timeout: 45000 },
  async (t) => electronPair(t));

test('A5: отказ нового server boot восстанавливает прежнюю пару Electron+server', { timeout: 125000 },
  async (t) => electronPair(t, true));

const { loadInstalledModule } = await import('../../helpers/installedBuildFixture.mjs');
const { isolatedEnvironment } = await import('../../helpers/installedUpdateFixture.mjs');

test('A3: headless CLI применяет готовый server-only и оставляет stopped без reinstall', async (t) => {
  const box = await installedFixture(t, { mode: 'server' });
  const job = await box.create();

  await box.manager.prepare(job.id);

  const hook = await pinnedKeyHook(box.temporary, box.release.publicKeyPem);
  const worker = path.join(box.temporary, 'apply.mjs');
  const workerUrl = new URL('../../../shared/node/installedUpdateWorker.ts', import.meta.url).href;
  const bin = path.join(box.temporary, 'bin');

  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, 'systemctl'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  await fs.writeFile(worker, [
    `import { runInstalledUpdateWorker } from ${JSON.stringify(workerUrl)};`,
    `await runInstalledUpdateWorker(${JSON.stringify(box.root)}, process.argv[3]);`,
  ].join('\n'));
  await fs.writeFile(path.join(box.root, 'update/maintenance'), [
    '#!/bin/sh', `exec '${process.execPath}' --import '${hook}' '${worker}' "$@"`,
  ].join('\n'), { mode: 0o700 });
  isolatedEnvironment(t, {
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: box.temporary,
    DISPLAY: '',
  });

  const { runUpdateCommand } = await loadInstalledModule(t, 'cli/updates.ts', box.release.publicKeyPem);
  const output = [];
  const port = {
    write: (value) => output.push(value),
    error: (value) => output.push(value),
  };
  const code = await runUpdateCommand({
    kind: 'server',
    action: 'update',
    json: true,
    restart: true,
  }, box.root, port);

  assert.equal(code, 0, output.join(''));
  assert.equal(JSON.parse(output.join('')).job.stage, 'applied_not_started');

  const pointer = await box.pointer();

  output.length = 0;
  assert.equal(await runUpdateCommand({
    kind: 'server',
    action: 'update-status',
    json: true,
  },
    box.root, port), 0);
  assert.equal(JSON.parse(output.join('')).job.id, job.id);
  assert.deepEqual(await box.pointer(), pointer);
  assert.equal(pointer.desktop, null);
  await box.preserved();
});
