// Read-only ядро предпросмотра документов. Оно не знает ни о чатах, ни о Vue, ни о
// плагинах: вызывающая сборка передаёт поставщиков разрешённых корней, HTTP-модуль
// превращает результат в API. Содержимое нигде не сохраняется и не индексируется.
import { constants as FS, promises as fs } from 'node:fs';
import type { BigIntStats, Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';

// Разрешённый корень: стабильный id ссылки, подпись для человека и канонический путь.
export interface DocumentRoot {
  id: string;
  label: string;
  path: string;
}

// Поставщик корней: сборка приложения объявляет, откуда вообще можно читать.
export type DocumentRootProvider = () => Promise<unknown> | unknown;

// Поставщик корней области: отдаёт папки одного владельца (например, одного чата)
// по его id. Такие корни видны только ссылкам, которые назвали эту область.
export type DocumentScopeProvider = (scopeId: string) => Promise<unknown> | unknown;

// Ссылка на документ. Приходит из запроса, поэтому оба поля недоверенные.
export interface DocumentRef {
  source?: unknown;
  path?: unknown;
}

// Снимок файла по открытому дескриптору. `bigint: true` даёт bigint-поля, поэтому
// сравнения ниже допускают обе формы.
type FileSnapshot = Stats | BigIntStats;

const ALLOWED_EXTENSIONS = new Map([
  ['.md', 'markdown'],
  ['.markdown', 'markdown'],
  ['.txt', 'text'],
]);
const ALLOWED_ASSET_EXTENSIONS = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
]);

// Область — `вид:id`, источник её корня — `вид:id:номер`. Номер — позиция в ответе
// поставщика, поэтому исчезнувшая папка не сдвигает ссылки на соседние.
const SCOPE_RE = /^([a-z][a-z0-9-]{0,31}):([A-Za-z0-9_-]{1,128})$/;
const SCOPED_SOURCE_RE = /^([a-z][a-z0-9-]{0,31}:[A-Za-z0-9_-]{1,128}):\d{1,4}$/;

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_ASSET_BYTES = 5_000_000;
const READ_CHUNK_BYTES = 64 * 1024;

export class DocumentReadError extends Error {
  readonly code: string;

  readonly statusCode: number;

  constructor(code: string, message: string, statusCode: number, cause: unknown = null) {
    super(message, cause ? { cause } : undefined);
    this.name = 'DocumentReadError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

// Объявленный `never` не украшение: после `fail(...)` сужение продолжается, и
// проверенные выше `source`/`format` не приходится страховать второй раз.
function fail(code: string, message: string, statusCode: number): never {
  throw new DocumentReadError(code, message, statusCode);
}

function isInside(root: string, target: string) {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function assertMostSpecificOwner(roots: DocumentRoot[], source: DocumentRoot, target: string) {
  // roots() уже отсортирован от самого узкого пути к широкому. DocumentRef не
  // имеет права назвать внешний source для файла, которым владеет вложенный root:
  // иначе policy/label/project authority зависели бы от подменённого source id.
  const owner = roots.find((root) => isInside(root.path, target));
  if (!owner || owner.id !== source.id || owner.path !== source.path) {
    fail('document_source_mismatch', 'Документ принадлежит другому источнику', 403);
  }
  return owner;
}

function formatOf(filePath: string) {
  return ALLOWED_EXTENSIONS.get(path.extname(filePath).toLowerCase()) || '';
}

function assetTypeOf(filePath: string) {
  return ALLOWED_ASSET_EXTENSIONS.get(path.extname(filePath).toLowerCase()) || '';
}

function byteLimit(value: unknown, fallback: number, { ceiling = Number.MAX_SAFE_INTEGER }: {
  ceiling?: number;
} = {}) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, ceiling);
}

function snapshotSize(stat: FileSnapshot | null | undefined) {
  const size = Number(stat?.size);
  if (!Number.isSafeInteger(size) || size < 0) {
    fail('document_unsafe_file', 'Не удалось подтвердить размер обычного файла', 403);
  }
  return size;
}

function snapshotRevision(stat: FileSnapshot | null | undefined, nanoseconds: string, milliseconds: string) {
  // Поля наносекунд есть только у bigint-формы, и объявлены они порознь: читаем
  // снимок как словарь, чтобы одно правило работало для обеих форм.
  const record = stat as unknown as Record<string, unknown> | null | undefined;
  return record?.[nanoseconds] ?? record?.[milliseconds];
}

function sameSnapshot(before: FileSnapshot | null | undefined, after: FileSnapshot | null | undefined) {
  return before?.dev === after?.dev
    && before?.ino === after?.ino
    && before?.mode === after?.mode
    && before?.nlink === after?.nlink
    && before?.size === after?.size
    && snapshotRevision(before, 'mtimeNs', 'mtimeMs') === snapshotRevision(after, 'mtimeNs', 'mtimeMs')
    && snapshotRevision(before, 'ctimeNs', 'ctimeMs') === snapshotRevision(after, 'ctimeNs', 'ctimeMs');
}

function assertInitialSnapshot(stat: FileSnapshot | null | undefined, maxBytes: number, kind: string) {
  if (!stat?.isFile?.()) fail('document_not_file', 'Путь не является обычным файлом', 415);
  if (stat.nlink !== 1 && stat.nlink !== 1n) {
    fail('document_unsafe_file', 'Файл с несколькими жёсткими ссылками запрещён', 403);
  }
  const size = snapshotSize(stat);
  if (size > maxBytes) {
    const label = kind === 'asset' ? 'Изображение' : 'Документ';
    fail('document_too_large', `${label} больше ${maxBytes} байт`, 413);
  }
  return size;
}

function assertStableSnapshot(
  before: FileSnapshot | null | undefined,
  after: FileSnapshot | null | undefined,
  bytesRead: number,
) {
  const afterSize = snapshotSize(after);
  if (!after?.isFile?.() || (after.nlink !== 1 && after.nlink !== 1n)
      || !sameSnapshot(before, after) || bytesRead !== afterSize) {
    fail('document_changed', 'Файл изменился во время чтения', 409);
  }
}

async function canonicalDirectory(value: unknown): Promise<DocumentRoot | null> {
  const entry = value as { id?: unknown; label?: unknown; path?: unknown } | null;
  const raw = String(entry?.path || '');
  if (!raw || !path.isAbsolute(raw)) return null;
  try {
    const canonical = await fs.realpath(raw);
    const stat = await fs.stat(canonical);
    if (!stat.isDirectory()) return null;
    return {
      id: String(entry?.id || path.basename(canonical) || 'root'),
      label: String(entry?.label || entry?.id || path.basename(canonical) || 'Документы'),
      path: canonical,
    };
  } catch {
    // Исчезнувший или недоступный корень не расширяет область доступа.
    return null;
  }
}

async function readLimited(handle: FileHandle, maxBytes: number) {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= maxBytes) {
    const room = maxBytes + 1 - total;
    const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, room));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
    if (!bytesRead) break;
    chunks.push(chunk.subarray(0, bytesRead));
    total += bytesRead;
  }
  if (total > maxBytes) {
    fail('document_too_large', `Документ больше ${maxBytes} байт`, 413);
  }
  return Buffer.concat(chunks, total);
}

function publicReadError(value: unknown) {
  if (value instanceof DocumentReadError) return value;
  const error = value as { code?: unknown } | null;
  if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
    return new DocumentReadError('document_not_found', 'Документ не найден', 404);
  }
  if (error?.code === 'EACCES' || error?.code === 'EPERM') {
    return new DocumentReadError('document_unreadable', 'Нет доступа к документу', 403);
  }
  if (error?.code === 'ELOOP') {
    return new DocumentReadError('document_unsafe_path', 'Небезопасный путь к документу', 403);
  }
  return new DocumentReadError(
    'document_read_failed',
    'Не удалось безопасно прочитать документ',
    500,
    value,
  );
}

export class DocumentReader {
  private readonly rootProviders: DocumentRootProvider[];

  private readonly scopeProviders = new Map<string, DocumentScopeProvider>();

  readonly maxBytes: number;

  readonly maxAssetBytes: number;

  private readonly resolveOpenedPath: (handle: FileHandle) => Promise<string>;

  private readonly statOpenedFile: (handle: FileHandle) => Promise<FileSnapshot>;

  constructor({
    rootProviders = [],
    maxBytes = DEFAULT_MAX_BYTES,
    maxAssetBytes = DEFAULT_MAX_ASSET_BYTES,
    deps = {},
  }: {
    rootProviders?: readonly DocumentRootProvider[];
    maxBytes?: unknown;
    maxAssetBytes?: unknown;
    deps?: {
      resolveOpenedPath?: (handle: FileHandle) => Promise<string>;
      statOpenedFile?: (handle: FileHandle) => Promise<FileSnapshot>;
    };
  } = {}) {
    this.rootProviders = [...rootProviders];
    // 16 MiB — общий верхний предел generic text adapter. Конкретный consumer может
    // только сузить его; поднять границу через конфигурацию нельзя.
    this.maxBytes = byteLimit(maxBytes, DEFAULT_MAX_BYTES, { ceiling: DEFAULT_MAX_BYTES });
    this.maxAssetBytes = byteLimit(maxAssetBytes, DEFAULT_MAX_ASSET_BYTES);
    this.resolveOpenedPath = deps.resolveOpenedPath
      || ((handle) => fs.realpath(`/proc/self/fd/${handle.fd}`));
    this.statOpenedFile = deps.statOpenedFile
      || ((handle) => handle.stat({ bigint: true }));
    if (typeof this.resolveOpenedPath !== 'function' || typeof this.statOpenedFile !== 'function') {
      throw new TypeError('document reader deps must be functions');
    }
  }

  async verifiedOpenedPath(handle: FileHandle, sourceRoot: string, expectedPath: string) {
    let openedPath: unknown;
    try {
      openedPath = await this.resolveOpenedPath(handle);
    } catch {
      fail('document_unsafe_path', 'Не удалось подтвердить путь открытого файла', 403);
    }
    if (typeof openedPath !== 'string' || !path.isAbsolute(openedPath)
        || openedPath !== expectedPath || !isInside(sourceRoot, openedPath)) {
      fail('document_unsafe_path', 'Путь изменился во время открытия', 403);
    }
    return openedPath;
  }

  /** Зарегистрировать ещё один источник корней на этапе сборки приложения. */
  addRootProvider(provider: DocumentRootProvider) {
    if (typeof provider !== 'function') throw new TypeError('document root provider must be a function');
    this.rootProviders.push(provider);
    return this;
  }

  /**
   * Зарегистрировать поставщика корней области `kind`. Корни области не попадают в общий
   * список: их видит только запрос, который явно назвал область (`kind:id`).
   */
  addScopeProvider(kind: string, provider: DocumentScopeProvider) {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(kind)) {
      throw new TypeError('document scope kind is invalid');
    }
    if (typeof provider !== 'function') {
      throw new TypeError('document scope provider must be a function');
    }
    if (this.scopeProviders.has(kind)) {
      throw new TypeError(`document scope ${kind} is already registered`);
    }

    this.scopeProviders.set(kind, provider);

    return this;
  }

  /**
   * Общие корни плюс корни названной области. Общий корень с тем же путём побеждает:
   * один каталог не получает двух id, а документ Cockpit остаётся ссылкой `cockpit`.
   */
  async roots(scope: unknown = ''): Promise<DocumentRoot[]> {
    const declared: unknown[] = [];
    for (const provider of this.rootProviders) {
      const entries = await provider();
      if (Array.isArray(entries)) declared.push(...entries);
    }
    const canonical = (await Promise.all(declared.map(canonicalDirectory)))
      .filter((root): root is DocumentRoot => Boolean(root));
    const roots: DocumentRoot[] = [];
    const byId = new Map<string, DocumentRoot>();
    const byPath = new Map<string, DocumentRoot>();
    for (const root of canonical) {
      const sameId = byId.get(root.id);
      const samePath = byPath.get(root.path);
      // DocumentRef содержит только source + path. Два разных корня с одним id (или
      // один root с разными id) сделали бы ссылку зависимой от порядка providers.
      // Композиционная ошибка не должна молча расширять область чтения.
      if ((sameId && sameId.path !== root.path) || (samePath && samePath.id !== root.id)) {
        fail('document_source_conflict', 'Конфликт конфигурации источников документов', 500);
      }
      if (sameId || samePath) continue; // точное повторное объявление безопасно и идемпотентно
      byId.set(root.id, root);
      byPath.set(root.path, root);
      roots.push(root);
    }
    for (const root of await this.scopeRoots(scope)) {
      if (byPath.has(root.path)) {
        continue;
      }

      byPath.set(root.path, root);
      roots.push(root);
    }
    // Самый узкий корень владеет документом при вложенных источниках.
    return roots.sort((a, b) => b.path.length - a.path.length);
  }

  /**
   * Канонические корни одной области с id `вид:id:номер`. Неизвестная или пустая область
   * ничего не добавляет: отказ поставщика не расширяет и не ломает общий список.
   */
  private async scopeRoots(scope: unknown): Promise<DocumentRoot[]> {
    const match = SCOPE_RE.exec(String(scope || ''));
    const [name = '', kind = '', scopeId = ''] = match || [];
    const provider = this.scopeProviders.get(kind);

    if (!name || !provider) {
      return [];
    }

    let entries: unknown;

    try {
      entries = await provider(scopeId);
    } catch {
      return [];
    }

    if (!Array.isArray(entries)) {
      return [];
    }

    const roots = await Promise.all(entries.map((entry, index) => {
      const declared = entry as { label?: unknown; path?: unknown } | null;

      return canonicalDirectory({
        id: `${name}:${index}`,
        label: String(declared?.label || ''),
        path: declared?.path,
      });
    }));
    const seen = new Set<string>();

    return roots.filter((root): root is DocumentRoot => {
      if (!root || seen.has(root.path)) {
        return false;
      }

      seen.add(root.path);

      return true;
    });
  }

  /**
   * Превратить старую абсолютную ссылку агента в стабильный DocumentRef. Этот метод
   * не читает содержимое; HTTP использует его только на входе bridge-route.
   * `scope` добавляет к общим корням папки названной области (`chat:<id>`).
   */
  async resolveAbsolute(inputPath: unknown, scope: unknown = '') {
    const requested = String(inputPath || '');
    if (!requested || requested.includes('\0') || !path.isAbsolute(requested)) {
      fail('document_bad_path', 'Нужен абсолютный путь к документу', 400);
    }
    if (!formatOf(requested)) {
      fail('document_type_not_allowed', 'Можно просматривать только .md, .markdown и .txt', 415);
    }

    let canonical: string;
    try {
      canonical = await fs.realpath(requested);
    } catch (error) {
      throw publicReadError(error);
    }
    const format = formatOf(canonical);
    if (!format) {
      fail('document_type_not_allowed', 'Целевой файл имеет неподдерживаемый тип', 415);
    }

    const roots = await this.roots(scope);
    const source = roots.find((root) => isInside(root.path, canonical));
    if (!source) {
      fail('document_outside_roots', 'Документ находится вне разрешённых корней', 403);
    }
    const relativePath = path.relative(source.path, canonical);
    return {
      ref: { source: source.id, path: relativePath },
      name: path.basename(canonical),
      format,
      source: { id: source.id, label: source.label },
    };
  }

  async read(documentRef: DocumentRef | null | undefined) {
    const sourceId = String(documentRef?.source || '');
    const relativePath = String(documentRef?.path || '');
    if (!sourceId || !relativePath || relativePath.includes('\0') || path.isAbsolute(relativePath)) {
      fail('document_bad_ref', 'Некорректная ссылка на документ', 400);
    }
    if (!formatOf(relativePath)) {
      fail('document_type_not_allowed', 'Можно просматривать только .md, .markdown и .txt', 415);
    }

    const roots = await this.roots(SCOPED_SOURCE_RE.exec(sourceId)?.[1] || '');
    const source = roots.find((root) => root.id === sourceId);
    if (!source) fail('document_unknown_source', 'Источник документов не найден', 404);
    const candidate = path.resolve(source.path, relativePath);
    if (!isInside(source.path, candidate)) {
      fail('document_outside_roots', 'Документ находится вне разрешённого корня', 403);
    }
    let canonical: string;
    try { canonical = await fs.realpath(candidate); }
    catch (error) { throw publicReadError(error); }
    if (!isInside(source.path, canonical)) {
      fail('document_outside_roots', 'Документ находится вне разрешённого корня', 403);
    }
    assertMostSpecificOwner(roots, source, canonical);
    const format = formatOf(canonical);
    if (!format) fail('document_type_not_allowed', 'Целевой файл имеет неподдерживаемый тип', 415);

    let handle: FileHandle | undefined;
    try {
      // O_NOFOLLOW закрывает подмену последнего компонента после realpath, O_NONBLOCK
      // не даёт зависнуть на подложенном FIFO. После open границу проверяем повторно
      // по fd — это ловит и подмену родительского symlink между realpath и open.
      const flags = FS.O_RDONLY | (FS.O_NOFOLLOW || 0) | (FS.O_NONBLOCK || 0);
      handle = await fs.open(canonical, flags);
      const stat = await this.statOpenedFile(handle);
      assertInitialSnapshot(stat, this.maxBytes, 'document');
      const openedPath = await this.verifiedOpenedPath(handle, source.path, canonical);
      assertMostSpecificOwner(roots, source, openedPath);

      const buffer = await readLimited(handle, this.maxBytes);
      const after = await this.statOpenedFile(handle);
      assertStableSnapshot(stat, after, buffer.length);
      assertMostSpecificOwner(
        roots,
        source,
        await this.verifiedOpenedPath(handle, source.path, canonical),
      );
      if (buffer.includes(0)) fail('document_binary', 'Бинарные файлы не поддерживаются', 415);
      let content: string;
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
      catch { fail('document_encoding', 'Документ должен быть в UTF-8', 415); }
      if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);

      return {
        ref: { source: source.id, path: path.relative(source.path, openedPath) },
        name: path.basename(openedPath),
        displayPath: path.relative(source.path, openedPath) || path.basename(openedPath),
        format,
        size: buffer.length,
        modifiedAt: stat.mtime.toISOString(),
        source: { id: source.id, label: source.label },
        content,
      };
    } catch (error) {
      throw publicReadError(error);
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  /** Картинки Markdown читаются по тем же границам source/realpath, но как Buffer. */
  async readAsset(documentRef: DocumentRef | null | undefined) {
    const sourceId = String(documentRef?.source || '');
    const relativePath = String(documentRef?.path || '');
    if (!sourceId || !relativePath || relativePath.includes('\0') || path.isAbsolute(relativePath)) {
      fail('document_bad_ref', 'Некорректная ссылка на изображение', 400);
    }
    if (!assetTypeOf(relativePath)) {
      fail('document_asset_type_not_allowed', 'Поддерживаются PNG, JPEG, GIF и WebP', 415);
    }

    const roots = await this.roots(SCOPED_SOURCE_RE.exec(sourceId)?.[1] || '');
    const source = roots.find((root) => root.id === sourceId);
    if (!source) fail('document_unknown_source', 'Источник документов не найден', 404);
    const candidate = path.resolve(source.path, relativePath);
    if (!isInside(source.path, candidate)) {
      fail('document_outside_roots', 'Изображение находится вне разрешённого корня', 403);
    }
    let canonical: string;
    try { canonical = await fs.realpath(candidate); }
    catch (error) { throw publicReadError(error); }
    if (!isInside(source.path, canonical)) {
      fail('document_outside_roots', 'Изображение находится вне разрешённого корня', 403);
    }
    assertMostSpecificOwner(roots, source, canonical);
    const contentType = assetTypeOf(canonical);
    if (!contentType) fail('document_asset_type_not_allowed', 'Целевой файл имеет неподдерживаемый тип', 415);

    let handle: FileHandle | undefined;
    try {
      const flags = FS.O_RDONLY | (FS.O_NOFOLLOW || 0) | (FS.O_NONBLOCK || 0);
      handle = await fs.open(canonical, flags);
      const stat = await this.statOpenedFile(handle);
      assertInitialSnapshot(stat, this.maxAssetBytes, 'asset');
      assertMostSpecificOwner(
        roots,
        source,
        await this.verifiedOpenedPath(handle, source.path, canonical),
      );
      const content = await readLimited(handle, this.maxAssetBytes);
      const after = await this.statOpenedFile(handle);
      assertStableSnapshot(stat, after, content.length);
      assertMostSpecificOwner(
        roots,
        source,
        await this.verifiedOpenedPath(handle, source.path, canonical),
      );
      return { content, contentType, size: content.length, modifiedAt: stat.mtime.toISOString() };
    } catch (error) {
      throw publicReadError(error);
    } finally {
      await handle?.close().catch(() => {});
    }
  }
}
