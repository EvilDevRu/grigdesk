import test from 'node:test';
import assert from 'node:assert/strict';

import { LauncherError, LauncherService, parseShortcutStatus } from '../../server/src/lib/launcher.ts';

// Фальшивый runner: ответы по ключу «команда аргументы», журнал вызовов — для проверки порядка.
// Ответ-функция получает журнал и может зависеть от уже сделанных вызовов (enable → enabled).
function fakeRunner(answers) {
  const calls = [];
  const runner = async (file, args) => {
    const key = `${file} ${args.join(' ')}`;
    calls.push(key);
    const found = answers[key];
    const answer = typeof found === 'function' ? found(calls) : found;
    if (!answer) return { code: 1, signal: null, timedOut: false, stdout: '', stderr: `нет ответа: ${key}` };
    return { code: 0, signal: null, timedOut: false, stdout: '', stderr: '', ...answer };
  };
  return { runner, calls };
}

// is-enabled, который «замечает» свой enable/disable в журнале вызовов.
function enabledAfterToggle(initial) {
  return (calls) => {
    const toggles = calls.filter((call) => /^systemctl --user (enable|disable) /.test(call));
    const last = toggles[toggles.length - 1];
    const enabled = last ? last.includes(' enable ') : initial;
    return enabled ? { stdout: 'enabled\n' } : { stdout: 'disabled\n', code: 1 };
  };
}

const UNIT = 'cockpit-server.service';
const SHORTCUT = 'bash /repo/deploy/shortcut.sh';

function service(answers) {
  const fake = fakeRunner(answers);
  return {
    ...fake,
    launcher: new LauncherService({ rootDir: '/repo', runner: fake.runner, userName: 'tester' }),
  };
}

test('состояние: enabled + linger = старт при включении, ярлык из status-строк скрипта', async () => {
  const { launcher } = service({
    [`systemctl --user is-enabled ${UNIT}`]: { stdout: 'enabled\n' },
    [`systemctl --user is-active ${UNIT}`]: { stdout: 'active\n' },
    'loginctl show-user tester -p Linger --value': { stdout: 'yes\n' },
    [`${SHORTCUT} status`]: { stdout: 'desktop_dir\t/home/test/Рабочий стол\ndesktop\t1\nmenu\t0\n' },
  });

  const state = await launcher.readState();

  assert.deepEqual(state.autostart, { unit: 'enabled', active: true, linger: true, mode: 'boot' });
  assert.deepEqual(state.shortcut, { desktopDir: '/home/test/Рабочий стол', desktop: true, menu: false });
});

test('состояние: enabled без linger — только при входе; disabled — выключен', async () => {
  const withoutLinger = service({
    [`systemctl --user is-enabled ${UNIT}`]: { stdout: 'enabled\n' },
    [`systemctl --user is-active ${UNIT}`]: { stdout: 'inactive\n', code: 3 },
    'loginctl show-user tester -p Linger --value': { stdout: 'no\n' },
  });
  assert.equal((await withoutLinger.launcher.readAutostart()).mode, 'login');

  const disabled = service({
    [`systemctl --user is-enabled ${UNIT}`]: { stdout: 'disabled\n', code: 1 },
    [`systemctl --user is-active ${UNIT}`]: { stdout: 'active\n' },
    'loginctl show-user tester -p Linger --value': { stdout: 'yes\n' },
  });
  const state = await disabled.launcher.readAutostart();
  assert.equal(state.unit, 'disabled');
  assert.equal(state.mode, 'off');
  assert.equal(state.active, true, 'выключенный автозапуск не означает остановленный сервер');
});

test('состояние: юнит не установлен — пустой stdout is-enabled; logind молчит — linger null', async () => {
  const { launcher } = service({
    [`systemctl --user is-enabled ${UNIT}`]: { stdout: '', code: 1, stderr: 'Failed to get unit file state' },
    [`systemctl --user is-active ${UNIT}`]: { stdout: 'inactive\n', code: 3 },
    'loginctl show-user tester -p Linger --value': { code: 1, stderr: 'Failed to get user' },
  });

  const state = await launcher.readAutostart();

  assert.equal(state.unit, 'missing');
  assert.equal(state.linger, null);
  assert.equal(state.mode, 'unavailable');
});

test('включение: enable без --now, linger добивается только когда его нет', async () => {
  const withLinger = service({
    [`systemctl --user is-enabled ${UNIT}`]: enabledAfterToggle(false),
    [`systemctl --user is-active ${UNIT}`]: { stdout: 'active\n' },
    'loginctl show-user tester -p Linger --value': { stdout: 'yes\n' },
    [`systemctl --user enable ${UNIT}`]: { stdout: '' },
  });
  const enabledState = await withLinger.launcher.setAutostart(true);
  assert.equal(enabledState.mode, 'boot');
  assert.ok(withLinger.calls.includes(`systemctl --user enable ${UNIT}`));
  assert.ok(!withLinger.calls.some((call) => call.includes('--now')), 'живой процесс не трогаем');
  assert.ok(!withLinger.calls.includes('loginctl enable-linger tester'), 'linger уже есть');

  const withoutLinger = service({
    [`systemctl --user is-enabled ${UNIT}`]: enabledAfterToggle(false),
    [`systemctl --user is-active ${UNIT}`]: { stdout: 'active\n' },
    'loginctl show-user tester -p Linger --value': { stdout: 'no\n' },
    [`systemctl --user enable ${UNIT}`]: { stdout: '' },
    'loginctl enable-linger tester': { code: 1, stderr: 'Interactive authentication required.' },
  });
  const state = await withoutLinger.launcher.setAutostart(true);
  assert.ok(withoutLinger.calls.includes('loginctl enable-linger tester'));
  assert.equal(state.mode, 'login', 'отказ polkit по linger — не отказ операции, а честное «при входе»');
});

test('выключение: disable без остановки; без юнита — отказ 409', async () => {
  const { launcher, calls } = service({
    [`systemctl --user is-enabled ${UNIT}`]: enabledAfterToggle(true),
    [`systemctl --user is-active ${UNIT}`]: { stdout: 'active\n' },
    'loginctl show-user tester -p Linger --value': { stdout: 'yes\n' },
    [`systemctl --user disable ${UNIT}`]: { stdout: '' },
  });
  const disabledState = await launcher.setAutostart(false);
  assert.equal(disabledState.mode, 'off');
  assert.ok(calls.includes(`systemctl --user disable ${UNIT}`));
  assert.ok(!calls.some((call) => call.startsWith('systemctl --user stop')));
  assert.ok(!calls.includes('loginctl enable-linger tester'));

  const missing = service({
    [`systemctl --user is-enabled ${UNIT}`]: { stdout: '', code: 1 },
    [`systemctl --user is-active ${UNIT}`]: { stdout: 'inactive\n', code: 3 },
    'loginctl show-user tester -p Linger --value': { stdout: 'yes\n' },
  });
  await assert.rejects(
    () => missing.launcher.setAutostart(true),
    (error) => error instanceof LauncherError && error.code === 'unit_missing' && error.statusCode === 409,
  );
});

test('отказ systemctl при переключении — ошибка с хвостом stderr', async () => {
  const { launcher } = service({
    [`systemctl --user is-enabled ${UNIT}`]: { stdout: 'disabled\n', code: 1 },
    [`systemctl --user is-active ${UNIT}`]: { stdout: 'active\n' },
    'loginctl show-user tester -p Linger --value': { stdout: 'yes\n' },
    [`systemctl --user enable ${UNIT}`]: { code: 1, stderr: 'Failed to enable unit: Access denied\n' },
  });

  await assert.rejects(
    () => launcher.setAutostart(true),
    (error) => error instanceof LauncherError && error.code === 'autostart_failed'
      && /Access denied/.test(error.message),
  );
});

test('ярлык: install и remove идут в deploy/shortcut.sh, статус перечитывается после', async () => {
  const status = { stdout: 'desktop_dir\t/home/test/Desktop\ndesktop\t1\nmenu\t1\n' };
  const { launcher, calls } = service({
    [`${SHORTCUT} status`]: status,
    [`${SHORTCUT} install`]: { stdout: 'ярлык создан' },
    [`${SHORTCUT} remove`]: { stdout: 'ярлык убран' },
  });

  const installed = await launcher.installShortcut();
  assert.deepEqual(installed, { desktopDir: '/home/test/Desktop', desktop: true, menu: true });
  assert.deepEqual(calls, [`${SHORTCUT} install`, `${SHORTCUT} status`]);

  await launcher.removeShortcut();
  assert.equal(calls[2], `${SHORTCUT} remove`);

  const failing = service({
    [`${SHORTCUT} install`]: { code: 1, stderr: 'каталог рабочего стола не найден\n' },
  });
  await assert.rejects(
    () => failing.launcher.installShortcut(),
    (error) => error instanceof LauncherError && error.code === 'shortcut_failed'
      && /рабочего стола/.test(error.message),
  );
});

test('разбор status-строк: пропущенные ключи — по умолчанию, лишние игнорируются', () => {
  assert.deepEqual(parseShortcutStatus('desktop_dir\t\ndesktop\t0\nmenu\t1\nextra\tx\n'), {
    desktopDir: null, desktop: false, menu: true,
  });
  assert.deepEqual(parseShortcutStatus(''), { desktopDir: null, desktop: false, menu: false });
});
