import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { ensureNodeArchive, readTargetNodeRuntime, serverNodeRuntimeManifest }
  from '../shared/node/nodeRuntime.ts';
import { downloadFile } from '../shared/node/seaBuild.ts';

const execute = promisify(execFile);
const requiredDiskKiB = 16 * 1024 * 1024;

/**
 * Изолированная сборка наследует только каталог уже проверенного Go из среды сборщика.
 * Версия и физический путь берутся одной нативной пробой до очистки PATH.
 */
export async function resolveReleaseGoDirectory(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  try {
    const { stdout } = await execute('go', ['env', '-json', 'GOROOT', 'GOVERSION'], {
      env: {
        PATH: env.PATH,
        GOTOOLCHAIN: 'local',
        GOWORK: 'off',
        GOENV: 'off',
      },
      timeout: 8000,
      maxBuffer: 65536,
    });
    const { GOROOT, GOVERSION } = JSON.parse(stdout);

    if (GOVERSION !== 'go1.27.4' || typeof GOROOT !== 'string' || !path.isAbsolute(GOROOT)) {
      throw new Error('неверные метаданные инструмента');
    }

    const bin = await fs.realpath(path.join(GOROOT, 'bin'));

    if (bin.includes(path.delimiter)) {
      throw new Error('путь инструмента содержит разделитель PATH');
    }

    await fs.access(path.join(bin, 'go'), constants.X_OK);

    return bin;
  } catch (cause) {
    throw new Error('Для сборки выпуска нужен Go 1.27.4 в PATH.', { cause });
  }
}

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
  host?(): { platform: string; arch: string };
  run?(file: string, argv: string[]): Promise<{ stdout: string; stderr: string }>;
  diskFreeKiB?(probe: string): Promise<number>;
  browserCachePresent?(directory: string): Promise<boolean>;
}

/**
 * Выбирает цель по нативной паре ОС и архитектуры сборщика.
 * Системные условия проверяются после выбора цели.
 */
export function selectDistributionTarget(platform: string, arch: string): 'linux-x64' | 'darwin-arm64' {
  if (platform === 'linux' && arch === 'x64') {
    return 'linux-x64';
  }

  if (platform === 'darwin' && arch === 'arm64') {
    return 'darwin-arm64';
  }

  throw new Error('dist_host_unsupported');
}

type CheckRecorder = (id: string, ok: boolean, detail: string) => void;

/**
 * Сверяет архитектуру процесса с ядром.
 * Версия ОС и SDK проверяются отдельными системными пробами.
 */
async function darwinHostChecks(probes: EnvironmentProbes, record: CheckRecorder): Promise<void> {
  const [system, cpu, version, sdk] = await Promise.all([
    probeCommand(probes, '/usr/bin/uname', ['-s']),
    probeCommand(probes, '/usr/bin/uname', ['-m']),
    probeCommand(probes, '/usr/bin/sw_vers', ['-productVersion']),
    probeCommand(probes, '/usr/bin/xcrun', ['--sdk', 'macosx', '--show-sdk-path']),
  ]);

  record('macos-arm64', system === 'Darwin' && cpu === 'arm64', `${system} ${cpu}`);
  record('macos-version', Boolean(version && /^\d+\.\d+(?:\.\d+)?$/u.test(version)
    && Number(version.split('.')[0]) >= 15), version ?? 'требуется macOS 15 или новее');
  record('macos-sdk', Boolean(sdk && path.isAbsolute(sdk)), sdk ?? 'требуются инструменты Xcode');
}

/**
 * Останавливает сборку до снимка при неподдерживаемой системе.
 * Проверяет SDK и доступное место для временных файлов.
 */
export async function requireDarwinBuildHost(artifactDirectory?: string): Promise<void> {
  const failures: string[] = [];

  await darwinHostChecks({}, (id, ok, detail) => {
    if (!ok) {
      failures.push(`${id} ${detail}`);
    }
  });

  if (failures.length > 0) {
    throw new Error(`dist_host_unsupported ${failures.join(', ')}`);
  }

  if (artifactDirectory) {
    const available = await releaseDiskFreeKiB(artifactDirectory);

    if (!(available >= requiredDiskKiB)) {
      throw new Error(`dist_disk_insufficient требуется ${requiredDiskKiB} KiB, доступно ${available} KiB`);
    }
  }
}

async function releaseDiskFreeKiB(directory: string): Promise<number> {
  const { stdout } = await execute('/bin/df', ['-Pk', directory]);

  return Number(stdout.split('\n')[1]?.trim().split(/\s+/)[3]);
}

/**
 * Пробует реальные программы Homebrew по абсолютному пути из каждой формулы.
 * Отсутствие одного файла отражается в собственном check с именем формулы.
 */
async function darwinDependencyChecks(probes: EnvironmentProbes, record: CheckRecorder): Promise<void> {
  const { darwinEngineFormulas } = await import('../server/src/lib/factoryDarwinRuntime.ts');
  const formulas = [...darwinEngineFormulas,
    ['ffmpeg', 'bin', ['ffmpeg', 'ffprobe']], ['ripgrep', 'bin', ['rg']],
  ] as const;

  for (const [formula, directory, commands] of formulas) {
    const prefix = await probeCommand(probes, '/opt/homebrew/bin/brew', ['--prefix', formula]);
    const knownPrefix = prefix === `/opt/homebrew/opt/${formula}`
      || formula === 'python' && /^\/opt\/homebrew\/opt\/python@\d+\.\d+$/u.test(prefix ?? '');

    for (const command of commands) {
      const flag = command === 'ffmpeg' || command === 'ffprobe' ? '-version' : '--version';
      const output = knownPrefix
        ? await probeCommand(probes, path.join(prefix!, directory, command), [flag]) : null;

      record(command === 'rg' ? 'ripgrep' : command, Boolean(output),
        output?.split('\n')[0] ?? `Требуется формула Homebrew ${formula}`);
    }
  }
}

/**
 * Отсутствующая команда или ненулевой exit превращаются в явное отсутствие условия.
 * Пустой stdout успешной sandbox-пробы сохраняет успешный результат.
 */
async function probeCommand(probes: EnvironmentProbes, file: string,
  argv: string[]): Promise<string | null> {
  try {
    const result = probes.run ? await probes.run(file, argv) : await execute(file, argv, { timeout: 30_000 });

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
  requireUserManager?: boolean;
} = {}): Promise<EnvironmentReport> {
  const probes = options.probes ?? {};
  const diskFreeKiB = probes.diskFreeKiB ?? releaseDiskFreeKiB;
  const host = probes.host?.() ?? process;
  const target = selectDistributionTarget(host.platform, host.arch);
  const darwin = target === 'darwin-arm64';
  const runtime = await readTargetNodeRuntime(path.join(root, serverNodeRuntimeManifest(target)), target);
  const nodeVersion = await probeCommand(probes, process.execPath, ['--version']);
  const npmVersion = await probeCommand(probes, 'npm', ['--version']);
  const goVersion = await probeCommand(probes, 'go', ['env', 'GOVERSION']);
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
  mandatory('go-pinned', goVersion === 'go1.27.4',
    `активный ${goVersion || 'не найден'}, pinned go1.27.4`);

  if (darwin) {
    await darwinHostChecks(probes, mandatory);
    await darwinDependencyChecks(probes, mandatory);
  } else {
    for (const [id, file, argv, expected] of [
      ['ffmpeg', 'ffmpeg', ['-version'], /ffmpeg version/u],
      ['ffprobe', 'ffprobe', ['-version'], /ffprobe version/u],
      ['ripgrep', 'rg', ['--version'], /ripgrep/u],
    ] as const) {
      const output = await probeCommand(probes, file, [...argv]);

      mandatory(id, output !== null && expected.test(output), output ?? 'не найден');
    }

    for (const [tool, argv] of [['curl', ['--version']], ['unzip', ['-v']], ['7z', ['i']]] as const) {
      const output = await probeCommand(probes, tool, [...argv]);

      mandatory(tool, output !== null, output?.split('\n')[0] ?? 'не найден');
    }

    const pillow = await probeCommand(probes, 'python3',
      ['-c', 'from PIL import Image; print(Image.__version__)']);

    mandatory('pillow', pillow !== null, pillow ?? 'python3-pil не найден');

    const bwrap = await probeCommand(probes, 'bwrap', ['--ro-bind', '/', '/', '--dev', '/dev',
      '--unshare-pid', '--proc', '/proc', '--die-with-parent', '--', '/usr/bin/true']);
    const unshare = await probeCommand(probes, 'unshare', ['-Urnm', '/usr/bin/true']);

    mandatory('bubblewrap', bwrap !== null, bwrap ?? 'проба bwrap не прошла');
    mandatory('unshare', unshare !== null, unshare ?? 'проба unshare не прошла');

    const userBus = `unix:path=/run/user/${process.getuid!()}/bus`;
    const userManager = await probeCommand(probes, 'env', [
      `DBUS_SESSION_BUS_ADDRESS=${userBus}`, 'systemctl', '--user', 'show', '--property=Version', '--value',
    ]);

    (options.requireUserManager ? mandatory : informational)('systemd-user', Boolean(userManager),
      userManager || 'пользовательский systemd недоступен для нативных тестов Qwen');
  }

  const chromium = process.env.PLAYWRIGHT_BROWSERS_PATH
    ?? path.join(os.homedir(), darwin ? 'Library/Caches' : '.cache', 'ms-playwright');

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
    await (probes.browserCachePresent ?? (async (directory) =>
      fs.stat(directory).then((stat) => stat.isDirectory(), () => false)))(chromium)
      && chromiumProbe === 'chromium-ok',
    `playwright browsers: ${chromium}`);

  const workspaceFree = await diskFreeKiB(root);

  mandatory('disk-16gib', workspaceFree >= requiredDiskKiB,
    `доступно ${workspaceFree} KiB`);

  const openFiles = await probeCommand(probes, 'bash', ['-c', 'ulimit -n']);

  informational('open-files', openFiles !== null && Number(openFiles) >= 4096,
    openFiles ?? 'ulimit -n не прочитан');

  if (options.strictCI && !darwin) {
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
  cache = path.join(runDir, 'node-cache'), signal?: AbortSignal) {
  const target = selectDistributionTarget(process.platform, process.arch);
  const runtime = await readTargetNodeRuntime(path.join(root, serverNodeRuntimeManifest(target)), target);
  const archive = await ensureNodeArchive(runtime, cache, {
    download: (url, file) => downloadFile(url, file, signal),
    signal,
  });
  const toolchain = path.join(runDir, 'toolchain');

  await fs.mkdir(toolchain, { mode: 0o700 });
  signal?.throwIfAborted();
  await execute('tar', ['-xJf', archive, '--strip-components=1', '-C', toolchain], { signal });

  const node = path.join(toolchain, 'bin/node');
  const npm = path.join(toolchain, 'lib/node_modules/npm/bin/npm-cli.js');
  const nodeVersion = (await execute(node, ['--version'], { signal })).stdout.trim();
  const npmVersion = (await execute(node, [npm, '--version'], { signal })).stdout.trim();

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
  const requireBrowser = process.argv.includes('--require-ready')
    || process.argv.includes('--require-native-ready');
  const requireUserManager = process.argv.includes('--require-user-manager');
  const report = await runEnvironmentReport(process.cwd(), {
    strictCI,
    requireBrowser,
    requireUserManager,
  });

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = (strictCI || requireBrowser || requireUserManager) && !report.ok ? 2 : 0;
}
