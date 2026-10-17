import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Щелчок по переходному ярлыку проверяется на копии deploy/shortcut.sh с записывающей
 * заглушкой cockpit. Остальные внешние инструменты перекрыты и проверены до запуска скрипта.
 */
function sandbox(t, suffix = 'repo') {
  const home = mkdtempSync(path.join(os.tmpdir(), 'cockpit-launch-'));
  const repo = path.join(home, suffix);
  const stubs = path.join(home, 'stubs');
  const log = path.join(home, 'calls.log');

  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(path.join(repo, 'bin'), { recursive: true });
  mkdirSync(path.join(repo, 'deploy/lib'), { recursive: true });
  mkdirSync(stubs);

  // Скрипт ярлыка при любом действии подключает общий путь окна: копия нужна и для open.
  for (const file of ['deploy/shortcut.sh', 'deploy/lib/desktop-app.sh']) {
    copyFileSync(path.join(root, file), path.join(repo, file));
  }

  writeFileSync(path.join(repo, '.env'), 'COCKPIT_PORT=18149\n');
  writeFileSync(path.join(repo, 'bin/cockpit'), `#!/bin/bash
printf 'cockpit %s\\n' "$*" >> "$STUB_LOG"
printf 'first-path %s\\n' "\${PATH%%:*}" >> "$STUB_LOG"
printf '%s' "\${STUB_STDERR:-}" >&2
exit "\${STUB_CODE:-0}"
`, { mode: 0o755 });

  for (const command of ['systemctl', 'journalctl', 'docker', 'xdg-open', 'notify-send', 'curl']) {
    writeFileSync(path.join(stubs, command), `#!/bin/bash
printf '${command} %s\\n' "$*" >> "$STUB_LOG"
exit 0
`, { mode: 0o755 });
  }

  const env = {
    ...process.env,
    HOME: home,
    COCKPIT_HOME: path.join(home, '.cockpit'),
    XDG_CONFIG_HOME: path.join(home, 'config'),
    XDG_DATA_HOME: path.join(home, 'data'),
    PATH: `${stubs}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    STUB_LOG: log,
  };

  delete env.COCKPIT_PORT;
  delete env.COCKPIT_NODE_DIR;

  const guard = spawnSync('bash', ['-c',
    'command -v systemctl journalctl docker xdg-open notify-send curl'], { env, encoding: 'utf8' });

  assert.equal(guard.status, 0, guard.stderr);

  for (const command of guard.stdout.trim().split('\n')) {
    assert.ok(command.startsWith(stubs + '/'), command);
  }

  return {
    home,
    run: (overrides = {}) => spawnSync('bash', [path.join(repo, 'deploy/shortcut.sh'), 'open'], {
      env: { ...env, ...overrides },
      encoding: 'utf8',
      timeout: 10000,
    }),
    calls: () => existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [],
  };
}

test('LN-1 ярлык вызывает cockpit open без уведомления при успехе', (t) => {
  const box = sandbox(t);
  const result = box.run();

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(box.calls().filter((call) => call.startsWith('cockpit ')), ['cockpit open']);
  assert.ok(!box.calls().some((call) => call.startsWith('notify-send ')));
});

test('LN-2 отказ передаёт stderr в уведомление', (t) => {
  const box = sandbox(t);
  const result = box.run({ STUB_CODE: '3', STUB_STDERR: 'Причина тестового отказа' });

  assert.equal(result.status, 1);
  assert.ok(box.calls().some((call) =>
    call.startsWith('notify-send ') && call.includes('Причина тестового отказа')));
});

test('LN-3 каталог явного Node первый в PATH', (t) => {
  const box = sandbox(t);
  const directory = path.join(box.home, 'node directory');

  mkdirSync(directory);
  writeFileSync(path.join(directory, 'node'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });

  const result = box.run({ COCKPIT_NODE_DIR: directory });

  assert.equal(result.status, 0, result.stderr);
  assert.ok(box.calls().includes('first-path ' + directory));
});

test('LN-4 корень с пробелами и кириллицей', (t) => {
  const box = sandbox(t, 'копия с пробелами');
  const result = box.run();

  assert.equal(result.status, 0, result.stderr);
  assert.ok(box.calls().includes('cockpit open'));
});
