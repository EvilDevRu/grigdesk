import { randomBytes } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';

import type { ExecutorAdapter } from '../executors/index.ts';
import type {
  ExternalCliInstallation,
  ExternalCliInventory,
} from '../../../../shared/chat/providerInstallationInventory.ts';
import type {
  ProviderLifecycleFootprint,
  ProviderLifecycleMigrationPreparation,
  ProviderMigrationEntry,
  ProviderMigrationTarget,
} from '../../../../shared/chat/providerLifecycleContracts.ts';
import type { ProviderInstallNotice } from '../../../../shared/chat/providerInstallContracts.ts';
import { readEnvFile, updateEnvFile } from '../envFile.ts';
import { runCommand, type PluginCommandRunner } from '../packageInstall/runCommand.ts';
import { discoverExternalCli } from './inventory.ts';
import type { ExternalCliDefinition, ExternalCliInventoryInput } from './inventoryTypes.ts';
import {
  InstallEnvironmentError, type InstallRoots,
} from './npmEnvironment.ts';
import {
  assertNoLegacyKimiShim, executeNpmStrategy, prepareNpmStrategy, revalidateNpmStrategy,
  type PreparedNpmStrategy,
} from './npmStrategy.ts';
import { BLOCK_END, BLOCK_START, findManagedBlock } from './bashPath.ts';
import { resolveUserCliEnvironment, resolveUserCliNpm } from './userCliEnvironment.ts';
import { treeSnapshot } from './treeSnapshot.ts';

export interface MigrationShellChange {
  file: string;
  block: string;
  action: 'remove';
  before: Buffer;
  after: Buffer;
  mode: number;
  dev: number;
  ino: number;
  backup: string;
}

export interface MigrationShim {
  from: string;
  to: string;
  dev: number;
  ino: number;
  backup: string;
}

export interface MigrationTargetPlan {
  providerId: string;
  definition: ExternalCliDefinition;
  sourceIds: string[];
  removeIds: string[];
  sources: ExternalCliInstallation[];
  removeRoots: string[];
  removeAliases: string[];
  configKey: string;
  envKey: string;
  oldConfig: string | null;
  prepared: PreparedNpmStrategy;
  environment: NodeJS.ProcessEnv;
  target: ProviderMigrationTarget;
}

export interface MigrationPlan {
  preview: ProviderLifecycleMigrationPreparation;
  scope: string;
  consumed: boolean;
  directory: string;
  envPath: string | null;
  configChanges: Record<string, string>;
  targets: MigrationTargetPlan[];
  shell: MigrationShellChange[];
  shims: MigrationShim[];
  cleanupOwnedShell: boolean;
  sourceSnapshots: Record<string, string>;
}

const notice = (code: string, message: string): ProviderInstallNotice => ({ code, message });
const inside = (file: string, root: string): boolean => file === root || file.startsWith(root + path.sep);
const outside = (file: string, roots: readonly string[]): boolean =>
  !roots.some((root) => inside(path.resolve(file), path.resolve(root)));
const versionPattern = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/u;

/**
 * Список legacy-корней: только доказанные внутренние копии GrigDesk получают origin.
 * Пользовательский prefix остаётся user-копией и не удаляется миграцией.
 */
export function legacyRootsOf(roots: InstallRoots): string[] {
  return [path.join(roots.dataHome, 'state', 'npm-global'), roots.installationRoot, roots.runtimeRoot];
}

/**
 * Разбор каталогов из управляемого блока без запуска shell.
 * Чужой текст считается данными: неверная строка просто не даёт каталога.
 */
function blockDirectories(block: string): string[] {
  const lines = block.split('\n');
  const start = lines.findIndex((line) => line.trim() === '__grigdesk_cli_dirs=(');
  const end = lines.findIndex((line, index) => index > start && line.trim() === ')');

  if (start < 0 || end < 0) {
    return [];
  }

  const directories: string[] = [];

  for (const line of lines.slice(start + 1, end)) {
    const value = line.trim();

    if (!value) {
      continue;
    }
    if (value.startsWith("'") && value.endsWith("'")) {
      directories.push(value.slice(1, -1).replace(/'\\''/gu, "'"));
    } else if (path.isAbsolute(value)) {
      directories.push(value);
    }
  }

  return directories;
}

/**
 * Чтение файла startup-оболочки без ссылки и с ограничением размера.
 * Симлинк отвергается на уровне open, а не после чтения чужого файла.
 */
async function readShellFile(file: string): Promise<{
  bytes: Buffer;
  mode: number;
  dev: number;
  ino: number;
} | null> {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);

  if (!handle) {
    return null;
  }

  try {
    const stat = await handle.stat();

    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) {
      throw new InstallEnvironmentError('shell_cleanup_conflict',
        'Файл оболочки недоступен для миграции');
    }
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw new InstallEnvironmentError('shell_cleanup_conflict',
        'Файл оболочки принадлежит другому пользователю');
    }

    const buffer = Buffer.alloc(stat.size);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);

    return {
      bytes: buffer.subarray(0, bytesRead),
      mode: stat.mode,
      dev: stat.dev,
      ino: stat.ino,
    };
  } finally {
    await handle.close();
  }
}

const shellFileNames = ['.bashrc', '.bash_profile', '.profile', '.bash_login'];

/**
 * Удаляются только точные управляемые блоки и доказанные legacy exports.
 * Соседние строки, комментарии и mode сохраняются; symlink сразу даёт отказ.
 */
async function planShellCleanup(input: {
  home: string;
  legacyRoots: string[];
  adapters: Map<string, ExecutorAdapter>;
  entries: ProviderMigrationEntry[];
  config: unknown;
  cleanupOwnedShell: boolean;
  directory: string;
}): Promise<{ shell: MigrationShellChange[]; warnings: ProviderInstallNotice[] }> {
  const shell: MigrationShellChange[] = [];
  const warnings: ProviderInstallNotice[] = [];
  const covered = new Set(input.entries.map((entry) => entry.providerId));
  const seen = new Set<string>();
  let found = 0;

  for (const name of shellFileNames) {
    const file = path.join(input.home, name);
    const lstat = await fs.lstat(file).catch(() => null);

    if (!lstat) {
      continue;
    }
    if (lstat.isSymbolicLink()) {
      const followed = await fs.readFile(file, 'utf8').catch(() => null);

      if (followed?.includes(BLOCK_START) || followed?.includes('state/npm-global/bin')) {
        throw new InstallEnvironmentError('shell_cleanup_conflict',
          'Файл оболочки является ссылкой; миграция не переписывает чужие настройки');
      }

      continue;
    }

    const current = await readShellFile(file);

    if (!current) {
      continue;
    }

    const text = current.bytes.toString('utf8');
    const block = findManagedBlock(text);

    if (block === 'invalid') {
      throw new InstallEnvironmentError('shell_cleanup_conflict',
        'Управляемый блок PATH повреждён или продублирован');
    }

    let after = text;
    let blockText: string | null = null;

    if (block !== 'absent') {
      const lines = text.split('\n');
      const blockLines = lines.slice(block.start, block.end + 1);
      const directories = blockDirectories(blockLines.join('\n'));

      for (const adapter of input.adapters.values()) {
        if (covered.has(adapter.id)) {
          continue;
        }

        const definition = adapter.externalCli?.(input.config, input.home);

        if (!definition) {
          continue;
        }

        for (const directory of directories) {
          const candidate = path.join(directory, definition.binName);

          if (await fs.stat(candidate).then((stat) => stat.isFile(), () => false)) {
            throw new InstallEnvironmentError('migration_block_dependency',
              `Общий блок PATH содержит другого исполнителя (${adapter.id}); включите его в перенос`);
          }
        }
      }

      found += 1;
      blockText = blockLines.join('\n') + (block.end + 1 < lines.length ? '\n' : '');
      after = [...lines.slice(0, block.start), ...lines.slice(block.end + 1)].join('\n');
    }

    const lines = after.split('\n');
    const kept: string[] = [];
    let exportChanged = false;

    for (const line of lines) {
      const match = /^\s*(?:export\s+)?PATH=(?:"([^"]+)"|'([^']+)'|(\S+)):\$PATH\s*$/u.exec(line);
      const directory = match?.[1] ?? match?.[2] ?? match?.[3];

      if (directory && path.isAbsolute(directory)
        && !outside(directory, input.legacyRoots)) {
        found += 1;
        exportChanged = true;

        continue;
      }

      kept.push(line);
    }

    if (exportChanged) {
      after = kept.join('\n');
    }

    if (after === text) {
      continue;
    }
    if (!input.cleanupOwnedShell) {
      warnings.push(notice('shell_cleanup_skipped',
        'Строки PATH не изменены: очистка оболочки не подтверждена'));

      continue;
    }

    const backup = path.join(input.directory, 'shell', `${bufferName(file)}-${current.ino}`);
    const change: MigrationShellChange = {
      file,
      block: blockText ?? 'legacy_path_export',
      action: 'remove',
      before: current.bytes,
      after: Buffer.from(after),
      mode: current.mode,
      dev: current.dev,
      ino: current.ino,
      backup,
    };

    if (seen.has(file)) {
      throw new InstallEnvironmentError('shell_cleanup_conflict',
        'Один файл оболочки требует двух независимых правок');
    }

    seen.add(file);
    shell.push(change);
  }

  if (!found) {
    warnings.push(notice('shell_cleanup_absent', 'Доказанных вставок PATH прежней схемы не найдено'));
  }

  return { shell, warnings };
}

const bufferName = (file: string): string => Buffer.from(file).toString('hex');

/** Приватная копия исходных байтов до первой правки оболочки. */
async function backupShell(change: MigrationShellChange): Promise<void> {
  await fs.mkdir(path.dirname(change.backup), { recursive: true, mode: 0o700 });
  await fs.writeFile(change.backup, change.before, { mode: 0o600, flag: 'wx' });
}

/**
 * Запись startup-файла сохраняет его mode и не следует симлинку.
 * Перед заменой байты обязаны совпасть со снимком preview.
 */
async function writeShell(change: MigrationShellChange): Promise<void> {
  const current = await readShellFile(change.file);

  if (!current || current.dev !== change.dev || current.ino !== change.ino
    || current.mode !== change.mode || !current.bytes.equals(change.before)) {
    throw new InstallEnvironmentError('migration_recovery_required',
      'Файл оболочки изменился после preview; запись не выполнена');
  }

  const temporary = path.join(path.dirname(change.file),
    `.${path.basename(change.file)}.grigdesk-${randomBytes(6).toString('hex')}`);
  const handle = await fs.open(temporary, 'wx', change.mode & 0o7777);

  try {
    await handle.writeFile(change.after);
    await handle.sync();
  } finally {
    await handle.close();
  }

  await fs.rename(temporary, change.file);
}

/**
 * Восстановление оболочки после сбоя активации не затирает чужую правку.
 * Возвращает false, если файл уже не совпадает с записанным after.
 */
async function restoreShell(change: MigrationShellChange): Promise<boolean> {
  const current = await readShellFile(change.file).catch(() => null);

  if (!current || !current.bytes.equals(change.after)) {
    return false;
  }

  await fs.writeFile(change.file, change.before, { mode: change.mode & 0o7777 });

  return true;
}

/**
 * Последняя версия пакета нужна только при отсутствии версии у старой копии.
 * Сеть здесь не подменяет точную версию, полученную из inventory.
 */
async function latestVersion(input: {
  runtime: {
    node: string;
    npm: string;
    env: NodeJS.ProcessEnv;
    home: string;
  };
  definition: ExternalCliDefinition;
  run?: PluginCommandRunner;
}): Promise<string | null> {
  const result = await (input.run ?? runCommand)(input.runtime.node,
    [input.runtime.npm, 'view', input.definition.packageId, 'version', '--json'], {
      cwd: input.runtime.home,
      env: input.runtime.env,
      timeoutMs: 30_000,
    });

  if (result.code !== 0) {
    return null;
  }

  try {
    const value: unknown = JSON.parse(result.stdout);

    return typeof value === 'string' && versionPattern.test(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Выбранные цели проверяются по одному атомарному inventory, без доверия путям клиента.
 * Старые копии удаляются только при доказанном origin grigdesk.
 */
async function targetOf(input: {
  entry: ProviderMigrationEntry;
  adapter: ExecutorAdapter;
  definition: ExternalCliDefinition;
  inventory: ExternalCliInventory;
  legacyRoots: string[];
  runtime: Awaited<ReturnType<typeof resolveUserCliNpm>>['runtime'];
  environment: NodeJS.ProcessEnv;
  prefix: string;
  loginPath: string;
  scratch: string;
  run?: PluginCommandRunner;
}): Promise<MigrationTargetPlan> {
  const known = new Map(input.inventory.installations.map((entry) => [entry.installationId, entry]));
  const sources = input.entry.sourceIds.map((id) => {
    const source = known.get(id);

    if (!source) {
      throw new InstallEnvironmentError('preparation_changed',
        'Выбранная старая копия больше не найдена');
    }

    return source;
  });
  const remove = input.entry.removeIds.map((id) => known.get(id)!).filter(Boolean);
  const versions = sources.map((source) => source.version).filter((version): version is string => !!version);

  if (new Set(versions).size > 1) {
    throw new InstallEnvironmentError('migration_version_conflict',
      'Старые копии имеют разные версии; выберите одну');
  }

  const version = versions[0] ?? await latestVersion({
    runtime: input.runtime,
    definition: input.definition,
    run: input.run,
  });

  if (!version) {
    throw new InstallEnvironmentError('migration_version_conflict',
      'Не удалось определить версию переносимой копии');
  }

  const prepared = await prepareNpmStrategy({
    providerId: input.entry.providerId,
    operation: 'install',
    definition: input.definition,
    selected: null,
    runtime: input.runtime,
    prefix: input.prefix,
    version,
    scratch: input.scratch,
    loginPath: input.loginPath,
    allowKimiShimMigration: true,
    run: input.run,
  });
  const prefix = input.prefix;
  const removeRoots: string[] = [];
  const removeAliases: string[] = [];

  for (const source of remove) {
    if (source.origin !== 'grigdesk' || !source.root) {
      throw new InstallEnvironmentError('migration_source_not_owned',
        'Удалять можно только доказанные внутренние копии GrigDesk');
    }

    removeRoots.push(source.root);

    for (const alias of source.aliases) {
      if (inside(alias, path.join(prefix, 'bin'))) {
        continue;
      }
      // Удаляется только ссылка внутри доказанного legacy-корня: пользовательский bin
      // без отдельного подтверждения не трогаем.
      if (!outside(alias, input.legacyRoots)) {
        removeAliases.push(alias);
      }
    }
  }

  const target: ProviderMigrationTarget = {
    providerId: input.entry.providerId,
    sourceIds: input.entry.sourceIds,
    removeIds: input.entry.removeIds,
    targetMethod: 'npm',
    fromVersion: versions[0] ?? null,
    targetVersion: version,
    command: `npm install --global --prefix ${JSON.stringify(prefix)} `
      + `${input.definition.packageId}@${version}`,
    prefix,
    footprint: [
      {
        path: prepared.packageRoot,
        action: 'install',
        reason: input.definition.packageId,
      },
      {
        path: prepared.alias,
        action: 'replace',
        reason: input.definition.binName,
      },
      ...removeRoots.map((root) => ({
        path: root,
        action: 'remove' as const,
        reason: 'legacy copy',
      })),
      ...removeAliases.map((alias) => ({
        path: alias,
        action: 'remove' as const,
        reason: 'legacy alias',
      })),
    ],
    warnings: [],
  };

  return {
    providerId: input.entry.providerId,
    definition: input.definition,
    sourceIds: input.entry.sourceIds,
    removeIds: input.entry.removeIds,
    sources,
    removeRoots,
    removeAliases,
    configKey: input.definition.configKey,
    envKey: input.definition.envKey,
    oldConfig: null,
    prepared,
    environment: input.environment,
    target,
  };
}

/**
 * Preview собирает цели всех провайдеров, старые ссылки, rc-строки и shims.
 * Ни одна мутация здесь не выполняется; любые сомнения закрывают preview.
 */
export async function prepareMigrationPlan(input: {
  entries: ProviderMigrationEntry[];
  cleanupOwnedShell: boolean;
  adapters: Map<string, ExecutorAdapter>;
  config: unknown;
  env: NodeJS.ProcessEnv;
  envPath: string | null;
  home: string;
  roots: InstallRoots;
  scratch: string;
  scope: string;
  ttl: number;
  run?: PluginCommandRunner;
}): Promise<MigrationPlan> {
  if (!input.entries.length || input.entries.length > 3
    || new Set(input.entries.map((entry) => entry.providerId)).size !== input.entries.length) {
    throw new InstallEnvironmentError('migration_entries_invalid',
      'Неверный набор исполнителей для переноса');
  }

  const token = randomBytes(24).toString('base64url');
  const directory = path.join(input.roots.dataHome, 'state', 'lifecycle-migrations', token);
  const legacyRoots = legacyRootsOf(input.roots);
  const config = input.config as Record<string, unknown>;
  const envValues = input.envPath ? await readEnvFile(input.envPath) : {};
  const targets: MigrationTargetPlan[] = [];
  const warnings: ProviderInstallNotice[] = [];
  const sourceSnapshots: Record<string, string> = {};

  for (const entry of input.entries) {
    const adapter = input.adapters.get(entry.providerId);

    if (!adapter) {
      throw new InstallEnvironmentError('unknown_provider', 'Исполнитель не найден');
    }

    const definition = adapter.externalCli?.(input.config, input.home);

    if (!definition || adapter.distribution?.(input.config)?.managed
      || entry.targetMethod !== 'npm') {
      throw new InstallEnvironmentError('unsupported_action', 'Этот исполнитель не переносится');
    }

    const resolved = await resolveUserCliNpm({
      env: input.env,
      cliName: definition.binName,
      packageId: definition.packageId,
      scratch: input.scratch,
      roots: input.roots,
    });
    const inventory = await discoverExternalCli({
      providerId: adapter.id,
      definition,
      configuredBin: String(adapter.bin(input.config) ?? ''),
      env: resolved.shell.env,
      home: input.home,
      legacyRoots,
    });
    const target = await targetOf({
      entry,
      adapter,
      definition,
      inventory,
      legacyRoots,
      runtime: resolved.runtime,
      prefix: resolved.prefix,
      environment: input.env,
      loginPath: resolved.shell.loginEnv.PATH ?? '',
      scratch: input.scratch,
      run: input.run,
    });

    const configured = typeof config[definition.configKey] === 'string'
      ? config[definition.configKey] as string : null;
    const configuredLegacy = configured && path.isAbsolute(configured)
      && !outside(configured, legacyRoots);
    const envConfigured = envValues[definition.envKey] ?? null;
    const envLegacy = envConfigured && path.isAbsolute(envConfigured)
      && !outside(envConfigured, legacyRoots);

    if (configured && path.isAbsolute(configured) && !configuredLegacy
      && path.resolve(configured) !== path.resolve(target.prepared.alias)) {
      throw new InstallEnvironmentError('installation_conflict',
        'В настройках выбрана другая копия; миграция не переключает ручной выбор молча');
    }
    if (!configured && envConfigured && path.isAbsolute(envConfigured) && !envLegacy
      && path.resolve(envConfigured) !== path.resolve(target.prepared.alias)) {
      throw new InstallEnvironmentError('installation_conflict',
        'В .env выбрана другая копия; миграция не переключает ручной выбор молча');
    }

    target.oldConfig = configured;
    target.target.warnings.push(...(configuredLegacy || envLegacy
      ? [notice('legacy_binding_replaced', 'Прежняя привязка будет переключена на новую копию')]
      : []));
    targets.push(target);

    for (const source of target.sources) {
      if (source.root) {
        sourceSnapshots[source.root] = await treeSnapshot(source.root);
      }
    }
  }

  const shell = await planShellCleanup({
    home: input.home,
    legacyRoots,
    adapters: input.adapters,
    entries: input.entries,
    config: input.config,
    cleanupOwnedShell: input.cleanupOwnedShell,
    directory,
  });

  warnings.push(...shell.warnings);

  const shims: MigrationShim[] = [];
  const kimi = targets.find((target) => target.definition.packageId === '@moonshot-ai/kimi-code');

  if (kimi) {
    for (const from of kimi.prepared.kimiShims) {
      const target = path.join(path.dirname(from), 'kimi-legacy');
      const existing = await fs.lstat(target).catch(() => null);

      if (existing) {
        throw new InstallEnvironmentError('installer_side_effect_conflict',
          'Имя kimi-legacy уже занято; нужен явный выбор человека');
      }

      const stat = await fs.lstat(from);

      shims.push({
        from,
        to: target,
        dev: stat.dev,
        ino: stat.ino,
        backup: path.join(directory, 'shims', bufferName(from)),
      });
      kimi.target.footprint.push({
        path: from,
        action: 'rename',
        reason: 'legacy Python shim',
      });
      kimi.target.footprint.push({
        path: target,
        action: 'rename',
        reason: 'legacy Python shim',
      });
    }
  }

  await fs.mkdir(directory, { recursive: true, mode: 0o700 });

  const envPath = input.envPath;
  const configChanges = Object.fromEntries(targets.map((target) => [target.envKey, target.prepared.alias]));
  const preview: ProviderLifecycleMigrationPreparation = {
    schemaVersion: 2,
    token,
    expiresAt: Date.now() + input.ttl,
    operation: 'migrate',
    affectedProviderIds: targets.map((target) => target.providerId),
    targets: targets.map((target) => target.target),
    cleanupOwnedShell: input.cleanupOwnedShell,
    shellChanges: shell.shell.map((change) => ({
      file: change.file,
      action: 'remove',
      block: change.block,
    })),
    warnings,
  };

  return {
    preview,
    scope: input.scope,
    consumed: false,
    directory,
    envPath,
    configChanges,
    targets,
    shell: shell.shell,
    shims,
    cleanupOwnedShell: input.cleanupOwnedShell,
    sourceSnapshots,
  };
}

/**
 * Все цели перепроверяются до mutation: новые bytes, старые копии, rc и shims.
 * Изменение любой из сторон требует нового preview.
 */
export async function revalidateMigration(plan: MigrationPlan): Promise<void> {
  for (const target of plan.targets) {
    await revalidateNpmStrategy(target.prepared);
    await assertNoLegacyKimiShim({ ...target.prepared.input, allowKimiShimMigration: true });

    for (const source of target.sources) {
      if (source.root && await treeSnapshot(source.root) !== plan.sourceSnapshots[source.root]) {
        throw new InstallEnvironmentError('preparation_changed', 'Старая копия изменилась после preview');
      }
    }
  }

  for (const change of plan.shell) {
    const current = await readShellFile(change.file);

    if (!current || current.dev !== change.dev || current.ino !== change.ino
      || !current.bytes.equals(change.before)) {
      throw new InstallEnvironmentError('preparation_changed', 'Файл оболочки изменился после preview');
    }
  }
  for (const shim of plan.shims) {
    const stat = await fs.lstat(shim.from).catch(() => null);

    if (!stat || stat.dev !== shim.dev || stat.ino !== shim.ino) {
      throw new InstallEnvironmentError('preparation_changed', 'Старая Python-копия Kimi изменилась');
    }
  }
}

/**
 * Уборка удаляет только тот же пакет, который был в preview.
 * Чужая замена по тому же пути остаётся на диске и даёт cleanup pending.
 */
async function removeProvenTarget(target: MigrationTargetPlan): Promise<void> {
  for (const root of target.removeRoots) {
    const source = target.sources.find((item) => item.root === root);

    if (!source || await fs.realpath(root).catch(() => null) !== root) {
      throw new InstallEnvironmentError('migration_recovery_required',
        'Старая копия изменилась до уборки');
    }

    const manifest = await fs.readFile(path.join(root, 'package.json'), 'utf8')
      .then((text) => JSON.parse(text) as { name?: unknown; version?: unknown }, () => null);

    if (manifest?.name !== target.definition.packageId
      || source.version && manifest.version !== source.version) {
      throw new InstallEnvironmentError('migration_recovery_required',
        'По пути старой копии появился другой пакет');
    }

    await fs.rm(root, { recursive: true, force: true });
  }

  for (const alias of target.removeAliases) {
    const link = await fs.readlink(alias).catch(() => null);
    const resolved = link ? path.resolve(path.dirname(alias), link) : null;
    const owned = resolved !== null && target.sources.some((source) =>
      source.root !== null && inside(resolved, source.root));

    if (!owned) {
      throw new InstallEnvironmentError('migration_recovery_required',
        'Старая ссылка изменилась до уборки');
    }

    await fs.rm(alias, { force: true });
  }
}

/**
 * Активация обратима до binding commit: shell и shims восстанавливаются из backup.
 * Новая установленная копия остаётся на диске честным partial-результатом.
 */
export async function executeMigration(plan: MigrationPlan, options: {
  phase(value: 'download-install' | 'activation' | 'terminal' | 'cleanup'): Promise<void>;
  ownership?: Parameters<typeof executeNpmStrategy>[1]['ownership'];
}): Promise<{ outcome: 'migrated' | 'activated_with_cleanup_pending'; warnings: ProviderInstallNotice[] }> {
  for (const target of plan.targets) {
    await executeNpmStrategy(target.prepared, { phase: async (phase) => {
      if (phase === 'download-install') {
        await options.phase('download-install');
      }
    }, ownership: options.ownership });
  }

  await options.phase('activation');

  const changedShell: MigrationShellChange[] = [];
  const renamed: MigrationShim[] = [];

  try {
    for (const change of plan.shell) {
      await backupShell(change);
      await writeShell(change);
      changedShell.push(change);
    }
    for (const shim of plan.shims) {
      await fs.mkdir(path.dirname(shim.backup), { recursive: true, mode: 0o700 });
      await fs.copyFile(shim.from, shim.backup, constants.COPYFILE_EXCL);
      await fs.rename(shim.from, shim.to);
      renamed.push(shim);
    }
  } catch (error) {
    for (const shim of renamed.reverse()) {
      await fs.rename(shim.to, shim.from).catch(() => {});
    }
    for (const change of changedShell.reverse()) {
      await restoreShell(change).catch(() => {});
    }

    throw error;
  }

  await options.phase('terminal');

  try {
    for (const target of plan.targets) {
      const shell = await resolveUserCliEnvironment({
        env: target.environment,
        cliName: target.definition.binName,
        scratch: path.join(plan.directory, 'terminal'),
      });
      const found = await fs.realpath(shell.cli.path).catch(() => null);
      const expected = await fs.realpath(target.prepared.alias).catch(() => null);

      if (!found || !expected || found !== expected) {
        throw new InstallEnvironmentError('terminal_conflict',
          'Новый терминал выбирает другую копию');
      }
    }
  } catch (error) {
    await rollbackMigrationActivation(plan);

    throw error;
  }

  if (plan.envPath) {
    await updateEnvFile(plan.envPath, plan.configChanges);
  }

  const warnings: ProviderInstallNotice[] = [];
  let cleanupPending = false;

  await options.phase('cleanup');

  try {
    for (const target of plan.targets) {
      await removeProvenTarget(target);
    }
    for (const shim of plan.shims) {
      await fs.rm(shim.backup, { force: true });
    }

    await fs.rm(plan.directory, { recursive: true, force: true });
  } catch {
    cleanupPending = true;
    warnings.push(notice('migration_cleanup_pending',
      'Новая копия активна; удаление старых файлов нужно повторить'));
  }

  return {
    outcome: cleanupPending ? 'activated_with_cleanup_pending' : 'migrated',
    warnings,
  };
}

/**
 * Откат shell/shims до commit: используется сервисом после сбоя терминала.
 * Возвращает false, если хотя бы один файл уже не совпадает с нашей записью.
 */
export async function rollbackMigrationActivation(plan: MigrationPlan): Promise<boolean> {
  let ok = true;

  for (const shim of plan.shims) {
    const exists = await fs.lstat(shim.to).catch(() => null);

    if (exists) {
      await fs.rename(shim.to, shim.from).catch(() => {
        ok = false;
      });
    }
  }
  for (const change of plan.shell) {
    if (!await restoreShell(change)) {
      ok = false;
    }
  }

  return ok;
}
