// Библиотека владеет одним lifetime flock. Изменения модели сериализованы, JSON
// долговечен, файлы независимы от источников, а active/unknown входы защищены lease.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fstatSync, lstatSync, realpathSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { isDeepStrictEqual } from 'node:util';

import { ACTIVE_STATUSES, parseStudio3d } from '../../../../shared/studio3d/studio3dContracts.ts';
import type { Studio3dModel, Studio3dVersion } from '../../../../shared/studio3d/studio3dContracts.ts';
import { acquireKernelFileLock } from '../kernelLock.ts';
import type { KernelFileLock } from '../kernelLock.ts';
import { withPathLock } from '../pathLock.ts';
import {
  atomicWrite,
  ensureDirectory,
  isExternalName,
  isSafeName,
  openVerified,
  pinDirectory,
  readJson,
  safeCopy,
  verifiedHash,
} from './safePath.ts';
import type { PinnedDirectory, SafeCopyOptions } from './safePath.ts';
import { borrowedReadStream } from './fileStreams.ts';

export const MODEL_ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
export const VERSION_ID_RE = /^v\d{2,4}-[a-z0-9-]{1,40}$/;
export const LIBRARY_UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

export interface DiskModel extends Pick<Studio3dModel,
  'id' | 'name' | 'project' | 'category' | 'tags' | 'origin' | 'mainVersion' | 'createdAt' | 'updatedAt'> {
  schema: 1;
  notes: string;
}

export type VersionFile = Omit<Studio3dVersion['files'][number], 'url'>;

export interface DiskVersion extends Omit<Studio3dVersion,
  'libraryId' | 'files' | 'preview' | 'retryAvailable' | 'retryReason'> {
  schema: 1;
  files: VersionFile[];
  inputs: { role: string; file: string }[];
  idempotencyKey: string | null;
  pool: { key: string; limit: number | null } | null;
  retryAt: string | null;
  submittedAt: string | null;
  accountKey: string | null;
  planIndex: number;
  missedPolls: number;
}

export interface ModelEntry {
  model: DiskModel;
  versions: DiskVersion[];
}

export interface LibraryOptions {
  dir: string;
  ensureGitignore?: boolean;
  now?: () => number;
  randomHex?: () => string;
  lockTimeoutMs?: number;
  beforePersist?: (file: string) => Promise<void>;
}

export interface LibrarySettings {
  saveFolders: Record<string, Record<string, string>>;
}

interface StoreFileOptions {
  role?: string;
  id?: string;
  replace?: boolean;
}

type CopyInOptions = Omit<SafeCopyOptions, 'targetRoot' | 'target'> & {
  name: string;
  role: string;
  id?: string;
  replace?: boolean;
};

export class LibraryError extends Error {
  readonly code: string;

  constructor(code: string, message = 'Не удалось безопасно изменить библиотеку 3D.') {
    super(message);
    this.name = 'LibraryError';
    this.code = code;
  }
}

const modelKeys = new Set([
  'schema', 'id', 'name', 'project', 'category', 'tags', 'notes', 'origin', 'mainVersion',
  'createdAt', 'updatedAt',
]);
const versionKeys = new Set([
  'schema', 'id', 'seq', 'parent', 'kind', 'operation', 'provider', 'label', 'origin', 'status',
  'progress', 'etaSeconds', 'params', 'idempotencyKey', 'pool', 'retryAt', 'submittedAt',
  'intentId', 'childId', 'accountKey', 'planIndex', 'missedPolls', 'inputs', 'files', 'stats',
  'task', 'cost', 'error', 'rigCheck', 'createdAt', 'updatedAt', 'savedTo', 'views', 'mainFileId',
  'waitReason',
]);
const letters = 'абвгдеёжзийклмнопрстуфхцчшщъыьэюя'.split('');
const latin = [
  'a', 'b', 'v', 'g', 'd', 'e', 'e', 'zh', 'z', 'i', 'y', 'k', 'l', 'm', 'n', 'o', 'p',
  'r', 's', 't', 'u', 'f', 'kh', 'ts', 'ch', 'sh', 'sch', '', 'y', '', 'e', 'yu', 'ya',
];
const transliteration = new Map(letters.map((letter, index) => [letter, latin[index]!]));

/**
 * Имена модели транслитерируются, но не превращаются в произвольный путь.
 * Случайный suffix выделяется отдельно под замком и проверяется на коллизию.
 */
export function modelSlug(name: string): string {
  const translated = [...name.toLowerCase()].map((letter) => transliteration.get(letter) ?? letter).join('');

  return translated.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    .slice(0, 32).replace(/-$/, '') || 'model';
}

/**
 * JSON библиотеки имеет закрытую schema. Незнакомое поле не становится новой
 * опцией пути/credentials и не переносится автоматически в DTO.
 */
function object(value: unknown, keys: Set<string>): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !keys.has(key))) {
    throw new LibraryError('invalid_schema');
  }

  return value as Record<string, unknown>;
}

/**
 * Все суммы/тексты проверяет публичный decoder; вычисляемые поля здесь нулевые.
 * Сводка для пользователя строится отдельно из реальных версий и журнала расходов.
 */
function modelShape(model: DiskModel): Studio3dModel {
  return {
    id: model.id,
    name: model.name,
    project: model.project,
    category: model.category,
    tags: model.tags,
    origin: model.origin,
    createdAt: model.createdAt,
    updatedAt: model.updatedAt,
    mainVersion: model.mainVersion,
    preview: null,
    versions: 0,
    active: 0,
    spent: 0,
    spending: [],
    sizeBytes: 0,
    has: {
      rig: false,
      animation: false,
      parts: false,
      images: false
    },
  };
}

/**
 * Metadata модели проверяется до обхода папок и выбора mainVersion.
 * Stored id обязан совпадать с каталогом: JSON не перенаправляет чтение.
 */
export function decodeModel(value: unknown, expectedId: string, libraryId: string): DiskModel {
  const raw = object(value, modelKeys);

  if (raw.schema !== 1 || raw.id !== expectedId || !MODEL_ID_RE.test(expectedId)
    || typeof raw.notes !== 'string' || raw.notes.length > 100_000
    || !Array.isArray(raw.tags) || raw.tags.length > 20) {
    throw new LibraryError('invalid_schema');
  }

  const model = raw as unknown as DiskModel;

  parseStudio3d.models({
    libraryId,
    models: [modelShape(model)],
    total: 1,
    broken: []
  });

  if (model.mainVersion !== null && !VERSION_ID_RE.test(model.mainVersion)) {
    throw new LibraryError('invalid_schema');
  }

  return model;
}

/**
 * Версия разделяет частные поля журнала и безопасный DTO. Manifest закрывает
 * имена и хеши, входы разрешены только собственными basenames/inputs файлами.
 */
export function decodeVersion(value: unknown, expectedId: string, libraryId: string): DiskVersion {
  const raw = object(value, versionKeys);
  const version = raw as unknown as DiskVersion;

  if (raw.schema !== 1 || raw.id !== expectedId || !VERSION_ID_RE.test(expectedId)
    || !Number.isSafeInteger(version.seq) || version.seq < 1 || version.seq > 9999
    || !expectedId.startsWith(`v${String(version.seq).padStart(2, '0')}-`)
    || !Array.isArray(version.files) || version.files.length > 128 || !Array.isArray(version.inputs)
    || !Number.isSafeInteger(version.planIndex) || version.planIndex < 0
    || !Number.isSafeInteger(version.missedPolls) || version.missedPolls < 0) {
    throw new LibraryError('invalid_schema');
  }

  const names = new Set<string>();
  const ids = new Set<string>();

  for (const file of version.files) {
    if (!file || typeof file !== 'object' || Object.keys(file).some((key) => ![
      'id', 'role', 'name', 'size', 'sha256',
    ].includes(key)) || !isSafeName(file.name) || !isSafeName(file.id) || names.has(file.name)
      || ids.has(file.id) || !/^[a-f0-9]{64}$/.test(file.sha256)) {
      throw new LibraryError('invalid_schema');
    }

    names.add(file.name);
    ids.add(file.id);
  }

  for (const input of version.inputs) {
    if (!input || typeof input !== 'object'
      || Object.keys(input).some((key) => !['role', 'file'].includes(key))
      || typeof input.role !== 'string' || typeof input.file !== 'string'
      || !(isSafeName(input.file) || /^inputs\/[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(input.file))
      || input.file.includes('..')) {
      throw new LibraryError('invalid_schema');
    }
  }

  for (const key of ['idempotencyKey', 'retryAt', 'submittedAt', 'accountKey'] as const) {
    if (version[key] !== null && typeof version[key] !== 'string') {
      throw new LibraryError('invalid_schema');
    }
  }

  if (version.pool !== null && (!version.pool || typeof version.pool.key !== 'string'
    || Object.keys(version.pool).some((key) => !['key', 'limit'].includes(key))
    || (version.pool.limit !== null
      && (!Number.isSafeInteger(version.pool.limit) || version.pool.limit < 1)))) {
    throw new LibraryError('invalid_schema');
  }

  const dto = versionProjection(version, libraryId, () => '');

  parseStudio3d.version(dto);

  if (version.mainFileId !== null && !ids.has(version.mainFileId)) {
    throw new LibraryError('invalid_schema');
  }

  return version;
}

/**
 * Явная проекция не переносит accountKey/pool/idempotency metadata в браузер.
 * Retry определяется worker-ом по точным входам; сама библиотека его не обещает.
 */
export function versionProjection(
  version: DiskVersion,
  libraryId: string,
  fileUrl: (name: string) => string,
  retry: { available: boolean; reason: string | null } = { available: false, reason: null },
): Studio3dVersion {
  return {
    libraryId,
    id: version.id,
    seq: version.seq,
    parent: version.parent,
    kind: version.kind,
    operation: version.operation,
    provider: version.provider,
    label: version.label,
    status: version.status,
    progress: version.progress,
    etaSeconds: version.etaSeconds,
    params: version.params,
    files: version.files.map((file) => ({ ...file, url: fileUrl(file.name) })),
    preview: version.files.find((file) => file.role === 'preview')?.name
      ? fileUrl(version.files.find((file) => file.role === 'preview')!.name) : null,
    stats: version.stats,
    task: version.task,
    cost: version.cost,
    error: version.error,
    origin: version.origin,
    createdAt: version.createdAt,
    updatedAt: version.updatedAt,
    savedTo: version.savedTo,
    rigCheck: version.rigCheck,
    intentId: version.intentId,
    childId: version.childId,
    waitReason: version.waitReason,
    retryAvailable: retry.available,
    retryReason: retry.reason,
    views: version.views,
    mainFileId: version.mainFileId,
  };
}

/**
 * Ссылки родства принадлежат только модели, каждый seq уникален и циклов нет.
 * Проверка линейна по количеству версий, включая невыбранные основной веткой.
 */
function validateGraph(model: DiskModel, versions: DiskVersion[]): void {
  const byId = new Map(versions.map((version) => [version.id, version]));
  const sequences = new Set(versions.map((version) => version.seq));

  if (byId.size !== versions.length || sequences.size !== versions.length
    || (model.mainVersion !== null && !byId.has(model.mainVersion))) {
    throw new LibraryError('invalid_graph');
  }

  const finished = new Set<string>();

  for (const version of versions) {
    let current: DiskVersion | undefined = version;
    const visiting = new Set<string>();

    while (current && !finished.has(current.id)) {
      if (visiting.has(current.id) || (current.parent !== null && !byId.has(current.parent))) {
        throw new LibraryError('invalid_graph');
      }

      visiting.add(current.id);
      current = current.parent === null ? undefined : byId.get(current.parent);
    }

    for (const id of visiting) {
      finished.add(id);
    }
  }
}

/**
 * SaveFolders не хранит абсолютные пути: конкретный repo выбирается позднее API.
 * Обновления двух проектов объединяются под одним lock настройки библиотеки.
 */
function decodeSettings(value: unknown): LibrarySettings {
  const raw = object(value, new Set(['saveFolders']));

  if (!raw.saveFolders || typeof raw.saveFolders !== 'object' || Array.isArray(raw.saveFolders)) {
    throw new LibraryError('invalid_settings');
  }

  const saveFolders: LibrarySettings['saveFolders'] = {};

  for (const [project, repos] of Object.entries(raw.saveFolders)) {
    if (!isSafeName(project) || !repos || typeof repos !== 'object' || Array.isArray(repos)) {
      throw new LibraryError('invalid_settings');
    }

    saveFolders[project] = {};

    for (const [repo, folder] of Object.entries(repos)) {
      if (!isSafeName(repo) || typeof folder !== 'string' || folder.length > 500 || path.isAbsolute(folder)
        || folder.split(/[\\/]/).some((segment) => segment === '..') || folder.includes('\0')) {
        throw new LibraryError('invalid_settings');
      }

      saveFolders[project]![repo] = folder;
    }
  }

  return { saveFolders };
}

/**
 * Один default версии используется обычным добавлением и durable планированием.
 * ID и seq приходят из lock библиотеки, не из пользовательского patch.
 */
function versionTemplate(
  model: DiskModel,
  id: string,
  seq: number,
  input: Partial<DiskVersion> & { kind: DiskVersion['kind'] },
  at: string,
  libraryId: string,
): DiskVersion {
  return decodeVersion({
    schema: 1,
    parent: null,
    operation: null,
    provider: null,
    label: 'Файл',
    origin: model.origin,
    status: 'ready',
    progress: 100,
    etaSeconds: null,
    params: {},
    idempotencyKey: null,
    pool: null,
    retryAt: null,
    submittedAt: null,
    intentId: null,
    childId: null,
    accountKey: null,
    planIndex: 0,
    missedPolls: 0,
    inputs: [],
    files: [],
    stats: null,
    task: null,
    cost: {
      estimated: 0,
      actual: 0,
      free: true,
      unit: null,
      state: 'free'
    },
    error: null,
    rigCheck: null,
    savedTo: [],
    views: [],
    mainFileId: null,
    waitReason: null,
    ...input,
    id,
    seq,
    createdAt: at,
    updatedAt: at,
  }, id, libraryId);
}

class Library {
  private owner: KernelFileLock | null = null;
  private root: PinnedDirectory | null = null;
  private identity = '';
  private readonly requestedDir: string;
  private readonly options: LibraryOptions;
  private readonly leases = new Map<string, Set<string>>();
  private readonly hashes = new Map<string, { revision: string; sha256: string }>();
  private readonly plannedModels = new Set<string>();
  private readonly plannedSequences = new Map<string, Set<number>>();

  constructor(options: LibraryOptions) {
    this.options = options;
    this.requestedDir = path.resolve(options.dir);
  }

  get dir(): string {
    return this.root?.canonical ?? this.requestedDir;
  }

  get libraryId(): string {
    return this.identity;
  }

  /**
   * Последний допуск POST проверяет root и lock синхронно после journal fsync.
   * Нового await между подтверждением identity и началом платного эффекта нет.
   */
  assertOwnerNow(): void {
    if (!this.owner || !this.root) {
      throw new LibraryError('owner_closed');
    }

    this.owner.assertHeld();

    const held = fstatSync(this.root.handle.fd);
    const atPath = lstatSync(this.root.canonical);
    const lock = fstatSync(this.owner.inheritedFd());
    const lockAtPath = lstatSync(path.join(this.root.canonical, '.owner.lock'));

    if (!held.isDirectory() || !atPath.isDirectory() || atPath.isSymbolicLink()
      || held.dev !== atPath.dev || held.ino !== atPath.ino
      || realpathSync(this.root.canonical) !== this.root.canonical
      || !lock.isFile() || !lockAtPath.isFile() || lockAtPath.isSymbolicLink()
      || lock.nlink !== 1 || lockAtPath.nlink !== 1 || lock.dev !== lockAtPath.dev
      || lock.ino !== lockAtPath.ino) {
      throw new LibraryError('owner_lost');
    }
  }

  /**
   * Открытие явно вызывается lifecycle включённого плагина. Конструктор ничего
   * не создаёт, повторное ensure не сбрасывает UUID и не берёт второй flock.
   */
  async ensure(): Promise<void> {
    await withPathLock(`studio3d:ensure:${this.requestedDir}`, async () => {
      if (this.owner) {
        await this.assertOwner();

        return;
      }

      await fs.mkdir(this.requestedDir, { recursive: true, mode: 0o700 });

      const canonical = await fs.realpath(this.requestedDir);
      const root = await pinDirectory(canonical, canonical);
      let owner: KernelFileLock | null = null;

      try {
        owner = await acquireKernelFileLock({
          lockPath: root.child('.owner.lock'),
          timeoutMs: this.options.lockTimeoutMs ?? 100,
          timeoutCode: 'owner_busy',
          unavailableCode: 'owner_unavailable',
          lostCode: 'owner_lost',
          label: 'библиотеки 3D',
          errorFactory: (code) => new LibraryError(code),
        });
        await root.verify();

        this.owner = owner;
        this.root = root;

        let stored;

        try {
          stored = await readJson(this.dir, path.join(this.dir, '.library.json'));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
          }
        }

        if (stored === undefined) {
          this.identity = randomUUID();
          await this.persist(path.join(this.dir, '.library.json'), {
            schema: 1,
            libraryId: this.identity
          }, false);
        } else {
          const value = object(stored, new Set(['schema', 'libraryId']));

          if (value.schema !== 1 || typeof value.libraryId !== 'string'
            || !LIBRARY_UUID_RE.test(value.libraryId)) {
            throw new LibraryError('invalid_library');
          }

          this.identity = value.libraryId;
        }

        await ensureDirectory(this.dir, path.join(this.dir, '.jobs'));
        await ensureDirectory(this.dir, path.join(this.dir, '.uploads'));

        if (this.options.ensureGitignore) {
          await atomicWrite({
            root: this.dir,
            target: path.join(this.dir, '.gitignore'),
            data: '*\n!.gitignore\n'
          }).catch((error) => {
            if ((error as { code: string }).code !== 'exists') {
              throw error;
            }
          });
        }
      } catch (error) {
        this.owner = null;
        this.root = null;

        await owner?.release();
        await root.close();

        throw error;
      }
    });
  }

  /**
   * Потеря inode lock или корня закрывает все последующие мутации. Замок не
   * удаляется при close, другой процесс продолжает ту же библиотеку и журнал.
   */
  async assertOwner(): Promise<void> {
    if (!this.owner || !this.root) {
      throw new LibraryError('owner_closed');
    }

    this.owner.assertHeld();
    await this.owner.assertPathIdentity();
    await this.root.verify();

    const lock = await fs.lstat(this.root.child('.owner.lock'));

    if (!lock.isFile() || lock.nlink !== 1) {
      throw new LibraryError('owner_lost');
    }
  }

  /**
   * Закрываются только дескрипторы этой библиотеки, без unlink owner.lock.
   * Scheduler останавливается вызывающим до close и может затем открыть её снова.
   */
  async close(): Promise<void> {
    await withPathLock(`studio3d:ensure:${this.requestedDir}`, async () => {
      await this.owner?.release();
      await this.root?.close();

      this.owner = null;
      this.root = null;
      this.leases.clear();
      this.hashes.clear();
      this.plannedModels.clear();
      this.plannedSequences.clear();
    });
  }

  /**
   * Все собственные JSON идут через durable atomicWrite и проверку owner.
   * Fault hook применяется только тестами и не является настройкой HTTP API.
   */
  async persist(file: string, data: unknown, replace = true): Promise<void> {
    await this.assertOwner();
    await this.options.beforePersist?.(file);
    await atomicWrite({
      root: this.dir,
      target: file,
      data: `${JSON.stringify(data, null, 2)}\n`,
      overwrite: replace,
      internalReplace: true,
    });
  }

  /**
   * Новая папка выделяется атомарным mkdir в pinned parent. Существующее имя
   * означает коллизию, не разрешение переписать содержимое чужой модели.
   */
  private async allocate(parent: string, name: string): Promise<boolean> {
    const directory = await pinDirectory(this.dir, parent);

    try {
      await this.assertOwner();
      await directory.verify();
      await fs.mkdir(directory.child(name), { mode: 0o700 });
      await directory.handle.sync();

      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        return false;
      }

      throw error;
    } finally {
      await directory.close();
    }
  }

  private timestamp(): string {
    return new Date((this.options.now ?? Date.now)()).toISOString();
  }

  private hex(): string {
    const value = (this.options.randomHex ?? (() => randomBytes(2).toString('hex')))();

    if (!/^[a-f0-9]{4}$/.test(value)) {
      throw new LibraryError('invalid_random');
    }

    return value;
  }

  /**
   * Metadata полностью создаётся в новой папке; имя и UUID не зависят от prefs.
   * Два concurrent create не используют одну случайную папку даже при коллизии.
   */
  async createModel(input: Partial<Omit<DiskModel, 'schema' | 'id' | 'createdAt' | 'updatedAt'>>
    & { name: string }): Promise<DiskModel> {
    return withPathLock(`${this.dir}:models`, async () => {
      await this.assertOwner();

      for (let attempt = 0; attempt < 100; attempt += 1) {
        const id = `${modelSlug(input.name)}-${this.hex()}`;

        if (this.plannedModels.has(id)) {
          continue;
        }

        const at = this.timestamp();
        const model = decodeModel({
          schema: 1,
          id,
          name: input.name,
          project: input.project ?? null,
          category: input.category ?? null,
          tags: input.tags ?? [],
          notes: input.notes ?? '',
          origin: input.origin ?? 'section',
          mainVersion: null,
          createdAt: at,
          updatedAt: at
        }, id, this.libraryId);

        if (!await this.allocate(this.dir, id)) {
          continue;
        }

        await ensureDirectory(this.dir, path.join(this.dir, id, 'incoming'));
        await this.persist(path.join(this.dir, id, 'model.json'), model, false);

        return model;
      }

      throw new LibraryError('id_collision');
    });
  }

  /**
   * Seq и случайное имя выделяются вместе под lock модели. Parent проверяется
   * по её текущим версиям, а не по произвольному пути из input.
   */
  async addVersion(modelId: string, input: Partial<DiskVersion> & { kind: DiskVersion['kind'] }) {
    return withPathLock(this.modelPath(modelId), async () => {
      await this.assertOwner();

      const entry = await this.readModel(modelId);
      const seq = this.nextSeq(modelId, entry.versions);
      const operation = input.operation ?? 'file';

      if (!/^[a-z0-9-]{1,32}$/.test(operation) || seq > 9999) {
        throw new LibraryError('invalid_version');
      }

      for (let attempt = 0; attempt < 100; attempt += 1) {
        const id = `v${String(seq).padStart(2, '0')}-${operation}-${this.hex()}`;
        const at = this.timestamp();
        const version = versionTemplate(entry.model, id, seq, input, at, this.libraryId);
        const model = {
          ...entry.model,
          mainVersion: entry.model.mainVersion ?? (version.status === 'ready' ? id : null),
          updatedAt: at
        };

        validateGraph(model, [...entry.versions, version]);

        if (!await this.allocate(this.modelPath(modelId), id)) {
          continue;
        }

        await this.persist(path.join(this.modelPath(modelId), id, 'version.json'), version, false);
        await this.persist(path.join(this.modelPath(modelId), 'model.json'), model);

        return version;
      }

      throw new LibraryError('id_collision');
    });
  }

  /**
   * Seq учитывает ещё не опубликованные планы других намерений той же модели.
   * После recovery все планы materialize-ятся до открытия допуска новым заказам.
   */
  private nextSeq(modelId: string, versions: DiskVersion[]): number {
    return Math.max(0, ...versions.map((version) => version.seq),
      ...this.plannedSequences.get(modelId) ?? []) + 1;
  }

  /**
   * Model ID резервируется только в памяти под allocation lock. На диске ещё
   * нет проекции: durable intent с этим ID будет записан первым.
   */
  async planModel(input: Partial<DiskModel> & { name: string }): Promise<DiskModel> {
    return withPathLock(`${this.dir}:models`, async () => {
      await this.assertOwner();

      for (let attempt = 0; attempt < 100; attempt += 1) {
        const id = `${modelSlug(input.name)}-${this.hex()}`;
        const existing = await fs.lstat(this.modelPath(id)).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
          }

          return null;
        });

        if (existing || this.plannedModels.has(id)) {
          continue;
        }

        const at = this.timestamp();
        const model = decodeModel({
          schema: 1,
          id,
          name: input.name,
          project: input.project ?? null,
          category: input.category ?? null,
          tags: input.tags ?? [],
          notes: input.notes ?? '',
          origin: input.origin ?? 'section',
          mainVersion: null,
          createdAt: at,
          updatedAt: at
        }, id, this.libraryId);

        this.plannedModels.add(id);

        return model;
      }

      throw new LibraryError('id_collision');
    });
  }

  /**
   * Каждая будущая версия получает собственные id/seq до записи намерения.
   * Parent проверяется по прежней модели, несколько clips не используют planIndex.
   */
  async planVersion(model: DiskModel | string,
    input: Partial<DiskVersion> & { kind: DiskVersion['kind'] }): Promise<DiskVersion> {
    const modelId = typeof model === 'string' ? model : model.id;

    return withPathLock(this.modelPath(modelId), async () => {
      await this.assertOwner();

      const entry = typeof model === 'string' ? await this.readModel(model)
        : { model, versions: [] as DiskVersion[] };
      const seq = this.nextSeq(modelId, entry.versions);
      const operation = input.operation ?? 'file';

      if (!/^[a-z0-9-]{1,32}$/.test(operation) || seq > 9999) {
        throw new LibraryError('invalid_version');
      }

      const id = `v${String(seq).padStart(2, '0')}-${operation}-${this.hex()}`;
      const version = versionTemplate(entry.model, id, seq, input, this.timestamp(), this.libraryId);

      validateGraph(entry.model, [...entry.versions, version]);

      const sequences = this.plannedSequences.get(modelId) ?? new Set<number>();

      sequences.add(seq);
      this.plannedSequences.set(modelId, sequences);

      return version;
    });
  }

  /**
   * Recovery создаёт сохранённый model ID, а существующие пользовательские
   * metadata сохраняются. Новое случайное имя вместо durable плана не выделяется.
   */
  async materializeModel(template: DiskModel): Promise<DiskModel> {
    return withPathLock(`${this.dir}:models`, async () => {
      await this.assertOwner();

      const model = decodeModel(template, template.id, this.libraryId);
      const folder = this.modelPath(model.id);
      let existing: unknown;

      try {
        existing = await readJson(this.dir, path.join(folder, 'model.json'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }

      if (existing !== undefined) {
        this.plannedModels.delete(model.id);

        return decodeModel(existing, model.id, this.libraryId);
      }

      await this.allocate(this.dir, model.id);
      await ensureDirectory(this.dir, path.join(folder, 'incoming'));
      await this.persist(path.join(folder, 'model.json'), model, false);

      this.plannedModels.delete(model.id);

      return model;
    });
  }

  /**
   * Версия создаётся с journal id или возвращается по тому же intent/child.
   * Частично созданная папка восстанавливается до допуска первого внешнего POST.
   */
  async materializeVersion(modelId: string, template: DiskVersion): Promise<DiskVersion> {
    return withPathLock(this.modelPath(modelId), async () => {
      await this.assertOwner();

      const version = decodeVersion(template, template.id, this.libraryId);
      const folder = path.join(this.modelPath(modelId), version.id);
      let existing: unknown;

      try {
        existing = await readJson(this.dir, path.join(folder, 'version.json'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }

      if (existing !== undefined) {
        const found = decodeVersion(existing, version.id, this.libraryId);

        if (found.intentId !== version.intentId || found.childId !== version.childId) {
          throw new LibraryError('projection_conflict');
        }

        this.plannedSequences.get(modelId)?.delete(version.seq);

        return found;
      }

      const entry = await this.readModel(modelId, { skipMissingVersion: version.id });

      validateGraph(entry.model, [...entry.versions, version]);
      await this.allocate(this.modelPath(modelId), version.id);
      await this.persist(path.join(folder, 'version.json'), version, false);

      this.plannedSequences.get(modelId)?.delete(version.seq);

      return version;
    });
  }

  /**
   * Отказ до durable intent освобождает только in-memory резервы identity.
   * Уже опубликованные папки/JSON и финансовый журнал этим методом не удаляются.
   */
  releasePlans(modelId: string, versions: readonly DiskVersion[], releaseModel = false): void {
    if (releaseModel) {
      this.plannedModels.delete(modelId);
    }

    for (const version of versions) {
      this.plannedSequences.get(modelId)?.delete(version.seq);
    }
  }

  private modelPath(id: string): string {
    if (!MODEL_ID_RE.test(id)) {
      throw new LibraryError('invalid_model');
    }

    return path.join(this.dir, id);
  }

  /**
   * Версии читаются по существующим разрешённым каталогам, не списку путей JSON.
   * Полная graph проверка не позволяет cross-model mainVersion или parent.
   */
  async readModel(modelId: string, options: { skipMissingVersion?: string } = {}): Promise<ModelEntry> {
    const directory = this.modelPath(modelId);
    const pinned = await pinDirectory(this.dir, directory);

    try {
      const model = decodeModel(await readJson(this.dir, path.join(directory, 'model.json')),
        modelId, this.libraryId);
      const names = await fs.readdir(pinned.child('.'), { withFileTypes: true });
      const versions: DiskVersion[] = [];

      for (const entry of names) {
        if (!VERSION_ID_RE.test(entry.name)) {
          continue;
        }

        if (!entry.isDirectory() || entry.isSymbolicLink()) {
          throw new LibraryError('invalid_version');
        }

        try {
          versions.push(decodeVersion(await readJson(this.dir,
            path.join(directory, entry.name, 'version.json')), entry.name, this.libraryId));
        } catch (error) {
          if (entry.name !== options.skipMissingVersion
            || (error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
          }
        }
      }

      validateGraph(model, versions);
      await pinned.verify();

      return { model, versions: versions.sort((a, b) => a.seq - b.seq) };
    } finally {
      await pinned.close();
    }
  }

  /**
   * Broken папка исключается отдельно, не скрывая остальные модели.
   * Служебные папки и symlink не становятся моделями только по имени.
   */
  async listModels(): Promise<{ entries: ModelEntry[]; broken: string[] }> {
    if (!this.root) {
      throw new LibraryError('owner_closed');
    }

    await this.root.verify();

    const entries: ModelEntry[] = [];
    const broken: string[] = [];

    for (const item of await fs.readdir(this.root.child('.'), { withFileTypes: true })) {
      if (!MODEL_ID_RE.test(item.name) || !item.isDirectory()) {
        continue;
      }

      try {
        entries.push(await this.readModel(item.name));
      } catch {
        broken.push(item.name);
      }
    }

    await this.root.verify();

    return { entries, broken: broken.sort() };
  }

  /**
   * Patch либо updater применяется к актуальному JSON внутри model lock.
   * Нельзя менять id/seq/schema и создавать цикл запоздалой записью родства.
   */
  async updateVersion(modelId: string, versionId: string,
    patch: Partial<DiskVersion> | ((version: DiskVersion) => Partial<DiskVersion>)): Promise<DiskVersion> {
    return withPathLock(this.modelPath(modelId), async () => {
      await this.assertOwner();

      const entry = await this.readModel(modelId);
      const current = entry.versions.find((version) => version.id === versionId);

      if (!current) {
        throw new LibraryError('version_not_found');
      }

      const changes = typeof patch === 'function' ? patch(structuredClone(current)) : patch;

      if (changes.id !== undefined || changes.seq !== undefined || changes.schema !== undefined) {
        throw new LibraryError('immutable_version');
      }

      if (Object.entries(changes).every(([key, value]) =>
        isDeepStrictEqual(current[key as keyof DiskVersion], value))) {
        return current;
      }

      const updated = decodeVersion({
        ...current,
        ...changes,
        updatedAt: this.timestamp()
      },
        versionId, this.libraryId);

      const versions = entry.versions.map((version) => version.id === versionId ? updated : version);

      validateGraph(entry.model, versions);
      await this.persist(path.join(this.modelPath(modelId), versionId, 'version.json'), updated);

      return updated;
    });
  }

  /**
   * Метаданные модели обновляются без изменения её identity. Main выбирается
   * только из её версий и сохраняется вместе с датой изменения.
   */
  async updateModel(modelId: string, patch: Partial<DiskModel>): Promise<DiskModel> {
    return withPathLock(this.modelPath(modelId), async () => {
      await this.assertOwner();

      const entry = await this.readModel(modelId);

      if (patch.id !== undefined || patch.schema !== undefined) {
        throw new LibraryError('immutable_model');
      }

      const model = decodeModel({
        ...entry.model,
        ...patch,
        updatedAt: this.timestamp()
      },
        modelId, this.libraryId);

      validateGraph(model, entry.versions);
      await this.persist(path.join(this.modelPath(modelId), 'model.json'), model);

      return model;
    });
  }

  /**
   * Путь выдаётся только для существующей версии из этой модели.
   * Открытие конкретного файла дополнительно требует записи в manifest.
   */
  async versionDir(modelId: string, versionId: string): Promise<string> {
    if (!VERSION_ID_RE.test(versionId)) {
      throw new LibraryError('invalid_version');
    }

    const entry = await this.readModel(modelId);

    if (!entry.versions.some((version) => version.id === versionId)) {
      throw new LibraryError('version_not_found');
    }

    return path.join(this.modelPath(modelId), versionId);
  }

  /**
   * Recovery после публикации файла до version.json принимает только exact SHA.
   * Необъявленное имя не обслуживается API, пока manifest не зафиксирован fsync.
   */
  async adoptVersionFile(modelId: string, versionId: string, name: string,
    expectedSha256: string, options: StoreFileOptions): Promise<VersionFile> {
    return withPathLock(this.modelPath(modelId), async () => {
      await this.assertOwner();

      if (!isSafeName(name) || ['model.json', 'version.json'].includes(name)) {
        throw new LibraryError('invalid_file');
      }

      const entry = await this.readModel(modelId);
      const version = entry.versions.find((item) => item.id === versionId);

      if (!version) {
        throw new LibraryError('version_not_found');
      }

      const info = await verifiedHash(this.dir, path.join(this.modelPath(modelId), versionId, name));

      if (info.sha256 !== expectedSha256) {
        throw new LibraryError('changed');
      }

      const file = {
        id: options.id ?? name,
        role: options.role ?? 'file',
        name,
        size: info.size,
        sha256: info.sha256
      };
      const current = version.files.find((item) => item.name === name);

      if (current && (current.sha256 !== file.sha256 || current.id !== file.id ||
        current.role !== file.role)) {
        throw new LibraryError('changed');
      }

      const updated = decodeVersion({
        ...version,
        files: [...version.files.filter((item) => item.name !== name), file],
        updatedAt: this.timestamp()
      }, version.id, this.libraryId);

      await this.persist(path.join(this.modelPath(modelId), versionId, 'version.json'), updated);

      return file;
    });
  }

  /**
   * File descriptor закрепляет manifest файл до отправки HTTP или copy.
   * Version JSON, inputs и случайное имя в папке не доступны этой ручкой.
   */
  async openVersionFile(modelId: string, versionId: string, name: string) {
    if (!isSafeName(name)) {
      throw new LibraryError('invalid_file');
    }

    const entry = await this.readModel(modelId);
    const version = entry.versions.find((item) => item.id === versionId);
    const file = version?.files.find((item) => item.name === name);

    if (!file) {
      throw new LibraryError('file_not_found');
    }

    const opened = await openVerified(this.dir, path.join(this.modelPath(modelId), versionId, name));

    if (opened.size !== file.size) {
      await opened.handle.close();

      throw new LibraryError('changed');
    }

    try {
      let cached = this.hashes.get(opened.canonical);

      if (cached?.revision !== opened.revision) {
        const hash = createHash('sha256');

        await pipeline(borrowedReadStream(opened.handle, opened.canonical), hash);
        await opened.verify();

        cached = { revision: opened.revision, sha256: hash.digest('hex') };

        if (this.hashes.size >= 512) {
          this.hashes.clear();
        }

        this.hashes.set(opened.canonical, cached);
      }

      if (cached.sha256 !== file.sha256) {
        throw new LibraryError('changed');
      }

      await opened.verify();
    } catch (error) {
      await opened.handle.close();

      throw error;
    }

    return { ...opened, file };
  }

  /**
   * Совместимый path helper также подтверждает fd до возврата канонического имени.
   * Потоковым читателям следует использовать openVersionFile и тот же дескриптор.
   */
  async filePath(modelId: string, versionId: string, name: string): Promise<string> {
    const opened = await this.openVersionFile(modelId, versionId, name);

    await opened.handle.close();

    return opened.canonical;
  }

  /**
   * Готовые байты публикуются в новую версию и добавляются в закрытый manifest.
   * Повторная запись требует старый SHA; свободный preview не заменяет модель.
   */
  async writeVersionFile(modelId: string, versionId: string, name: string, data: Uint8Array,
    options: StoreFileOptions = {}) {
    return this.storeFile(modelId, versionId, name, options, async (target, previous) => atomicWrite({
      root: this.dir,
      target,
      data,
      overwrite: options.replace && previous !== undefined,
      expectedSha256: previous?.sha256,
    }));
  }

  /**
   * Вход копируется в независимый inode, не hardlink. В manifest попадают
   * только байты подтверждённой ревизии, а failure не создаёт доступного файла.
   */
  async copyIn(modelId: string, versionId: string, options: CopyInOptions) {
    return this.storeFile(modelId, versionId, options.name, options, async (target, previous) => safeCopy({
      ...options,
      targetRoot: this.dir,
      target,
      overwrite: options.replace && previous !== undefined,
      expectedSha256: previous?.sha256,
    }));
  }

  /**
   * Общая транзакция файла/manifest сериализуется тем же lock модели.
   * Orphan при сбое JSON не становится доступен: чтение требует manifest.
   */
  private async storeFile(
    modelId: string,
    versionId: string,
    name: string,
    options: {
      role?: string;
      id?: string;
      replace?: boolean
    },
    write: (target: string, previous?: VersionFile) => Promise<{ size: number; sha256: string }>,
  ) {
    return withPathLock(this.modelPath(modelId), async () => {
      await this.assertOwner();

      if (!isSafeName(name) || ['model.json', 'version.json'].includes(name)) {
        throw new LibraryError('invalid_file');
      }

      const entry = await this.readModel(modelId);
      const current = entry.versions.find((version) => version.id === versionId);

      if (!current) {
        throw new LibraryError('version_not_found');
      }

      const previous = current.files.find((file) => file.name === name);
      const result = await write(path.join(this.modelPath(modelId), versionId, name), previous);
      const file = {
        id: options.id ?? previous?.id ?? `file-${randomBytes(8).toString('hex')}`,
        role: options.role ?? 'file',
        name,
        ...result,
      };
      const retired = options.replace && options.role === 'preview'
        ? current.files.filter((item) => item.role === 'preview' && item.name !== name) : [];
      const files = [...current.files.filter((item) => item.name !== name && !retired.includes(item)), file];
      const updated = decodeVersion({
        ...current,
        files,
        mainFileId: current.mainFileId ?? (['model', 'file', 'image'].includes(file.role) ? file.id : null),
        updatedAt: this.timestamp()
      }, versionId, this.libraryId);

      await this.persist(path.join(this.modelPath(modelId), versionId, 'version.json'), updated);

      if (retired.length) {
        const directory = await pinDirectory(this.dir, path.join(this.modelPath(modelId), versionId));
        
        try {
          for (const previousPreview of retired) {
            await directory.verify();
            await fs.unlink(directory.child(previousPreview.name)).catch((error) => {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw error;
              }
            });
          }
          
          await directory.handle.sync();
        } finally {
          await directory.close();
        }
      }

      return result;
    });
  }

  /**
   * Lease действует на конкретный вход, дополняя persistent active statuses.
   * Несколько заданий удерживают один файл до освобождения последнего владельца.
   */
  private lease(key: string, owner: string): () => void {
    const owners = this.leases.get(key) ?? new Set<string>();

    owners.add(owner);
    this.leases.set(key, owners);

    return () => {
      owners.delete(owner);

      if (!owners.size) {
        this.leases.delete(key);
      }
    };
  }

  leaseVersion(modelId: string, versionId: string, owner: string): () => void {
    return this.lease(`version:${modelId}:${versionId}`, owner);
  }

  leaseUpload(uploadId: string, owner: string): () => void {
    return this.lease(`upload:${uploadId}`, owner);
  }

  private protectedVersion(modelId: string, version: DiskVersion): boolean {
    return ACTIVE_STATUSES.includes(version.status) || this.leases.has(`version:${modelId}:${version.id}`);
  }

  /**
   * Удаление модели не затрагивает .jobs, UUID и финансовые tombstones.
   * Все active/unknown версии и входы под lease блокируют это действие.
   */
  async deleteModel(modelId: string): Promise<void> {
    await withPathLock(this.modelPath(modelId), async () => {
      await this.assertOwner();

      const entry = await this.readModel(modelId);

      if (entry.versions.some((version) => this.protectedVersion(modelId, version))) {
        throw new LibraryError('active_jobs');
      }

      await this.removeDirectory(this.modelPath(modelId));
    });
  }

  /**
   * Потомок запрещает удаление родителя; main после удаления выбирается из ready.
   * Persistent журнал намерения остаётся вне папки версии при любом удалении.
   */
  async deleteVersion(modelId: string, versionId: string): Promise<void> {
    await withPathLock(this.modelPath(modelId), async () => {
      await this.assertOwner();

      const entry = await this.readModel(modelId);
      const version = entry.versions.find((item) => item.id === versionId);

      if (!version) {
        throw new LibraryError('version_not_found');
      }

      if (this.protectedVersion(modelId, version)) {
        throw new LibraryError('active_jobs');
      }

      if (entry.versions.some((item) => item.parent === versionId)) {
        throw new LibraryError('has_children');
      }

      const remaining = entry.versions.filter((item) => item.id !== versionId);
      const model = {
        ...entry.model,
        mainVersion: entry.model.mainVersion === versionId
          ? remaining.filter((item) => item.status === 'ready').at(-1)?.id ?? null : entry.model.mainVersion,
        updatedAt: this.timestamp()
      };

      await this.persist(path.join(this.modelPath(modelId), 'model.json'), model);
      await this.removeDirectory(path.join(this.modelPath(modelId), versionId));
    });
  }

  /**
   * Удаление закрепляет parent и проверяет каталог до recursive rm.
   * Symlink не становится каталогом удаления, корневые служебные папки не принимаются.
   */
  private async removeDirectory(directory: string): Promise<void> {
    const pinned = await pinDirectory(this.dir, directory);
    const parent = await pinDirectory(this.dir, path.dirname(directory));

    try {
      await this.assertOwner();
      await pinned.verify();
      await parent.verify();
      await fs.rm(parent.child(path.basename(directory)), { recursive: true });
      await parent.handle.sync();
    } finally {
      await pinned.close();
      await parent.close();
    }
  }

  /**
   * Облегчение удаляет только manifest model/base-model и считает фактический stat.
   * Превью/JSON сохраняются, основные и leased входы требуют отдельного допуска.
   */
  async lighten(modelId: string, versionId: string, options: { force?: boolean } = {}): Promise<number> {
    return withPathLock(this.modelPath(modelId), async () => {
      await this.assertOwner();

      const entry = await this.readModel(modelId);
      const version = entry.versions.find((item) => item.id === versionId);

      if (!version) {
        throw new LibraryError('version_not_found');
      }

      if (this.protectedVersion(modelId, version)) {
        throw new LibraryError('active_jobs');
      }

      if (entry.model.mainVersion === versionId && !options.force) {
        throw new LibraryError('main_version');
      }

      const directory = await pinDirectory(this.dir, path.join(this.modelPath(modelId), versionId));
      let freed = 0;

      try {
        for (const file of version.files.filter((item) => ['model', 'base-model'].includes(item.role))) {
          const opened = await openVerified(this.dir, path.join(directory.canonical, file.name));

          await opened.verify();
          await directory.verify();
          await fs.unlink(directory.child(file.name));

          freed += opened.size;

          await opened.handle.close();
        }

        await directory.handle.sync();
      } finally {
        await directory.close();
      }

      const files = version.files.filter((file) => !['model', 'base-model'].includes(file.role));
      const updated = decodeVersion({
        ...version,
        files,
        mainFileId: files.some((file) => file.id === version.mainFileId) ? version.mainFileId : null,
        status: 'lightened',
        updatedAt: this.timestamp()
      }, versionId, this.libraryId);

      await this.persist(path.join(this.modelPath(modelId), versionId, 'version.json'), updated);

      return freed;
    });
  }

  /**
   * Incoming перечисляет только обычные одноимённые 3D файлы в папке модели.
   * Импорт отдельно проверит сигнатуру/лимиты и создаст независимую копию.
   */
  async incoming(modelId: string): Promise<string[]> {
    await this.readModel(modelId);

    const directory = await pinDirectory(this.dir, path.join(this.modelPath(modelId), 'incoming'));
    const names: string[] = [];

    try {
      for (const item of await fs.readdir(directory.child('.'), { withFileTypes: true })) {
        if (!item.isFile() || !isExternalName(item.name)
          || !/\.(?:glb|fbx|obj|stl|splat)$/i.test(item.name)) {
          continue;
        }

        const opened = await openVerified(this.dir, path.join(directory.canonical, item.name))
          .catch(() => null);

        if (opened) {
          names.push(item.name);
          await opened.handle.close();
        }
      }

      await directory.verify();

      return names.sort();
    } finally {
      await directory.close();
    }
  }

  /**
   * Учёт включает скрытые snapshots и partial, обход не следует symlink.
   * Категории суммируются в логические байты, не обещают освобождение reflink блоков.
   */
  async diskUsage() {
    const usage = {
      bytes: 0,
      modelBytes: 0,
      inputBytes: 0,
      temporaryBytes: 0,
      freeBytes: null as number | null
    };
    const stack = [this.dir];

    while (stack.length) {
      const current = stack.pop()!;
      const pinned = await pinDirectory(this.dir, current);

      try {
        for (const item of await fs.readdir(pinned.child('.'), { withFileTypes: true })) {
          const file = path.join(current, item.name);

          if (item.isDirectory() && !item.isSymbolicLink()) {
            stack.push(file);

            continue;
          }

          if (!item.isFile()) {
            continue;
          }

          const stat = await fs.lstat(pinned.child(item.name)).catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') {
              return null;
            }

            throw error;
          });

          if (!stat?.isFile() || stat.nlink !== 1) {
            continue;
          }

          const relative = path.relative(this.dir, file);
          const group = relative.startsWith(`.uploads${path.sep}`) || /\.(?:part|tmp)$/.test(relative)
            ? 'temporaryBytes' : relative.startsWith(`.jobs${path.sep}`) ? 'inputBytes' : 'modelBytes';

          usage[group] += stat.size;
          usage.bytes += stat.size;
        }

        await pinned.verify();
      } finally {
        await pinned.close();
      }
    }

    const space = await fs.statfs(this.dir).catch(() => null);

    usage.freeBytes = space ? space.bavail * space.bsize : null;

    return usage;
  }

  /**
   * Отсутствие настроек означает пустую таблицу, повреждённый JSON — явный отказ.
   * Settings не читается из live prefs и принадлежит конкретному library UUID.
   */
  async settings(): Promise<LibrarySettings> {
    try {
      return decodeSettings(await readJson(this.dir, path.join(this.dir, 'settings.json')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { saveFolders: {} };
      }

      throw error;
    }
  }

  /**
   * Patch объединяет repo каждого проекта с актуальными settings под lock.
   * Независимые concurrent сохранения не стирают выбранную папку другого проекта.
   */
  async saveSettings(patch: LibrarySettings): Promise<LibrarySettings> {
    return withPathLock(`${this.dir}:settings`, async () => {
      const current = await this.settings();
      const changes = decodeSettings(patch);

      for (const [project, repos] of Object.entries(changes.saveFolders)) {
        current.saveFolders[project] = { ...current.saveFolders[project], ...repos };
      }

      await this.persist(path.join(this.dir, 'settings.json'), current);

      return current;
    });
  }

  uploadsDir(): string {
    return path.join(this.dir, '.uploads');
  }

  /**
   * Уборка проходит под общим lock uploads и пропускает действующие lease.
   * Старое имя не позволяет удалить ссылку наружу или вход продолжающегося заказа.
   */
  async cleanUploads(olderThanMs: number): Promise<void> {
    await withPathLock(`${this.dir}:uploads`, async () => {
      await this.assertOwner();

      const directory = await pinDirectory(this.dir, this.uploadsDir());

      try {
        for (const item of await fs.readdir(directory.child('.'), { withFileTypes: true })) {
          if (!isSafeName(item.name) || !item.isDirectory() || this.leases.has(`upload:${item.name}`)) {
            continue;
          }

          const stat = await fs.lstat(directory.child(item.name));

          if (stat.isDirectory() && stat.mtimeMs < (this.options.now ?? Date.now)() - olderThanMs) {
            await this.removeDirectory(path.join(this.uploadsDir(), item.name));
          }
        }
      } finally {
        await directory.close();
      }
    });
  }
}

/**
 * Создание объекта библиотеки не имеет файловых эффектов. Ensure и close вызываются
 * владельцем lifecycle; тесты используют те же flock и atomic публикацию.
 */
export function createLibrary(options: LibraryOptions): Library {
  return new Library(options);
}

export type StudioLibrary = ReturnType<typeof createLibrary>;
