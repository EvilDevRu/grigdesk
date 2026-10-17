import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_WINDOW,
  normalizeSettings,
  readSettings,
  writeSettings,
} from '../../desktop/src/settings.ts';

const defaults = {
  version: 1,
  connection: null,
  window: { ...DEFAULT_WINDOW },
};
const first = {
  version: 1,
  connection: {
    kind: 'local',
    origin: 'http://127.0.0.1',
  },
  window: {
    width: 900,
    height: 700,
    maximized: false,
  },
};
const second = {
  version: 1,
  connection: {
    kind: 'local',
    origin: 'http://127.0.0.1:2',
  },
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
      version: 2,
    }),
    JSON.stringify({
      ...first,
      version: '1',
    }),
    JSON.stringify({
      connection: first.connection,
      window: first.window,
    }),
    'null',
  ]) {
    await fs.writeFile(file, value);
    assert.deepEqual(await readSettings(file), defaults);
  }
});

test('DW-09: неверная connection не портит окно версии 1', async (t) => {
  const { root } = await fixture(t);
  const file = path.join(root, 'settings.json');

  for (const connection of [
    null,
    [],
    'http://127.0.0.1:2',
    {
      kind: 'remote',
      origin: 'http://127.0.0.1:2',
    },
    {
      kind: 'local',
      origin: 'http://localhost:8140',
    },
    {
      kind: 'local',
      origin: 'http://127.0.0.1:80',
    },
  ]) {
    const input = {
      ...first,
      connection,
    };
    const expected = {
      ...first,
      connection: null,
    };

    assert.deepEqual(normalizeSettings(input), expected);
    await fs.writeFile(file, JSON.stringify(input));
    assert.deepEqual(await readSettings(file), expected);
  }

  assert.deepEqual(normalizeSettings(first), first);
  assert.deepEqual(normalizeSettings(second), second);
  assert.deepEqual(normalizeSettings({
    ...first,
    window: null,
  }), {
    ...first,
    window: { ...DEFAULT_WINDOW },
  });
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
