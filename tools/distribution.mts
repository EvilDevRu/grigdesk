import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';

import { readRunRecord, verifyRunArtifacts } from './distributionRuns.mts';
import { verifyDistributionArtifacts, type DistributionTrust }
  from './releaseArtifactVerification.mts';
import { verifyInstallation } from './verifyInstallation.mts';
import { runDistributionBuild } from './distributionBuild.mts';
import { artifactsPath } from '../shared/runtime/dataHome.ts';
import { runEnvironmentReport } from './releaseEnvironment.mts';
import { RELEASE_SIGNING_PUBLIC_KEY }  from '../shared/runtime/releaseChannelContracts.ts';
import { copyInstallFile } from '../shared/node/binaryInstall.ts';
import { verifyReleaseInstaller } from './releaseArtifactVerification.mts';
import { cliTranslator } from '../cli/i18n.ts';

const USAGE = [
  'grigdesk-ctl dist — подготовка и проверка дистрибутива из исходников',
  '',
  'Использование:',
  '  dist build [--channel release|dev]',
  '  dist check --from <каталог> [--commit <SHA40>]',
  '  dist check --local-run <UUID>',
  '  dist install --from <каталог> [--commit <SHA40>] --mode local|remote|server',
  '             --root <ABS> --data-home <ABS> [--user-data <ABS>] [--bin-dir <ABS>]',
  '             [--applications-dir <ABS>] [--unit-dir <ABS>] [--yes]',
  '  dist install --local-run <UUID> --mode local|remote|server --root <ABS>',
  '             --data-home <ABS> [прочие флаги путей] [--yes]',
  '  dist doctor',
  '',
  'Официальный кандидат (--from): commit — из явного --commit либо из поля commit',
  'release-checks.json артефакта Actions; явное значение сверяется с файлом.',
  '',
].join('\n');

/**
 * Каталог записей run-ов фиксирован в состоянии пользователя и переживает процесс
 * build: artifacts/distribution-runs вне передаваемого каталога кандидата. Переменная
 * окружения GRIGDESK_DIST_RUN_DIR переопределяет каталог только для тестов.
 */
function defaultRunsRoot(): string {
  return process.env.GRIGDESK_DIST_RUN_DIR ?? path.join(
    artifactsPath({ env: process.env, home: os.homedir() }), 'distribution-runs');
}

/**
 * Разбор источника доверия: ровно один ключ. --from — официальный pinned ключ;
 * commit берётся из явного --commit либо из поля commit release-checks.json
 * кандидата Actions (явное значение дополнительно сверяется с файлом и конвертом).
 * --local-run читает только собственную запись run-а.
 */
export async function resolveTrust(argv: string[]): Promise<{
  directory: string;
  trust: DistributionTrust;
}> {
  const from = valueOf(argv, '--from');
  const localRun = valueOf(argv, '--local-run');

  if (Boolean(from) === Boolean(localRun)) {
    throw new Error('dist_source_required');
  }

  if (from) {
    const directory = path.resolve(from);
    const explicit = valueOf(argv, '--commit');
    const recorded = await fs.readFile(path.join(directory, 'release-checks.json'),
      'utf8').then((text) => {
      const value = JSON.parse(text) as { commit?: unknown };

      if (typeof value.commit !== 'string' || !/^[a-f0-9]{40}$/u.test(value.commit)) {
        throw new Error('dist_commit_source_invalid');
      }

      return value.commit;
    }, (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') {
        throw error;
      }

      return null;
    });

    if (!explicit && !recorded) {
      throw new Error('dist_commit_source_missing');
    }

    if (explicit && recorded && explicit !== recorded) {
      throw new Error('dist_commit_mismatch');
    }

    return { directory, trust: {
      purpose: 'official',
      publicKeyPem: RELEASE_SIGNING_PUBLIC_KEY,
      expectedCommit: explicit ?? recorded!
    } };
  }

  const record = await readRunRecord(defaultRunsRoot(), localRun!);

  if (record.stage !== 'verified') {
    throw new Error('distribution_run_not_verified');
  }

  await verifyRunArtifacts(record);

  return { directory: record.realArtifactsRoot, trust: {
    purpose: 'local',
    publicKeyPem: record.publicKeyPem,
    expectedCommit: record.sourceCommit,
    expectedManifestDigest: record.manifestDigest
  } };
}

function valueOf(argv: string[], flag: string): string | null {
  const index = argv.indexOf(flag);

  return index >= 0 && argv[index + 1] ? argv[index + 1]! : null;
}

/**
 * Подтверждение читает человеческий терминал до любых записей тестовой установки.
 * EOF и запуск без TTY не считаются согласием.
 */
async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    throw new Error('dist_install_confirmation_requires_tty');
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    const answer = await rl.question(`${question} [y/N] `);

    return /^(y|yes|д|да)$/iu.test(answer.trim());
  } finally {
    rl.close();
  }
}

/**
 * Закрытый набор флагов исключает дубли и подмену источника доверия.
 * Проверка выполняется до чтения кандидата, снимка и создания каталогов.
 */
function validateArguments(argv: string[]): void {
  const command = argv[0];
  const allowed = command === 'build' ? ['--channel'] : command === 'doctor' ? []
    : ['--from', '--local-run', '--commit', ...command === 'install'
      ? ['--mode', '--root', '--data-home', '--user-data', '--bin-dir',
        '--applications-dir', '--unit-dir', '--yes'] : []];
  const seen = new Set<string>();

  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index]!;

    if (!allowed.includes(flag) || seen.has(flag)) {
      throw new Error('dist_arguments_invalid');
    }

    seen.add(flag);

    if (flag !== '--yes') {
      index += 1;

      if (!argv[index] || argv[index]!.startsWith('--')) {
        throw new Error('dist_arguments_invalid');
      }
    }
  }
}

/**
 * Меню спрашивает корни явно, остальные пути предлагает в отдельном тестовом профиле.
 * Рабочие launchers и XDG владельца не становятся умолчанием приёмочной установки.
 */
async function installationPaths(argv: string[]): Promise<Record<string, string>> {
  const { t } = cliTranslator();
  const paths: Record<string, string> = {};
  const interactive = process.stdin.isTTY && !argv.includes('--yes');
  const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;

  try {
    for (const flag of ['--root', '--data-home', '--user-data', '--bin-dir',
      '--applications-dir', '--unit-dir']) {
      const fallback = paths['--root'] ? path.join(paths['--root'] + '-profile', flag.slice(2)) : '';
      const defaultPath = ['--root', '--data-home'].includes(flag) ? '' : fallback;
      const answer = valueOf(argv, flag) ?? (rl
        ? await rl.question(`${t('distribution.path.' + flag.slice(2))} [${defaultPath}]: `) : '');
      const value = answer || defaultPath;

      if (!value || !path.isAbsolute(value)) {
        throw new Error('dist_install_arguments_required');
      }

      paths[flag] = path.resolve(value);
    }

    return paths;
  } finally {
    rl?.close();
  }
}

/**
 * Единственный dist-диспетчер проверяет источник доверия перед установкой или сборкой.
 * Самостоятельная публикация и доступ к релизным SSH-ключам сюда не входят.
 */
async function main(argv: string[]): Promise<number> {
  const command = argv[0];

  if (argv.includes('--help') || argv.includes('-h') || !command) {
    process.stdout.write(USAGE);

    return 0;
  }

  validateArguments(argv);

  // dist работает только из исходников: markers проверяются до любых эффектов,
  // кроме справки (см. приложение F — установленный/portable dist даёт код 2).
  for (const marker of ['server/src/app.ts', 'web/package.json', 'desktop/package.json',
    'tools/distribution.mts']) {
    if (!await fs.stat(path.join(process.cwd(), marker)).then(() => true, () => false)) {
      process.stderr.write('Команда dist доступна в установке из исходников.\n');

      return 2;
    }
  }

  if (command === 'doctor') {
    const report = await runEnvironmentReport(process.cwd());

    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

    return 0;
  }

  if (command === 'check') {
    const source = await resolveTrust(argv);
    const verified = await verifyDistributionArtifacts(source.directory, source.trust);
    const installRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dist-check-'));

    try {
      await verifyInstallation(source.directory, source.trust.expectedCommit, {
        trust: source.trust,
        installRoot,
        modes: ['local', 'remote', 'server'],
      });
    } finally {
      await fs.rm(installRoot, { recursive: true, force: true });
    }

    process.stdout.write(`${JSON.stringify({
      verified: true,
      version: verified.envelope.payload.version,
      manifestDigest: verified.bootstrap.manifestDigest
    })}\n`);

    return 0;
  }

  if (command === 'install') {
    const mode = valueOf(argv, '--mode');

    if (!mode || !['local', 'remote', 'server'].includes(mode)) {
      throw new Error('dist_install_arguments_required');
    }

    const source = await resolveTrust(argv);
    const verified = await verifyDistributionArtifacts(source.directory, source.trust);
    const paths = await installationPaths(argv);
    const { t } = cliTranslator();

    process.stdout.write(JSON.stringify({ mode, ...paths }, null, 2) + '\n');

    if (!argv.includes('--yes') && !await confirm(t('distribution.confirmInstall'))) {
      return 0;
    }

    const profile = paths['--root'] + '-profile';
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'dist-install-'));
    const script = path.join(temporary, 'grigdesk-install');

    await copyInstallFile(path.join(source.directory, 'grigdesk-install'), script);
    await verifyReleaseInstaller(script, verified.envelope,
      await fs.readFile(path.join(source.directory, 'grigdesk-install.sha256'), 'utf8'),
      await fs.readFile(path.join(source.directory, 'grigdesk-install.sig'), 'utf8'),
      source.trust.publicKeyPem);

    const home = path.join(profile, 'home');

    for (const folder of [home, path.join(home, 'cache'), path.join(home, 'config'),
      path.join(home, 'runtime')]) {
      await fs.mkdir(folder, { recursive: true, mode: 0o700 });
    }

    const child = spawn('sh', [script, '--yes', '--mode', mode,
      ...Object.entries(paths).flat(), '--source-dir', source.directory], {
      stdio: 'inherit',
      env: {
        PATH: '/usr/bin:/bin',
        HOME: home,
        LANG: process.env.LANG ?? 'C.UTF-8',
        XDG_CONFIG_HOME: path.join(home, 'config'),
        XDG_CACHE_HOME: path.join(home, 'cache'),
        XDG_RUNTIME_DIR: path.join(home, 'runtime'),
        DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(home, 'runtime/absent-bus')}`,
      },
    });

    return await new Promise<number>((resolve) => {
      child.on('error', () => resolve(2));
      child.on('close', (code) => resolve(code ?? 1));
    }).finally(() => fs.rm(temporary, { recursive: true, force: true }));
  }

  if (command === 'build') {
    return runDistributionBuild(process.cwd(), valueOf(argv, '--channel') ?? 'release',
      defaultRunsRoot());
  }

  process.stderr.write(USAGE);

  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  try {
    process.exit(await main(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);

    process.exit(2);
  }
}
