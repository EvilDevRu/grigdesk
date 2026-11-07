import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';

import { createBrowserApps, normalizeManualBrowserApps } from '../../desktop/src/browser/browserApps.ts';

import {
  DEFAULT_WINDOW,
  normalizeSettings,
  readSettings,
  writeSettings,
  updateSettings,
} from '../../desktop/src/settings.ts';

const defaults = {
  version: 2,
  profiles: [],
  selected: null,
  window: { ...DEFAULT_WINDOW },
};
const first = {
  version: 2,
  selected: 'local',
  profiles: [{
    id: 'local',
    name: 'Этот компьютер',
    kind: 'local',
    address: 'http://127.0.0.1',
    fp: null,
    port: 47101,
    createdAt: 0,
  }],
  window: {
    width: 900,
    height: 700,
    maximized: false,
  },
};
const second = {
  version: 2,
  selected: 'local',
  profiles: [{
    id: 'local',
    name: 'Этот компьютер',
    kind: 'local',
    address: 'http://127.0.0.1:2',
    fp: null,
    port: 47101,
    createdAt: 0,
  }],
  window: {
    width: 1400,
    height: 1000,
    maximized: true,
  },
};

/**
 * Каждая проверка получает собственный каталог и убирает только свои файлы.
 * Права каталога не подменяют детерминированный отказ операции файловой системы.
 */
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-settings-'));

  t.after(() => fs.rm(root, {
    recursive: true,
    force: true,
  }));

  return {
    root,
    file: path.join(root, 'profile', 'settings.json'),
  };
}

test('DW-07: нет файла — defaults', async (t) => {
  assert.deepEqual(DEFAULT_WINDOW, {
    width: 1280,
    height: 860,
    maximized: false,
  });

  const { file } = await fixture(t);

  assert.deepEqual(await readSettings(file), defaults);
});

test('DW-08: битый JSON, массив и чужая version — defaults', async (t) => {
  const { root } = await fixture(t);
  const file = path.join(root, 'settings.json');

  for (const value of [
    '{broken',
    JSON.stringify([first]),
    JSON.stringify({
      ...first,
      version: 99,
    }),
    JSON.stringify({
      ...first,
      version: '1',
    }),
    JSON.stringify({
      profiles: first.profiles,
      window: first.window,
    }),
    'null',
  ]) {
    await fs.writeFile(file, value);
    assert.deepEqual(await readSettings(file), defaults);
  }
});

test('DW-09: неверный профиль не портит окно, v1 мигрирует без записи', async (t) => {
  const { root } = await fixture(t);
  const file = path.join(root, 'settings.json');
  const input = { ...first, profiles: [{ kind: 'unexpected' }] };
  const expected = {
    ...first,
    profiles: [],
    selected: null,
  };

  assert.deepEqual(normalizeSettings(input), expected);
  await fs.writeFile(file, JSON.stringify(input));
  assert.deepEqual(await readSettings(file), expected);
  assert.equal(await fs.readFile(file, 'utf8'), JSON.stringify(input));
  assert.deepEqual(normalizeSettings(first), first);
  assert.deepEqual(normalizeSettings(second), second);
  assert.deepEqual(normalizeSettings({ ...first, window: null }).window, { ...DEFAULT_WINDOW });
});

test('D6/DW-09: шесть неверных v1-подключений не портят геометрию при миграции', async (t) => {
  const { file } = await fixture(t);

  for (const connection of [null, [], 'http://127.0.0.1:2',
    { kind: 'local', origin: 'http://127.0.0.1:80' }, { kind: 'remote', origin: 'http://127.0.0.1' },
    { kind: 'local', origin: 'https://127.0.0.1:8140' },
    { kind: 'local', origin: 'http://localhost:8140' },
    { kind: 'local', origin: 'http://127.0.0.1:8140/path' }]) {
    const input = {
      version: 1,
      connection,
      window: first.window
    };
    const expected = { ...defaults, window: first.window };

    await writeSettings(file, input);
    assert.deepEqual(normalizeSettings(input), expected);
    assert.deepEqual(await readSettings(file), expected);
  }
});

test('DW-10: размеры нормализованы', () => {
  for (const [window, expected] of [
    [
      {
        width: 100,
        height: 99999,
        maximized: true,
      },
      {
        width: 600,
        height: 10000,
        maximized: true,
      },
    ],
    [
      {
        width: 900.4,
        height: 700.6,
        maximized: false,
      },
      {
        width: 900,
        height: 701,
        maximized: false,
      },
    ],
    [
      {
        width: NaN,
        height: Infinity,
        maximized: 'true',
      },
      { ...DEFAULT_WINDOW },
    ],
    [
      {
        width: '900',
        height: null,
        maximized: 1,
      },
      { ...DEFAULT_WINDOW },
    ],
    [
      {
        width: 1500,
        height: -Infinity,
      },
      {
        width: 1500,
        height: 860,
        maximized: false,
      },
    ],
    [[], { ...DEFAULT_WINDOW }],
    [null, { ...DEFAULT_WINDOW }],
  ]) {
    assert.deepEqual(normalizeSettings({
      ...first,
      window,
    }).window, expected);
  }
});

test('DW-11: последняя запись атомарна', async (t) => {
  const { file } = await fixture(t);
  const directory = path.dirname(file);

  await fs.mkdir(directory, { mode: 0o700 });
  await fs.writeFile(file, JSON.stringify(defaults), { mode: 0o600 });

  const rename = fs.rename;
  const observed = [];
  const temporaries = [];

  t.mock.method(fs, 'rename', async (temporary, destination) => {
    observed.push(JSON.parse(await fs.readFile(destination, 'utf8')));
    temporaries.push(temporary);
    assert.equal((await fs.stat(temporary)).mode & 0o777, 0o600);
    await rename(temporary, destination);
  });

  await Promise.all([writeSettings(file, first), writeSettings(file, second)]);

  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), second);
  assert.deepEqual(observed, [defaults, first]);
  assert.equal(new Set(temporaries).size, 2);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
  assert.deepEqual(await fs.readdir(directory), ['settings.json']);
});

test('DW-11/rename: отказ сохраняет старый файл, очищает temporary и не ломает очередь', async (t) => {
  const { root } = await fixture(t);
  const file = path.join(root, 'settings.json');

  await fs.writeFile(file, JSON.stringify(first), { mode: 0o600 });

  const renameMock = t.mock.method(fs, 'rename', async () => {
    throw new Error('Тестовый отказ rename');
  });

  await assert.rejects(writeSettings(file, second), /Тестовый отказ rename/);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), first);
  assert.deepEqual(await fs.readdir(root), ['settings.json']);

  renameMock.mock.restore();
  await writeSettings(file, second);
  assert.deepEqual(await readSettings(file), second);
});

test('DW-11/symlink: ссылка файла и ссылка личного каталога не меняют внешний файл', async (t) => {
  const { root, file } = await fixture(t);
  const outside = path.join(root, 'outside');

  await fs.mkdir(outside, { mode: 0o700 });
  await fs.writeFile(path.join(outside, 'settings.json'), JSON.stringify(first), { mode: 0o600 });
  await fs.symlink(outside, path.dirname(file));

  await assert.rejects(writeSettings(file, second));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(outside, 'settings.json'), 'utf8')), first);

  const linkFile = path.join(root, 'settings.json');

  await fs.symlink(path.join(outside, 'settings.json'), linkFile);
  await assert.rejects(writeSettings(linkFile, second));
  assert.equal((await fs.lstat(linkFile)).isSymbolicLink(), true);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(outside, 'settings.json'), 'utf8')), first);
});

test('DW-11/каталог: новый личный каталог имеет 0700, произвольный родитель не chmod', async (t) => {
  const { root, file } = await fixture(t);

  await writeSettings(file, second);
  assert.equal(await fs.access(file).then(() => true, () => false), true);
  assert.equal((await fs.stat(path.dirname(file))).mode & 0o777, 0o700);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);

  const parent = path.join(root, 'shared');

  await fs.mkdir(parent, { mode: 0o755 });
  await assert.rejects(writeSettings(path.join(parent, 'settings.json'), first));
  assert.equal((await fs.stat(parent)).mode & 0o777, 0o755);
  assert.deepEqual(await fs.readdir(parent), []);
});

test('BR02: browser сохраняется вместе с геометрией и профилями', async (t) => {
  const { file } = await fixture(t);
  const browser = {
    open: 'internal',
    external: 'app:firefox',
    agents: true
  };
  const settings = normalizeSettings({ ...first, browser });

  assert.deepEqual(settings.browser, browser);
  await writeSettings(file, settings);

  const loaded = await readSettings(file);

  assert.deepEqual(loaded.browser, browser);
  assert.deepEqual(loaded.profiles, settings.profiles);
  assert.deepEqual(loaded.window, settings.window);
});

test('BR07-Q: browser commit и следующая геометрия не теряют поля друг друга', async (t) => {
  const { file } = await fixture(t);
  const settings = normalizeSettings(first);
  const browser = {
    open: 'internal',
    external: 'system',
    agents: true
  };
  const browserSave = updateSettings(file, settings, { browser });

  settings.window.width = 1777;

  const geometrySave = writeSettings(file, settings);

  await Promise.all([browserSave, geometrySave]);

  const loaded = await readSettings(file);

  assert.deepEqual(loaded.browser, browser);
  assert.equal(loaded.window.width, 1777);
});

test('BR-M01: manual register переживает restart и последующие записи geometry/preferences', async (t) => {
  const { root, file } = await fixture(t);
  const executable = path.join(root, 'browser');

  await fs.writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });

  const settings = normalizeSettings(first);
  const manual = structuredClone(settings.manualBrowserApps ?? []);
  const apps = createBrowserApps({
    dataHome: path.join(root, 'xdg'),
    dataDirs: [],
    manual,
    save: () => updateSettings(file, settings, { manualBrowserApps: structuredClone(manual) }),
  });
  const selected = await apps.registerManual(executable);

  await updateSettings(file, settings, { browser: {
    open: 'external',
    external: selected.id,
    agents: false,
  } });
  settings.window.width = 1333;
  settings.profiles[0].name = 'Renamed fixture';
  await writeSettings(file, settings);

  const loaded = await readSettings(file);
  const restarted = createBrowserApps({
    dataHome: path.join(root, 'xdg'),
    dataDirs: [],
    manual: loaded.manualBrowserApps,
  });

  assert.equal(loaded.browser.external, selected.id);
  assert.equal(loaded.window.width, 1333);
  assert.equal(loaded.profiles[0].name, 'Renamed fixture');
  assert.deepEqual(await restarted.resolve(selected.id), { command: executable, args: [] });
  await fs.unlink(executable);
  assert.equal(await restarted.resolve(selected.id), null);
  await writeSettings(file, loaded);
  assert.equal((await readSettings(file)).manualBrowserApps[0].id, selected.id);
});

test('BR-M02: private normalizer bounded; 33-я регистрация не становится ephemeral ID', async (t) => {
  const { root } = await fixture(t);
  const executable = path.join(root, 'existing');
  const other = path.join(root, 'new');

  await fs.writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  await fs.writeFile(other, '#!/bin/sh\nexit 0\n', { mode: 0o700 });

  const manual = Array.from({ length: 32 }, (_, index) => ({
    id: `app:manual-${randomUUID()}`,
    path: index === 0 ? executable : path.join(root, `unused-${index}`),
    name: `Fixture ${index}`,
  }));
  const bad = {
    id: 'app:manual-forged',
    path: '/bad',
    name: 'Bad'
  };
  const extra = {
    id: `app:manual-${randomUUID()}`,
    path: other,
    name: 'Other'
  };
  const normalized = normalizeManualBrowserApps([bad, manual[0], manual[0], ...manual.slice(1), extra]);

  assert.equal(normalized.length, 32);
  assert.equal(normalized.some((entry) => entry.path === other), false);

  let saves = 0;
  const apps = createBrowserApps({
    dataHome: root,
    dataDirs: [],
    manual,
    save: async () => {
      saves += 1;
    }
  });

  assert.deepEqual(await apps.registerManual(executable), { id: manual[0].id, name: manual[0].name });
  await assert.rejects(() => apps.registerManual(other), /browser_app_limit/u);
  assert.equal(saves, 0);
  assert.equal(manual.length, 32);
});

test('BR-M03: failed pending register не отдаёт второй операции неподтверждённый ID', async (t) => {
  const { root } = await fixture(t);
  const executable = path.join(root, 'browser');

  await fs.writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });

  let entered;
  let release;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let saves = 0;
  const manual = [];
  const apps = createBrowserApps({
    dataHome: root,
    dataDirs: [],
    manual,
    save: async () => {
      saves += 1;

      if (saves === 1) {
        entered();
        await gate;

        throw new Error('disk');
      }
    }
  });
  const first = apps.registerManual(executable);
  const rejected = assert.rejects(first, /disk/u);

  await started;

  let secondSettled = false;
  const second = apps.registerManual(executable).then((value) => {
    secondSettled = true;

    return value;
  });

  assert.equal(secondSettled, false);
  release();
  await rejected;

  const selected = await second;

  assert.equal(saves, 2);
  assert.equal(manual.length, 1);
  assert.equal(manual[0].id, selected.id);
});
