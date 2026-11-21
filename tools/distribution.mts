import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import type { Stats } from 'node:fs';

import { readRunRecord, verifyRunArtifacts, type DistributionRunRecord } from './distributionRuns.mts';
import { verifyDistributionArtifacts, type DistributionTrust }
  from './releaseArtifactVerification.mts';
import { verifyInstallation, type VerificationScopeState } from './verifyInstallation.mts';
import { runDistributionBuild } from './distributionBuild.mts';
import { artifactsPath } from '../shared/runtime/dataHome.ts';
import { runEnvironmentReport } from './releaseEnvironment.mts';
import { RELEASE_SIGNING_PUBLIC_KEY }  from '../shared/runtime/releaseChannelContracts.ts';
import { copyInstallFile } from '../shared/node/binaryInstall.ts';
import { verifyReleaseInstaller } from './releaseArtifactVerification.mts';
import { cliTranslator } from '../cli/i18n.ts';
import { createDistributionProgress } from '../cli/distributionProgress.ts';
import { TerminalSession, terminalLines } from '../cli/terminal.ts';
import type { TerminalLine } from '../cli/terminal.ts';
import { readDarwinBuildSetsid } from './darwinBuildTools.mts';
import { configureDarwinBuildProcessHelper } from '../shared/node/processIdentity.ts';
import { removePrivateTree } from '../shared/node/files.ts';

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
export async function resolveTrust(argv: string[], signal?: AbortSignal): Promise<{
  directory: string;
  trust: DistributionTrust;
  nativeTools?: NodeJS.ProcessEnv;
}> {
  signal?.throwIfAborted();

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

  await verifyRunArtifacts(record, signal);

  const nativeTools = process.platform === 'darwin' ? await readLocalVerificationTools(record) : undefined;

  return {
    directory: record.realArtifactsRoot,
    nativeTools,
    trust: {
      purpose: 'local',
      publicKeyPem: record.publicKeyPem,
      expectedCommit: record.sourceCommit,
      expectedManifestDigest: record.manifestDigest,
    },
  };
}

function valueOf(argv: string[], flag: string): string | null {
  const index = argv.indexOf(flag);

  return index >= 0 && argv[index + 1] ? argv[index + 1]! : null;
}

/**
 * Подтверждение читает человеческий терминал до любых записей тестовой установки.
 * EOF и запуск без TTY не считаются согласием.
 */
async function confirm(question: string, details: string[]): Promise<boolean | 130 | 143> {
  if (!process.stdin.isTTY) {
    throw new Error('dist_install_confirmation_requires_tty');
  }

  if (process.stdout.isTTY) {
    return chooseConfirmation(question, details);
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
 * Терминал показывает пути рядом с подтверждением и начинает со строки отмены.
 * Буквенный ответ по-прежнему можно ввести целиком и подтвердить Enter.
 */
async function chooseConfirmation(question: string, details: string[]): Promise<boolean | 130 | 143> {
  const session = new TerminalSession();
  const { t } = cliTranslator();
  const positioned = process.env.TERM !== 'dumb';
  let selected = 0;
  let typed = '';
  let page = 0;

  /**
   * Перенос строк заново учитывает размер терминала при смене геометрии.
   * Строка выбора сохраняется при просмотре другой страницы подробностей.
   */
  const draw = () => {
    const columns = Math.max(1, Math.min(80, session.columns - 1));
    const inset = columns >= 34 ? '  ' : '';
    const content = columns - inset.length * 2;
    const title = terminalLines(question, content, { words: true });
    const available = Math.max(1, session.rows - title.length - 4);
    const wrapped = details.flatMap((line) => terminalLines(line, content, { words: true }));

    page = Math.min(page, Math.max(0, Math.ceil(wrapped.length / available) - 1));

    const rows: TerminalLine[] = [
      ...title.map((text) => ({ spans: [{ text: inset + text, tone: 'accent' as const }] })),
      ...wrapped.slice(page * available, (page + 1) * available).map((text) => ({
        spans: [{ text: inset + text, tone: 'muted' as const }],
      })),
      ...[t('choice.decline'), t('choice.accept')].map((label, index) => ({
        selected: index === selected,
        spans: [{ text: inset + (index === selected ? '› ' : '  ') + label }],
      })),
      { spans: [{
        text: inset + t(wrapped.length > available ? 'choice.paging' : 'navigation'),
        tone: 'muted',
      }] },
    ];

    session.draw(rows, draw, { theme: 'dark', width: columns });
  };

  if (positioned) {
    session.output.write('\x1b[?1049h');
  }

  try {
    return await session.run(async () => {
      draw();

      for (;;) {
        const key = await session.nextKey();

        if (key.name === 'enter' || key.name === 'return') {
          return typed ? /^(y|yes|д|да)$/iu.test(typed.trim()) : selected === 1;
        }
        if (key.name === 'escape' || key.name === 'eof') {
          return false;
        }
        if (key.name === 'interrupt' || key.name === 'terminate') {
          return key.name === 'interrupt' ? 130 : 143;
        }
        if (key.name === 'up' || key.name === 'down' || key.name === 'tab') {
          selected = 1 - selected;
          typed = '';
          draw();
        } else if (key.name === 'pageup' || key.name === 'pagedown') {
          page = Math.max(0, page + (key.name === 'pageup' ? -1 : 1));
          draw();
        } else if (key.name === 'home' || key.name === 'end') {
          page = key.name === 'home' ? 0 : Number.MAX_SAFE_INTEGER;
          draw();
        } else if (key.name === 'backspace') {
          typed = typed.slice(0, -1);
        } else if (key.text && typed.length < 128) {
          typed += key.text;
        }
      }
    });
  } finally {
    if (positioned) {
      session.output.write('\x1b[?1049l');
    }
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
 * Проверяет два фиксированных файла из приватной записи UUID.
 * Публичная опись артефактов не задаёт путь к исполняемым инструментам.
 */
async function readLocalVerificationTools(record: DistributionRunRecord): Promise<NodeJS.ProcessEnv> {
  const tools = record.verificationTools;

  if (!tools) {
    throw new Error('dist_verification_native_tools_invalid');
  }

  const directory = path.join(await fs.realpath(defaultRunsRoot()), record.runId, 'verification-tools');
  const env = {
    GRIGDESK_BUILD_PROCESS_HELPER: path.join(directory, 'process-identity'),
    GRIGDESK_BUILD_PROCESS_HELPER_SHA256: tools.processIdentity,
    GRIGDESK_TEST_SETSID_BIN: path.join(directory, 'setsid'),
    GRIGDESK_BUILD_SETSID_SHA256: tools.setsid,
  };

  await readDarwinBuildSetsid(env);
  await configureDarwinBuildProcessHelper(env);

  return env;
}

/** Установка и очистка используют тот же физический приватный inode. */
async function proveCheckRoot(directory: string, original: Stats): Promise<void> {
  const current = await fs.lstat(directory);

  if (!original.isDirectory() || !current.isDirectory() || current.uid !== process.getuid!()
    || original.uid !== current.uid || (original.mode & 0o7777) !== 0o700
    || (current.mode & 0o7777) !== 0o700 || original.dev !== current.dev || original.ino !== current.ino
    || await fs.realpath(directory) !== directory) {
    throw new Error('dist_verification_scope_invalid');
  }
}

/**
 * Local check на Mac сохраняет первую причину отмены до проверки выхода сервиса.
 * Состояние записи сборки принадлежит build и в check остаётся только для чтения.
 */
async function checkDistribution(argv: string[]): Promise<number> {
  const scoped = process.platform === 'darwin' && argv.includes('--local-run');
  const cancellation = new AbortController();
  const signal = scoped ? cancellation.signal : undefined;
  const interrupt = () => cancellation.abort(130);
  const terminate = () => cancellation.abort(143);

  if (scoped) {
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
  }

  try {
    const source = await resolveTrust(argv, signal);
    const verified = await verifyDistributionArtifacts(source.directory, {
      ...source.trust, requireHostPlatform: true,
    }, signal);

    signal?.throwIfAborted();

    const temporary = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'dist-check-'));
    const installRoot = scoped ? await fs.realpath(temporary) : temporary;
    const original = scoped ? await fs.lstat(temporary) : null;
    const scope: { state: VerificationScopeState } = { state: 'idle' };

    try {
      if (original) {
        await proveCheckRoot(installRoot, original);
      }

      await verifyInstallation(source.directory, source.trust.expectedCommit, {
        trust: source.trust,
        installRoot,
        modes: ['local', 'remote', 'server'],
        signal,
        nativeTools: source.nativeTools,
        onScopeState: (state) => {
          scope.state = state;
        },
      });
    } finally {
      if (scope.state === 'idle' || scope.state === 'clean') {
        if (original) {
          await proveCheckRoot(installRoot, original);
        }

        await removePrivateTree(installRoot);
      } else {
        process.stderr.write(`Сохранена временная установка ${installRoot}\n`);
      }
    }

    signal?.throwIfAborted();

    process.stdout.write(`${JSON.stringify({
      verified: true,
      version: verified.envelope.payload.version,
      manifestDigest: verified.bootstrap.manifestDigest,
    })}\n`);

    return 0;
  } catch (error) {
    if (signal?.aborted) {
      return signal.reason as number;
    }

    throw error;
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
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
    return checkDistribution(argv);
  }

  if (command === 'install') {
    const mode = valueOf(argv, '--mode');

    if (!mode || !['local', 'remote', 'server'].includes(mode)) {
      throw new Error('dist_install_arguments_required');
    }

    const source = await resolveTrust(argv);
    const verified = await verifyDistributionArtifacts(source.directory, {
      ...source.trust, requireHostPlatform: true,
    });
    const paths = await installationPaths(argv);
    const { t } = cliTranslator();

    process.stdout.write(JSON.stringify({ mode, ...paths }, null, 2) + '\n');

    if (!argv.includes('--yes')) {
      const decision = await confirm(t('distribution.confirmInstall'),
        [mode, ...Object.entries(paths).map(([flag, value]) => `${flag} ${value}`)]);

      if (decision !== true) {
        return decision || 0;
      }
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
    const progress = createDistributionProgress();

    try {
      return await runDistributionBuild(process.cwd(), valueOf(argv, '--channel') ?? 'release',
        defaultRunsRoot(), progress);
    } finally {
      progress?.close();
    }
  }

  process.stderr.write(USAGE);

  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);

    process.exitCode = 2;
  }
}
