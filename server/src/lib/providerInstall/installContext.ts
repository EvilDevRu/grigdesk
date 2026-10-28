import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { shellQuote } from '../../../../shared/lib/shellQuote.ts';
import type {
  ProviderInstallNotice,
  ProviderInstallOperation,
  ProviderInstallShellChange,
} from '../../../../shared/chat/providerInstallContracts.ts';
import type { ProviderInstallCommand, ProviderInstallation } from '../executors/index.ts';
import { probeBashEnvironment, type BashProbeReport } from './bashEnvironment.ts';
import { chooseDirectoryOrder, planBashPath, type BashPathPlan } from './bashPath.ts';
import { inspectBinTarget, type BinIdentity, type BinTargetInspection } from './legacyBinMigration.ts';
import {
  InstallEnvironmentError,
  npmInstallArgs,
  npmInstallCommandText,
  readGlobalPrefix,
  resolveExternalRuntime,
  selectInstallPrefix,
  type ExternalInstallRuntime,
  type InstallRoots,
} from './npmEnvironment.ts';

/**
 * Контекст установки собирается один раз и переиспользуется установщиком,
 * проверкой prefix и повторами. Окружение и argv не возвращаются к ports.env,
 * а внешние Node/npm закрепляются явной парой абсолютных путей.
 */
export interface RuntimeIdentity extends BinIdentity {
  file: string;
  realpath: string;
}

export interface ActiveBinding {
  name: string;
  directory: string;
  binPath: string;
  packageId: string;
}

export interface NpmInstallContext {
  runtime: ExternalInstallRuntime;
  packageId: string;
  binName: string;
  configKey: string;
  envKey: string;
  oldBin: string | null;
  prefix: string;
  fallback: boolean;
  effectivePrefix: string;
  args: string[];
  displayCommand: string;
  target: BinTargetInspection;
  migrate: boolean;
  warnings: ProviderInstallNotice[];
  identities: RuntimeIdentity[];
}

export interface ShellInstallContext {
  report: BashProbeReport;
  plan: BashPathPlan | null;
  terminalSetup: 'bash' | 'manual';
  reason: string | null;
  changes: ProviderInstallShellChange[];
  directories: string[];
}

export interface InstallContext {
  kind: 'npm' | 'native';
  command: ProviderInstallCommand;
  loginArgs: string[] | null;
  loginCommand: string;
  prefix: string | null;
  nativeBinDirs: string[];
  npm: NpmInstallContext | null;
  shell: ShellInstallContext | null;
  warnings: ProviderInstallNotice[];
}

const PREFIX_TIMEOUT_MS = 10_000;

const notice = (code: string, message: string): ProviderInstallNotice => ({ code, message });

async function identityOf(file: string): Promise<RuntimeIdentity> {
  const realpath = await fs.realpath(file);
  const stat = await fs.stat(realpath);

  return {
    file,
    realpath,
    dev: stat.dev,
    ino: stat.ino,
  };
}

/**
 * Внешний Node из startup-файлов важнее серверного: npm — скрипт с `env node`,
 * поэтому его собственный каталог ставится первым только в окружении установщика.
 */
function pinShellRuntime(runtime: ExternalInstallRuntime, npm: string, node: string):
  ExternalInstallRuntime {
  const nodeDirectory = path.dirname(node);
  const entries = (runtime.env.PATH ?? '').split(path.delimiter)
    .filter((entry) => entry && path.resolve(entry) !== path.resolve(nodeDirectory));

  return {
    npm,
    node,
    home: runtime.home,
    env: { ...runtime.env, PATH: [nodeDirectory, ...entries].join(path.delimiter) },
  };
}

/**
 * Эффективный prefix берётся у той же оболочки, что запускала npm: значение из `-ic`
 * уже учитывает пользовательский npmrc, config и env. Серверная копия используется
 * только когда независимая оболочка недоступна или её startup не сработал.
 */
async function effectivePrefix(runtime: ExternalInstallRuntime, report: BashProbeReport | null,
  scratch: string, signal?: AbortSignal): Promise<string> {
  const fromShell = report?.interactive?.prefix;

  if (fromShell) {
    return fromShell;
  }

  return readGlobalPrefix(runtime, {
    cwd: scratch,
    timeoutMs: PREFIX_TIMEOUT_MS,
    signal,
  });
}

/**
 * План Bash строится только в явной операции. Неподдержанная оболочка, отказ probe,
 * невыполнимый порядок каталогов и повреждённый rc дают manual/conflict, а не запись.
 */
async function buildShellContext(input: {
  probe: BashProbeReport | null;
  home: string;
  roots: InstallRoots;
  prefix: string;
  binName: string;
  bindings: readonly ActiveBinding[];
  withShell: boolean;
  warnings: ProviderInstallNotice[];
}): Promise<ShellInstallContext | null> {
  if (!input.withShell || !input.probe) {
    return null;
  }

  const report = input.probe;

  if (report.shell !== 'bash' || report.failed) {
    input.warnings.push(notice('terminal_setup_required',
      'Оболочка не поддерживается автоматически: каталог установки нужно добавить в PATH вручную'));

    return {
      report,
      plan: null,
      terminalSetup: 'manual',
      reason: 'terminal_setup_required',
      changes: [],
      directories: [],
    };
  }

  const added = path.join(input.prefix, 'bin');
  const bindings = input.bindings.map((binding) => ({
    name: binding.name,
    directory: binding.directory,
  }));
  const selected = await chooseDirectoryOrder({
    added,
    existing: bindings.map((binding) => binding.directory),
    bindings,
  });

  if (selected.conflict) {
    input.warnings.push(notice('terminal_command_conflict',
      'Порядок каталогов PATH не разрешает активные команды; блок PATH не изменён'));

    return {
      report,
      plan: null,
      terminalSetup: 'manual',
      reason: 'terminal_command_conflict',
      changes: [],
      directories: [],
    };
  }

  const plan = await planBashPath({
    home: input.home,
    roots: input.roots,
    directories: selected.order,
  });

  if (plan.status === 'conflict') {
    input.warnings.push(notice('terminal_command_conflict',
      'Управляемый блок PATH повреждён; файл настройки оставлен как есть'));

    return {
      report,
      plan,
      terminalSetup: 'manual',
      reason: 'terminal_command_conflict',
      changes: [],
      directories: selected.order,
    };
  }
  if (plan.status === 'manual') {
    input.warnings.push(notice('terminal_setup_required',
      'Файл настройки Bash нельзя изменить автоматически; нужна ручная настройка PATH'));

    return {
      report,
      plan,
      terminalSetup: 'manual',
      reason: plan.reason,
      changes: [],
      directories: selected.order,
    };
  }

  return {
    report,
    plan,
    terminalSetup: 'bash',
    reason: null,
    changes: plan.changes.map((change) => ({
      file: change.file,
      action: change.action,
      block: change.block,
    })),
    directories: plan.directories,
  };
}

/**
 * Чужой одноимённый объект в уже используемом `~/.local/bin` — отказ до npm.
 * Затенять разрешено только доказанную ссылку на переносимый D-пакет.
 */
async function assertLocalShadow(input: {
  home: string;
  roots: InstallRoots;
  packageId: string;
  binName: string;
  oldBin: string | null;
}): Promise<void> {
  const localPrefix = path.join(path.resolve(input.home), '.local');
  const local = await inspectBinTarget({
    target: path.join(localPrefix, 'bin', input.binName),
    prefix: localPrefix,
    roots: input.roots,
    packageId: input.packageId,
    binName: input.binName,
    oldBin: input.oldBin,
  });

  if (local.status !== 'free' && local.status !== 'legacy') {
    throw new InstallEnvironmentError('npm_bin_conflict',
      'В пользовательском ~/.local/bin уже есть чужая команда с тем же именем');
  }
}

/**
 * Собирает npm-контекст: shell probe, внешняя пара Node/npm, выбранный prefix,
 * цель bin и план настройки Bash. Отказы выражаются кодом InstallEnvironmentError,
 * а не текстом npm; папки и rc при этом не меняются.
 */
export async function buildInstallContext(input: {
  config: Record<string, unknown>;
  env: NodeJS.ProcessEnv;
  roots: InstallRoots;
  home: string;
  scratch: string;
  cliName: string;
  command: ProviderInstallCommand;
  declared: ProviderInstallation;
  operation: ProviderInstallOperation;
  withShell: boolean;
  activeBindings: readonly ActiveBinding[];
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<InstallContext> {
  const loginArgs = input.declared.loginArgs ?? null;
  const warnings: ProviderInstallNotice[] = [];
  const binding = input.command.npmBinding;

  if (!binding) {
    return {
      kind: 'native',
      command: input.command,
      loginArgs,
      loginCommand: input.declared.loginCommand,
      prefix: null,
      nativeBinDirs: input.declared.nativeBinDirs ?? [],
      npm: null,
      shell: null,
      warnings,
    };
  }

  const probe = input.withShell ? await probeBashEnvironment({
    env: input.env,
    roots: input.roots,
    cliName: input.cliName,
    scratch: input.scratch,
    nonce: randomBytes(12).toString('base64url'),
    timeoutMs: input.timeoutMs,
    signal: input.signal,
  }) : null;

  if (probe?.failed) {
    warnings.push(notice('shell_probe_failed',
      'Не удалось проверить внешнюю оболочку; установка продолжится без настройки терминала'));
  }

  let runtime = await resolveExternalRuntime({
    env: input.env,
    roots: input.roots,
    home: input.home,
  });
  const shellRuntime = probe?.interactive;

  if (shellRuntime?.node.kind === 'file' && shellRuntime.npm.kind === 'file') {
    runtime = pinShellRuntime(runtime, shellRuntime.npm.path, shellRuntime.node.path);
  }

  const effective = await effectivePrefix(runtime, probe, input.scratch, input.signal);
  const selection = await selectInstallPrefix({
    runtime,
    roots: input.roots,
    packageId: binding.packageId,
    home: input.home,
    requested: effective,
    cwd: input.scratch,
    timeoutMs: PREFIX_TIMEOUT_MS,
    signal: input.signal,
  });
  const targetPath = path.join(selection.prefix, 'bin', binding.binName);
  const oldBin = typeof input.config[binding.configKey] === 'string'
    ? input.config[binding.configKey] as string : null;
  const target = await inspectBinTarget({
    target: targetPath,
    prefix: selection.prefix,
    roots: input.roots,
    packageId: binding.packageId,
    binName: binding.binName,
    oldBin,
  });
  const localPrefix = path.join(path.resolve(input.home), '.local');
  const sameAsLocal = path.resolve(selection.prefix) === path.resolve(localPrefix);
  const migrate = target.status === 'legacy' && sameAsLocal;

  if (target.status === 'conflict' || (target.status === 'legacy' && !migrate)) {
    throw new InstallEnvironmentError('npm_bin_conflict',
      'На месте установки уже есть чужая команда с тем же именем');
  }
  if (!sameAsLocal) {
    await assertLocalShadow({
      home: input.home,
      roots: input.roots,
      packageId: binding.packageId,
      binName: binding.binName,
      oldBin,
    });
  }
  if (migrate && !input.withShell) {
    throw new InstallEnvironmentError('npm_bin_conflict',
      'Прежняя ссылка на пакет мешает установке, нужна явная подготовка операции');
  }

  const shell = await buildShellContext({
    probe,
    home: input.home,
    roots: input.roots,
    prefix: selection.prefix,
    binName: binding.binName,
    bindings: input.activeBindings,
    withShell: input.withShell,
    warnings,
  });

  return {
    kind: 'npm',
    command: input.command,
    loginArgs,
    loginCommand: loginArgs
      ? [shellQuote(targetPath), ...loginArgs.map(shellQuote)].join(' ')
      : input.declared.loginCommand,
    prefix: selection.prefix,
    nativeBinDirs: [],
    npm: {
      runtime,
      packageId: binding.packageId,
      binName: binding.binName,
      configKey: binding.configKey,
      envKey: binding.envKey,
      oldBin,
      prefix: selection.prefix,
      fallback: selection.fallback,
      effectivePrefix: effective,
      args: npmInstallArgs(binding.packageId, selection.prefix),
      displayCommand: npmInstallCommandText(runtime.npm, binding.packageId, selection.prefix),
      target,
      migrate,
      warnings: selection.warnings,
      identities: [await identityOf(runtime.npm), await identityOf(runtime.node)],
    },
    shell,
    warnings,
  };
}

/**
 * Предупреждения контекста собираются из выбранного prefix и состояния оболочки.
 * Порядок стабилен: сначала каталог установки, затем внешняя оболочка.
 */
export function contextWarnings(context: InstallContext): ProviderInstallNotice[] {
  return [...(context.npm?.warnings ?? []), ...context.warnings];
}
