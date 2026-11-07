import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createClientRuntime } from '../../desktop/src/clientRuntime.ts';
import { startPipe } from '../../desktop/src/pipe/pipeServer.ts';
import { normalizeSettings, readSettings, writeSettings } from '../../desktop/src/settings.ts';

/**
 * Настоящие runtime, shell, очередь записи и труба работают с отдельным settings.json.
 * Открытие документов и ключи подменены; upstream отсутствует до явного выбора машины.
 */
async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'i18n-desktop-'));
  const file = path.join(root, 'profile', 'settings.json');
  const settings = normalizeSettings({ 
    version: 2, 
    profiles: [], 
    ...options.settings 
  });
  const navigations = [];
  let rejectSave = false;

  await writeSettings(file, settings);

  /**
   * Перезапуск читает тот же файл, который сохраняет callback runtime.
   * Отказ внедряется до записи и не зависит от прав пользователя процесса.
   */
  async function start(stored) {
    const runtime = createClientRuntime({
      settings: stored,
      save: async () => {
        if (rejectSave) {
          throw new Error('Тестовый отказ записи языка');
        }

        await writeSettings(file, stored);
      },
      systemLanguage: 'ru-RU',
      uiDir: root,
      secret: 'synthetic-locale-secret',
      identity: { load: async () => undefined },
      identityDirectory: root,
      localAvailable: () => true,
      localAddress: () => 'http://127.0.0.1:9',
      windowKey: async () => '',
      onOrigin() {},
      navigate: async (origin) => navigations.push(origin),
    });
    const pipe = await startPipe({
      port: 0,
      uiDir: root,
      secret: 'synthetic-locale-secret',
      appApi: { major: 0, minor: 1 },
      upstream: null,
      shell: runtime.shell,
    });

    return {
      runtime,
      pipe,
      settings: stored,
      async close() {
        await pipe.close();
        await runtime.close();
      },
    };
  }

  let active = await start(settings);

  t.after(async () => {
    await active.close();
    await rm(root, { recursive: true, force: true });
  });

  return {
    file,
    navigations,
    get runtime() {
      return active.runtime;
    },
    failSave(value) {
      rejectSave = value;
    },
    async restart() {
      await active.close();
      active = await start(await readSettings(file));
    },
    /**
     * Запрос идёт через общий auth настоящей трубы с синтетической cookie.
     * Ограниченный срок не позволяет неработающему long-poll подвесить тест.
     */
    async request(route, body, extra = {}) {
      return fetch(active.pipe.origin + '/__shell/' + route, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { cookie: 'grigdesk_pipe=synthetic-locale-secret' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(3000),
        ...extra,
      });
    },
  };
}

test('I18N-D02: snapshot, POST locale, rev/long-poll, сохранение и restart без машины', async (t) => {
  const f = await fixture(t);
  const before = f.runtime.shell.state();

  assert.deepEqual(before.locale, { preference: 'system', systemLanguage: 'ru-RU' });

  const pending = f.request(`state?rev=${before.rev}`);
  const response = await f.request('locale', { preference: 'en' });

  assert.equal(response.status, 200, 'К2/К5: локальный endpoint языка доступен без машины');

  const accepted = await response.json();
  const snapshot = await (await pending).json();

  assert.equal(accepted.locale.preference, 'en');
  assert.equal(snapshot.locale.preference, 'en');
  assert.ok(snapshot.rev > before.rev);
  assert.equal(snapshot.profile, null);
  assert.equal(f.navigations.length, 0);
  assert.equal((await readSettings(f.file)).uiLanguage, 'en');
  await f.restart();
  assert.equal(f.runtime.shell.state().locale.preference, 'en');
});

test('I18N-D02/invalid: неверный язык/форма и превышение тела не меняют настройки', async (t) => {
  const f = await fixture(t);
  const before = await readFile(f.file, 'utf8');

  for (const body of [{ preference: 'unknown' }, { preference: 1 }, {},
    { preference: 'en', upstream: 'http://foreign.test' }]) {
    const response = await f.request('locale', body);

    assert.equal(response.status, 400);
    assert.equal(await readFile(f.file, 'utf8'), before);
  }

  const oversized = await f.request('locale', undefined, {
    method: 'POST',
    body: JSON.stringify({ preference: 'en', padding: 'x'.repeat(65537) }),
  });

  assert.equal(oversized.status, 400);
  assert.equal(await readFile(f.file, 'utf8'), before);
});

test('I18N-D02/failure: отказ сохранения явный, файл и принятый выбор прежние', async (t) => {
  const f = await fixture(t);

  assert.equal((await f.request('locale', { preference: 'ru' })).status, 200);

  const before = await readFile(f.file, 'utf8');

  f.failSave(true);

  const response = await f.request('locale', { preference: 'en' });

  assert.ok(response.status >= 400 && response.status < 600);
  assert.ok((await response.text()).length > 0);
  assert.equal(await readFile(f.file, 'utf8'), before);
  assert.equal(f.runtime.shell.state().locale.preference, 'ru');
  f.failSave(false);
  assert.equal((await f.request('locale', { preference: 'en' })).status, 200);
});

test('I18N-D03: нормализация сохраняет язык; invalid/missing означают system', () => {
  for (const uiLanguage of ['en', 'ru', 'system']) {
    assert.equal(normalizeSettings({ version: 2, uiLanguage }).uiLanguage ?? 'system', uiLanguage);
  }

  for (const uiLanguage of [undefined, null, 'wrong', 4, {}]) {
    assert.equal(normalizeSettings({ version: 2, uiLanguage }).uiLanguage ?? 'system', 'system');
  }
});

for (const languageFirst of [true, false]) {
  test(`I18N-D03: язык ${languageFirst ? 'до' : 'после'} машины переживает общий save и restart`,
    async (t) => {
    const f = await fixture(t);

    if (languageFirst) {
      assert.equal((await f.request('locale', { preference: 'en' })).status, 200);
    }

    const added = await f.request('profiles', { local: true });

    assert.equal(added.status, 200);

    if (!languageFirst) {
      assert.equal((await f.request('locale', { preference: 'en' })).status, 200);
    }

    const id = f.runtime.profiles.settings.selected;

    assert.ok(id);
    assert.equal((await f.request('select', { id })).status, 200);
    assert.equal((await readSettings(f.file)).uiLanguage, 'en');
    await f.restart();
    assert.equal(f.runtime.shell.state().locale.preference, 'en');
    assert.equal(f.runtime.profiles.settings.selected, id);
    assert.equal(f.runtime.profiles.settings.profiles.length, 1);
    assert.equal(f.runtime.profiles.settings.profiles[0].name, 'Этот компьютер');
    assert.equal((await f.request('locale', { preference: 'ru' })).status, 200);
  });
}
