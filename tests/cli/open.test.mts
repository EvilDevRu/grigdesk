import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { HELP_TEXT } from '../../cli/args.ts';
import { parseLockTarget, readWindow, windowAppPath, windowDataDir } from '../../cli/window.ts';
import { completed, createSandbox } from './helpers/sandbox.mts';

test('CO-1 пути установки и профиля', () => {
  assert.equal(windowAppPath('/opt/копия grigdesk'), '/opt/копия grigdesk/bin/grigdesk-app');
  assert.equal(windowDataDir({
    HOME: '/home/user',
    GRIGDESK_DESKTOP_DATA_DIR: '/profile',
  }), '/profile');
  assert.equal(windowDataDir({
    HOME: '/home/user',
    GRIGDESK_DESKTOP_DATA_DIR: 'relative',
  }),
    '/home/user/.config/GrigDesk');
});

test('CO-2 блокировка: последний дефис и положительный целый PID', () => {
  assert.deepEqual(parseLockTarget('host-name-123'), {
    host: 'host-name',
    pid: 123,
  });

  for (const target of ['host', 'host-abc', 'host-0', '-12', 'host-1.5']) {
    assert.equal(parseLockTarget(target), null);
  }
});

test('CO-3 настоящие ссылки и завершившийся процесс', async (t) => {
  const box = await createSandbox(t);
  const env = {
    HOME: box.home,
    XDG_CONFIG_HOME: path.join(box.home, 'config'),
    XDG_DATA_HOME: path.join(box.home, 'data'),
  };

  box.lock(`${os.hostname()}-${process.pid}`);
  assert.equal(await readWindow(box.root, env), 'open');
  rmSync(path.join(env.XDG_CONFIG_HOME, 'GrigDesk/SingletonLock'));
  box.installWindow();

  const child = spawn(process.execPath, ['-e', '']);
  const pid = child.pid;

  assert.ok(pid);
  await completed(child);
  box.lock(`${os.hostname()}-${pid}`);
  assert.equal(await readWindow(box.root, env), 'closed');
  rmSync(path.join(env.XDG_CONFIG_HOME, 'GrigDesk/SingletonLock'));
  rmSync(path.join(box.root, 'bin/grigdesk-app'));
  assert.equal(await readWindow(box.root, env), 'not_installed');
});

test('CO-4 с descriptor: окно запущено, systemctl не вызывался, HTTP-запросов нет', async (t) => {
  const box = await createSandbox(t);

  box.installWindow();
  box.installRuntime();
  await box.serve('grigdesk');

  const result = await box.run([]);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Окно открывается/);
  await box.waitFor(() => box.calls().some((call) => call.startsWith('app ')));
  assert.ok(!box.calls().some((call) => call.startsWith('systemctl ')), box.calls().join('\n'));
  assert.deepEqual(box.requests(), []);

  // Справка не обещает запрос сервера без оговорки про переходный режим.
  const help = HELP_TEXT.replace(/\s+/gu, ' ');
  const promise = 'Открыть окно GrigDesk; сервер поднимает само окно (без runtime.json — через службу)';

  assert.ok(help.includes(promise), HELP_TEXT);
  assert.doesNotMatch(help, /запросить запуск сервера/u);
});

test('CO-5 ровно один аргумент, только путь ключа из .env', async (t) => {
  const box = await createSandbox(t);

  box.installWindow();
  writeFileSync(path.join(box.home, '.grigdesk/.env'), [
    `GRIGDESK_PORT=${box.port}`,
    'GRIGDESK_WINDOW_KEY_PATH=/run/test/key',
    'SECRET_TOKEN=s3cret',
  ].join('\n'));

  const result = await box.run(['open']);

  assert.equal(result.code, 0, result.stderr);
  await box.waitFor(() => box.calls().some((call) => call.startsWith('app-secret ')));
  assert.ok(box.calls().includes(`app --grigdesk-url=http://127.0.0.1:${box.port}/`));
  assert.ok(box.calls().includes('app-argc 1'));
  assert.ok(box.calls().includes('app-key /run/test/key'));
  assert.ok(box.calls().includes('app-secret '));
});

test('CO-6 без descriptor: готовый сервер не стартует повторно, остановленный получает start', async (t) => {
  const ready = await createSandbox(t);

  ready.installWindow();
  ready.unit({ ActiveState: 'active' });
  await ready.serve('grigdesk');

  assert.equal((await ready.run([])).code, 0);
  assert.ok(!ready.calls().some((call) => call.includes(' start ')));
  assert.ok(ready.requests().includes('/api/auth/state'), 'без descriptor сервер спрошен');

  // Неразборчивый descriptor равен отсутствующему: окно запускается прежде удержанного
  // systemd, а остановленный сервер получает start.
  const stopped = await createSandbox(t);

  stopped.installWindow();
  stopped.installRuntime('{"version":2}');

  const release = stopped.hold();

  t.after(release);

  const output = completed(stopped.spawn([]));

  await stopped.waitFor(() => stopped.calls().some((call) => call.startsWith('app ')));
  await stopped.waitFor(() => stopped.calls().some((call) => call.startsWith('systemctl ')));

  const app = stopped.calls().findIndex((call) => call.startsWith('app '));
  const systemd = stopped.calls().findIndex((call) => call.startsWith('systemctl '));

  assert.ok(app < systemd, stopped.calls().join('\n'));
  release();

  const result = await output;

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Окно открывается/);
  assert.equal(stopped.calls().filter((call) =>
    call === 'systemctl --user start --no-block grigdesk-server.service').length, 1);
});

test('CO-7 нет окна: с descriptor — ошибка без запроса сервера; без — прежнее поведение', async (t) => {
  const described = await createSandbox(t);

  described.installRuntime();
  await described.serve('grigdesk');

  const refused = await described.run([]);

  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /grigdesk-ctl desktop install/);
  assert.deepEqual(described.calls(), []);
  assert.deepEqual(described.requests(), []);

  const legacy = await createSandbox(t);
  const result = await legacy.run([]);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /grigdesk-ctl desktop install/);
  assert.ok(legacy.calls().includes('systemctl --user start --no-block grigdesk-server.service'));
  assert.ok(!legacy.calls().some((call) => call.startsWith('xdg-open ')));
});

test('CO-8 нет графического сеанса: с descriptor — ошибка без запроса сервера; без — прежнее', async (t) => {
  const headless = {
    DISPLAY: undefined,
    WAYLAND_DISPLAY: undefined,
  };
  const described = await createSandbox(t);

  described.installWindow();
  described.installRuntime();
  await described.serve('grigdesk');

  const refused = await described.run([], headless);

  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /Нет графического сеанса/);
  assert.deepEqual(described.calls(), []);
  assert.deepEqual(described.requests(), []);

  const legacy = await createSandbox(t);

  legacy.installWindow();

  const result = await legacy.run([], headless);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /Нет графического сеанса/);
  assert.ok(!legacy.calls().some((call) => call.startsWith('app ')));
  assert.ok(legacy.calls().includes('systemctl --user start --no-block grigdesk-server.service'));
});

test('CO-9 сторож окна до эффектов, force разрешает', async (t) => {
  const box = await createSandbox(t);

  box.installWindow();
  writeFileSync(path.join(box.home, 'cgroup'), '0::/user.slice/grigdesk-server.service');

  const refused = await box.run([]);

  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /ход агента/);
  assert.match(refused.stderr, /--force/);
  assert.deepEqual(box.calls(), []);
  assert.equal((await box.run(['open', '--force'])).code, 0);
  await box.waitFor(() => box.calls().some((call) => call.startsWith('app ')));
});
