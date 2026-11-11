import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { auditStage } from '../../server/scripts/sea/stage.mts';

const runFile = promisify(execFile);
const SOURCE = path.resolve(import.meta.dirname, '../..');

/**
 * Минимальный R с собственным Node-портом и SEA-портом, внешние команды — заглушки.
 * HOME/D временные; проверка PATH до запуска не допускает настоящий systemctl/npm.
 */
async function fixture(t, name = 'R') {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-sea-launch-'));
  const root = path.join(temp, name);
  const home = path.join(temp, 'home');
  const stubs = path.join(temp, 'stubs');
  const calls = path.join(temp, 'calls');

  t.after(() => rm(temp, { recursive: true, force: true }));
  await cp(path.join(SOURCE, 'deploy'), path.join(root, 'deploy'), { recursive: true });

  for (const directory of ['bin', 'server/scripts', 'shared/runtime', 'runtime/node/bin',
    'server/runtime/helpers']) {
    await mkdir(path.join(root, directory), { recursive: true });
  }

  await mkdir(home);
  await mkdir(stubs);
  await cp(path.join(SOURCE, 'bin/grigdesk-ctl'), path.join(root, 'bin/grigdesk-ctl'));
  await writeFile(path.join(root, 'server/scripts/dataHomeCheck.mts'), 'process.exitCode = 0;\n');
  await writeFile(path.join(root, 'release.json'), '{"schema":1}\n');
  await writeFile(path.join(root, 'bin/b24'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  // Fast-тест проверяет shell argv; настоящий helper/execve проверяется отдельно.
  await writeFile(path.join(root, 'server/runtime/helpers/launch-sea-server.mjs'), [
    'import { fileURLToPath } from "node:url";',
    'const binary = fileURLToPath(new URL("../../grigdesk-server", import.meta.url));',
    'process.execve(binary, [binary, ...process.argv.slice(2)], process.env);',
  ].join('\n'));
  await writeFile(path.join(root, 'runtime/node/bin/node'), [
    '#!/bin/bash',
    '[[ -z "${NODE_OPTIONS+x}" ]] || exit 42',
    'if [[ "$*" == *fetch* ]]; then printf grigdesk; exit 0; fi',
    'exec "$FIXTURE_NODE" "$@"',
  ].join('\n'), { mode: 0o755 });
  await writeFile(path.join(root, 'server/grigdesk-server'), [
    '#!/bin/bash',
    'echo "sea $*" >> "$STUB_LOG"',
    '[[ -z "${NODE_OPTIONS+x}" ]] || exit 43',
    'if [[ "${1:-}" == --check-runtime || "${1:-}" == --check-startup ]]; then',
    '  exit "${FIXTURE_BAD_PACKAGE:-0}"',
    'fi',
    'echo "SEA $*"',
  ].join('\n'), { mode: 0o755 });

  for (const command of ['node', 'npm', 'python3', 'systemctl', 'loginctl', 'curl', 'notify-send']) {
    await writeFile(path.join(stubs, command), `#!/bin/bash
printf '${command} %s\\n' "$*" >> "$STUB_LOG"
${['node', 'npm', 'python3'].includes(command) ? 'exit 97' : 'exit 0'}
`, { mode: 0o755 });
  }

  const env = {
    PATH: `${stubs}:/usr/bin:/bin`,
    HOME: home,
    GRIGDESK_HOME: path.join(temp, 'data'),
    GRIGDESK_PORT: '19001',
    FIXTURE_NODE: process.execPath,
    STUB_LOG: calls,
    GRIGDESK_B24_INSTALL_PAUSE: '0',
  };
  const guard = await runFile('bash', ['-c', 'command -v node npm systemctl loginctl'], { env });

  assert.equal(guard.stdout.trim().split('\n').every((file) => file.startsWith(stubs + '/')), true);

  return {
    root,
    home,
    env,
    calls: () => readFile(calls, 'utf8').catch(() => ''),
    run: (script, args = [], extra = {}) => runFile('bash', [path.join(root, script), ...args], {
      env: { ...env, ...extra },
      cwd: '/',
      timeout: 30000,
    }),
  };
}

test('SEA-LAUNCH-01: run проверяет пакет и очищает NODE_OPTIONS до собственного Node', async (t) => {
  const box = await fixture(t);
  const result = await box.run('bin/grigdesk-ctl', ['run', '--version'], {
    NODE_OPTIONS: '--max-old-space-size=512',
  });

  assert.equal(result.stdout.trim(), 'SEA --version');
  assert.match(await box.calls(), /sea --check-startup/);
  assert.doesNotMatch(await box.calls(), /^node /m);
});

test('REVIEW-P5: служебный argv shell не требует допустимой папки D', async (t) => {
  const box = await fixture(t);
  const result = await box.run('bin/grigdesk-ctl', ['run', '--version'], {
    GRIGDESK_HOME: 'relative-data',
  });

  assert.equal(result.stdout.trim(), 'SEA --version');
});

test('SEA-LAUNCH-02: повреждённый manifest или отсутствие своего Node не запускают fallback', async (t) => {
  const box = await fixture(t);

  await assert.rejects(box.run('bin/grigdesk-ctl', ['run'], { FIXTURE_BAD_PACKAGE: '19' }));
  assert.doesNotMatch(await box.calls(), /^sea $/m);
  await rm(path.join(box.root, 'runtime/node/bin/node'));
  await assert.rejects(box.run('bin/grigdesk-ctl', ['run']));
  assert.doesNotMatch(await box.calls(), /^node /m);
});

test('SEA-LAUNCH-03: unit-only выбирает SEA, свой Node для helper-ов и очищает Node options', async (t) => {
  const box = await fixture(t, 'R with space');

  await box.run('deploy/install.sh', ['--unit-only']);

  const unit = await readFile(path.join(box.home, '.config/systemd/user/grigdesk-server.service'), 'utf8');

  assert.match(unit, new RegExp(`ExecStart=.*${box.root}/server/grigdesk-server`));
  assert.doesNotMatch(unit, /server\/src\/app\.ts/);
  assert.ok(unit.includes(`${box.root}/runtime/node/bin`));
  assert.match(unit, /UnsetEnvironment=NODE_OPTIONS/);
  assert.match(unit, /KillMode=mixed/);
  assert.match(unit, /Environment=PYTHONDONTWRITEBYTECODE=1/);
  assert.ok(unit.includes(`${box.root}/runtime/node/bin"`));
  assert.doesNotMatch(await box.calls(), /^npm /m);
});

test('REVIEW-P5: shell использует свой Node явно, дети сохраняют PATH пользователя', async (t) => {
  const box = await fixture(t);
  const probe = [
    'set -euo pipefail',
    'source "$1/deploy/lib/runtime-env.sh"',
    'grigdesk_require_migrated "$1"',
    'printf "%s\\n" "$PATH" "${PYTHONDONTWRITEBYTECODE:-}"',
  ].join('\n');
  const result = await runFile('bash', ['-c', probe, '_', box.root], { env: box.env });
  const [search, python] = result.stdout.trim().split('\n');

  assert.equal(search.split(':').at(-1), path.join(box.root, 'runtime/node/bin'));
  assert.equal(search.split(':')[0], box.env.PATH.split(':')[0]);
  assert.equal(python, '1');
  assert.doesNotMatch(await box.calls(), /^node /m);
});

test('SEA-LAUNCH-04: регистрация готового пакета не запускает npm/Python и не пишет в R', async (t) => {
  const box = await fixture(t);
  const before = await auditStage(box.root, { required: [] });

  await box.run('deploy/install.sh', ['--no-autostart', '--no-shortcut', '--no-cuda']);
  assert.deepEqual(await auditStage(box.root, { required: [] }), before);
  assert.doesNotMatch(await box.calls(), /^(npm|python3) /m);
  assert.doesNotMatch(await box.calls(), /systemctl .*start/);
});

test('SEA-LAUNCH-05: команда restart выбирается без Node-флагов, source сохраняет env-file', async (t) => {
  const box = await fixture(t);
  const probe = [
    'set -euo pipefail',
    'source "$1/deploy/lib/runtime-env.sh"',
    'GRIGDESK_NODE_ENV_ARGS=(--env-file /fixture/data.env)',
    'grigdesk_server_command "$1"',
    'printf "%s\\n" "${GRIGDESK_SERVER_COMMAND[@]}"',
  ].join('\n');
  const packaged = await runFile('bash', ['-c', probe, '_', box.root], { env: box.env });

  assert.deepEqual(packaged.stdout.trim().split('\n'), [
    path.join(box.root, 'runtime/node/bin/node'),
    path.join(box.root, 'server/runtime/helpers/launch-sea-server.mjs'),
  ]);
  await rm(path.join(box.root, 'release.json'));

  const source = await runFile('bash', ['-c', probe, '_', box.root], { env: box.env });

  assert.deepEqual(source.stdout.trim().split('\n'), [
    'node', '--env-file', '/fixture/data.env', path.join(box.root, 'server/src/app.ts'),
  ]);
});
