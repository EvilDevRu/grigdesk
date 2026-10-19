import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { selectSeaServer } from '../../server/src/lib/selectSeaServer.ts';
import { processStarttime } from '../../server/src/lib/dataHomeBoot.ts';

/**
 * Установка и папка данных фиктивные, проверка SEA заменена явным портом.
 * Настоящие descriptor, профили и серверы машины не читаются и не меняются.
 */
async function fixture(t) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-sea-select-'));
  const root = path.join(temp, 'release');
  const home = path.join(temp, 'home');
  const data = path.join(temp, 'data');
  const previousRoot = path.join(temp, 'source');
  const xdg = path.join(temp, 'xdg');
  const runtimePath = path.join(xdg, 'grigdesk/desktop/runtime.json');
  const previous = JSON.stringify({
    version: 2,
    root: previousRoot,
    node: '/fixture/node',
    home: data,
  });

  t.after(() => rm(temp, { recursive: true, force: true }));

  for (const directory of [root, home, data, previousRoot, path.dirname(runtimePath)]) {
    await mkdir(directory, { recursive: true });
  }

  await writeFile(runtimePath, previous, { mode: 0o600 });
  await writeFile(path.join(path.dirname(runtimePath), 'runtime-version'), '3\n');

  return {
    root,
    home,
    data,
    runtimePath,
    previous,
    previousRoot,
    env: {
      HOME: home,
      XDG_DATA_HOME: xdg,
      GRIGDESK_HOME: data,
    },
    verify: async () => {},
  };
}

test('SEA-SELECT-01: физический R и D публикуются атомарно, прежний descriptor сохранён', async (t) => {
  const input = await fixture(t);
  const alias = path.join(path.dirname(input.root), 'release-link');

  await symlink(input.root, alias);
  await selectSeaServer({ ...input, root: alias });

  assert.deepEqual(JSON.parse(await readFile(input.runtimePath, 'utf8')), {
    version: 3,
    kind: 'sea',
    root: input.root,
    home: input.data,
  });
  assert.equal(await readFile(`${input.runtimePath}.previous`, 'utf8'), input.previous);
  assert.equal((await stat(input.runtimePath)).mode & 0o777, 0o600);
  await selectSeaServer(input);
  assert.equal(await readFile(`${input.runtimePath}.previous`, 'utf8'), input.previous);
});

test('SEA-SELECT-02: ошибка проверки сохраняет оба descriptor и не создаёт D', async (t) => {
  const input = await fixture(t);
  const backup = `${input.runtimePath}.previous`;
  const futureData = path.join(path.dirname(input.data), 'future-data');

  await writeFile(backup, 'previous backup');
  await assert.rejects(selectSeaServer({
    ...input,
    env: { ...input.env, GRIGDESK_HOME: futureData },
    verify: async () => {
      throw new Error('fixture corrupt package');
    },
  }), /corrupt/);
  assert.equal(await readFile(input.runtimePath, 'utf8'), input.previous);
  assert.equal(await readFile(backup, 'utf8'), 'previous backup');
  assert.equal(await stat(futureData).catch(() => null), null);
});

test('SEA-SELECT-03: живой владелец lock запрещает выбор без сигналов и замены descriptor', async (t) => {
  const input = await fixture(t);
  const lock = path.join(input.data, 'state/server.lock');

  await mkdir(path.dirname(lock));
  await writeFile(lock, JSON.stringify({ pid: process.pid, starttime: processStarttime(process.pid) }));
  await assert.rejects(selectSeaServer(input), /пользуется сервер|занята сервером/);
  assert.equal(await readFile(input.runtimePath, 'utf8'), input.previous);
  assert.equal(JSON.parse(await readFile(lock, 'utf8')).pid, process.pid);
});

test('SEA-SELECT-04: source-профили требуют явного выбора, старое окно требует обновления', async (t) => {
  const input = await fixture(t);

  await mkdir(path.join(input.previousRoot, 'profiles'));
  await assert.rejects(selectSeaServer(input), /FACTORY_PROFILES_DIR/);
  await mkdir(path.join(input.data, 'profiles'));
  await selectSeaServer({
    ...input,
    env: { ...input.env, FACTORY_PROFILES_DIR: path.join(input.data, 'profiles') },
  });
  await writeFile(path.join(path.dirname(input.runtimePath), 'runtime-version'), '2\n');
  await assert.rejects(selectSeaServer(input), /обновлённое окно/);
});

test('SEA-SELECT-05: нестандартный профиль должен сохраняться для будущего запуска окна', async (t) => {
  const input = await fixture(t);
  const profiles = path.join(input.previousRoot, 'profiles');

  await mkdir(profiles);
  await assert.rejects(selectSeaServer({
    ...input,
    env: { ...input.env, FACTORY_PROFILES_DIR: profiles },
  }), /\.env/);
  await writeFile(path.join(input.data, '.env'), `FACTORY_PROFILES_DIR=${profiles}\n`);
  await selectSeaServer(input);
  assert.equal(JSON.parse(await readFile(input.runtimePath, 'utf8')).version, 3);
});

test('SEA-SELECT-06: смена D не обходит lock прежнего выбранного сервера', async (t) => {
  const input = await fixture(t);
  const lock = path.join(input.data, 'state/server.lock');

  await mkdir(path.dirname(lock));
  await writeFile(lock, JSON.stringify({ pid: process.pid, starttime: processStarttime(process.pid) }));
  await assert.rejects(selectSeaServer({
    ...input,
    env: { ...input.env, GRIGDESK_HOME: path.join(path.dirname(input.data), 'other-data') },
  }), /пользуется сервер|занята сервером/);
  assert.equal(await readFile(input.runtimePath, 'utf8'), input.previous);
});

test('REVIEW-P12: занятый select-lock объясняет отказ и сохраняет descriptor', async (t) => {
  const input = await fixture(t);
  const lock = `${input.runtimePath}.select-lock`;

  await mkdir(lock);
  await assert.rejects(selectSeaServer(input), (error) => {
    assert.doesNotMatch(error.message, /EEXIST/);
    assert.ok(error.message.includes(lock));
    assert.match(error.message, /выбор.*сервера.*заблокирован|блокировка.*выбора/i);
    assert.match(error.message, /повторите|проверьте/);

    return true;
  });
  assert.equal(await readFile(input.runtimePath, 'utf8'), input.previous);
  assert.equal((await stat(lock)).isDirectory(), true);
});
