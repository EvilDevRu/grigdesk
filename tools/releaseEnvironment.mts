import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { ensureNodeArchive } from '../shared/node/nodeRuntime.ts';
import { downloadFile } from '../shared/node/seaBuild.ts';
import { readNodeRuntime } from '../shared/node/nodeRuntime.ts';

const execute = promisify(execFile);

export interface EnvironmentCheck {
  id: string;
  ok: boolean;
  detail: string;
  mandatory: boolean;
}

export interface EnvironmentReport {
  format: 1;
  nodeVersion: string;
  npmVersion: string;
  checks: EnvironmentCheck[];
  ok: boolean;
}

export interface EnvironmentProbes {
  run?(file: string, argv: string[]): Promise<{ stdout: string; stderr: string }>;
  diskFreeKiB?(probe: string): Promise<number>;
}

/**
 * Отсутствующая команда или ненулевой exit превращаются в явное отсутствие условия.
 * Пустой stdout успешной sandbox-пробы сохраняет успешный результат.
 */
async function probeCommand(probes: EnvironmentProbes, file: string,
  argv: string[]): Promise<string | null> {
  try {
    const result = await (probes.run ?? execute)(file, argv);

    return result.stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Doctor собирает фактическое состояние среды теми же пробами, что и CI:
 * pinned Node, инструменты, песочницы, место и лимиты. Список несоответствий
 * возвращается до запуска тестов; установка пакетов исключена контрактно.
 */
export async function runEnvironmentReport(root: string, options: {
  strictCI?: boolean;
  probes?: EnvironmentProbes;
  requireBrowser?: boolean;
} = {}): Promise<EnvironmentReport> {
  const probes = options.probes ?? {};
  const diskFreeKiB = probes.diskFreeKiB ?? (async (probe: string) => {
    const result = await execute('df', ['-Pk', probe]);

    return Number(result.stdout.split('\n')[1]?.trim().split(/\s+/)[3]);
  });
  const runtime = readNodeRuntime(JSON.parse(await fs.readFile(
    path.join(root, 'server/build/node-runtime.json'), 'utf8',
  )), 'server/build/node-runtime.json');
  const nodeVersion = await probeCommand(probes, process.execPath, ['--version']);
  const npmVersion = await probeCommand(probes, 'npm', ['--version']);
  const checks: EnvironmentCheck[] = [];
  const mandatory = (id: string, ok: boolean, detail: string) => {
    checks.push({
      id,
      ok,
      detail,
      mandatory: true
    });
  };
  const informational = (id: string, ok: boolean, detail: string) => {
    checks.push({
      id,
      ok,
      detail,
      mandatory: false
    });
  };

  mandatory('node-pinned', nodeVersion === `v${runtime.version}`,
    `активный ${nodeVersion ?? 'не найден'}, pinned v${runtime.version}`);
  mandatory('npm-present', npmVersion !== null, npmVersion ?? 'npm не найден');

  for (const [id, file, argv, expected] of [
    ['ffmpeg', 'ffmpeg', ['-version'], /ffmpeg version/u],
    ['ffprobe', 'ffprobe', ['-version'], /ffprobe version/u],
    ['ripgrep', 'rg', ['--version'], /ripgrep/u],
  ] as const) {
    const output = await probeCommand(probes, file, [...argv]);

    mandatory(id, output !== null && expected.test(output), output ?? 'не найден');
  }

  const pillow = await probeCommand(probes, 'python3',
    ['-c', 'from PIL import Image; print(Image.__version__)']);

  mandatory('pillow', pillow !== null, pillow ?? 'python3-pil не найден');

  const bwrap = await probeCommand(probes, 'bwrap', ['--ro-bind', '/', '/', '--dev', '/dev',
    '--unshare-pid', '--proc', '/proc', '--die-with-parent', '--', '/usr/bin/true']);
  const unshare = await probeCommand(probes, 'unshare', ['-Urnm', '/usr/bin/true']);

  mandatory('bubblewrap', bwrap !== null, bwrap ?? 'проба bwrap не прошла');
  mandatory('unshare', unshare !== null, unshare ?? 'проба unshare не прошла');

  const chromium = process.env.PLAYWRIGHT_BROWSERS_PATH
    ?? path.join(os.homedir(), '.cache', 'ms-playwright');

  // На рабочей ОС браузер может стоять системно — проверка информационная;
  // обязательной она становится только в строгом CI-режиме. Проба запускает
  // headless-страницу: наличие каталога без работающего браузера не засчитывается.
  const chromiumProbe = await probeCommand(probes, process.execPath, ['-e',
    'const { chromium } = require(process.argv[1]);'
      + '(async () => { const browser = await chromium.launch('
      + '{ headless: true, chromiumSandbox: true }); await browser.close();'
      + " console.log('chromium-ok'); })()"
      + '.catch(() => process.exit(1));',
    path.join(root, 'server/node_modules/playwright-core')]).catch(() => null);

  (options.strictCI || options.requireBrowser ? mandatory : informational)('chromium-present',
    await fs.stat(chromium).then(() => true, () => false) && chromiumProbe !== null,
    `playwright browsers: ${chromium}`);

  const workspaceFree = await diskFreeKiB(root);

  mandatory('disk-16gib', workspaceFree >= 16 * 1024 * 1024,
    `доступно ${workspaceFree} KiB`);

  const openFiles = await probeCommand(probes, 'bash', ['-c', 'ulimit -n']);

  informational('open-files', openFiles !== null && Number(openFiles) >= 4096,
    openFiles ?? 'ulimit -n не прочитан');

  if (options.strictCI) {
    const osRelease = await fs.readFile('/etc/os-release', 'utf8').catch(() => '');

    mandatory('ubuntu-24-04', /^VERSION_ID="?24\.04"?$/mu.test(
      osRelease.split('\n').find((line) => line.startsWith('VERSION_ID=')) ?? ''),
    'строгий CI-режим требует Ubuntu 24.04');
  }

  return {
    format: 1,
    nodeVersion: nodeVersion ?? '',
    npmVersion: npmVersion ?? '',
    checks,
    ok: checks.every((check) => !check.mandatory || check.ok),
  };
}

/**
 * Сборка получает Node и npm из одного закреплённого архива, отдельно от хоста.
 * Хеш архива проверяется общим загрузчиком до извлечения приватного toolchain.
 */
export async function prepareReleaseToolchain(root: string, runDir: string,
  cache = path.join(runDir, 'node-cache')) {
  const runtime = readNodeRuntime(JSON.parse(await fs.readFile(
    path.join(root, 'server/build/node-runtime.json'), 'utf8',
  )), 'server/build/node-runtime.json');
  const archive = await ensureNodeArchive(runtime, cache, { download: downloadFile });
  const toolchain = path.join(runDir, 'toolchain');

  await fs.mkdir(toolchain, { mode: 0o700 });
  await execute('tar', ['-xJf', archive, '--strip-components=1', '-C', toolchain]);

  const node = path.join(toolchain, 'bin/node');
  const npm = path.join(toolchain, 'lib/node_modules/npm/bin/npm-cli.js');
  const nodeVersion = (await execute(node, ['--version'])).stdout.trim();
  const npmVersion = (await execute(node, [npm, '--version'])).stdout.trim();

  if (nodeVersion !== `v${runtime.version}` || !/^\d+\.\d+\.\d+$/u.test(npmVersion)) {
    throw new Error('release_toolchain_invalid');
  }

  return {
    node,
    bin: path.join(toolchain, 'bin'),
    nodeVersion,
    npmVersion
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const strictCI = process.argv.includes('--strict-ci');
  const report = await runEnvironmentReport(process.cwd(), {
    strictCI,
    requireBrowser: process.argv.includes('--require-ready'),
  });

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = (strictCI || process.argv.includes('--require-ready')) && !report.ok ? 2 : 0;
}
