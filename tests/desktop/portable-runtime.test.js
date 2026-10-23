import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createClientRuntime } from '../../desktop/src/clientRuntime.ts';
import { createPortableRuntime } from '../../desktop/src/portableRuntime.ts';
import { Profiles } from '../../desktop/src/profiles.ts';
import { createShellApi } from '../../desktop/src/pipe/shellApi.ts';
import { normalizeSettings, readSettings, writeSettings } from '../../desktop/src/settings.ts';
import { desktopRuntimePath } from '../../shared/desktop/desktopRuntime.ts';
import { selectSeaServer } from '../../server/src/lib/selectSeaServer.ts';
import { processStarttime } from '../../server/src/lib/dataHomeBoot.ts';

/**
 * Новый API проверяется assertion, чтобы отсутствие координатора не ломало загрузку suite.
 * Остальные ошибки импорта остаются настоящими ошибками, а не ожидаемым RED.
 */
async function portableApi() {
  const file = new URL('../../desktop/src/portableRuntime.ts', import.meta.url);
  const present = await fs.stat(file).then(() => true, (error) => {
    assert.equal(error.code, 'ENOENT');

    return false;
  });

  assert.ok(present, 'К7–9: отсутствует координатор portable discovery и выбора');

  const api = await import(file.href);

  assert.equal(typeof api.createPortableRuntime, 'function');

  return api.createPortableRuntime;
}

/**
 * Две установки содержат только executable ELF-fixtures; транзакция выбора настоящая.
 * Порты verify/start внедрены: ни один синтетический ELF не исполняется как программа.
 */
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'portable-runtime-'));
  const home = path.join(root, 'home');
  const data = path.join(root, 'D');
  const env = {
    HOME: home,
    XDG_DATA_HOME: path.join(root, 'xdg'),
    GRIGDESK_HOME: data,
    PATH: '/usr/bin:/bin',
  };
  const installations = {};

  t.after(() => fs.rm(root, { recursive: true, force: true }));

  for (const directory of [home, data]) {
    await fs.mkdir(directory, { recursive: true });
  }

  await fs.writeFile(path.join(data, '.env'), 'GRIGDESK_PORT=19314\n');

  for (const name of ['A', 'B']) {
    const directory = path.join(root, `installation ${name}`);
    const binary = path.join(directory, 'bin/grigdesk-server');
    const window = path.join(directory, 'GrigDesk');

    await fs.mkdir(path.dirname(binary), { recursive: true });
    await fs.writeFile(binary, '\x7fELF-fixture', { mode: 0o755 });
    await fs.writeFile(window, 'AppImage-fixture', { mode: 0o755 });
    await fs.writeFile(path.join(directory, 'bin/bundle.json'), JSON.stringify({
      format: 1,
      kind: 'portable',
      version: '0.1.0',
      commit: '1'.repeat(40),
      dirty: false,
      files: [],
    }));
    installations[name] = {
      directory,
      binary,
      window,
    };
  }

  const settingsFile = path.join(root, 'userData/settings.json');
  const settings = normalizeSettings(options.settings ?? null);
  const profiles = new Profiles({
    settings,
    save: () => writeSettings(settingsFile, settings),
    available: async () => true,
  });
  const runtimePath = desktopRuntimePath({ env, home });
  const descriptor = {
    version: 4,
    kind: 'binary',
    binary: installations.A.binary,
    home: data,
    cliPaths: [path.join(root, 'user-cli')],
  };

  if (options.saved !== false) {
    await fs.mkdir(path.dirname(runtimePath), { recursive: true, mode: 0o700 });
    await fs.writeFile(runtimePath, JSON.stringify(descriptor));
    await fs.writeFile(path.join(path.dirname(runtimePath), 'runtime-version'), '4\n');
  }

  const events = [];
  const notifications = [];
  const starts = [];
  const input = {
    isPackaged: true,
    execPath: '/tmp/.mount_GrigDesk/usr/grigdesk',
    env: {
      ...env,
      APPIMAGE: installations.B.window,
      APPDIR: '/tmp/.mount_GrigDesk',
    },
    home,
    profiles,
    verifyBinary: async () => {
      events.push('verify');
    },
    selectServer: async (selection) => {
      events.push('select');

      return selectSeaServer({ ...selection, verifyBinary: input.verifyBinary });
    },
    startServer: async (binary) => {
      events.push('spawn');
      starts.push(binary);
    },
    stopServer: async () => {
      events.push('stop');
    },
    notify: async (message) => {
      notifications.push(message);
    },
    report: (state) => {
      events.push(state);
    },
    fs,
  };

  return {
    root,
    home,
    data,
    env,
    installations,
    settings,
    settingsFile,
    profiles,
    runtimePath,
    descriptor,
    events,
    starts,
    notifications,
    input,
  };
}

/**
 * Legacy local и remote используют настоящую нормализацию settings v2.
 * Сохранность id/port/pin проверяется по снимку до появления кандидата.
 */
async function savedProfiles(box) {
  const local = await box.profiles.add({
    kind: 'local',
    name: 'Мой сервер A',
    address: 'http://127.0.0.1:19314',
    fp: null,
  });
  const remote = await box.profiles.add({
    kind: 'remote',
    name: 'Удалённая машина',
    address: 'https://remote.example',
    fp: '12'.repeat(32),
  });

  await box.profiles.select(local.id);

  return { local: structuredClone(local), remote: structuredClone(remote) };
}

test('PB-RUN-01: физический APPIMAGE и packaged execPath, source и mount не сканируются', async (t) => {

  for (const mode of ['appimage', 'extract', 'execPath', 'source', 'bad-appimage', 'no-marker']) {
    await t.test(mode, async (t) => {
      const box = await fixture(t, { saved: false });
      const create = await portableApi();
      const input = { ...box.input, env: { ...box.input.env } };

      if (mode === 'extract') {
        input.env.APPIMAGE_EXTRACT_AND_RUN = '1';
      }

      if (mode === 'execPath') {
        delete input.env.APPIMAGE;
        input.execPath = box.installations.B.window;
      }

      if (mode === 'source') {
        input.isPackaged = false;
      }

      if (mode === 'bad-appimage') {
        input.env.APPIMAGE = path.join(box.root, 'missing/GrigDesk');
        input.execPath = box.installations.B.window;
      }

      if (mode === 'no-marker') {
        await fs.rm(path.join(box.installations.B.directory, 'bin/bundle.json'));
      }

      const coordinator = create(input);

      t.after(() => coordinator.close());

      const result = await coordinator.discover();
      const available = ['appimage', 'extract', 'execPath'].includes(mode);

      assert.equal(result.localAvailable, available);
      assert.ok(!box.events.includes('verify'), 'discovery не делает тяжёлой проверки');
      await assert.rejects(fs.stat(box.runtimePath), { code: 'ENOENT' });

      if (available) {
        assert.equal(result.address, 'http://127.0.0.1:19314', 'порт из той же D/.env, что runtimeConfig');

        const profile = box.settings.profiles.find(
          (item) => item.serverBinary === box.installations.B.binary,
        );

        assert.ok(profile, 'сосед доступен локальным профилем');
        await box.profiles.select(profile.id);
        await coordinator.prepareLocal(profile);
        assert.equal(JSON.parse(await fs.readFile(box.runtimePath, 'utf8')).binary,
          box.installations.B.binary);
        assert.deepEqual(box.starts, [box.installations.B.binary]);
      }
    });
  }
});

test('PB-RUN-02: медленная подготовка не задерживает документ и не создаёт ранний транспорт', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'portable-document-'));
  const settings = normalizeSettings(null);
  const server = http.createServer((_req, res) => res.writeHead(503).end());
  let release;
  let probes = 0;
  let keyReads = 0;
  const gate = new Promise((resolve) => {
    release = resolve;
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  server.on('request', () => {
    probes += 1;
  });

  const client = createClientRuntime({
    settings,
    save: async () => {},
    uiDir: root,
    secret: 'portable-test-secret',
    identity: { load: async () => assert.fail('local не читает remote identity') },
    identityDirectory: root,
    localAvailable: () => true,
    localAddress: () => `http://127.0.0.1:${server.address().port}`,
    windowKey: async () => {
      keyReads += 1;

      return 'portable-test-window-key';
    },
    prepareLocal: () => gate,
    onOrigin: () => {},
    navigate: async () => {},
  });

  t.after(async () => {
    release();
    await client.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });

  const origin = await Promise.race([
    client.start(),
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('UI ждёт verify вместо открытия документа')), 2000);

      timer.unref();
    }),
  ]);

  assert.match(origin, /^http:\/\/127\.0\.0\.1:/u);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(keyReads, 0, 'транспорт не читает ключ до окончания async prepareLocal');
  assert.equal(probes, 0, 'upstream не создаётся до окончания async prepareLocal');
  client.shell.disconnect();
  release();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(keyReads, 0, 'disconnect запрещает позднее создание транспорта');
  assert.equal(probes, 0, 'disconnect запрещает поздний bootstrap');
});

test('PB-RUN-03: v1–4, remote и явный URL сохраняют прежний выбор без verify соседа', async (t) => {

  for (const version of [1, 2, 3, 4, 'remote', 'url']) {
    await t.test(String(version), async (t) => {
      const box = await fixture(t);
      const create = await portableApi();
      const saved = await savedProfiles(box);
      let descriptor = box.descriptor;

      if ([1, 2, 3].includes(version)) {
        const root = path.join(box.root, 'legacy');
        const entry = version === 3 ? 'server/grigdesk-server' : 'server/src/app.ts';

        await fs.mkdir(path.dirname(path.join(root, entry)), { recursive: true });
        await fs.writeFile(path.join(root, entry), 'fixture', { mode: 0o755 });
        descriptor = version === 3 ? {
          version,
          kind: 'sea',
          root,
          home: box.data,
        } : {
          version,
          root,
          node: process.execPath,
          ...(version === 2 ? { home: box.data } : {}),
        };
      }

      if (version === 'remote') {
        await box.profiles.select(saved.remote.id);
      }

      if (version === 'url') {
        box.input.explicitUrl = 'https://explicit.example';
      }

      const previous = JSON.stringify(descriptor);
      const selected = box.settings.selected;

      await fs.writeFile(box.runtimePath, previous);

      const coordinator = create(box.input);

      t.after(() => coordinator.close());
      await coordinator.discover();
      assert.equal(await fs.readFile(box.runtimePath, 'utf8'), previous);
      assert.equal(box.settings.selected, selected);
      assert.deepEqual(box.profiles.get(saved.remote.id), saved.remote);
      assert.equal(box.profiles.get(saved.local.id).name, saved.local.name);
      assert.equal(box.profiles.get(saved.local.id).port, saved.local.port);
      assert.ok(!box.events.includes('verify'));
      assert.deepEqual(box.starts, []);
      assert.deepEqual(box.notifications, []);
      assert.ok(box.settings.profiles.some((item) => item.serverBinary === box.installations.B.binary));
    });
  }
});

test('PB-RUN-04: исчезнувший ELF заменяется соседом с прежней D, id/port и одним сообщением', async (t) => {
  const box = await fixture(t);
  const create = await portableApi();
  const { local } = await savedProfiles(box);

  await fs.rm(box.installations.A.directory, { recursive: true });

  const coordinator = create(box.input);

  t.after(() => coordinator.close());
  await coordinator.discover();
  await coordinator.prepareLocal(box.profiles.get(local.id));

  const descriptor = JSON.parse(await fs.readFile(box.runtimePath, 'utf8'));

  assert.equal(descriptor.binary, box.installations.B.binary);
  assert.equal(descriptor.home, box.data);
  assert.deepEqual(descriptor.cliPaths, box.descriptor.cliPaths);
  assert.equal(box.settings.selected, local.id);
  assert.equal(box.profiles.get(local.id).port, local.port);
  assert.equal(box.notifications.length, 1);
  await coordinator.prepareLocal(box.profiles.get(local.id));
  assert.equal(box.notifications.length, 1);
});

test('PB-RUN-05: ошибка и отмена запрещают поздний commit/spawn', async (t) => {

  for (const failure of ['json', 'access', 'bad-neighbor', 'abort', 'profile-change']) {
    await t.test(failure, async (t) => {
      const box = await fixture(t);
      const create = await portableApi();
      const { local, remote } = await savedProfiles(box);
      const controller = new AbortController();

      if (failure === 'json') {
        await fs.writeFile(box.runtimePath, '{broken');
      } else if (failure === 'access') {
        box.input.fs = { ...fs, stat: async (file, ...args) => {
          if (file === box.installations.A.binary) {
            throw Object.assign(new Error('Синтетический EACCES'), { code: 'EACCES' });
          }

          return fs.stat(file, ...args);
        } };
      } else {
        await fs.rm(box.installations.A.binary);
      }

      if (failure === 'bad-neighbor') {
        await fs.writeFile(box.installations.B.binary, 'not ELF');
      }

      box.input.verifyBinary = async () => {
        if (failure === 'abort') {
          controller.abort();
        }

        if (failure === 'profile-change') {
          await box.profiles.select(remote.id);
        }
      };

      const before = await fs.readFile(box.runtimePath, 'utf8');
      const coordinator = create(box.input);

      t.after(() => coordinator.close());
      await coordinator.discover().catch(() => {});
      await coordinator.prepareLocal(box.profiles.get(local.id), {
        signal: controller.signal,
      }).catch(() => {});
      assert.equal(await fs.readFile(box.runtimePath, 'utf8'), before);
      assert.deepEqual(box.starts, []);
      assert.equal(box.settings.selected, failure === 'profile-change' ? remote.id : local.id);
    });
  }
});

/**
 * HTTP select проходит тот же приватный hook, что обычное окно.
 * Транспорт не ходит в сеть; проверяемый эффект — descriptor и выбранный executable.
 */
async function shellFixture(t, box, coordinator) {
  const shell = createShellApi({
    profiles: box.profiles,
    pairing: { addByPairing: async () => assert.fail('pairing не вызывается') },
    localAvailable: () => true,
    localAddress: () => 'http://127.0.0.1:19314',
    beforeSelect: (profile) => coordinator.activate(profile),
    navigate: async () => {},
    upstream: () => ({
      request() {},
      upgrade() {},
      close() {},
      probe: async () => {},
    }),
  });
  const server = http.createServer((req, res) => shell.handle(req, res));

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    shell.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  return (id) => fetch(`http://127.0.0.1:${server.address().port}/__shell/select`, {
    method: 'POST',
    body: JSON.stringify({ id }),
  });
}

test('PB-SWITCH-01: ручной сосед проверяется до stop и запускает выбранный ELF', async (t) => {
  const box = await fixture(t);
  const create = await portableApi();

  await savedProfiles(box);

  const coordinator = create(box.input);

  t.after(() => coordinator.close());
  await coordinator.discover();

  const select = await shellFixture(t, box, coordinator);
  const candidate = box.settings.profiles.find(
    (item) => item.serverBinary === box.installations.B.binary,
  );

  assert.ok(candidate);
  assert.equal((await select(candidate.id)).status, 200);
  assert.equal(box.settings.selected, candidate.id);
  assert.equal(JSON.parse(await fs.readFile(box.runtimePath, 'utf8')).binary,
          box.installations.B.binary);
  assert.deepEqual(box.starts, [box.installations.B.binary]);
  assert.ok(box.events.indexOf('verify') < box.events.indexOf('stop'));
  assert.ok(box.events.indexOf('stop') < box.events.indexOf('spawn'));
});

test('PB-SWITCH-02: внешний busy и verify failure сохраняют descriptor/selected без сигналов', async (t) => {

  for (const failure of ['busy', 'verify']) {
    await t.test(failure, async (t) => {
      const box = await fixture(t);
      const create = await portableApi();

      await savedProfiles(box);

      if (failure === 'busy') {
        await fs.mkdir(path.join(box.data, 'state'), { recursive: true });
        await fs.writeFile(path.join(box.data, 'state/server.lock'), JSON.stringify({
          pid: process.pid,
          starttime: processStarttime(process.pid),
        }));
      } else {
        box.input.verifyBinary = async () => {
          throw new Error('Синтетический отказ verify');
        };
      }

      const previous = await fs.readFile(box.runtimePath, 'utf8');
      const selected = box.settings.selected;
      const coordinator = create(box.input);

      t.after(() => coordinator.close());
      await coordinator.discover();

      const select = await shellFixture(t, box, coordinator);
      const candidate = box.settings.profiles.find(
    (item) => item.serverBinary === box.installations.B.binary,
  );

      assert.ok(candidate);
      assert.equal((await select(candidate.id)).ok, false);
      assert.equal(await fs.readFile(box.runtimePath, 'utf8'), previous);
      assert.equal(box.settings.selected, selected);
      assert.deepEqual(box.starts, []);
      assert.ok(!box.events.includes('stop'));
    });
  }
});

test('PB-SKEP-01: прежний local возвращает свой ELF после A→B→A и повторного запуска', async (t) => {
  const box = await fixture(t);
  const create = await portableApi();
  const { local, remote } = await savedProfiles(box);
  const sentinels = ['chats/history.json', 'chats/attachment.bin'];

  for (const relative of sentinels) {
    await fs.mkdir(path.dirname(path.join(box.data, relative)), { recursive: true });
    await fs.writeFile(path.join(box.data, relative), `сохранённые данные ${relative}`);
  }

  const before = await Promise.all(sentinels.map((file) => fs.readFile(path.join(box.data, file))));
  const coordinator = create(box.input);

  t.after(() => coordinator.close());
  await coordinator.discover();
  assert.equal(box.settings.selected, local.id);
  assert.equal(JSON.parse(await fs.readFile(box.runtimePath, 'utf8')).binary, box.installations.A.binary);

  const select = await shellFixture(t, box, coordinator);
  const candidate = box.settings.profiles.find(
    (item) => item.serverBinary === box.installations.B.binary,
  );

  assert.ok(candidate);
  assert.equal((await select(candidate.id)).status, 200);
  assert.equal(JSON.parse(await fs.readFile(box.runtimePath, 'utf8')).binary,
          box.installations.B.binary);
  assert.equal((await select(local.id)).status, 200);
  assert.equal(JSON.parse(await fs.readFile(box.runtimePath, 'utf8')).binary, box.installations.A.binary);
  assert.deepEqual(box.starts, [box.installations.B.binary, box.installations.A.binary]);
  await writeSettings(box.settingsFile, box.settings);
  await coordinator.close();

  const restored = await readSettings(box.settingsFile);
  const profiles = new Profiles({
    settings: restored,
    save: () => writeSettings(box.settingsFile, restored),
    available: async () => true,
  });
  const restarted = create({ ...box.input, profiles });

  t.after(() => restarted.close());
  await restarted.discover();
  await restarted.prepareLocal(profiles.get(local.id));
  assert.equal(box.starts.at(-1), box.installations.A.binary);
  assert.equal(JSON.parse(await fs.readFile(box.runtimePath, 'utf8')).binary, box.installations.A.binary);
  assert.equal(restored.selected, local.id);
  assert.equal(profiles.get(local.id).port, local.port);
  assert.equal(profiles.get(local.id).name, local.name);
  assert.deepEqual(profiles.get(remote.id), remote);
  assert.equal(JSON.parse(await fs.readFile(box.runtimePath, 'utf8')).home, box.data);
  assert.deepEqual(await Promise.all(sentinels.map((file) => fs.readFile(path.join(box.data, file)))),
    before);
});

/**
 * Внешний CLI меняет установку той же транзакцией, что production use-server/use-source.
 * Подставлены только проверки содержимого: descriptor, lock и публикация остаются настоящими.
 */
async function selectOutsideWindow(box, version) {
  const root = path.join(box.root, 'installation C');
  const entry = path.join(root, version === 4 ? 'bin/grigdesk-server'
    : version === 3 ? 'server/grigdesk-server' : 'server/src/app.ts');

  await fs.mkdir(path.dirname(entry), { recursive: true });
  await fs.writeFile(entry, '\x7fELF-fixture', { mode: 0o755 });
  await selectSeaServer({
    root: version === 4 ? entry : root,
    ...(version === 2 ? { node: process.execPath } : {}),
    env: box.env,
    home: box.home,
    verifyBinary: async () => {},
    verify: async () => {},
    verifySource: async () => {},
  });

  return entry;
}

test('PB-RETURN-01: внешний выбор ELF/R/source переживает повторное открытие окна', async (t) => {
  for (const version of [4, 3, 2]) {
    for (const mode of ['installed', 'portable']) {
      await t.test(`v${version} ${mode}`, async (t) => {
        const box = await fixture(t);
        const { local } = await savedProfiles(box);
        const first = createPortableRuntime(box.input);

        await first.discover();
        assert.equal(box.profiles.get(local.id).serverBinary, box.installations.A.binary);
        first.close();

        const entry = await selectOutsideWindow(box, version);
        const previous = await fs.readFile(box.runtimePath, 'utf8');

        await fs.rm(path.join(box.installations.A.directory, 'bin/bundle.json'));
        box.events.length = 0;

        const reopened = createPortableRuntime({
          ...box.input,
          env: {
            ...box.input.env,
            APPIMAGE: box.installations[mode === 'installed' ? 'A' : 'B'].window,
          },
        });

        t.after(() => reopened.close());
        await reopened.discover();
        await reopened.prepareLocal(box.profiles.get(local.id));
        assert.equal(await fs.readFile(box.runtimePath, 'utf8'), previous);
        assert.equal(box.settings.selected, local.id);
        assert.ok(!box.events.includes('verify'), 'фоновый запуск не проверяет прежнюю привязку');
        assert.ok(!box.events.includes('select'), 'внешний descriptor не переписывается');
        assert.ok(!box.events.includes('stop'), 'сервер внешнего выбора не останавливается');
        assert.deepEqual(box.starts, [entry], 'запуск использует текущий descriptor');
      });
    }
  }
});

/**
 * Проверяется настоящий POST local без Electron и без сетевого подключения upstream.
 * Второй вход использует тот же Profiles.add, который main вызывает для явного URL.
 */
async function addLocalFromShell(t, box, address) {
  const shell = createShellApi({
    profiles: box.profiles,
    pairing: { addByPairing: async () => assert.fail('local не требует pairing') },
    localAvailable: () => true,
    localAddress: () => address,
    navigate: async () => {},
    upstream: () => ({
      request() {},
      upgrade() {},
      close() {},
      probe: async () => {},
    }),
  });
  const server = http.createServer((req, res) => shell.handle(req, res));

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    shell.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const response = await fetch(`http://127.0.0.1:${server.address().port}/__shell/profiles`, {
    method: 'POST',
    body: JSON.stringify({ local: true }),
  });

  assert.equal(response.status, 200);

  return box.profiles.get(box.settings.selected);
}

test('PB-RETURN-02: URL и POST local сохраняют местный id/порт и не захватывают portable', async (t) => {
  for (const entry of ['explicit-url', 'shell-local']) {
    for (const existing of [true, false]) {
      await t.test(`${entry}, местный профиль ${existing ? 'есть' : 'отсутствует'}`, async (t) => {
        const box = await fixture(t, { saved: existing });
        const local = existing ? (await savedProfiles(box)).local : null;
        const runtime = createPortableRuntime(box.input);

        t.after(() => runtime.close());
        await runtime.discover();

        // Повторное чтение настроек не должно терять различие local и переносимой машины.
        const restored = normalizeSettings(JSON.parse(JSON.stringify(box.settings)));

        box.settings.profiles = restored.profiles;

        const candidate = box.settings.profiles.find(
          (item) => item.serverBinary === box.installations.B.binary,
        );
        const candidateBefore = structuredClone(candidate);
        const count = box.settings.profiles.length;
        const address = 'http://127.0.0.1:19414';
        const add = () => entry === 'shell-local' ? addLocalFromShell(t, box, address) : box.profiles.add({
          name: 'Этот компьютер',
          kind: 'local',
          address,
          fp: null,
        });
        const repeated = await add();
        const again = await add();

        assert.equal(box.settings.profiles.length, count + (existing ? 0 : 1));
        assert.notEqual(repeated.id, candidate.id, 'переносимая машина остаётся отдельной');
        assert.equal(repeated.id, local?.id ?? again.id);
        assert.equal(repeated.port, local?.port ?? again.port);
        assert.equal(repeated.address, address);
        assert.deepEqual(box.profiles.get(candidate.id), candidateBefore);
      });
    }
  }
});

test('PB-RETURN-03: сообщение о переносе не удерживает подготовку и его ошибка безопасна', async (t) => {
  for (const mode of ['pending', 'reject', 'throw']) {
    await t.test(mode, async (t) => {
      const box = await fixture(t);
      const { local } = await savedProfiles(box);
      let release;
      let calls = 0;
      const notification = new Promise((resolve) => {
        release = resolve;
      });

      t.after(() => release());
      await fs.rm(box.installations.A.directory, { recursive: true });

      const runtime = createPortableRuntime({
        ...box.input,
        /**
         * Удержание и оба способа отказа моделируют независимый native-диалог.
         * Ни один из них не должен задержать транспорт после запуска сервера.
         */
        notify() {
          calls += 1;

          if (mode === 'throw') {
            throw new Error('Синтетическая ошибка показа');
          }

          return mode === 'reject' ? Promise.reject(new Error('Синтетический отказ диалога')) : notification;
        },
      });

      t.after(() => runtime.close());
      await runtime.discover();

      let timer;

      try {
        const ready = runtime.prepareLocal(box.profiles.get(local.id)).then(() => 'ready');
        const result = await Promise.race([
          ready,
          new Promise((resolve) => {
            timer = setTimeout(() => resolve('dialog-blocked'), 500);
          }),
        ]);

        assert.equal(result, 'ready', 'подготовка завершается до закрытия сообщения');
        assert.deepEqual(box.starts, [box.installations.B.binary]);
        await runtime.prepareLocal(box.profiles.get(local.id));
        assert.equal(calls, 1, 'сообщение показывается один раз за запуск');
      } finally {
        clearTimeout(timer);
      }
    });
  }
});
