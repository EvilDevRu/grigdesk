// Content-addressed хранилище маршрутов протокола route-v2.
//
// Опубликованный bundle никогда не меняется. Сначала он целиком собирается во временном
// каталоге рядом с revisions/, валидируется и только затем публикуется atomic rename.
// Единственный изменяемый файл — catalog/current.json; его замена защищена CAS и lock-файлом.

import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import type { FileHandle } from 'node:fs/promises';

import { sha256 } from '../../../../shared/node/hash.ts';
import { isRecord } from '../../../../shared/lib/objects.ts';

import { acquireKernelFileLock } from '../../lib/kernelLock.ts';
import {
  assertProfileId,
  assertRevisionHash,
  assertRouteId,
  ROUTES_V2_HASH_RE,
  RoutesError,
  validateBootstrap,
  validateCatalog,
  validatePromptFiles,
  validateRoute,
} from './schema.ts';
import type { RouteCatalogDoc, RouteMachineDoc } from './schema.ts';

// Запись manifest: путь внутри bundle, его hash и размер в байтах.
export interface ManifestEntry {
  path: string;
  sha256: string;
  size: number;
}

// Manifest bundle. `id` есть только у маршрута: каталог адресуется профилем.
export interface BundleManifest {
  schema: number;
  kind: string;
  profile: string;
  id?: string;
  algorithm: string;
  files: ManifestEntry[];
}

// Адрес bundle, по которому сверяется manifest.
export interface BundleAddress {
  kind: 'route' | 'catalog';
  profile: string;
  id?: string;
}

// Карта prompt-файлов: полный относительный путь внутри bundle → текст.
export type PromptMap = Record<string, string>;

// Указатель current.json: единственный изменяемый файл хранилища.
export interface CurrentPointer {
  schema: number;
  catalogHash: string;
}

// Прочитанный route bundle вместе с его manifest.
export interface StoredRoute {
  routeHash: string;
  route: RouteMachineDoc;
  prompts: PromptMap;
  manifest: BundleManifest;
}

// Прочитанный catalog bundle: сам каталог, bootstrap и их prompts.
export interface StoredCatalog {
  catalogHash: string;
  catalog: RouteCatalogDoc;
  bootstrap: RouteMachineDoc;
  prompts: PromptMap;
  manifest: BundleManifest;
}

// Одна ревизия каталога в списке отката. `routes` пуст у повреждённой ревизии.
export interface CatalogRevision {
  catalogHash: string;
  createdAt: string;
  isCurrent: boolean;
  routes: Record<string, string> | null;
  integrity: string;
}

const MANIFEST_FILE = 'manifest.json';
const CURRENT_FILE = 'current.json';
const CURRENT_LOCK = '.current.lock';
const EDITOR_SOURCE_FILE = 'editor-source.json';
const LOCK_TIMEOUT_MS = 5_000;
const profileMutationContext = new AsyncLocalStorage<Set<string>>();

export interface RouteProfileMutation {
  readonly profile: string;
  readonly catalogDir: string;
}

export interface RouteEditorSource {
  mode: 'profile-script' | 'editor';
  revision: number;
}

const errorCode = (error: unknown) => (error as { code?: unknown } | null)?.code;

function storeError(
  code: string,
  message: string,
  details: Record<string, unknown> = {},
  cause: unknown = null,
): RoutesError {
  const error = new RoutesError(code, message, details);
  if (cause) error.cause = cause;
  return error;
}

function sortedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, sortedJson(value[key])]),
  );
}

function compareFileNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Канонический, но читаемый JSON. Hash считается по этим точным байтам. */
export function serializeRoutesJson(value: unknown): string {
  return `${JSON.stringify(sortedJson(value), null, 2)}\n`;
}

function normalizePromptText(text: string): string {
  const normalized = text.replace(/\r\n?/g, '\n');
  return normalized.endsWith('\n') ? normalized : `${normalized}\n`;
}

function assertManifestKeys(
  value: unknown,
  required: readonly string[],
  pathName: string,
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) {
    throw storeError('ROUTES_V2_TAMPERED', `${pathName}: manifest не является объектом`);
  }
  const expected = new Set(required);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) {
      throw storeError('ROUTES_V2_TAMPERED', `${pathName}: неизвестное поле manifest «${key}»`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      throw storeError('ROUTES_V2_TAMPERED', `${pathName}: нет поля manifest «${key}»`);
    }
  }
}

function isSafeBundleFile(kind: string, file: string): boolean {
  if (kind === 'route') {
    return file === 'route.json'
      || /^prompts\/[a-z0-9][a-z0-9_-]{0,40}(?:\.[a-z0-9][a-z0-9_-]{0,40})*\.md$/.test(file);
  }
  return file === 'catalog.json'
    || file === 'bootstrap/scout.json'
    || /^bootstrap\/prompts\/[a-z0-9][a-z0-9_-]{0,40}(?:\.[a-z0-9][a-z0-9_-]{0,40})*\.md$/.test(file);
}

function allowedBundleDirectories(kind: string): Set<string> {
  return kind === 'route'
    ? new Set(['prompts'])
    : new Set(['bootstrap', 'bootstrap/prompts']);
}

function parseCanonicalJson(
  bytes: Buffer | undefined,
  file: string,
  { code = 'ROUTES_V2_TAMPERED' } = {},
): unknown {
  if (!bytes) throw storeError(code, `${file}: файл отсутствует в bundle`, { file });
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch (cause) {
    throw storeError(code, `${file}: повреждённый JSON`, { file }, cause);
  }
  if (serializeRoutesJson(value) !== bytes.toString('utf8')) {
    throw storeError(code, `${file}: JSON записан не в каноническом формате`, { file });
  }
  return value;
}

async function writeDurable(file: string, bytes: Buffer): Promise<void> {
  const handle = await fs.open(file, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(directory, 'r');
    await handle.sync();
  } catch {
    // На некоторых FS fsync каталога недоступен. Atomic rename от этого не перестаёт
    // быть атомарным; теряется лишь дополнительная гарантия пережить power loss.
  } finally {
    await handle?.close();
  }
}

function promptFilesFromManifest(manifest: BundleManifest): Set<string> {
  return new Set(
    manifest.files
      .map((entry) => entry.path)
      .filter((file) => file.endsWith('.md')),
  );
}

function promptsFromFiles(files: Map<string, Buffer>, manifest: BundleManifest): PromptMap {
  return Object.fromEntries(
    manifest.files
      .map((entry) => entry.path)
      .filter((file) => file.endsWith('.md'))
      .map((file) => [file, (files.get(file) ?? Buffer.alloc(0)).toString('utf8')]),
  );
}

function storedSchema<Value>(operation: () => Value, label: string): Value {
  try {
    return operation();
  } catch (cause) {
    if (!(cause instanceof RoutesError)) throw cause;
    throw storeError(
      'ROUTES_V2_TAMPERED',
      `${label}: опубликованный документ не проходит schema v2`,
      { document: label },
      cause,
    );
  }
}

export class RoutesStore {
  readonly baseDir: string;

  readonly lockTimeoutMs: number;

  constructor({ baseDir, lockTimeoutMs = LOCK_TIMEOUT_MS }: {
    baseDir: string;
    lockTimeoutMs?: number;
  }) {
    if (typeof baseDir !== 'string' || baseDir.length === 0) {
      throw storeError('ROUTES_V2_INVALID_SCHEMA', 'baseDir обязателен');
    }
    this.baseDir = path.resolve(baseDir);
    if (this.baseDir === path.parse(this.baseDir).root) {
      throw storeError('ROUTES_V2_INVALID_SCHEMA', 'Корень filesystem нельзя использовать как baseDir');
    }
    this.lockTimeoutMs = lockTimeoutMs;
  }

  async _baseDirectory({ create }: { create: boolean }): Promise<string> {
    const parsed = path.parse(this.baseDir);
    let current = parsed.root;
    const parts = path.relative(parsed.root, this.baseDir).split(path.sep).filter(Boolean);

    for (const part of parts) {
      current = path.join(current, part);
      let info;
      try {
        info = await fs.lstat(current);
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error;
        if (!create) {
          throw storeError(
            'ROUTES_V2_NOT_FOUND',
            `${current}: корень хранилища не найден`,
            { file: current },
            error,
          );
        }
        try {
          await fs.mkdir(current, { mode: 0o700 });
        } catch (mkdirError) {
          if (errorCode(mkdirError) !== 'EEXIST') throw mkdirError;
        }
        info = await fs.lstat(current);
      }
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw storeError(
          create ? 'ROUTES_V2_PATH_TRAVERSAL' : 'ROUTES_V2_TAMPERED',
          `${current}: небезопасный компонент корня хранилища`,
          { file: current },
        );
      }
    }
    return this.baseDir;
  }

  async _ensureDirectory(parts: readonly string[] = []): Promise<string> {
    await this._baseDirectory({ create: true });
    let current = this.baseDir;
    for (const part of parts) {
      current = path.join(current, part);
      try {
        const info = await fs.lstat(current);
        if (info.isSymbolicLink() || !info.isDirectory()) {
          throw storeError(
            'ROUTES_V2_PATH_TRAVERSAL',
            `${current}: компонент хранилища не является обычным каталогом`,
            { file: current },
          );
        }
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error;
        try {
          await fs.mkdir(current, { mode: 0o700 });
        } catch (mkdirError) {
          if (errorCode(mkdirError) !== 'EEXIST') throw mkdirError;
        }
        const info = await fs.lstat(current);
        if (info.isSymbolicLink() || !info.isDirectory()) {
          throw storeError(
            'ROUTES_V2_PATH_TRAVERSAL',
            `${current}: небезопасная подмена каталога`,
            { file: current },
          );
        }
      }
    }
    return current;
  }

  async _existingDirectory(parts: readonly string[]): Promise<string> {
    let current = await this._baseDirectory({ create: false });
    for (const part of parts) {
      current = path.join(current, part);
      let info;
      try {
        info = await fs.lstat(current);
      } catch (cause) {
        if (errorCode(cause) === 'ENOENT') {
          throw storeError('ROUTES_V2_NOT_FOUND', `${current}: bundle не найден`, { file: current }, cause);
        }
        throw cause;
      }
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw storeError(
          'ROUTES_V2_TAMPERED',
          `${current}: компонент bundle подменён`,
          { file: current },
        );
      }
    }
    return current;
  }

  _routeRevisionParts(profile: string, routeId: string, hash: string): string[] {
    return [profile, routeId, 'revisions', hash];
  }

  _catalogRevisionParts(profile: string, hash: string): string[] {
    return [profile, 'catalog', 'revisions', hash];
  }

  async _walkBundle(root: string, kind: string): Promise<{
    files: string[];
    directories: string[];
  }> {
    const files: string[] = [];
    const directories: string[] = [];
    const allowedDirs = allowedBundleDirectories(kind);

    const walk = async (directory: string, relative = ''): Promise<void> => {
      const entries = await fs.readdir(directory, { withFileTypes: true });
      entries.sort((left, right) => compareFileNames(left.name, right.name));
      for (const entry of entries) {
        const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
        const child = path.join(directory, entry.name);
        const info = await fs.lstat(child);
        if (info.isSymbolicLink()) {
          throw storeError('ROUTES_V2_TAMPERED', `${childRelative}: symlink запрещён`, { file: childRelative });
        }
        if (info.isDirectory()) {
          if (!allowedDirs.has(childRelative)) {
            throw storeError(
              'ROUTES_V2_TAMPERED',
              `${childRelative}: лишний каталог bundle`,
              { file: childRelative },
            );
          }
          directories.push(childRelative);
          await walk(child, childRelative);
        } else if (info.isFile()) {
          files.push(childRelative);
        } else {
          throw storeError(
            'ROUTES_V2_TAMPERED',
            `${childRelative}: разрешены только обычные файлы`,
            { file: childRelative },
          );
        }
      }
    };
    await walk(root);
    return { files, directories };
  }

  async _verifyBundleAt(bundleDir: string, expectedHash: string, expected: BundleAddress): Promise<{
    manifest: BundleManifest;
    files: Map<string, Buffer>;
  }> {
    const rootInfo = await fs.lstat(bundleDir);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
      throw storeError('ROUTES_V2_TAMPERED', `${bundleDir}: bundle подменён`, { file: bundleDir });
    }

    const manifestPath = path.join(bundleDir, MANIFEST_FILE);
    let manifestInfo;
    try {
      manifestInfo = await fs.lstat(manifestPath);
    } catch (cause) {
      throw storeError('ROUTES_V2_TAMPERED', 'manifest.json отсутствует', { file: manifestPath }, cause);
    }
    if (manifestInfo.isSymbolicLink() || !manifestInfo.isFile()) {
      throw storeError('ROUTES_V2_TAMPERED', 'manifest.json не является обычным файлом', { file: manifestPath });
    }

    const manifestBytes = await fs.readFile(manifestPath);
    if (sha256(manifestBytes) !== expectedHash) {
      throw storeError(
        'ROUTES_V2_TAMPERED',
        'Hash manifest не совпадает с именем ревизии',
        { expectedHash },
      );
    }
    const parsedManifest = parseCanonicalJson(manifestBytes, MANIFEST_FILE);
    const manifest = parsedManifest as BundleManifest;
    const requiredKeys = expected.kind === 'route'
      ? ['schema', 'kind', 'profile', 'id', 'algorithm', 'files']
      : ['schema', 'kind', 'profile', 'algorithm', 'files'];
    assertManifestKeys(parsedManifest, requiredKeys, MANIFEST_FILE);
    if (
      manifest.schema !== 2
      || manifest.kind !== expected.kind
      || manifest.profile !== expected.profile
      || manifest.algorithm !== 'sha256'
      || (expected.kind === 'route' && manifest.id !== expected.id)
    ) {
      throw storeError('ROUTES_V2_TAMPERED', 'Метаданные manifest не совпадают с адресом bundle');
    }
    if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
      throw storeError('ROUTES_V2_TAMPERED', 'manifest.files пуст или повреждён');
    }

    const declared = new Set<string>();
    let previous = '';
    for (const [index, entry] of manifest.files.entries()) {
      assertManifestKeys(entry, ['path', 'sha256', 'size'], `manifest.files[${index}]`);
      if (
        typeof entry.path !== 'string'
        || !isSafeBundleFile(expected.kind, entry.path)
        || entry.path === MANIFEST_FILE
      ) {
        throw storeError(
          'ROUTES_V2_TAMPERED',
          `manifest.files[${index}]: небезопасный путь`,
          { file: entry.path },
        );
      }
      if (entry.path <= previous || declared.has(entry.path)) {
        throw storeError('ROUTES_V2_TAMPERED', 'manifest.files должен быть уникален и отсортирован');
      }
      if (!ROUTES_V2_HASH_RE.test(entry.sha256) || !Number.isSafeInteger(entry.size) || entry.size < 0) {
        throw storeError('ROUTES_V2_TAMPERED', `manifest.files[${index}]: неверный hash/size`);
      }
      previous = entry.path;
      declared.add(entry.path);
    }
    const requiredFiles = expected.kind === 'route'
      ? ['route.json']
      : ['bootstrap/scout.json', 'catalog.json'];
    for (const file of requiredFiles) {
      if (!declared.has(file)) {
        throw storeError('ROUTES_V2_TAMPERED', `${file}: обязательный файл отсутствует в manifest`);
      }
    }

    const actual = await this._walkBundle(bundleDir, expected.kind);
    const expectedActual = new Set([...declared, MANIFEST_FILE]);
    if (
      actual.files.length !== expectedActual.size
      || actual.files.some((file) => !expectedActual.has(file))
    ) {
      throw storeError('ROUTES_V2_TAMPERED', 'Набор файлов bundle не совпадает с manifest');
    }
    for (const directory of actual.directories) {
      if (!actual.files.some((file) => file.startsWith(`${directory}/`))) {
        throw storeError('ROUTES_V2_TAMPERED', `${directory}: лишний пустой каталог`);
      }
    }

    const files = new Map<string, Buffer>();
    for (const entry of manifest.files) {
      const filePath = path.join(bundleDir, ...entry.path.split('/'));
      const info = await fs.lstat(filePath);
      if (info.isSymbolicLink() || !info.isFile()) {
        throw storeError('ROUTES_V2_TAMPERED', `${entry.path}: не обычный файл`, { file: entry.path });
      }
      const bytes = await fs.readFile(filePath);
      if (bytes.length !== entry.size || sha256(bytes) !== entry.sha256) {
        throw storeError('ROUTES_V2_TAMPERED', `${entry.path}: содержимое не совпадает с manifest`, {
          file: entry.path,
        });
      }
      files.set(entry.path, bytes);
    }
    return { manifest, files };
  }

  async _publishBundle({ revisionsDir, files, manifestMeta }: {
    revisionsDir: string;
    files: Map<string, Buffer>;
    manifestMeta: BundleAddress;
  }): Promise<{ hash: string; created: boolean }> {
    const temp = await fs.mkdtemp(path.join(revisionsDir, '.tmp-'));
    let temporary: string | null = temp;
    try {
      const entries = [...files.entries()].sort(([left], [right]) => compareFileNames(left, right));
      for (const [relative, bytes] of entries) {
        const filePath = path.join(temp, ...relative.split('/'));
        await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
        await writeDurable(filePath, bytes);
      }

      const manifest = {
        schema: 2,
        kind: manifestMeta.kind,
        profile: manifestMeta.profile,
        ...(manifestMeta.kind === 'route' ? { id: manifestMeta.id } : {}),
        algorithm: 'sha256',
        files: entries.map(([file, bytes]) => ({
          path: file,
          sha256: sha256(bytes),
          size: bytes.length,
        })),
      };
      const manifestBytes = Buffer.from(serializeRoutesJson(manifest));
      const revisionHash = sha256(manifestBytes);
      await writeDurable(path.join(temp, MANIFEST_FILE), manifestBytes);
      await this._verifyBundleAt(temp, revisionHash, manifestMeta);

      const finalDir = path.join(revisionsDir, revisionHash);
      try {
        const info = await fs.lstat(finalDir);
        if (!info.isDirectory() || info.isSymbolicLink()) {
          throw storeError('ROUTES_V2_TAMPERED', `${revisionHash}: ревизия подменена`);
        }
        await this._verifyBundleAt(finalDir, revisionHash, manifestMeta);
        await fs.rm(temp, { recursive: true, force: true });
        temporary = null;
        return { hash: revisionHash, created: false };
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error;
      }

      try {
        await fs.rename(temp, finalDir);
        temporary = null;
        await syncDirectory(revisionsDir);
        return { hash: revisionHash, created: true };
      } catch (error) {
        if (errorCode(error) !== 'EEXIST' && errorCode(error) !== 'ENOTEMPTY') throw error;
        await this._verifyBundleAt(finalDir, revisionHash, manifestMeta);
        await fs.rm(temp, { recursive: true, force: true });
        temporary = null;
        return { hash: revisionHash, created: false };
      }
    } finally {
      if (temporary) await fs.rm(temporary, { recursive: true, force: true });
    }
  }

  _normalizePrompts(prompts: unknown, prefix: string): {
    normalized: PromptMap;
    promptFiles: Set<string>;
  } {
    validatePromptFiles(prompts, { prefix });
    const normalized: PromptMap = Object.fromEntries(
      Object.entries(prompts as PromptMap).map(([file, text]) => [file, normalizePromptText(text)]),
    );
    const promptFiles = validatePromptFiles(normalized, { prefix });
    return { normalized, promptFiles };
  }

  /** Публикует route bundle, но не меняет каталог. */
  async publishRoute(profile: string, routeId: string, { route, prompts }: {
    route: unknown;
    prompts: unknown;
  }): Promise<{ routeHash: string; created: boolean }> {
    assertProfileId(profile);
    assertRouteId(routeId);
    const { normalized, promptFiles } = this._normalizePrompts(prompts, 'prompts/');
    validateRoute(route, { profile, routeId, promptFiles });

    const revisionsDir = await this._ensureDirectory([profile, routeId, 'revisions']);
    const files = new Map<string, Buffer>([
      ['route.json', Buffer.from(serializeRoutesJson(route))],
      ...Object.entries(normalized).map(([file, text]): [string, Buffer] => (
        [file, Buffer.from(text)]
      )),
    ]);
    const published = await this._publishBundle({
      revisionsDir,
      files,
      manifestMeta: { kind: 'route', profile, id: routeId },
    });
    return { routeHash: published.hash, created: published.created };
  }

  async readRoute(profile: string, routeId: string, routeHash: string): Promise<StoredRoute> {
    assertProfileId(profile);
    assertRouteId(routeId);
    assertRevisionHash(routeHash);
    const bundleDir = await this._existingDirectory(
      this._routeRevisionParts(profile, routeId, routeHash),
    );
    const verified = await this._verifyBundleAt(bundleDir, routeHash, {
      kind: 'route',
      profile,
      id: routeId,
    });
    const promptFiles = promptFilesFromManifest(verified.manifest);
    const route = parseCanonicalJson(verified.files.get('route.json'), 'route.json');
    const validated = storedSchema(
      () => validateRoute(route, {
        profile,
        routeId,
        promptFiles,
        // Уже закреплённые immutable-бандлы могли быть опубликованы до появления
        // семантического запрета. Чтение сохраняем; publishRoute остаётся строгим.
        allowLegacyProductFailureRewind: true,
      }),
      'route.json',
    );
    return {
      routeHash,
      route: validated,
      prompts: promptsFromFiles(verified.files, verified.manifest),
      manifest: verified.manifest,
    };
  }

  _validateMachineRouteReferences(
    machine: RouteMachineDoc,
    catalog: RouteCatalogDoc,
    label: string,
  ): void {
    const knownRoutes = new Set(Object.keys(catalog.routes));
    for (const record of machine.escalation) {
      for (const routeId of record.allowedRoutes) {
        if (!knownRoutes.has(routeId)) {
          throw storeError(
            'ROUTES_V2_INVALID_SCHEMA',
            `${label} разрешает отсутствующий в catalog маршрут «${routeId}»`,
            { routeId },
          );
        }
      }
    }
    for (const node of machine.nodes) {
      if (node.executor === 'status') continue;
      for (const transition of Object.values(node.on ?? {})) {
        for (const routeId of transition.escalate?.routes || []) {
          if (!knownRoutes.has(routeId)) {
            throw storeError(
              'ROUTES_V2_INVALID_SCHEMA',
              `${label} выбирает отсутствующий в catalog маршрут «${routeId}»`,
              { routeId },
            );
          }
        }
      }
    }
  }

  async _verifyCatalogRouteReferences(
    profile: string,
    catalog: RouteCatalogDoc,
    { catalogIntegrity = false } = {},
  ): Promise<void> {
    try {
      const routes = await Promise.all(
        Object.entries(catalog.routes).map(async ([routeId, routeHash]): Promise<
        [string, StoredRoute]
        > => [
          routeId,
          await this.readRoute(profile, routeId, routeHash),
        ]),
      );
      for (const [routeId, bundle] of routes) {
        this._validateMachineRouteReferences(
          bundle.route,
          catalog,
          `Route «${routeId}»`,
        );
      }
    } catch (cause) {
      if (!catalogIntegrity || !(cause instanceof RoutesError)) throw cause;
      throw storeError(
        'ROUTES_V2_TAMPERED',
        'catalog ссылается на отсутствующий или повреждённый route bundle',
        {},
        cause,
      );
    }
  }

  /** Создаёт проверенный immutable catalog bundle, не меняя current.json. */
  async prepareCatalog(
    profile: string,
    { catalog, bootstrap, prompts }: { catalog: unknown; bootstrap: unknown; prompts: unknown },
  ): Promise<{ catalogHash: string; created: boolean }> {
    assertProfileId(profile);
    const catalogDoc = validateCatalog(catalog, { profile });
    const { normalized, promptFiles } = this._normalizePrompts(
      prompts,
      'bootstrap/prompts/',
    );
    const bootstrapDoc = validateBootstrap(bootstrap, { profile, promptFiles });
    this._validateMachineRouteReferences(bootstrapDoc, catalogDoc, 'Bootstrap');
    await this._verifyCatalogRouteReferences(profile, catalogDoc);

    const revisionsDir = await this._ensureDirectory([profile, 'catalog', 'revisions']);
    const files = new Map<string, Buffer>([
      ['catalog.json', Buffer.from(serializeRoutesJson(catalog))],
      ['bootstrap/scout.json', Buffer.from(serializeRoutesJson(bootstrap))],
      ...Object.entries(normalized).map(([file, text]): [string, Buffer] => (
        [file, Buffer.from(text)]
      )),
    ]);
    const published = await this._publishBundle({
      revisionsDir,
      files,
      manifestMeta: { kind: 'catalog', profile },
    });
    return { catalogHash: published.hash, created: published.created };
  }

  /**
   * Старый profile-script путь сохраняет формат и CAS-семантику ответа.
   * Проверка source-mode и общий coordinator добавляются в D2.
   */
  async publishCatalog(
    profile: string,
    input: { catalog: unknown; bootstrap: unknown; prompts: unknown },
    options: { expectedCatalogHash?: string | null } = {},
  ): Promise<{ catalogHash: string; created: boolean; currentChanged: boolean }> {
    assertProfileId(profile);
    if (!Object.hasOwn(options, 'expectedCatalogHash')) {
      throw storeError(
        'ROUTES_V2_INVALID_SCHEMA',
        'publishCatalog требует expectedCatalogHash (null для первой публикации)',
      );
    }
    const expectedCatalogHash = options.expectedCatalogHash ?? null;
    if (expectedCatalogHash !== null) assertRevisionHash(expectedCatalogHash, 'expectedCatalogHash');
    const published = await this.prepareCatalog(profile, input);
    const current = await this._compareAndSwapCurrent(
      profile,
      published.catalogHash,
      expectedCatalogHash,
      'profile-script',
    );
    return {
      catalogHash: published.catalogHash,
      created: published.created,
      currentChanged: current.changed,
    };
  }

  async readCatalog(profile: string, catalogHash: string): Promise<StoredCatalog> {
    assertProfileId(profile);
    assertRevisionHash(catalogHash);
    const bundleDir = await this._existingDirectory(
      this._catalogRevisionParts(profile, catalogHash),
    );
    const verified = await this._verifyBundleAt(bundleDir, catalogHash, {
      kind: 'catalog',
      profile,
    });
    const catalog = parseCanonicalJson(verified.files.get('catalog.json'), 'catalog.json');
    const bootstrap = parseCanonicalJson(
      verified.files.get('bootstrap/scout.json'),
      'bootstrap/scout.json',
    );
    const promptFiles = promptFilesFromManifest(verified.manifest);
    const catalogDoc = storedSchema(() => validateCatalog(catalog, { profile }), 'catalog.json');
    const bootstrapDoc = storedSchema(
      () => validateBootstrap(bootstrap, { profile, promptFiles }),
      'bootstrap/scout.json',
    );
    storedSchema(
      () => this._validateMachineRouteReferences(bootstrapDoc, catalogDoc, 'Bootstrap'),
      'bootstrap/scout.json',
    );
    await this._verifyCatalogRouteReferences(profile, catalogDoc, { catalogIntegrity: true });
    return {
      catalogHash,
      catalog: catalogDoc,
      bootstrap: bootstrapDoc,
      prompts: promptsFromFiles(verified.files, verified.manifest),
      manifest: verified.manifest,
    };
  }

  /**
   * Опубликованные ревизии каталога — материал для отката указателя из UI.
   * Времени публикации в бандле нет и быть не может: хеш считается ИЗ СОДЕРЖИМОГО,
   * и метка времени сделала бы одну и ту же схему двумя разными ревизиями. Поэтому
   * «когда появилась» берём из mtime каталога ревизии: это метаданные файловой
   * системы, к подписанному содержимому они отношения не имеют и на сверку не влияют.
   * Битая ревизия не роняет список — она возвращается с кодом в integrity, иначе одна
   * повреждённая папка отняла бы у человека возможность откатиться на здоровые.
   */
  async listCatalogRevisions(profile: string): Promise<{
    currentCatalogHash: string | null;
    revisions: CatalogRevision[];
  }> {
    assertProfileId(profile);
    let revisionsDir: string;
    try {
      revisionsDir = await this._existingDirectory([profile, 'catalog', 'revisions']);
    } catch (error) {
      if (error instanceof RoutesError && error.code === 'ROUTES_V2_NOT_FOUND') {
        return { currentCatalogHash: null, revisions: [] };
      }
      throw error;
    }
    const pointer = await this._readCurrentPointer(profile);
    const currentCatalogHash = pointer?.catalogHash ?? null;
    const revisions: CatalogRevision[] = [];
    for (const entry of await fs.readdir(revisionsDir, { withFileTypes: true })) {
      // Каталоги .tmp-* — след незавершённой публикации, ревизиями они не являются.
      if (!entry.isDirectory() || !ROUTES_V2_HASH_RE.test(entry.name)) continue;
      const bundleDir = path.join(revisionsDir, entry.name);
      const info = await fs.stat(bundleDir);
      const revision: CatalogRevision = {
        catalogHash: entry.name,
        createdAt: new Date(info.mtimeMs).toISOString(),
        isCurrent: entry.name === currentCatalogHash,
        routes: null,
        integrity: 'ok',
      };
      try {
        const verified = await this._verifyBundleAt(bundleDir, entry.name, {
          kind: 'catalog',
          profile,
        });
        const catalog = parseCanonicalJson(verified.files.get('catalog.json'), 'catalog.json');
        const doc = storedSchema(() => validateCatalog(catalog, { profile }), 'catalog.json');
        revision.routes = doc.routes;
      } catch (cause) {
        if (!(cause instanceof RoutesError)) throw cause;
        revision.integrity = cause.code;
      }
      revisions.push(revision);
    }
    // Свежие сверху; при совпавшем mtime порядок задаёт хеш — список стабилен.
    revisions.sort((left, right) => (
      right.createdAt.localeCompare(left.createdAt)
      || left.catalogHash.localeCompare(right.catalogHash)
    ));
    return { currentCatalogHash, revisions };
  }

  async _readCurrentPointer(profile: string): Promise<CurrentPointer | null> {
    const catalogDir = path.join(this.baseDir, profile, 'catalog');
    const currentPath = path.join(catalogDir, CURRENT_FILE);
    let info;
    try {
      info = await fs.lstat(currentPath);
    } catch (cause) {
      if (errorCode(cause) === 'ENOENT') return null;
      throw cause;
    }
    if (info.isSymbolicLink() || !info.isFile()) {
      throw storeError('ROUTES_V2_TAMPERED', 'current.json подменён', { file: currentPath });
    }
    const bytes = await fs.readFile(currentPath);
    const pointer = parseCanonicalJson(bytes, CURRENT_FILE);
    if (
      !isRecord(pointer)
      || Object.keys(pointer).length !== 2
      || pointer.schema !== 2
      || !Object.hasOwn(pointer, 'catalogHash')
    ) {
      throw storeError('ROUTES_V2_TAMPERED', 'current.json имеет неверный формат');
    }
    const catalogHash = storedSchema(
      () => assertRevisionHash(pointer.catalogHash, 'current.catalogHash'),
      CURRENT_FILE,
    );
    return { schema: 2, catalogHash };
  }

  async _withCurrentLock<Value>(
    profile: string,
    operation: (catalogDir: string) => Promise<Value>,
  ): Promise<Value> {
    const lockKey = `${this.baseDir}\0${profile}`;
    const active = profileMutationContext.getStore();
    if (active?.has(lockKey)) {
      throw storeError('ROUTES_V2_LOCKED', 'Повторный захват замка профиля запрещён');
    }

    const catalogDir = await this._ensureDirectory([profile, 'catalog']);
    const lockPath = path.join(catalogDir, CURRENT_LOCK);
    try {
      const info = await fs.lstat(lockPath);
      if (info.isSymbolicLink() || !info.isFile()) {
        throw storeError('ROUTES_V2_TAMPERED', 'CAS lock подменён', { file: lockPath });
      }
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
    const held = await acquireKernelFileLock({
      lockPath,
      timeoutMs: this.lockTimeoutMs,
      timeoutCode: 'ROUTES_V2_LOCKED',
      unavailableCode: 'ROUTES_V2_LOCK_UNAVAILABLE',
      lostCode: 'ROUTES_V2_LOCK_LOST',
      label: 'routes current',
      errorFactory: (code, message) => storeError(code, message),
    });
    try {
      held.assertHeld();
      const keys = new Set(active ?? []);
      keys.add(lockKey);
      const result = await profileMutationContext.run(keys, async () => {
        const { PublicationJournal } = await import('./publicationJournal.ts');
        await new PublicationJournal(this).recoverUnderMutation({ profile, catalogDir });
        return operation(catalogDir);
      });
      held.assertHeld();
      return result;
    } finally {
      await held.release();
    }
  }

  /** Читает source как данные; отсутствие файла сохраняет legacy default без записи. */
  async _readEditorSourceAt(catalogDir: string): Promise<RouteEditorSource> {
    const file = path.join(catalogDir, EDITOR_SOURCE_FILE);
    let handle: FileHandle;
    try {
      handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return { mode: 'profile-script', revision: 0 };
      throw storeError('routes_authoring_corrupted', 'Источник управления недоступен');
    }
    let bytes: Buffer;
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 4096) {
        throw storeError('routes_authoring_corrupted', 'Источник управления повреждён');
      }
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw storeError('routes_authoring_corrupted', 'Источник управления не JSON');
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)
      || Object.keys(parsed).sort().join(',') !== 'mode,revision,schema') {
      throw storeError('routes_authoring_corrupted', 'Источник управления имеет неверные поля');
    }
    const value = parsed as Record<string, unknown>;
    if (value.schema !== 1 || (value.mode !== 'profile-script' && value.mode !== 'editor')
      || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1) {
      throw storeError('routes_authoring_corrupted', 'Источник управления имеет неверную версию');
    }
    return { mode: value.mode, revision: Number(value.revision) };
  }

  async readEditorSource(profile: string): Promise<RouteEditorSource> {
    assertProfileId(profile);
    let catalogDir: string;
    try {
      catalogDir = await this._existingDirectory([profile, 'catalog']);
    } catch (error) {
      if (errorCode(error) === 'ROUTES_V2_NOT_FOUND') {
        return { mode: 'profile-script', revision: 0 };
      }
      throw error;
    }
    return this._readEditorSourceAt(catalogDir);
  }

  /** Меняет source и current-ожидание под тем же kernel lock, что защищает CAS. */
  async switchEditorSource(
    profile: string,
    { mode, expectedSourceRevision, expectedCatalogHash }: {
      mode: RouteEditorSource['mode'];
      expectedSourceRevision: number;
      expectedCatalogHash: string | null;
    },
  ): Promise<RouteEditorSource> {
    assertProfileId(profile);
    if (mode !== 'profile-script' && mode !== 'editor') {
      throw storeError('ROUTES_V2_INVALID_SCHEMA', 'Неверный источник управления');
    }
    if (!Number.isSafeInteger(expectedSourceRevision) || expectedSourceRevision < 0) {
      throw storeError('ROUTES_V2_INVALID_SCHEMA', 'Неверная ревизия источника');
    }
    if (expectedCatalogHash !== null) {
      assertRevisionHash(expectedCatalogHash, 'expectedCatalogHash');
    }
    return this.withProfileMutation(profile, async ({ catalogDir }) => {
      const source = await this._readEditorSourceAt(catalogDir);
      const current = await this._readCurrentPointer(profile);
      if (source.revision !== expectedSourceRevision) {
        throw storeError('routes_source_conflict', 'Источник управления изменился', {
          sourceRevision: source.revision,
        });
      }
      if ((current?.catalogHash ?? null) !== expectedCatalogHash) {
        throw storeError('routes_catalog_conflict', 'Текущий каталог изменился', {
          currentCatalogHash: current?.catalogHash ?? null,
        });
      }
      if (source.mode === mode) return source;
      const next = { mode, revision: source.revision + 1 } as const;
      const temporary = path.join(catalogDir,
        `${EDITOR_SOURCE_FILE}.${process.pid}.${randomUUID()}.tmp`);
      try {
        await writeDurable(temporary, Buffer.from(serializeRoutesJson({ schema: 1, ...next })));
        await fs.rename(temporary, path.join(catalogDir, EDITOR_SOURCE_FILE));
        await syncDirectory(catalogDir);
      } finally {
        await fs.rm(temporary, { force: true });
      }
      return next;
    });
  }

  /**
   * Единый межпроцессный замок для изменения авторства и current профиля.
   * Вложенный захват через этот или существующий CAS-путь отвергается.
   */
  async withProfileMutation<Value>(
    profile: string,
    operation: (mutation: RouteProfileMutation) => Promise<Value>,
  ): Promise<Value> {
    assertProfileId(profile);

    return this._withCurrentLock(profile, async (catalogDir) => operation({
      profile,
      catalogDir,
    }));
  }

  isProfileMutationActive(profile: string): boolean {
    assertProfileId(profile);
    return profileMutationContext.getStore()?.has(`${this.baseDir}\0${profile}`) ?? false;
  }

  async _compareAndSwapCurrent(
    profile: string,
    desiredHash: string,
    expectedHash: string | null,
    origin: 'profile-script' | 'editor' | 'rollback' = 'profile-script',
  ): Promise<{ changed: boolean; catalogHash: string }> {
    return this._withCurrentLock(profile, async () => this.activatePreparedUnderMutation(
      profile, desiredHash, expectedHash, { origin },
    ));
  }

  /** Единственный CAS для уже удерживаемого lock; вложенный захват запрещён. */
  async activatePreparedUnderMutation(
    profile: string,
    desiredHash: string,
    expectedHash: string | null,
    { origin, expectedSourceRevision }: {
      origin: 'profile-script' | 'editor' | 'rollback';
      expectedSourceRevision?: number;
    },
  ): Promise<{ changed: boolean; catalogHash: string }> {
    assertProfileId(profile);
    assertRevisionHash(desiredHash, 'desiredHash');
    const lockKey = `${this.baseDir}\0${profile}`;
    if (!profileMutationContext.getStore()?.has(lockKey)) {
      throw storeError('ROUTES_V2_LOCKED', 'Активация требует замка профиля');
    }
    const catalogDir = path.join(this.baseDir, profile, 'catalog');
    const source = await this._readEditorSourceAt(catalogDir);
    if (origin !== 'rollback' && source.mode !== origin) {
      throw storeError('routes_source_conflict',
        'Источник управления не разрешает активацию этим писателем', {
          sourceRevision: source.revision,
        });
    }
    if (expectedSourceRevision !== undefined && source.revision !== expectedSourceRevision) {
      throw storeError('routes_source_conflict', 'Ревизия источника изменена', {
        sourceRevision: source.revision,
      });
    }
    const current = await this._readCurrentPointer(profile);
    const currentHash = current?.catalogHash ?? null;
    // Старый writer сохраняет no-op ответ; editor дополнительно проверяет ожидаемый hash.
    if (origin !== 'editor' && currentHash === desiredHash) {
      return { changed: false, catalogHash: desiredHash };
    }
    if (currentHash !== expectedHash) {
      throw storeError(
        origin === 'editor' ? 'routes_catalog_conflict' : 'ROUTES_V2_STALE_REVISION',
        'current catalog изменился после начала редактирования',
        { expectedCatalogHash: expectedHash, currentCatalogHash: currentHash, desiredHash },
      );
    }
    if (currentHash === desiredHash) return { changed: false, catalogHash: desiredHash };
    const pointer = Buffer.from(serializeRoutesJson({ schema: 2, catalogHash: desiredHash }));
    const temporary = path.join(catalogDir,
      `${CURRENT_FILE}.${process.pid}.${randomUUID()}.tmp`);
    try {
      await writeDurable(temporary, pointer);
      await fs.rename(temporary, path.join(catalogDir, CURRENT_FILE));
      await syncDirectory(catalogDir);
    } finally {
      await fs.rm(temporary, { force: true });
    }
    const saved = await this._readCurrentPointer(profile);
    if (saved?.catalogHash !== desiredHash) {
      throw storeError('ROUTES_V2_TAMPERED', 'current.json не сохранил желаемую ревизию');
    }
    return { changed: true, catalogHash: desiredHash };
  }

  /**
   * Публичный CAS нужен для отката current на уже опубликованный catalog bundle.
   */
  async compareAndSwapCurrent(
    profile: string,
    desiredCatalogHash: string,
    { expectedCatalogHash = null }: { expectedCatalogHash?: string | null } = {},
  ): Promise<{ changed: boolean; catalogHash: string }> {
    assertProfileId(profile);
    assertRevisionHash(desiredCatalogHash, 'desiredCatalogHash');
    if (expectedCatalogHash !== null) {
      assertRevisionHash(expectedCatalogHash, 'expectedCatalogHash');
    }
    await this.readCatalog(profile, desiredCatalogHash);
    return this._compareAndSwapCurrent(profile, desiredCatalogHash,
      expectedCatalogHash, 'rollback');
  }

  async readCurrent(profile: string): Promise<StoredCatalog | null> {
    assertProfileId(profile);
    try {
      await this._existingDirectory([profile, 'catalog']);
    } catch (error) {
      if (errorCode(error) === 'ROUTES_V2_NOT_FOUND') return null;
      throw error;
    }
    const pointer = await this._readCurrentPointer(profile);
    if (!pointer) return null;
    return this.readCatalog(profile, pointer.catalogHash);
  }
}
