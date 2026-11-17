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
}): EnvironmentProbes {
  const outputs = new Map<string, string>([
    ['ffmpeg', `ffmpeg version ${overrides.ffmpeg ?? '7.0.1'}`],
    ['ffprobe', 'ffprobe version 7.0.1'],
    ['rg', 'ripgrep 14.1.0'],
    ['npm', '10.9.2'],
    ['bwrap', 'bwrap 0.10'],
    ['unshare', 'unshare 2.40'],
    ['python3', '10.3.0'],
  ]);

  return {
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
