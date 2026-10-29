import { promises as fs, type Stats } from 'node:fs';
import path from 'node:path';

import type { ProviderLifecycleOperation } from '../../../../shared/chat/providerLifecycleContracts.ts';
import type { ProviderInstallCommand } from '../executors/index.ts';
import { isOutdated, parseVersion } from '../executors/_npmLatest.ts';
import { runCommand, type CommandOwnership, type PluginCommandRunner }
  from '../pluginInstall/runCommand.ts';
import type { ExternalCliDefinition, ExternalCliInstallation } from './inventoryTypes.ts';
import { InstallEnvironmentError } from './npmEnvironment.ts';
import { treeSnapshot } from './treeSnapshot.ts';

interface NativeStrategyInput {
  operation: Exclude<ProviderLifecycleOperation, 'migrate'>;
  definition: ExternalCliDefinition;
  selected: ExternalCliInstallation;
  installer: ProviderInstallCommand;
  home: string;
  env: NodeJS.ProcessEnv;
  scratch: string;
  version: string | null;
  run?: PluginCommandRunner;
  signal?: AbortSignal;
}

export interface PreparedNativeStrategy {
  method: 'native';
  input: NativeStrategyInput;
  directory: string;
  packageRoot: string;
  alias: string;
  aliasLink: string | null;
  backup: string;
  backupReady: boolean;
  resourceKey: string;
  selectedVersion: string | null;
  version: string | null;
  snapshots: Record<string, string>;
}

const inside = (file: string, root: string): boolean => file.startsWith(root + path.sep);

/**
 * Запись для всех запрещена всегда; групповая запись допустима только своей основной группе.
 * Одно правило применяется к предкам root и к каждому узлу дерева при prepare и revalidate.
 */
const hasForeignWrite = (stat: Pick<Stats, 'mode' | 'gid'>): boolean =>
  !!(stat.mode & 0o002) || (!!(stat.mode & 0o020) && stat.gid !== process.getgid?.());

/**
 * Удаляемый root обязан совпадать с физическим объявленным каталогом внутри HOME.
 * Внешний launcher допускается только как объявленная ссылка внутрь этого root.
 */
async function assertNativeTargets(prepared: Pick<PreparedNativeStrategy,
  'packageRoot' | 'alias' | 'input'>): Promise<void> {
  const { packageRoot: root, alias, input } = prepared;
  const declared = input.definition.native?.find((item) =>
    path.resolve(item.root) === root && path.resolve(item.entry) === alias);
  const physical = await fs.realpath(alias).catch(() => null);

  if (!declared || !inside(root, path.resolve(input.home)) || !inside(alias, path.resolve(input.home))
    || await fs.realpath(root).catch(() => null) !== root
    || !physical || !inside(physical, root)) {
    throw new InstallEnvironmentError('installation_conflict', 'Изменились пути выбранной программы');
  }
  if (!inside(alias, root) && !(await fs.lstat(alias)).isSymbolicLink()) {
    throw new InstallEnvironmentError('installation_conflict', 'Не подтверждена ссылка на программу');
  }

  // Родители проверяются отдельно: rm не должен пройти через подменённую ссылку.
  // Каталоги, доступные чужому writer, не дают достаточного доказательства ownership.
  for (const target of [root, path.dirname(alias)]) {
    let current = target;

    while (inside(current, path.resolve(input.home)) || current === path.resolve(input.home)) {
      const stat = await fs.lstat(current);

      if (!stat.isDirectory() || stat.uid !== process.getuid?.() || hasForeignWrite(stat)) {
        throw new InstallEnvironmentError('native_ownership_unverified',
          `Не подтверждены владелец или права каталога программы: проверьте права на ${current}`);
      }
      if (current === path.resolve(input.home)) {
        break;
      }

      current = path.dirname(current);
    }
  }
}

/**
 * Снимок дополняет хеш байтов inode и владельцами всего дерева без перехода по ссылкам.
 * Даже замена файла теми же байтами требует нового подтверждения пользователя.
 */
async function nativeIdentity(root: string): Promise<string> {
  const identity: unknown[] = [];

  /**
   * Обход сверяет владельца каждого узла, включая ссылки, и не покидает дерево.
   * Метаданные фиксируются до чтения байтов для проверки замены между preview и start.
   */
  async function visit(file: string): Promise<void> {
    const stat = await fs.lstat(file);

    if (stat.uid !== process.getuid?.() || (!stat.isSymbolicLink() && hasForeignWrite(stat))) {
      throw new InstallEnvironmentError('native_ownership_unverified',
        `Не подтверждены владелец или права файлов программы: проверьте права на ${file}`);
    }

    identity.push([file, stat.dev, stat.ino, stat.uid, stat.gid, stat.mode,
      stat.size, stat.mtimeMs, stat.ctimeMs]);

    if (stat.isDirectory()) {
      for (const entry of (await fs.readdir(file)).sort()) {
        await visit(path.join(file, entry));
      }
    }
  }

  await visit(root);

  return JSON.stringify([identity, await treeSnapshot(root)]);
}

/**
 * Версия проверяется у объявленного entry, а не у случайного одноимённого CLI из PATH.
 * Успешный exit без распознанной версии не подтверждает установку.
 */
export async function probeNativeVersion(input: {
  alias: string;
  home: string;
  env: NodeJS.ProcessEnv;
  run?: PluginCommandRunner;
  signal?: AbortSignal;
  ownership?: CommandOwnership;
}): Promise<string> {
  const result = await (input.run ?? runCommand)(input.alias, ['--version'], {
    cwd: input.home,
    env: input.env,
    timeoutMs: 30_000,
    signal: input.signal,
    ownership: input.ownership,
  });
  const version = parseVersion(result.stdout)?.join('.');

  if (result.code !== 0 || result.aborted || result.timedOut || result.stdoutTruncated || !version) {
    throw new InstallEnvironmentError('version_unverified', 'Версия программы не подтверждена');
  }

  return version;
}

/**
 * Подготовка не запускает installer и не требует Node/npm для готовой программы.
 * Объявленный root содержит только программу; credentials и история в него не добавляются.
 */
export async function prepareNativeStrategy(input: NativeStrategyInput): Promise<PreparedNativeStrategy> {
  const declared = input.definition.native?.find((item) => item.root === input.selected.root
    && (input.selected.aliases.includes(item.entry) || item.entry === input.selected.realpath));

  if (!declared || input.selected.source !== 'native' || input.operation === 'install') {
    throw new InstallEnvironmentError('unsupported_action', 'Не подтверждена выбранная копия программы');
  }

  const targets = {
    packageRoot: path.resolve(declared.root),
    alias: path.resolve(declared.entry),
    input,
  };

  await assertNativeTargets(targets);

  const snapshots: Record<string, string> = {};

  for (const file of new Set([targets.packageRoot, targets.alias])) {
    snapshots[file] = await nativeIdentity(file);
  }

  const selectedVersion = await probeNativeVersion({ ...input, alias: targets.alias }).catch((error) => {
    if (input.operation === 'uninstall') {
      return null;
    }

    throw error;
  });

  await fs.mkdir(input.scratch, { recursive: true, mode: 0o700 });

  const directory = await fs.mkdtemp(path.join(input.scratch, 'native-'));

  return {
    method: 'native',
    ...targets,
    directory,
    aliasLink: await fs.readlink(targets.alias).catch(() => null),
    backup: path.join(directory, 'backup'),
    backupReady: false,
    resourceKey: input.selected.resourceKey,
    selectedVersion,
    version: input.operation === 'uninstall' ? null : input.version,
    snapshots,
  };
}

/**
 * Повторная проверка перед записью связывает commit с ownership и identity preview.
 * Новый файл, владелец, ссылка или подмена предка закрывают операцию без удаления.
 */
export async function revalidateNativeStrategy(prepared: PreparedNativeStrategy): Promise<void> {
  await assertNativeTargets(prepared);

  for (const [file, expected] of Object.entries(prepared.snapshots)) {
    if (await nativeIdentity(file) !== expected) {
      throw new InstallEnvironmentError('preparation_changed', 'Программа изменилась после подготовки');
    }
  }
}

/**
 * Удаление затрагивает только объявленный root и внешний launcher-ссылку адаптера.
 * Обновление и переустановка запускают его официальный installer под общим worker ownership.
 */
export async function executeNativeStrategy(prepared: PreparedNativeStrategy, options: {
  ownership: CommandOwnership;
  output(text: string): void;
  phase(value: 'backup' | 'download-install' | 'version' | 'cleanup'): Promise<void>;
}): Promise<void> {
  const { input, alias, packageRoot } = prepared;

  input.signal?.throwIfAborted();
  await options.phase('backup');
  await fs.cp(packageRoot, prepared.backup, {
    recursive: true,
    verbatimSymlinks: true,
    errorOnExist: true,
  });
  await revalidateNativeStrategy(prepared);
  prepared.backupReady = true;
  await options.phase('download-install');
  input.signal?.throwIfAborted();

  if (input.operation === 'uninstall') {
    if (!inside(alias, packageRoot)) {
      await fs.unlink(alias);
    }

    await fs.rm(packageRoot, { recursive: true });
  } else {
    const command = input.installer;
    const result = await (input.run ?? runCommand)(command.executable, command.args, {
      cwd: input.home,
      env: input.env,
      signal: input.signal,
      timeoutMs: 10 * 60 * 1000,
      ownership: options.ownership,
      onStdout: options.output,
      onStderr: options.output,
    });

    if (result.code !== 0 || result.aborted || result.timedOut) {
      throw new InstallEnvironmentError(result.timedOut ? 'timeout'
        : result.aborted ? 'interrupted' : 'command_exit_failed',
      'Установщик программы завершился с ошибкой');
    }
  }

  await options.phase('version');

  if (input.operation === 'uninstall') {
    if (await fs.lstat(packageRoot).then(() => true, () => false)
      || await fs.lstat(alias).then(() => true, () => false)) {
      throw new InstallEnvironmentError('uninstall_unverified', 'Удаление программы не подтверждено');
    }
  } else {
    await assertNativeTargets(prepared);

    const version = await probeNativeVersion({
      ...input,
      alias,
      ownership: options.ownership,
    });

    if (isOutdated(version, prepared.version) || isOutdated(version, prepared.selectedVersion)) {
      throw new InstallEnvironmentError('version_unverified', 'Установщик не обновил выбранную программу');
    }

    prepared.version = version;
  }
}

/**
 * Отказ installer возвращает только собственный законченный backup программы.
 * Пользовательские данные находятся вне этого root и в восстановлении не участвуют.
 */
export async function restoreNativeStrategy(prepared: PreparedNativeStrategy):
  Promise<'restored' | 'unavailable'> {
  if (!prepared.backupReady || await treeSnapshot(prepared.backup)
    !== JSON.parse(prepared.snapshots[prepared.packageRoot]!)[1]) {
    return 'unavailable';
  }

  await assertNativeTargets(prepared);
  await fs.rm(prepared.packageRoot, { recursive: true });
  await fs.cp(prepared.backup, prepared.packageRoot, { recursive: true, verbatimSymlinks: true });

  if (!inside(prepared.alias, prepared.packageRoot) && prepared.aliasLink !== null) {
    await fs.unlink(prepared.alias);
    await fs.symlink(prepared.aliasLink, prepared.alias);
  }

  const version = await probeNativeVersion({ ...prepared.input, alias: prepared.alias });

  return version === prepared.selectedVersion ? 'restored' : 'unavailable';
}
