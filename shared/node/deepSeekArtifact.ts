// Артефакт проверяется без зависимостей сборщика и без обращения к upstream.
// Контракт и каждый файл входят в identity, включая native addons и относительные ссылки.
// Серверные пути используют асинхронную проверку: обход ~20 тыс. записей поколения идёт
// на пуле потоков и не останавливает event loop; синхронная версия — для CLI и скриптов.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isNodeVersionSupported } from '../runtime/nodeVersion.ts';

export interface DeepSeekWorkerRuntime {
  nodeVersion: string;
  platform: string;
  arch: string;
  nativeAbi: string;
}

export interface DeepSeekArtifactContract {
  format: number;
  hostContract: number;
  journalFormat: number;
  source: {
    repository: string;
    commit: string;
    version: string;
  };
  nodeCompatibility: string;
  entry: string;
  capabilities: {
    web: boolean;
    acp: boolean;
    settingsWeb: boolean;
    settingsAcp: boolean;
  };
}

export interface DeepSeekArtifact extends DeepSeekArtifactContract {
  buildId: string;
  runtimeVersion: string;
  inputIdentity: Record<string, unknown> & { contract: DeepSeekArtifactContract };
  payload: Record<string, string>;
}

interface InventoryEntry {
  name: string;
  kind: 'directory' | 'file' | 'link';
  signature: string;
  link?: string;
}

const verified = new Map<string, { signature: string; artifact: DeepSeekArtifact }>();
const headers = new Map<string, { key: string; header: DeepSeekArtifactHeader }>();
const PAYLOAD_CONCURRENCY = 16;

export interface DeepSeekArtifactHeader {
  buildId: string;
  runtimeVersion: string;
  version: string;
  // Входы допуска модельного плагина GLM; DeepSeek их не читает. Заголовок не проверяет
  // целостность: перед запуском identity сверяется по полностью проверенному артефакту.
  commit: string;
  composition: string | null;
  dependencyLock: string | null;
  llmPiAi: unknown;
}

/**
 * Стабильный код различает повреждение, отсутствие и несовместимость runtime.
 * Публичное сообщение не содержит приватные пути и сырые ошибки файловой системы.
 */
export function deepSeekRuntimeError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function hash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Все звенья ссылок остаются внутри поколения, включая ссылку через другую ссылку.
 * Каталоги и файлы имеют канонические пути; выход наружу не считается зависимостью runtime.
 */
function assertContained(root: string, target: string): void {
  const relative = path.relative(root, target);

  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw deepSeekRuntimeError('deepseek_runtime_corrupt', 'Ссылка runtime выходит из поколения');
  }
}

/**
 * Сигнатура записи охватывает размер, mode, inode и обе даты; ссылка — ещё и цель.
 * Абсолютная цель ссылки запрещена: поколение обязано переживать перенос каталога.
 */
function inventoryEntry(name: string, stat: fs.BigIntStats, link?: string): InventoryEntry {
  const signature = [name, stat.mode, stat.size, stat.ino, stat.mtimeNs, stat.ctimeNs].join(':');

  if (stat.isDirectory() || stat.isFile()) {
    return {
      name,
      kind: stat.isDirectory() ? 'directory' : 'file',
      signature,
    };
  }

  if (stat.isSymbolicLink() && link !== undefined) {
    if (path.isAbsolute(link)) {
      throw deepSeekRuntimeError('deepseek_runtime_corrupt', 'Абсолютная ссылка runtime запрещена');
    }

    return {
      name,
      kind: 'link',
      signature: `${signature}:${link}`,
      link,
    };
  }

  throw deepSeekRuntimeError('deepseek_runtime_corrupt', 'Необычный файл в runtime запрещён');
}

/**
 * Сигнатура охватывает весь payload, а не только launcher.
 * Ссылка дополнительно проверяется по каноническому назначению до использования cache.
 */
function inventory(root: string, relative = ''): InventoryEntry[] {
  const entries: InventoryEntry[] = [];

  for (const entry of fs.readdirSync(path.join(root, relative)).sort()) {
    const name = relative ? `${relative}/${entry}` : entry;
    const file = path.join(root, name);
    const stat = fs.lstatSync(file, { bigint: true });
    const link = stat.isSymbolicLink() ? fs.readlinkSync(file) : undefined;
    const item = inventoryEntry(name, stat, link);

    if (link !== undefined) {
      assertContained(root, fs.realpathSync(file));
    }

    entries.push(item);

    if (stat.isDirectory()) {
      entries.push(...inventory(root, name));
    }
  }

  return entries;
}

/**
 * Тот же обход, что и синхронный, в том же порядке, но stat-запросы каталога идут
 * параллельно через пул потоков libuv, и event loop сервера остаётся свободным.
 */
async function inventoryAsync(root: string, relative = ''): Promise<InventoryEntry[]> {
  const names = (await fsp.readdir(path.join(root, relative))).sort();
  const stats = await Promise.all(names.map((entry) => fsp.lstat(
    path.join(root, relative, entry), { bigint: true },
  )));
  const entries: InventoryEntry[] = [];

  for (const [index, entry] of names.entries()) {
    const name = relative ? `${relative}/${entry}` : entry;
    const file = path.join(root, name);
    const stat = stats[index]!;
    const link = stat.isSymbolicLink() ? await fsp.readlink(file) : undefined;
    const item = inventoryEntry(name, stat, link);

    if (link !== undefined) {
      assertContained(root, await fsp.realpath(file));
    }

    entries.push(item);

    if (stat.isDirectory()) {
      entries.push(...await inventoryAsync(root, name));
    }
  }

  return entries;
}

/**
 * Заголовок сверяется с подписанным identity и поддерживаемым host contract.
 * Целые хеши несовместимого поколения не разрешают его загрузку текущим host.
 */
function verifyMetadata(artifact: DeepSeekArtifact, worker: DeepSeekWorkerRuntime): void {
  const contract = artifact.inputIdentity?.contract;

  if (!contract || !artifact.payload || typeof artifact.buildId !== 'string') {
    throw deepSeekRuntimeError('deepseek_runtime_corrupt', 'Метаданные runtime неполны');
  }

  for (const [key, value] of Object.entries(contract)) {
    if (JSON.stringify(artifact[key as keyof DeepSeekArtifact]) !== JSON.stringify(value)) {
      throw deepSeekRuntimeError('deepseek_runtime_corrupt', 'Контракт runtime изменён вне identity');
    }
  }

  const buildId = hash(JSON.stringify({ inputIdentity: artifact.inputIdentity, payload: artifact.payload }));

  if (
    artifact.buildId !== buildId ||
    artifact.runtimeVersion !== `${artifact.source?.version}.grigdesk.b${buildId.slice(0, 16)}`
  ) {
    throw deepSeekRuntimeError('deepseek_runtime_corrupt', 'Identity runtime не соответствует содержимому');
  }

  if (
    artifact.format !== 1 || artifact.hostContract !== 1 || artifact.journalFormat !== 1 ||
    artifact.entry !== 'entry.mjs' ||
    artifact.nodeCompatibility !== '^22.19.0 || >=24.0.0' ||
    !isNodeVersionSupported(worker.nodeVersion) ||
    artifact.inputIdentity.platform !== worker.platform ||
    artifact.inputIdentity.arch !== worker.arch ||
    artifact.inputIdentity.nativeAbi !== worker.nativeAbi ||
    artifact.capabilities?.web !== true || artifact.capabilities?.acp !== true
  ) {
    throw deepSeekRuntimeError('deepseek_runtime_incompatible', 'Runtime несовместим с текущим host');
  }

  if (!Object.hasOwn(artifact.payload, artifact.entry)) {
    throw deepSeekRuntimeError('deepseek_runtime_corrupt', 'Launcher отсутствует в payload runtime');
  }
}

/**
 * Хеш файла payload совпадает с алгоритмом сборщика: mode и base64 содержимого.
 * Ссылка хешируется по относительной цели, без случайного пути сборочной папки.
 */
function payloadHash(entry: InventoryEntry, mode: number, bytes: Buffer | null): string {
  return entry.link !== undefined
    ? hash(`link:${entry.link}`)
    : hash(`${mode & 0o777}:${bytes!.toString('base64')}`);
}

/**
 * Набор файлов и их хеши обязаны совпасть с payload целиком, без лишних и пропущенных.
 * Каталоги и сам runtime.json в payload не входят.
 */
function assertPayload(actual: Record<string, string>, artifact: DeepSeekArtifact): void {
  const names = Object.keys(actual);

  if (
    names.length !== Object.keys(artifact.payload).length ||
    names.some((name) => actual[name] !== artifact.payload[name])
  ) {
    throw deepSeekRuntimeError('deepseek_runtime_corrupt', 'Файлы runtime DeepSeek повреждены');
  }
}

function payloadEntries(entries: InventoryEntry[]): InventoryEntry[] {
  return entries.filter((entry) => entry.name !== 'runtime.json' && entry.kind !== 'directory');
}

/**
 * Ошибки файловой системы превращаются в безопасную причину, без скрытого fallback на CLI.
 * Собственные коды runtime проходят как есть.
 */
function safeArtifactError(error: unknown): Error {
  if (String((error as { code?: string }).code).startsWith('deepseek_runtime_')) {
    return error as Error;
  }

  return deepSeekRuntimeError('deepseek_runtime_corrupt', 'Встроенный runtime DeepSeek повреждён');
}

/**
 * Перед выдачей descriptor проверяет все файлы; cache живёт только при полной stat-сигнатуре.
 * Синхронная версия для CLI, скриптов и процессов без общего event loop.
 */
export function readDeepSeekArtifact(
  directory: string,
  worker: DeepSeekWorkerRuntime,
): { root: string; artifact: DeepSeekArtifact } {
  let root: string;

  try {
    root = fs.realpathSync(directory);
  } catch {
    throw deepSeekRuntimeError('deepseek_runtime_missing', 'Встроенный runtime DeepSeek отсутствует');
  }

  try {
    const metadata = fs.readFileSync(path.join(root, 'runtime.json'), 'utf8');
    const entries = inventory(root);
    const signature = hash(metadata + JSON.stringify(entries));
    const cached = verified.get(root);

    if (cached?.signature === signature) {
      verifyMetadata(cached.artifact, worker);

      return { root, artifact: structuredClone(cached.artifact) };
    }

    const artifact = JSON.parse(metadata) as DeepSeekArtifact;
    const actual: Record<string, string> = {};

    verifyMetadata(artifact, worker);

    for (const entry of payloadEntries(entries)) {
      const file = path.join(root, entry.name);
      const bytes = entry.link === undefined ? fs.readFileSync(file) : null;

      actual[entry.name] = payloadHash(entry, fs.lstatSync(file).mode, bytes);
    }

    assertPayload(actual, artifact);
    verified.set(root, { signature, artifact: structuredClone(artifact) });

    return { root, artifact };
  } catch (error) {
    throw safeArtifactError(error);
  }
}

/**
 * Асинхронная проверка с тем же контрактом и общим cache: серверный ход не стоит,
 * пока идёт обход и первичное хеширование ~240 МБ поколения.
 */
export async function readDeepSeekArtifactAsync(
  directory: string,
  worker: DeepSeekWorkerRuntime,
): Promise<{ root: string; artifact: DeepSeekArtifact }> {
  let root: string;

  try {
    root = await fsp.realpath(directory);
  } catch {
    throw deepSeekRuntimeError('deepseek_runtime_missing', 'Встроенный runtime DeepSeek отсутствует');
  }

  try {
    const metadata = await fsp.readFile(path.join(root, 'runtime.json'), 'utf8');
    const entries = await inventoryAsync(root);
    const signature = hash(metadata + JSON.stringify(entries));
    const cached = verified.get(root);

    if (cached?.signature === signature) {
      verifyMetadata(cached.artifact, worker);

      return { root, artifact: cached.artifact };
    }

    const artifact = JSON.parse(metadata) as DeepSeekArtifact;
    const actual: Record<string, string> = {};
    const files = payloadEntries(entries);

    verifyMetadata(artifact, worker);

    for (let start = 0; start < files.length; start += PAYLOAD_CONCURRENCY) {
      await Promise.all(files.slice(start, start + PAYLOAD_CONCURRENCY).map(async (entry) => {
        const file = path.join(root, entry.name);
        const stat = await fsp.lstat(file);
        const bytes = entry.link === undefined ? await fsp.readFile(file) : null;

        actual[entry.name] = payloadHash(entry, stat.mode, bytes);
      }));
    }

    assertPayload(actual, artifact);
    verified.set(root, { signature, artifact: structuredClone(artifact) });

    return { root, artifact };
  } catch (error) {
    throw safeArtifactError(error);
  }
}

/**
 * Лёгкое чтение заголовка выбранного поколения: buildId и версии без обхода файлов.
 * Это отпечаток для привязки сессий и ключей кэша, а не проверка целостности:
 * её выполняют проверка descriptor и запуск процесса.
 */
export function readDeepSeekArtifactHeader(root: string): DeepSeekArtifactHeader {
  const file = path.join(root, 'runtime.json');
  let key: string;

  try {
    const stat = fs.statSync(file, { bigint: true });

    key = [stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
  } catch {
    throw deepSeekRuntimeError('deepseek_runtime_missing', 'Встроенный runtime DeepSeek отсутствует');
  }

  const cached = headers.get(root);

  if (cached?.key === key) {
    return cached.header;
  }

  try {
    const artifact = JSON.parse(fs.readFileSync(file, 'utf8')) as DeepSeekArtifact;

    if (!/^[a-f0-9]{64}$/u.test(artifact.buildId) || typeof artifact.runtimeVersion !== 'string'
        || typeof artifact.source?.version !== 'string') {
      throw new Error('header');
    }

    const identity = artifact.inputIdentity as Record<string, unknown> | undefined;
    const header = Object.freeze({
      buildId: artifact.buildId,
      runtimeVersion: artifact.runtimeVersion,
      version: artifact.source.version,
      commit: String(artifact.source.commit ?? ''),
      composition: typeof identity?.composition === 'string' ? identity.composition : null,
      dependencyLock: typeof identity?.dependencyLock === 'string' ? identity.dependencyLock : null,
      llmPiAi: (artifact as { llmPiAi?: unknown }).llmPiAi ?? null,
    });

    headers.set(root, { key, header });

    return header;
  } catch {
    throw deepSeekRuntimeError('deepseek_runtime_corrupt', 'Встроенный runtime DeepSeek повреждён');
  }
}
