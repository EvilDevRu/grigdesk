import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

import { artifactsPath } from '../../shared/runtime/dataHome.ts';
import { createApplicationLauncher } from '../../desktop/src/applicationLauncher.ts';
import { applicationLauncherApi } from '../../desktop/src/pipe/applicationLauncherApi.ts';

/**
 * Все ярлыки и бинарник принадлежат одноразовому каталогу, настоящие HOME/XDG не меняются.
 * Имя бинарника содержит символы Exec, чтобы проверять файловый результат без запуска shell.
 */
async function fixture(t) {
  const directory = path.join(artifactsPath({ env: process.env, home: os.homedir() }), 'startup-settings');

  await fs.mkdir(directory, { recursive: true });

  const root = await fs.mkdtemp(path.join(directory, 'launcher-'));
  const home = path.join(root, 'home');
  const config = path.join(root, 'config');
  const data = path.join(root, 'data');
  const executablePath = path.join(root, 'копия с пробелом "100%" $`\\', 'GrigDesk');

  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.dirname(executablePath), { recursive: true });
  await fs.mkdir(home);
  await fs.mkdir(config);
  await fs.writeFile(executablePath, 'Бинарник фикстуры', { mode: 0o755 });

  const launcher = createApplicationLauncher({
    executablePath,
    home,
    env: { XDG_CONFIG_HOME: config, XDG_DATA_HOME: data },
  });

  return {
    root,
    home,
    config,
    executablePath,
    launcher,
    menu: path.join(data, 'applications/grigdesk.desktop'),
    autostart: path.join(config, 'autostart/grigdesk-app.desktop'),
  };
}

test('меню работает без Desktop и checkout, Exec указывает на текущий бинарник', async (t) => {
  const box = await fixture(t);
  const before = await box.launcher.read();

  assert.equal(before.autostart, false);
  assert.deepEqual(before.shortcut, { desktop: false, menu: false });

  const state = await box.launcher.setShortcut(true);
  const content = await fs.readFile(box.menu, 'utf8');
  const exec = content.split('\n').find((line) => line.startsWith('Exec='));

  assert.deepEqual(state.shortcut, { desktop: false, menu: true });
  assert.equal(state.executablePath, box.executablePath);
  assert.ok(exec.startsWith('Exec="'));
  assert.match(exec, /100%%/u);
  assert.ok(exec.includes('\\\\"'));
  assert.ok(exec.includes('\\\\$'));
  assert.ok(exec.includes('\\\\`'));
  assert.ok(exec.includes('\\\\\\\\'));
  assert.doesNotMatch(content, /systemctl|deploy\/|\.mount_|bash|node /u);
  assert.equal((await fs.stat(box.menu)).mode & 0o777, 0o755);
  await assert.rejects(fs.stat(box.autostart), { code: 'ENOENT' });

  await box.launcher.setShortcut(false);
  await assert.rejects(fs.stat(box.menu), { code: 'ENOENT' });
});

test('автозапуск окна и оба ярлыка независимы, Desktop берётся из локального XDG', async (t) => {
  const box = await fixture(t);
  const desktop = path.join(box.home, 'Рабочий стол');

  await fs.mkdir(desktop);
  await fs.writeFile(path.join(box.config, 'user-dirs.dirs'), 'XDG_DESKTOP_DIR="$HOME/Рабочий стол"\n');
  await box.launcher.setAutostart(true);
  assert.equal((await box.launcher.read()).autostart, true);
  await assert.rejects(fs.stat(box.menu), { code: 'ENOENT' });

  const state = await box.launcher.setShortcut(true);

  assert.deepEqual(state.shortcut, { desktop: true, menu: true });
  assert.equal(await fs.readFile(box.autostart, 'utf8'), await fs.readFile(box.menu, 'utf8'));
  await box.launcher.setShortcut(false);
  assert.equal((await box.launcher.read()).autostart, true);
  await assert.rejects(fs.stat(path.join(desktop, 'grigdesk.desktop')), { code: 'ENOENT' });
  await box.launcher.setAutostart(false);
  assert.equal((await box.launcher.read()).autostart, false);
});

test('GIO запускает точный файл с пробелами, кириллицей и буквальным процентом', async (t) => {
  const run = promisify(execFile);
  const available = await run('gio', ['version']).then(() => true, (error) => {
    if (error.code === 'ENOENT') {
      return false;
    }

    throw error;
  });

  if (!available) {
    t.skip('GIO не установлен');

    return;
  }

  const box = await fixture(t);
  const output = path.join(box.root, 'launched.json');
  const script = [
    '#!/usr/bin/env node',
    'require("node:fs").writeFileSync(process.env.GRIGDESK_LAUNCH_PROBE_FILE,',
    'JSON.stringify(process.argv.slice(1)));',
    '',
  ].join('\n');

  await fs.writeFile(box.executablePath, script, { mode: 0o755 });
  await box.launcher.setShortcut(true);
  await run('gio', ['launch', box.menu], {
    env: { ...process.env, GRIGDESK_LAUNCH_PROBE_FILE: output },
    timeout: 3000,
  });

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await fs.readFile(output, 'utf8').catch(() => null);

    if (result) {
      assert.deepEqual(JSON.parse(result), [box.executablePath]);

      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.fail('Созданный ярлык не запустил тестовый файл');
});

test('HOME отключает Desktop; относительный XDG использует стандартные каталоги', async (t) => {
  const box = await fixture(t);
  const config = path.join(box.home, '.config');

  await fs.mkdir(config);
  await fs.writeFile(path.join(config, 'user-dirs.dirs'), 'XDG_DESKTOP_DIR="$HOME"\n');

  const launcher = createApplicationLauncher({
    executablePath: box.executablePath,
    home: box.home,
    env: { XDG_CONFIG_HOME: 'relative', XDG_DATA_HOME: 'relative' },
  });

  assert.deepEqual((await launcher.setShortcut(true)).shortcut, { desktop: false, menu: true });
  await fs.stat(path.join(box.home, '.local/share/applications/grigdesk.desktop'));
  await assert.rejects(fs.stat(path.join(box.home, 'grigdesk.desktop')), { code: 'ENOENT' });
});

/**
 * Проверяется настоящий обработчик закрытого native API без живого окна и сети.
 * Тело остаётся недоверенным: путь запуска и лишние ключи не доходят до файлового порта.
 */
async function request(method, body, launcher) {
  const req = Readable.from([]);
  let result;
  const res = {
    writeHead(status) {
      this.statusCode = status;
    },
    end(text) {
      result = JSON.parse(text);
    },
  };

  req.method = method;
  await applicationLauncherApi(req, res, body, launcher);

  return { status: res.statusCode, result };
}

test('native API принимает только boolean и не зависит от выбранного сервера', async (t) => {
  const box = await fixture(t);

  assert.equal((await request('GET', {}, undefined)).status, 404);
  assert.equal((await request('GET', {}, box.launcher)).result.executablePath, box.executablePath);

  for (const body of [null, [], {}, { autostart: 'true' },
    { autostart: true, executablePath: '/other' }, { autostart: true, shortcut: true }]) {
    assert.equal((await request('POST', body, box.launcher)).status, 400);
  }

  assert.equal((await request('POST', { shortcut: true }, box.launcher)).result.shortcut.menu, true);
  assert.equal((await request('POST', { autostart: true }, box.launcher)).result.autostart, true);
  assert.equal((await request('DELETE', {}, box.launcher)).status, 400);
});
