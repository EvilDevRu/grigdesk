import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import { runEnvironmentReport, type EnvironmentProbes } from '../../tools/releaseEnvironment.mts';

const repository = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Пробы хоста подменяются; сам отчёт и правила mandatory — production-код.
 * Каждый вариант описывает одну деградацию среды до команды тестов.
 */
function probesWith(overrides: {
  node?: string;
  ffmpeg?: string | null;
  bwrap?: string | null;
  disk?: number;
  userManager?: boolean;
}): EnvironmentProbes {
  const outputs = new Map<string, string>([
    ['ffmpeg', `ffmpeg version ${overrides.ffmpeg ?? '7.0.1'}`],
    ['ffprobe', 'ffprobe version 7.0.1'],
    ['rg', 'ripgrep 14.1.0'],
    ['curl', 'curl 8.5.0'],
    ['unzip', 'UnZip 6.00'],
    ['7z', '7-Zip 23.01'],
    ['npm', '10.9.2'],
    ['bwrap', 'bwrap 0.10'],
    ['unshare', 'unshare 2.40'],
    ['python3', '10.3.0'],
  ]);

  return {
    host: () => ({ platform: 'linux', arch: 'x64' }),
    run: async (file, argv) => {
      if (file === process.execPath && argv[0] === '--version') {
        return { stdout: `${overrides.node ?? 'v24.21.0'}\n`, stderr: '' };
      }

      if (file === process.execPath && argv[0] === '-e') {
        return { stdout: 'chromium-ok\n', stderr: '' };
      }

      if (file === 'ffmpeg' && overrides.ffmpeg === null) {
        throw new Error('missing');
      }

      if (file === 'bwrap' && overrides.bwrap === null) {
        throw new Error('sandbox denied');
      }

      if (file === 'env' && argv[1] === 'systemctl' && overrides.userManager !== false) {
        return { stdout: '255\n', stderr: '' };
      }

      const output = outputs.get(file);

      if (output !== undefined) {
        return { stdout: `${output}\n`, stderr: '' };
      }

      if (file === 'bash') {
        return { stdout: '1048576\n', stderr: '' };
      }

      return { stdout: '\n', stderr: '' };
    },
    diskFreeKiB: async () => overrides.disk ?? 64 * 1024 * 1024,
  };
}

for (const unavailable of [null, 'xcrun', 'sw_vers', 'jq', 'chromium'] as const) {
  test('ENVIRONMENT-DARWIN: ' + (unavailable ?? 'нативный host и SDK'), async () => {
    const calls: string[] = [];
    const linux = probesWith({});
    const report = await runEnvironmentReport(repository, {
      requireBrowser: true,
      probes: {
        ...linux,
        host: () => ({ platform: 'darwin', arch: 'arm64' }),
        browserCachePresent: async () => true,
        run: async (file, argv) => {
          const command = path.basename(file);
          const probe = file === process.execPath && argv[0] === '-e' ? 'chromium' : command;

          calls.push([command, ...argv].join(' '));

          if (probe === unavailable) {
            throw new Error('missing');
          }

          const output = {
            uname: argv[0] === '-m' ? 'arm64' : 'Darwin',
            sw_vers: '15.0',
            xcrun: '/Applications/Xcode.app/MacOSX.sdk',
            brew: '/opt/homebrew/opt/' + argv[1],
          }[command];

          if (output) {
            return { stdout: output, stderr: '' };
          }

          if (file.startsWith('/opt/homebrew/opt/')) {
            assert.ok(['/opt/homebrew/opt/ffmpeg/bin/ffmpeg',
              '/opt/homebrew/opt/ffmpeg/bin/ffprobe'].includes(file)
              ? argv[0] === '-version' : argv[0] === '--version');

            return { stdout: command + ' 1.0', stderr: '' };
          }

          return linux.run!(file, argv);
        },
      },
    });

    const checkIds = {
      xcrun: 'macos-sdk',
      sw_vers: 'macos-version',
      jq: 'jq',
      chromium: 'chromium-present',
    } as const;

    assert.deepEqual(report.checks.filter((check) => check.mandatory && !check.ok)
      .map((check) => check.id), unavailable ? [checkIds[unavailable]] : []);
    assert.equal(report.ok, unavailable === null);
    assert.ok(calls.includes('xcrun --sdk macosx --show-sdk-path'));
    assert.ok(!calls.some((call) => /^(bwrap|unshare|xvfb-run)\b/u.test(call)));
  });
}

test('ENVIRONMENT-DEGRADED: doctor перечисляет несоответствия до тестов', async (t) => {
  const report = await runEnvironmentReport(repository, { probes: probesWith({
    node: 'v99.0.0',
    ffmpeg: null,
    bwrap: null,
    disk: 1024 * 1024,
  }) });

  const failed = report.checks.filter((check) => !check.ok).map((check) => check.id);

  assert.ok(failed.includes('node-pinned'));
  assert.ok(failed.includes('ffmpeg'));
  assert.ok(failed.includes('bubblewrap'));
  assert.ok(failed.includes('disk-16gib'));
  assert.equal(report.ok, false);
});

test('ENVIRONMENT-HEALTHY: полная среда даёт ok без установки чего-либо', async (t) => {
  const report = await runEnvironmentReport(repository, { probes: probesWith({}) });

  assert.equal(report.ok, true, JSON.stringify(report.checks.filter((c) => !c.ok)));
  assert.equal(report.nodeVersion, 'v24.21.0');
});

test('ENVIRONMENT-USER-MANAGER: недоступная шина блокирует обязательную проверку Qwen', async () => {
  const report = await runEnvironmentReport(repository, {
    probes: probesWith({ userManager: false }),
    requireUserManager: true,
  });
  const check = report.checks.find((item) => item.id === 'systemd-user');

  assert.equal(check?.mandatory, true);
  assert.equal(check?.ok, false);
  assert.equal(report.ok, false);
});

test('ENVIRONMENT-STRICT-CI: чужой релиз Ubuntu отмечается только в строгом режиме', async (t) => {
  const probes = probesWith({});

  assert.equal((await runEnvironmentReport(repository, { probes,
    strictCI: true })).checks.some((check) => check.id === 'ubuntu-24-04'), true);
  assert.equal((await runEnvironmentReport(repository, { probes,
    strictCI: false })).checks.some((check) => check.id === 'ubuntu-24-04'), false);
});

test('ENVIRONMENT-DOCTOR-CLI: doctor не меняет исходное дерево и не требует sudo', async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'environment-doctor-'));
  const { completed } = await import('../cli/helpers/sandbox.mts');
  const { spawn } = await import('node:child_process');

  t.after(() => fs.rm(temporary, { recursive: true, force: true }));

  const child = spawn(process.execPath, [path.join(repository,
    'tools/releaseEnvironment.mts')], {
      cwd: repository,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: temporary,
        XDG_CACHE_HOME: path.join(temporary, 'cache')
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  const result = await completed(child);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(typeof JSON.parse(result.stdout).format, 'number');
});
