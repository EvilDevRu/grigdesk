// Descriptor выбирается до подготовки запуска и хранит абсолютный путь поколения.
// После переключения current уже выбранный процесс продолжает использовать свою сборку.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DEEPSEEK_PIN } from './contract.ts';
import {
  deepSeekRuntimeError,
  readDeepSeekArtifact,
  readDeepSeekArtifactAsync,
  readDeepSeekArtifactHeader,
} from './runtimeArtifact.ts';
import type {
  DeepSeekArtifact,
  DeepSeekArtifactContract,
  DeepSeekArtifactHeader,
} from './runtimeArtifact.ts';

export interface DeepSeekRuntimeConfig {
  deepseekBin?: string;
  deepseekBinOverride?: string;
  deepseekRuntimeMode?: 'installed' | 'embedded';
  deepseekArtifactDir?: string;
  deepseekGenerationRoot?: string;
}

export interface DeepSeekRuntimeDescriptor {
  readonly kind: 'embedded' | 'external';
  readonly command: string;
  readonly prefixArgs: readonly string[];
  readonly upstreamVersion: string;
  readonly buildId: string | null;
  readonly runtimeVersion: string;
  readonly generationDir: string | null;
  readonly identity: string;
  readonly capabilities: Readonly<DeepSeekArtifactContract['capabilities']>;
}

const exec = promisify(execFile);
const defaultRoot = path.resolve(import.meta.dirname, '../../../runtime/deepseek');

/**
 * Legacy и явный override имеют отдельный отпечаток бинаря, а не identity Node.
 * Недоступность отражается в identity; probe и spawn дадут собственную проверяемую ошибку.
 */
function externalDescriptor(binary: string): DeepSeekRuntimeDescriptor {
  let command = binary;
  let identity = `${binary}:unavailable`;

  if (!binary.includes(path.sep)) {
    command = (process.env.PATH ?? '').split(path.delimiter)
      .map((directory) => path.resolve(directory, binary))
      .find((file) => {
        try {
          fs.accessSync(file, fs.constants.X_OK);

          return true;
        } catch {
          return false;
        }
      }) ?? binary;
  }

  try {
    command = fs.realpathSync(command);
    identity = `${command}:${createHash('sha256').update(fs.readFileSync(command)).digest('hex')}`;
  } catch {
    // Проверка версии не объявит отсутствующий внешний CLI установленным.
  }

  return Object.freeze({
    kind: 'external',
    command,
    prefixArgs: Object.freeze([]),
    upstreamVersion: DEEPSEEK_PIN.version,
    buildId: null,
    runtimeVersion: DEEPSEEK_PIN.version,
    generationDir: null,
    identity,
    capabilities: Object.freeze({
      web: true,
      acp: true,
      settingsWeb: true,
      settingsAcp: false,
    }),
  });
}

interface GenerationSelection {
  directory: string;
  runtimeRoot: string;
  pinned: boolean;
}

type RuntimeSelection = { external: DeepSeekRuntimeDescriptor } | GenerationSelection;

/**
 * Приоритет имеет только явный внешний override; embedded не ищет dsh в PATH.
 * Candidate передаётся тестами явно, а незавершённая публикация запрещает выбор current
 * ещё до чтения поколения.
 */
function selectDeepSeekRuntime(config: DeepSeekRuntimeConfig): RuntimeSelection {
  if (config.deepseekBinOverride) {
    return { external: externalDescriptor(config.deepseekBinOverride) };
  }

  if (!config.deepseekArtifactDir && config.deepseekRuntimeMode !== 'embedded') {
    return { external: externalDescriptor(config.deepseekBin || 'dsh') };
  }

  const runtimeRoot = path.resolve(config.deepseekGenerationRoot || defaultRoot);

  if (!config.deepseekArtifactDir && fs.existsSync(path.join(runtimeRoot, 'publish-pending.json'))) {
    throw deepSeekRuntimeError('deepseek_runtime_publish_pending', 'Публикация runtime Cockpit не завершена');
  }

  return {
    directory: config.deepseekArtifactDir || path.join(runtimeRoot, 'current'),
    runtimeRoot,
    pinned: Boolean(config.deepseekArtifactDir),
  };
}

/**
 * Production current обязан указывать внутрь immutable builds; явный candidate — как есть.
 * Сравнение каноническое: путь корня через символическую ссылку не считается выходом.
 */
function assertWithinBuilds(selection: GenerationSelection, root: string): void {
  if (selection.pinned) {
    return;
  }

  let builds: string;

  try {
    builds = fs.realpathSync(path.join(selection.runtimeRoot, 'builds'));
  } catch {
    throw deepSeekRuntimeError('deepseek_runtime_corrupt', 'Current DeepSeek выходит из builds');
  }

  const relative = path.relative(builds, root);

  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw deepSeekRuntimeError('deepseek_runtime_corrupt', 'Current DeepSeek выходит из builds');
  }
}

function embeddedDescriptor(root: string, artifact: DeepSeekArtifact): DeepSeekRuntimeDescriptor {
  return Object.freeze({
    kind: 'embedded',
    command: process.execPath,
    prefixArgs: Object.freeze([path.join(root, artifact.entry)]),
    upstreamVersion: artifact.source.version,
    buildId: artifact.buildId,
    runtimeVersion: artifact.runtimeVersion,
    generationDir: root,
    identity: `deepseek-build:${artifact.buildId}`,
    capabilities: Object.freeze({ ...artifact.capabilities }),
  });
}

/**
 * Descriptor разрешается один раз на запуск с полной проверкой поколения.
 * Синхронная версия для CLI и wrapper конвейера, у которых нет общего event loop.
 */
export function resolveDeepSeekRuntime(config: DeepSeekRuntimeConfig): DeepSeekRuntimeDescriptor {
  const selection = selectDeepSeekRuntime(config);

  if ('external' in selection) {
    return selection.external;
  }

  const { root, artifact } = readDeepSeekArtifact(selection.directory);

  assertWithinBuilds(selection, root);

  return embeddedDescriptor(root, artifact);
}

/**
 * Та же полная проверка без остановки event loop сервера: обход и хеширование поколения
 * идут асинхронно, контракт ошибок и cache общие с синхронной версией.
 */
export async function resolveDeepSeekRuntimeAsync(
  config: DeepSeekRuntimeConfig,
): Promise<DeepSeekRuntimeDescriptor> {
  const selection = selectDeepSeekRuntime(config);

  if ('external' in selection) {
    return selection.external;
  }

  const { root, artifact } = await readDeepSeekArtifactAsync(selection.directory);

  assertWithinBuilds(selection, root);

  return embeddedDescriptor(root, artifact);
}

/**
 * Отпечаток выбранной сборки без обхода её файлов: внешний CLI или buildId поколения.
 * Недоступность — исключение с безопасной причиной: вызывающий отказывает в запуске,
 * а не подменяет привязку сессии отпечатком «недоступно».
 */
export function requireDeepSeekRuntimeIdentity(config: DeepSeekRuntimeConfig): string {
  return describeDeepSeekRuntime(config).identity;
}

/**
 * Заголовок выбранного поколения без проверки файлов. Отсутствие каталога и выход
 * за каталог сборок дают стабильные коды runtime.
 */
function headerOf(selection: GenerationSelection): DeepSeekArtifactHeader {
  let root: string;

  try {
    root = fs.realpathSync(selection.directory);
  } catch {
    throw deepSeekRuntimeError('deepseek_runtime_missing', 'Встроенный runtime DeepSeek отсутствует');
  }

  assertWithinBuilds(selection, root);

  return readDeepSeekArtifactHeader(root);
}

/**
 * Заголовок выбранного встроенного поколения для адаптеров на той же сборке; внешний бинарь — null.
 * Целостность файлов здесь не доказывается — её проверяют descriptor и probe.
 */
export function readSelectedDeepSeekHeader(config: DeepSeekRuntimeConfig): DeepSeekArtifactHeader | null {
  const selection = selectDeepSeekRuntime(config);

  return 'external' in selection ? null : headerOf(selection);
}

/**
 * Лёгкое описание выбранной сборки для карточки и ключей кэша: identity и версии.
 * Целостность файлов здесь не доказывается — её проверяют descriptor и probe.
 */
export function describeDeepSeekRuntime(config: DeepSeekRuntimeConfig): {
  identity: string;
  buildId: string | null;
  runtimeVersion: string;
} {
  const selection = selectDeepSeekRuntime(config);

  if ('external' in selection) {
    return {
      identity: selection.external.identity,
      buildId: null,
      runtimeVersion: selection.external.runtimeVersion,
    };
  }

  const header = headerOf(selection);

  return {
    identity: `deepseek-build:${header.buildId}`,
    buildId: header.buildId,
    runtimeVersion: header.runtimeVersion,
  };
}

/**
 * Проверенный descriptor остаётся единственным источником argv и upstream version.
 * Node без целого артефакта никогда не означает installed DeepSeek.
 */
export async function probeDeepSeekRuntime(config: DeepSeekRuntimeConfig) {
  try {
    const runtime = await resolveDeepSeekRuntimeAsync(config);
    const { stdout } = await exec(runtime.command, [...runtime.prefixArgs, '-V'], {
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    });
    const version = stdout.trim().split(/\s+/u)[0] || null;

    return {
      ok: version === runtime.upstreamVersion,
      version,
      ...(version !== runtime.upstreamVersion
        ? { error: 'Версия DeepSeek не соответствует descriptor' } : {}),
    };
  } catch (error) {
    const rawCode = (error as { code?: unknown }).code;
    const code = typeof rawCode === 'string' ? rawCode : undefined;

    return {
      ok: false,
      version: null,
      code,
      error: code?.startsWith('deepseek_runtime_')
        ? (error as Error).message
        : 'Бинарь DeepSeek Harness недоступен',
    };
  }
}

/**
 * Сохранённый settings snapshot принадлежит конкретной сборке до создания session.
 * Смена поколения требует новой подготовки, даже при неизменной upstream version.
 */
export function assertDeepSeekPreparedRuntime(
  runtime: DeepSeekRuntimeDescriptor,
  plan?: { runtimeIdentity?: string },
): void {
  if (plan?.runtimeIdentity && plan.runtimeIdentity !== runtime.identity) {
    throw deepSeekRuntimeError(
      'deepseek_runtime_changed',
      'Runtime DeepSeek изменился после подготовки настроек',
    );
  }
}

/**
 * Перед spawn перепроверяется закреплённая generation, без нового выбора current.
 * Повреждение A после discovery не позволяет выполнить prompt в частично изменённом runtime.
 */
export function verifyDeepSeekRuntimeDescriptor(runtime: DeepSeekRuntimeDescriptor): void {
  if (runtime.kind !== 'embedded') {
    return;
  }

  const { artifact } = readDeepSeekArtifact(runtime.generationDir || '');

  if (artifact.buildId !== runtime.buildId) {
    throw deepSeekRuntimeError('deepseek_runtime_changed', 'Закреплённое поколение DeepSeek изменилось');
  }
}

/**
 * Асинхронная перепроверка перед spawn для серверных путей: тот же контракт,
 * но обход поколения не блокирует остальные запросы Cockpit.
 */
export async function verifyDeepSeekRuntimeDescriptorAsync(
  runtime: DeepSeekRuntimeDescriptor,
): Promise<void> {
  if (runtime.kind !== 'embedded') {
    return;
  }

  const { artifact } = await readDeepSeekArtifactAsync(runtime.generationDir || '');

  if (artifact.buildId !== runtime.buildId) {
    throw deepSeekRuntimeError('deepseek_runtime_changed', 'Закреплённое поколение DeepSeek изменилось');
  }
}

/**
 * Ключ кэша различает каждое поколение и безопасное состояние недоступности.
 * Он не обращается к модели и не наследует identity последней успешной сборки.
 */
export function deepSeekRuntimeIdentity(config: DeepSeekRuntimeConfig): string {
  try {
    return requireDeepSeekRuntimeIdentity(config);
  } catch (error) {
    return `${(error as { code?: string }).code}:unavailable`;
  }
}
