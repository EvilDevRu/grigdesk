// Content-addressed хранилище маршрутов протокола route-v2.
//
// Опубликованный bundle никогда не меняется. Сначала он целиком собирается во временном
// каталоге рядом с revisions/, валидируется и только затем публикуется atomic rename.
// Единственный изменяемый файл — catalog/current.json; его замена защищена CAS и lock-файлом.

import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { acquireKernelFileLock } from '../../lib/kernel-lock.js';
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
} from './schema.js';

const MANIFEST_FILE = 'manifest.json';
const CURRENT_FILE = 'current.json';
const CURRENT_LOCK = '.current.lock';
const LOCK_TIMEOUT_MS = 5_000;

function storeError(code, message, details = {}, cause = null) {
  const error = new RoutesError(code, message, details);
  if (cause) error.cause = cause;
  return error;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sortedJson(value) {
  if (Array.isArray(value)) return value.map(sortedJson);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, sortedJson(value[key])]),
  );
}

function compareFileNames(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Канонический, но читаемый JSON. Hash считается по этим точным байтам. */
export function serializeRoutesJson(value) {
  return `${JSON.stringify(sortedJson(value), null, 2)}\n`;
}

export function hashRoutesBytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

function normalizePromptText(text) {
  const normalized = text.replace(/\r\n?/g, '\n');
  return normalized.endsWith('\n') ? normalized : `${normalized}\n`;
}

function assertManifestKeys(value, required, pathName) {
  if (!isObject(value)) {
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

function isSafeBundleFile(kind, file) {
  if (kind === 'route') {
    return file === 'route.json'
      || /^prompts\/[a-z0-9][a-z0-9_-]{0,40}(?:\.[a-z0-9][a-z0-9_-]{0,40})*\.md$/.test(file);
  }
  return file === 'catalog.json'
    || file === 'bootstrap/scout.json'
    || /^bootstrap\/prompts\/[a-z0-9][a-z0-9_-]{0,40}(?:\.[a-z0-9][a-z0-9_-]{0,40})*\.md$/.test(file);
}

function allowedBundleDirectories(kind) {
  return kind === 'route'
    ? new Set(['prompts'])
    : new Set(['bootstrap', 'bootstrap/prompts']);
}

function parseCanonicalJson(bytes, file, { code = 'ROUTES_V2_TAMPERED' } = {}) {
  let value;
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

async function writeDurable(file, bytes) {
  const handle = await fs.open(file, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory) {
  let handle;
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

function promptFilesFromManifest(manifest) {
  return new Set(
    manifest.files
      .map((entry) => entry.path)
      .filter((file) => file.endsWith('.md')),
  );
}

function promptsFromFiles(files, manifest) {
  return Object.fromEntries(
    manifest.files
      .map((entry) => entry.path)
      .filter((file) => file.endsWith('.md'))
      .map((file) => [file, files.get(file).toString('utf8')]),
  );
}

function storedSchema(operation, label) {
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
  /** @param {{ baseDir: string, lockTimeoutMs?: number }} options */
  constructor({ baseDir, lockTimeoutMs = LOCK_TIMEOUT_MS }) {
    if (typeof baseDir !== 'string' || baseDir.length === 0) {
      throw storeError('ROUTES_V2_INVALID_SCHEMA', 'baseDir обязателен');
    }
    this.baseDir = path.resolve(baseDir);
    if (this.baseDir === path.parse(this.baseDir).root) {
      throw storeError('ROUTES_V2_INVALID_SCHEMA', 'Корень filesystem нельзя использовать как baseDir');
    }
    this.lockTimeoutMs = lockTimeoutMs;
  }

  async _baseDirectory({ create }) {
    const parsed = path.parse(this.baseDir);
    let current = parsed.root;
    const parts = path.relative(parsed.root, this.baseDir).split(path.sep).filter(Boolean);

    for (const part of parts) {
      current = path.join(current, part);
      let info;
      try {
        info = await fs.lstat(current);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
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
          if (mkdirError?.code !== 'EEXIST') throw mkdirError;
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

  async _ensureDirectory(parts = []) {
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
        if (error?.code !== 'ENOENT') throw error;
        try {
          await fs.mkdir(current, { mode: 0o700 });
        } catch (mkdirError) {
          if (mkdirError?.code !== 'EEXIST') throw mkdirError;
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

  async _existingDirectory(parts) {
    let current = await this._baseDirectory({ create: false });
    for (const part of parts) {
      current = path.join(current, part);
      let info;
      try {
        info = await fs.lstat(current);
      } catch (cause) {
        if (cause?.code === 'ENOENT') {
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

  _routeRevisionParts(profile, routeId, hash) {
    return [profile, routeId, 'revisions', hash];
  }

  _catalogRevisionParts(profile, hash) {
    return [profile, 'catalog', 'revisions', hash];
  }

  async _walkBundle(root, kind) {
    const files = [];
    const directories = [];
    const allowedDirs = allowedBundleDirectories(kind);

    const walk = async (directory, relative = '') => {
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

  async _verifyBundleAt(bundleDir, expectedHash, expected) {
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
    if (hashRoutesBytes(manifestBytes) !== expectedHash) {
      throw storeError(
        'ROUTES_V2_TAMPERED',
        'Hash manifest не совпадает с именем ревизии',
        { expectedHash },
      );
    }
    const manifest = parseCanonicalJson(manifestBytes, MANIFEST_FILE);
    const requiredKeys = expected.kind === 'route'
      ? ['schema', 'kind', 'profile', 'id', 'algorithm', 'files']
      : ['schema', 'kind', 'profile', 'algorithm', 'files'];
    assertManifestKeys(manifest, requiredKeys, MANIFEST_FILE);
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

    const declared = new Set();
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

    const files = new Map();
    for (const entry of manifest.files) {
      const filePath = path.join(bundleDir, ...entry.path.split('/'));
      const info = await fs.lstat(filePath);
      if (info.isSymbolicLink() || !info.isFile()) {
        throw storeError('ROUTES_V2_TAMPERED', `${entry.path}: не обычный файл`, { file: entry.path });
      }
      const bytes = await fs.readFile(filePath);
      if (bytes.length !== entry.size || hashRoutesBytes(bytes) !== entry.sha256) {
        throw storeError('ROUTES_V2_TAMPERED', `${entry.path}: содержимое не совпадает с manifest`, {
          file: entry.path,
        });
      }
      files.set(entry.path, bytes);
    }
    return { manifest, files };
  }

  async _publishBundle({ revisionsDir, files, manifestMeta }) {
    const temp = await fs.mkdtemp(path.join(revisionsDir, '.tmp-'));
    let temporary = temp;
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
          sha256: hashRoutesBytes(bytes),
          size: bytes.length,
        })),
      };
      const manifestBytes = Buffer.from(serializeRoutesJson(manifest));
      const revisionHash = hashRoutesBytes(manifestBytes);
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
        if (error?.code !== 'ENOENT') throw error;
      }

      try {
        await fs.rename(temp, finalDir);
        temporary = null;
        await syncDirectory(revisionsDir);
        return { hash: revisionHash, created: true };
      } catch (error) {
        if (error?.code !== 'EEXIST' && error?.code !== 'ENOTEMPTY') throw error;
        await this._verifyBundleAt(finalDir, revisionHash, manifestMeta);
        await fs.rm(temp, { recursive: true, force: true });
        temporary = null;
        return { hash: revisionHash, created: false };
      }
    } finally {
      if (temporary) await fs.rm(temporary, { recursive: true, force: true });
    }
  }

  _normalizePrompts(prompts, prefix) {
    validatePromptFiles(prompts, { prefix });
    const normalized = Object.fromEntries(
      Object.entries(prompts).map(([file, text]) => [file, normalizePromptText(text)]),
    );
    const promptFiles = validatePromptFiles(normalized, { prefix });
    return { normalized, promptFiles };
  }

  /**
   * Публикует route bundle, но не меняет каталог.
   * @returns {{ routeHash: string, created: boolean }}
   */
  async publishRoute(profile, routeId, { route, prompts }) {
    assertProfileId(profile);
    assertRouteId(routeId);
    const { normalized, promptFiles } = this._normalizePrompts(prompts, 'prompts/');
    validateRoute(route, { profile, routeId, promptFiles });

    const revisionsDir = await this._ensureDirectory([profile, routeId, 'revisions']);
    const files = new Map([
      ['route.json', Buffer.from(serializeRoutesJson(route))],
      ...Object.entries(normalized).map(([file, text]) => [file, Buffer.from(text)]),
    ]);
    const published = await this._publishBundle({
      revisionsDir,
      files,
      manifestMeta: { kind: 'route', profile, id: routeId },
    });
    return { routeHash: published.hash, created: published.created };
  }

  async readRoute(profile, routeId, routeHash) {
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
    storedSchema(
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
      route,
      prompts: promptsFromFiles(verified.files, verified.manifest),
      manifest: verified.manifest,
    };
  }

  _validateMachineRouteReferences(machine, catalog, label) {
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
      for (const transition of Object.values(node.on)) {
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

  async _verifyCatalogRouteReferences(profile, catalog, { catalogIntegrity = false } = {}) {
    try {
      const routes = await Promise.all(
        Object.entries(catalog.routes).map(async ([routeId, routeHash]) => [
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

  /**
   * Публикует immutable catalog bundle и CAS-ом переставляет current.json.
   * expectedCatalogHash обязателен: null означает «current ещё не существует».
   */
  async publishCatalog(
    profile,
    { catalog, bootstrap, prompts },
    options = {},
  ) {
    assertProfileId(profile);
    if (!Object.hasOwn(options, 'expectedCatalogHash')) {
      throw storeError(
        'ROUTES_V2_INVALID_SCHEMA',
        'publishCatalog требует expectedCatalogHash (null для первой публикации)',
      );
    }
    const expectedCatalogHash = options.expectedCatalogHash;
    if (expectedCatalogHash !== null) assertRevisionHash(expectedCatalogHash, 'expectedCatalogHash');

    validateCatalog(catalog, { profile });
    const { normalized, promptFiles } = this._normalizePrompts(
      prompts,
      'bootstrap/prompts/',
    );
    validateBootstrap(bootstrap, { profile, promptFiles });
    this._validateMachineRouteReferences(bootstrap, catalog, 'Bootstrap');
    await this._verifyCatalogRouteReferences(profile, catalog);

    const revisionsDir = await this._ensureDirectory([profile, 'catalog', 'revisions']);
    const files = new Map([
      ['catalog.json', Buffer.from(serializeRoutesJson(catalog))],
      ['bootstrap/scout.json', Buffer.from(serializeRoutesJson(bootstrap))],
      ...Object.entries(normalized).map(([file, text]) => [file, Buffer.from(text)]),
    ]);
    const published = await this._publishBundle({
      revisionsDir,
      files,
      manifestMeta: { kind: 'catalog', profile },
    });
    const current = await this._compareAndSwapCurrent(
      profile,
      published.hash,
      expectedCatalogHash,
    );
    return {
      catalogHash: published.hash,
      created: published.created,
      currentChanged: current.changed,
    };
  }

  async readCatalog(profile, catalogHash) {
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
    storedSchema(() => validateCatalog(catalog, { profile }), 'catalog.json');
    storedSchema(
      () => validateBootstrap(bootstrap, { profile, promptFiles }),
      'bootstrap/scout.json',
    );
    storedSchema(
      () => this._validateMachineRouteReferences(bootstrap, catalog, 'Bootstrap'),
      'bootstrap/scout.json',
    );
    await this._verifyCatalogRouteReferences(profile, catalog, { catalogIntegrity: true });
    return {
      catalogHash,
      catalog,
      bootstrap,
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
  async listCatalogRevisions(profile) {
    assertProfileId(profile);
    let revisionsDir;
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
    const revisions = [];
    for (const entry of await fs.readdir(revisionsDir, { withFileTypes: true })) {
      // Каталоги .tmp-* — след незавершённой публикации, ревизиями они не являются.
      if (!entry.isDirectory() || !ROUTES_V2_HASH_RE.test(entry.name)) continue;
      const bundleDir = path.join(revisionsDir, entry.name);
      const info = await fs.stat(bundleDir);
      const revision = {
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
        storedSchema(() => validateCatalog(catalog, { profile }), 'catalog.json');
        revision.routes = catalog.routes;
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

  async _readCurrentPointer(profile) {
    const catalogDir = path.join(this.baseDir, profile, 'catalog');
    const currentPath = path.join(catalogDir, CURRENT_FILE);
    let info;
    try {
      info = await fs.lstat(currentPath);
    } catch (cause) {
      if (cause?.code === 'ENOENT') return null;
      throw cause;
    }
    if (info.isSymbolicLink() || !info.isFile()) {
      throw storeError('ROUTES_V2_TAMPERED', 'current.json подменён', { file: currentPath });
    }
    const bytes = await fs.readFile(currentPath);
    const pointer = parseCanonicalJson(bytes, CURRENT_FILE);
    if (
      !isObject(pointer)
      || Object.keys(pointer).length !== 2
      || pointer.schema !== 2
      || !Object.hasOwn(pointer, 'catalogHash')
    ) {
      throw storeError('ROUTES_V2_TAMPERED', 'current.json имеет неверный формат');
    }
    storedSchema(
      () => assertRevisionHash(pointer.catalogHash, 'current.catalogHash'),
      CURRENT_FILE,
    );
    return pointer;
  }

  async _withCurrentLock(profile, operation) {
    const catalogDir = await this._ensureDirectory([profile, 'catalog']);
    const lockPath = path.join(catalogDir, CURRENT_LOCK);
    try {
      const info = await fs.lstat(lockPath);
      if (info.isSymbolicLink() || !info.isFile()) {
        throw storeError('ROUTES_V2_TAMPERED', 'CAS lock подменён', { file: lockPath });
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
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
      const result = await operation(catalogDir);
      held.assertHeld();
      return result;
    } finally {
      await held.release();
    }
  }

  async _compareAndSwapCurrent(profile, desiredHash, expectedHash) {
    return this._withCurrentLock(profile, async (catalogDir) => {
      const current = await this._readCurrentPointer(profile);
      const currentHash = current?.catalogHash ?? null;

      // Повтор запроса после потерянного HTTP-ответа безопасен: желаемое состояние уже
      // достигнуто, даже если expected у повторного запроса теперь выглядит устаревшим.
      if (currentHash === desiredHash) return { changed: false, catalogHash: desiredHash };
      if (currentHash !== expectedHash) {
        throw storeError(
          'ROUTES_V2_STALE_REVISION',
          'current catalog изменился после начала редактирования',
          { expectedCatalogHash: expectedHash, currentCatalogHash: currentHash, desiredHash },
        );
      }

      const pointer = Buffer.from(serializeRoutesJson({
        schema: 2,
        catalogHash: desiredHash,
      }));
      const temporary = path.join(
        catalogDir,
        `${CURRENT_FILE}.${process.pid}.${randomUUID()}.tmp`,
      );
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
    });
  }

  /**
   * Публичный CAS нужен для отката current на уже опубликованный catalog bundle.
   */
  async compareAndSwapCurrent(
    profile,
    desiredCatalogHash,
    { expectedCatalogHash } = {},
  ) {
    assertProfileId(profile);
    assertRevisionHash(desiredCatalogHash, 'desiredCatalogHash');
    if (expectedCatalogHash !== null) {
      assertRevisionHash(expectedCatalogHash, 'expectedCatalogHash');
    }
    await this.readCatalog(profile, desiredCatalogHash);
    return this._compareAndSwapCurrent(profile, desiredCatalogHash, expectedCatalogHash);
  }

  async readCurrent(profile) {
    assertProfileId(profile);
    try {
      await this._existingDirectory([profile, 'catalog']);
    } catch (error) {
      if (error?.code === 'ROUTES_V2_NOT_FOUND') return null;
      throw error;
    }
    const pointer = await this._readCurrentPointer(profile);
    if (!pointer) return null;
    return this.readCatalog(profile, pointer.catalogHash);
  }
}
