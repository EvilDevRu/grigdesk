import { randomUUID, createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { ProviderLifecycleOperation } from '../../../../shared/chat/providerLifecycleContracts.ts';
import type { ExternalCliInstallation } from './inventoryTypes.ts';
import type { ExternalCliDefinition } from './inventoryTypes.ts';
import { runCommand, type PluginCommandRunner, type CommandOwnership } from '../packageInstall/runCommand.ts';
import { InstallEnvironmentError, type ExternalInstallRuntime } from './npmEnvironment.ts';
import { inspectNpmGraph, assertReviewedNpmHooks, type NpmGraphPackage } from './npmGraph.ts';
import reviewed from './npmReviewedHooks.json' with { type: 'json' };
import { treeSnapshot } from './treeSnapshot.ts';

export interface NpmStrategyInput {
  providerId: string;
  operation: Exclude<ProviderLifecycleOperation, 'migrate'>;
  definition: ExternalCliDefinition;
  selected: ExternalCliInstallation | null;
  runtime: ExternalInstallRuntime;
  prefix: string;
  version: string | null;
  scratch: string;
  loginPath?: string;
  allowKimiShimMigration?: boolean;
  run?: PluginCommandRunner;
  signal?: AbortSignal;
}

export interface PreparedNpmStrategy {
  method: 'npm';
  input: NpmStrategyInput;
  directory: string;
  cache: string;
  packageRoot: string;
  alias: string;
  aliasLink: string | null;
  resourceKey: string;
  version: string | null;
  selectedVersion: string | null;
  graph: {
    relative: string;
    name: string;
    version: string;
    integrity: string;
  }[];
  snapshots: Record<string, string>;
  toolchain: string;
  headers: string | null;
  rehearsal: string | null;
  kimiShims: string[];
  backup: string;
}

/**
 * Ошибки npm не публикуют stdout: registry и startup могут содержать приватные значения.
 * Наружу передаётся стабильная причина, подробные секреты не сохраняются даже в job tail.
 */
async function npm(input: NpmStrategyInput, args: string[], env = input.runtime.env,
  ownership?: CommandOwnership): Promise<string> {
  const result = await (input.run ?? runCommand)(input.runtime.node, [input.runtime.npm, ...args], {
    cwd: input.runtime.home,
    env,
    timeoutMs: 10 * 60 * 1000,
    signal: input.signal,
    ownership,
  });

  if (result.code !== 0 || result.aborted || result.timedOut || result.stdoutTruncated) {
    throw new InstallEnvironmentError('npm_command_failed', 'Команда npm не завершилась успешно');
  }

  return result.stdout.trim();
}

/**
 * Kimi postinstall ищет Python shims в обоих PATH; обычная операция их менять не вправе.
 * Миграция получает этот список в preview и переносит только подтверждённые файлы.
 */
export async function legacyKimiShims(input: NpmStrategyInput): Promise<string[]> {
  if (input.definition.packageId !== '@moonshot-ai/kimi-code') {
    return [];
  }

  const found: string[] = [];

  const directories = [input.runtime.env.PATH ?? '', input.loginPath ?? '']
    .join(path.delimiter).split(path.delimiter).filter(Boolean);

  for (const directory of directories) {
    const file = await fs.open(path.join(directory, 'kimi'), 'r').catch(() => null);

    if (!file) {
      continue;
    }

    try {
      const bytes = Buffer.alloc(4096);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);

      if (bytes.subarray(0, bytesRead).toString('utf8').includes('kimi_cli')) {
        found.push(path.join(directory, 'kimi'));
      }
    } finally {
      await file.close();
    }
  }

  return [...new Set(found)];
}

/**
 * Обычная операция не запускает известный vendor hook поверх старых Python-копий.
 * Миграция отдельно перечисляет их в preview и не скрывает эффект от человека.
 */
export async function assertNoLegacyKimiShim(input: NpmStrategyInput): Promise<void> {
  if (input.allowKimiShimMigration) {
    return;
  }
  if ((await legacyKimiShims(input)).length) {
    throw new InstallEnvironmentError('installer_side_effect_conflict',
      'Найдена старая Python-копия Kimi; требуется отдельная миграция');
  }
}

/**
 * Граф фиксирует integrity каждого разрешённого узла, включая optional/transitive пакеты.
 * Точный профиль закрепляет tarball; допуск новой версии по байтам закрепляет integrity в preview.
 */
async function graphIdentity(input: NpmStrategyInput, cache: string, graph: NpmGraphPackage[]) {
  const result: PreparedNpmStrategy['graph'] = [];

  for (const entry of graph) {
    const value = JSON.parse(await npm(input, ['view', `${entry.name}@${entry.version}`, 'dist.integrity',
      '--json', '--offline', '--cache', cache]));

    if (typeof value !== 'string' || !/^sha512-[A-Za-z0-9+/]+=*$/u.test(value)) {
      throw new InstallEnvironmentError('npm_graph_invalid', 'Не подтверждены байты npm-пакета');
    }

    const profile = reviewed.find((item) => item.name === entry.name
      && item.reviewedVersion === entry.version);

    if ((Object.keys(entry.scripts).length || entry.bindingGyp) && profile && profile.integrity !== value) {
      throw new InstallEnvironmentError('installer_strategy_unverified', 'Изменились байты installer hook');
    }

    result.push({
      relative: entry.relative,
      name: entry.name,
      version: entry.version,
      integrity: value,
    });
  }

  return result;
}

/**
 * Любой проверенный binding.gyp может вызвать node-gyp, который не соблюдает npm offline.
 * Заголовки выбранного Node готовятся до preview, в том числе для fallback после prebuild.
 * Отсутствие локальных заголовков закрывает эту strategy вместо скрытой загрузки во время start.
 */
async function prepareHeaders(input: NpmStrategyInput, directory: string,
  graph: NpmGraphPackage[]): Promise<string | null> {
  if (!graph.some((entry) => entry.bindingGyp)) {
    return null;
  }

  const nodeRoot = path.dirname(path.dirname(await fs.realpath(input.runtime.node)));
  const source = path.join(nodeRoot, 'include/node');
  const version = await fs.readFile(path.join(source, 'node_version.h'), 'utf8').catch(() => '');
  const selected = await (input.run ?? runCommand)(input.runtime.node, ['--version'], {
    cwd: input.runtime.home,
    env: input.runtime.env,
    timeoutMs: 15_000,
  });
  const parts = ['MAJOR', 'MINOR', 'PATCH'].map((key) =>
    new RegExp(`#define NODE_${key}_VERSION\\s+(\\d+)`, 'u').exec(version)?.[1]);

  if (parts.some((part) => !part) || selected.code !== 0
    || selected.stdout.trim() !== `v${parts.join('.')}`) {
    throw new InstallEnvironmentError('node_headers_unavailable',
      'Для native-зависимости нужны заголовки выбранной версии Node');
  }

  const headers = path.join(directory, 'node-headers');

  await fs.mkdir(path.join(headers, 'include'), { recursive: true, mode: 0o700 });
  await fs.cp(source, path.join(headers, 'include/node'), { recursive: true, dereference: true });

  return headers;
}

/**
 * Тот же граф в чистом каталоге с подготовленным cache доказывает offline bytes.
 * Новое разрешение диапазона или отсутствующая зависимость запрещают preview/start.
 */
async function rehearseNpmStrategy(input: NpmStrategyInput, cache: string, directory: string,
  expected: PreparedNpmStrategy['graph']): Promise<string> {
  const rehearsal = path.join(directory, 'rehearsal');

  await fs.rm(rehearsal, { recursive: true, force: true });
  await npm(input, ['install', '--global', '--prefix', rehearsal, '--cache', cache,
    '--ignore-scripts', '--offline', '--no-audit', '--no-fund',
    `${input.definition.packageId}@${input.version}`]);

  const inspected = await inspectNpmGraph(path.join(rehearsal, 'lib/node_modules',
    input.definition.packageId));
  const same = inspected.length === expected.length && inspected.every((entry, index) => {
    const value = expected[index];

    return value?.relative === entry.relative && value.name === entry.name
      && value.version === entry.version;
  });

  if (!same) {
    throw new InstallEnvironmentError('npm_graph_changed',
      'Offline-прогон выбрал другой граф зависимостей');
  }

  await assertReviewedNpmHooks(inspected);

  return rehearsal;
}

const TOOLCHAIN_ENV = ['npm_config_registry', 'NPM_CONFIG_REGISTRY', 'npm_config_proxy',
  'npm_config_https_proxy', 'npm_config_cafile', 'npm_config_userconfig', 'NPM_CONFIG_USERCONFIG',
  'npm_config_cache', 'npm_config_globalconfig', 'NPM_CONFIG_GLOBALCONFIG'];

/**
 * Toolchain включает выбранные Node/npm, их версии, пользовательский npmrc и registry/proxy/CA.
 * Один symlink npm без этих входов не доказывает, что mutation запустит тот же npm.
 */
async function toolchainIdentity(input: NpmStrategyInput): Promise<string> {
  const nodeReal = await fs.realpath(input.runtime.node).catch(() => input.runtime.node);
  const npmReal = await fs.realpath(input.runtime.npm).catch(() => input.runtime.npm);
  const nodeRoot = path.dirname(path.dirname(nodeReal));
  const nodeHeader = await fs.readFile(path.join(nodeRoot, 'include/node/node_version.h'), 'utf8')
    .catch(() => '');
  const nodeVersion = ['MAJOR', 'MINOR', 'PATCH']
    .map((key) => new RegExp(`#define NODE_${key}_VERSION\\s+(\\d+)`, 'u').exec(nodeHeader)?.[1] ?? '')
    .join('.');
  let npmVersion = '';

  for (const candidate of [npmReal, path.join(path.dirname(npmReal), '..', 'package.json')]) {
    let current = path.dirname(candidate);

    for (let depth = 0; depth < 6 && !npmVersion; depth += 1) {
      const manifest = await fs.readFile(path.join(current, 'package.json'), 'utf8')
        .then((text) => JSON.parse(text) as { name?: unknown; version?: unknown }, () => null);

      if (manifest?.name === 'npm' && typeof manifest.version === 'string') {
        npmVersion = manifest.version;
      }

      current = path.dirname(current);
    }

    if (npmVersion) {
      break;
    }
  }

  const environment = TOOLCHAIN_ENV.map((key) => [key, input.runtime.env[key] ?? ''])
    .sort(([left], [right]) => String(left).localeCompare(String(right)));
  const userconfig = input.runtime.env.npm_config_userconfig
    ?? input.runtime.env.NPM_CONFIG_USERCONFIG ?? '';
  const npmrc = userconfig && path.isAbsolute(userconfig)
    ? await treeSnapshot(userconfig).catch(() => 'unreadable') : 'absent';

  return createHash('sha256').update(JSON.stringify({
    nodeVersion,
    npmVersion,
    nodeReal,
    npmReal,
    environment,
    npmrc,
  })).digest('hex');
}

/**
 * Prepare скачивает exact пакет без scripts в приватный inspection-prefix.
 * Пользовательский prefix не меняется, а полный граф и cache связываются с preview.
 * Offline-прогон здесь же доказывает, что start возьмёт те же bytes.
 */
export async function prepareNpmStrategy(input: NpmStrategyInput): Promise<PreparedNpmStrategy> {
  const selected = input.selected;

  if (selected && (selected.source !== 'npm' || !selected.root || !selected.prefix)) {
    throw new InstallEnvironmentError('exact_reinstall_unsupported',
      'Способ установки этой копии пока не поддерживает автоматическое обслуживание');
  }
  if (input.operation !== 'install' && !selected) {
    throw new InstallEnvironmentError('cli_missing', 'Копия исполнителя не найдена');
  }
  if (input.operation === 'install' && selected?.source === 'npm') {
    throw new InstallEnvironmentError('already_installed', 'Выбранная копия уже установлена');
  }
  if (input.operation !== 'uninstall' && (!input.version
    || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/u.test(input.version))) {
    throw new InstallEnvironmentError('version_unavailable', 'Точная версия установки неизвестна');
  }
  if (input.operation === 'reinstall' && input.version !== selected?.version) {
    throw new InstallEnvironmentError('version_unavailable', 'Переустановка должна сохранять версию');
  }

  await assertNoLegacyKimiShim(input);

  const prefix = selected?.prefix ?? input.prefix;
  const packageRoot = path.join(prefix, 'lib/node_modules', input.definition.packageId);
  const alias = path.join(prefix, 'bin', input.definition.binName);
  const aliasStat = await fs.lstat(alias).catch(() => null);

  if (aliasStat && (!aliasStat.isSymbolicLink()
    || !path.resolve(path.dirname(alias), await fs.readlink(alias)).startsWith(packageRoot + path.sep))) {
    throw new InstallEnvironmentError('installation_conflict', 'Имя команды занято другой установкой');
  }
  if (!selected && await fs.lstat(packageRoot).then(() => true, () => false)) {
    throw new InstallEnvironmentError('installation_conflict', 'Каталог пакета уже существует');
  }

  await fs.mkdir(input.scratch, { recursive: true, mode: 0o700 });

  const directory = await fs.mkdtemp(path.join(input.scratch, 'prepared-'));
  const cache = path.join(directory, 'cache');
  const inspectionPrefix = path.join(directory, 'inspection');
  const inspectionRoot = path.join(inspectionPrefix, 'lib/node_modules', input.definition.packageId);
  let graph: PreparedNpmStrategy['graph'] = [];
  let headers: string | null = null;
  let rehearsal: string | null = null;

  if (input.operation === 'uninstall') {
    await assertReviewedNpmHooks(await inspectNpmGraph(packageRoot));
  } else {
    await npm(input, ['install', '--global', '--prefix', inspectionPrefix, '--cache', cache,
      '--ignore-scripts', '--no-audit', '--no-fund', `${input.definition.packageId}@${input.version}`]);

    const inspected = await inspectNpmGraph(inspectionRoot);

    if (inspected[0]?.name !== input.definition.packageId || inspected[0].version !== input.version) {
      throw new InstallEnvironmentError('npm_graph_invalid', 'Получен другой npm-пакет');
    }

    await assertReviewedNpmHooks(inspected);
    graph = await graphIdentity(input, cache, inspected);
    headers = await prepareHeaders(input, directory, inspected);
    rehearsal = await rehearseNpmStrategy(input, cache, directory, graph);
  }

  const snapshots: Record<string, string> = {};
  const aliasLink = aliasStat?.isSymbolicLink() ? await fs.readlink(alias).catch(() => null) : null;

  const files = [
    packageRoot,
    alias,
    input.runtime.node,
    input.runtime.npm,
    await fs.realpath(input.runtime.node),
    await fs.realpath(input.runtime.npm),
    cache,
    ...(headers ? [headers] : []),
  ];

  for (const file of files) {
    snapshots[file] = await treeSnapshot(file);
  }

  const toolchain = await toolchainIdentity(input);
  const kimiShims = input.allowKimiShimMigration ? await legacyKimiShims(input) : [];

  return {
    method: 'npm',
    input,
    directory,
    cache,
    packageRoot,
    alias,
    aliasLink,
    resourceKey: selected?.resourceKey ?? createHash('sha256')
      .update(JSON.stringify([input.providerId, 'npm', packageRoot,
        input.definition.packageId])).digest('hex'),
    version: input.version,
    selectedVersion: selected?.version ?? null,
    graph,
    snapshots,
    toolchain,
    headers,
    rehearsal,
    kimiShims,
    backup: path.join(path.dirname(packageRoot), `.grigdesk-backup-${randomUUID()}`),
  };
}

/**
 * Start сверяет все подготовленные bytes до первой записи в пользовательскую установку.
 * Даже повреждение вложенной зависимости или cache требует нового preview.
 */
export async function revalidateNpmStrategy(prepared: PreparedNpmStrategy): Promise<void> {
  for (const [file, expected] of Object.entries(prepared.snapshots)) {
    if (await treeSnapshot(file) !== expected) {
      throw new InstallEnvironmentError('preparation_changed', 'Установка изменилась после подготовки');
    }
  }

  if (await toolchainIdentity(prepared.input) !== prepared.toolchain) {
    throw new InstallEnvironmentError('preparation_changed',
      'Node, npm или их настройки изменились после подготовки');
  }

  await assertNoLegacyKimiShim(prepared.input);

  // Полный graph сверяется offline до mutation: новая зависимость не выполнится
  // под старым token-ом и не попадёт в пользовательский prefix.
  if (prepared.input.operation !== 'uninstall') {
    await rehearseNpmStrategy(prepared.input, prepared.cache, prepared.directory, prepared.graph);
  }
}

/**
 * Мутация использует подготовленный offline cache и штатный npm с включёнными scripts.
 * Repair убирает старое дерево с backup; повтор install поверх повреждения не считается repair.
 */
export async function executeNpmStrategy(prepared: PreparedNpmStrategy, options: {
  ownership?: CommandOwnership;
  phase(value: 'backup' | 'download-install' | 'version' | 'cleanup'): Promise<void>;
}): Promise<void> {
  const { input, packageRoot, alias, cache } = prepared;
  const prefix = input.selected?.prefix ?? input.prefix;
  const env = { ...input.runtime.env };

  if (prepared.headers) {
    env.npm_config_nodedir = prepared.headers;
  }

  await options.phase('backup');

  if (input.selected) {
    await fs.cp(packageRoot, prepared.backup, {
      recursive: true,
      verbatimSymlinks: true,
      errorOnExist: true,
    });
    await fs.copyFile(path.join(packageRoot, 'package.json'),
      path.join(prepared.directory, 'old-package.json'));
  }

  await options.phase('download-install');

  if (input.operation === 'reinstall') {
    await fs.rm(packageRoot, { recursive: true });
    await fs.unlink(alias).catch((error) => {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    });
  }

  const args = input.operation === 'uninstall'
    ? ['uninstall', '--global', '--prefix', prefix, '--cache', cache, '--offline', input.definition.packageId]
    : ['install', '--global', '--prefix', prefix, '--cache', cache, '--offline',
      '--no-audit', '--no-fund', `${input.definition.packageId}@${prepared.version}`];

  await npm(input, args, env, options.ownership);
  await options.phase('version');

  if (input.operation === 'uninstall') {
    if (await fs.lstat(packageRoot).then(() => true, () => false)
      || await fs.lstat(alias).then(() => true, () => false)) {
      throw new InstallEnvironmentError('uninstall_unverified', 'Удаление выбранной копии не подтверждено');
    }

    return;
  }

  const installed = await inspectNpmGraph(packageRoot);
  const sameGraph = installed.length === prepared.graph.length && installed.every((entry, index) => {
    const expected = prepared.graph[index];

    return expected?.relative === entry.relative && expected.name === entry.name
      && expected.version === entry.version;
  });

  if (!sameGraph) {
    throw new InstallEnvironmentError('npm_graph_changed', 'Установлен другой граф зависимостей');
  }

  const probe = await (input.run ?? runCommand)(alias, ['--version'], {
    cwd: input.runtime.home,
    env: input.runtime.env,
    timeoutMs: 30_000,
    signal: input.signal,
    ownership: options.ownership,
  });

  if (probe.code !== 0 || !probe.stdout.includes(prepared.version!)) {
    throw new InstallEnvironmentError('version_unverified', 'Установленная версия не подтверждена');
  }
}

/**
 * Прерванная замена восстанавливается только из собственного backup после сверки.
 * Новая копия уже может быть рабочей, поэтому вызывающий решает, нужен ли restore.
 */
export async function restoreNpmStrategy(prepared: PreparedNpmStrategy):
  Promise<'restored' | 'unavailable'> {
  const backup = await fs.lstat(prepared.backup).catch(() => null);

  if (!backup?.isDirectory() || !prepared.selectedVersion) {
    return 'unavailable';
  }

  const old = await fs.readFile(path.join(prepared.directory, 'old-package.json'), 'utf8')
    .then((text) => JSON.parse(text) as { name?: unknown; version?: unknown }, () => null);

  if (old?.name !== prepared.input.definition.packageId
    || old.version !== prepared.selectedVersion) {
    return 'unavailable';
  }

  await fs.rm(prepared.packageRoot, { recursive: true, force: true });
  await fs.cp(prepared.backup, prepared.packageRoot, {
    recursive: true,
    verbatimSymlinks: true,
    errorOnExist: true,
  });
  await fs.unlink(prepared.alias).catch(() => {});

  if (prepared.aliasLink !== null) {
    await fs.symlink(prepared.aliasLink, prepared.alias);
  }

  const manifest = await fs.readFile(path.join(prepared.packageRoot, 'package.json'), 'utf8')
    .then((text) => JSON.parse(text) as { name?: unknown; version?: unknown }, () => null);

  return manifest?.name === prepared.input.definition.packageId
    && manifest.version === prepared.selectedVersion ? 'restored' : 'unavailable';
}
