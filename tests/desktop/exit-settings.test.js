import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';

import { createClientRuntime } from '../../desktop/src/clientRuntime.ts';
import { startPipe } from '../../desktop/src/pipe/pipeServer.ts';
import { normalizeSettings, readSettings, writeSettings } from '../../desktop/src/settings.ts';

/**
 * Отсутствующий в исходном продукте optional port остаётся отсутствующим, без заглушки SUT.
 * После появления нового модуля используется настоящий preference с общим settings/save.
 */
async function preference(settings, save) {
  const file = new URL('../../desktop/src/desktopExitPreference.ts', import.meta.url);

  if (!existsSync(file)) {
    return undefined;
  }

  const { createDesktopExitPreference } = await import(file.href);

  return createDesktopExitPreference({ settings, save });
}

/**
 * Настоящие runtime, shell и auth трубы читают только временный settings.json.
 * Отказ save внедрён до writer, чтобы не зависеть от прав и владельца процесса.
 */
async function fixture(t, { port = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-exit-preference-'));
  const file = path.join(root, 'profile', 'settings.json');
  let failed = false;
  let active;

  /**
   * Runtime при перезапуске читает тот же файл, который сохраняет preference.
   * Отключённый desktop port моделирует старый shell и других потребителей runtime.
   */
  async function start(settings) {
    const save = async () => {
      if (failed) {
        throw new Error('Тестовый отказ сохранения');
      }

      await writeSettings(file, settings);
    };
    const desktopExit = port ? await preference(settings, save) : undefined;
    const runtime = createClientRuntime({
      settings,
      save,
      desktopExit,
      systemLanguage: 'ru-RU',
      uiDir: root,
      secret: 'synthetic-exit-secret',
      identity: { load: async () => undefined },
      identityDirectory: root,
      localAvailable: () => true,
      localAddress: () => 'http://127.0.0.1:9',
      windowKey: async () => '',
      onOrigin() {},
      navigate: async () => {},
    });
    const pipe = await startPipe({
      port: 0,
      uiDir: root,
      secret: 'synthetic-exit-secret',
      appApi: { major: 0, minor: 1 },
      upstream: null,
      shell: runtime.shell,
    });

    return {
      runtime,
      pipe,
      settings,
      desktopExit,
    };
  }

  await writeSettings(file, normalizeSettings({ version: 2 }));
  active = await start(await readSettings(file));
  t.after(async () => {
    await active.pipe.close();
    await active.runtime.close();
    await rm(root, { recursive: true, force: true });
  });

  return {
    file,
    get runtime() {
      return active.runtime;
    },
    get port() {
      return active.desktopExit;
    },
    failSave(value) {
      failed = value;
    },
    async restart() {
      await active.pipe.close();
      await active.runtime.close();
      active = await start(await readSettings(file));
    },
    /**
     * Каждый запрос проходит реальный auth guard; тайм-аут ограничивает ошибочный long-poll.
     * Подменённые заголовки позволяют проверить отказы до записи preference.
     */
    request(route, body, headers = {}) {
      return new Promise((resolve, reject) => {
        const request = http.request(active.pipe.origin + '/__shell/' + route, {
          method: body === undefined ? 'GET' : 'POST',
          headers: { cookie: 'grigdesk_pipe=synthetic-exit-secret', ...headers },
          signal: AbortSignal.timeout(3000),
        }, (response) => {
          const chunks = [];

          response.on('data', (chunk) => chunks.push(chunk));
          response.on('end', () => resolve(new Response(Buffer.concat(chunks), {
            status: response.statusCode,
          })));
        });

        request.on('error', reject);
        request.end(body === undefined ? undefined : JSON.stringify(body));
      });
    },
  };
}

test('PREF01: true/false, версии и мусор нормализуются без изменения старой формы defaults', () => {
  for (const version of [1, 2]) {
    assert.equal(normalizeSettings({ version, skipExitConfirmation: true }).skipExitConfirmation, true);

    for (const value of [false, undefined, null, 'true', 1, {}]) {
      assert.equal(normalizeSettings({ version, skipExitConfirmation: value })
        .skipExitConfirmation ?? false, false);
    }
  }

  assert.equal(Object.hasOwn(normalizeSettings(null), 'skipExitConfirmation'), false);
  assert.equal(normalizeSettings({ version: 999, skipExitConfirmation: true })
    .skipExitConfirmation ?? false, false);
});

test('PREF01/persistence: согласие переживает writer/read/runtime и сохранения соседних полей', async (t) => {
  const f = await fixture(t);
  const response = await f.request('exit-preference', { skipConfirmation: true });

  assert.equal(response.status, 200, 'К7/К8: локальный POST сохраняет согласие');
  assert.equal((await readSettings(f.file)).skipExitConfirmation, true);
  assert.equal((await f.request('locale', { preference: 'en' })).status, 200);
  assert.equal((await f.request('profiles', { local: true })).status, 200);

  const stored = await readSettings(f.file);

  stored.window = {
    width: 1400,
    height: 900,
    maximized: true,
  };
  await writeSettings(f.file, stored);
  await f.restart();
  assert.equal(f.runtime.shell.state().desktopExit.skipConfirmation, true);
  assert.equal((await readSettings(f.file)).uiLanguage, 'en');
  assert.equal((await readSettings(f.file)).profiles.length, 1);
  assert.equal((await readSettings(f.file)).window.width, 1400);
  assert.equal((await f.request('exit-preference', { skipConfirmation: false })).status, 200);
  await f.restart();
  assert.equal(f.runtime.shell.state().desktopExit.skipConfirmation, false);
});

test('PREF02: snapshot/rev/long-poll и общий port Remember используют одно состояние', async (t) => {
  const f = await fixture(t);
  const before = f.runtime.shell.state();

  assert.deepEqual(before.desktopExit, { skipConfirmation: false });

  const pending = f.request(`state?rev=${before.rev}`);
  const response = await f.request('exit-preference', { skipConfirmation: true });

  assert.equal(response.status, 200);

  const accepted = await response.json();
  const changed = await (await pending).json();

  assert.ok(changed.rev > before.rev);
  assert.equal(changed.desktopExit.skipConfirmation, true);
  assert.equal(accepted.desktopExit.skipConfirmation, true);

  const remembered = f.request(`state?rev=${changed.rev}`);

  await f.port.set(false);

  const fromPort = await (await remembered).json();

  assert.ok(fromPort.rev > changed.rev, 'Remember будит тот же существующий long-poll');
  assert.equal(fromPort.desktopExit.skipConfirmation, false);
  assert.equal(f.runtime.shell.state().desktopExit.skipConfirmation, false);
});

test('PREF02/invalid: строгий boolean и лишние поля не меняют файл', async (t) => {
  const f = await fixture(t);

  assert.equal((await f.request('exit-preference', { skipConfirmation: true })).status, 200);

  const before = await readFile(f.file, 'utf8');

  for (const body of [{}, { skipConfirmation: 'true' }, { skipConfirmation: 1 },
    { skipConfirmation: null }, { skipConfirmation: false, extra: true }]) {
    assert.equal((await f.request('exit-preference', body)).status, 400);
    assert.equal(await readFile(f.file, 'utf8'), before);
  }
});

test('PREF02/failure: отказ записи откатывает принятое значение, следующий save успешен', async (t) => {
  const f = await fixture(t);

  assert.equal((await f.request('exit-preference', { skipConfirmation: true })).status, 200);

  const before = await readFile(f.file, 'utf8');

  f.failSave(true);

  const response = await f.request('exit-preference', { skipConfirmation: false });

  assert.ok(response.status >= 400 && response.status < 600);
  assert.equal(await readFile(f.file, 'utf8'), before);
  assert.equal(f.runtime.shell.state().desktopExit.skipConfirmation, true);
  f.failSave(false);
  assert.equal((await f.request('exit-preference', { skipConfirmation: false })).status, 200);
  assert.equal(f.runtime.shell.state().desktopExit.skipConfirmation, false);
});

test('PREF03: cookie/Host/Origin/Fetch-Site отклоняются до изменения', async (t) => {
  const f = await fixture(t);
  const before = await readFile(f.file, 'utf8');

  for (const headers of [
    { cookie: '' },
    { host: 'foreign.invalid' },
    { origin: 'https://foreign.invalid' },
    { 'sec-fetch-site': 'cross-site' },
  ]) {
    assert.equal((await f.request('exit-preference', { skipConfirmation: true }, headers)).status, 403);
    assert.equal(await readFile(f.file, 'utf8'), before);
  }
});

test('PREF02/optional: без desktop port поле отсутствует и endpoint возвращает 404', async (t) => {
  const f = await fixture(t, { port: false });

  assert.equal(Object.hasOwn(f.runtime.shell.state(), 'desktopExit'), false);
  assert.equal((await f.request('exit-preference', { skipConfirmation: true })).status, 404);
});
