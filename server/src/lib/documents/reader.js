// Read-only ядро предпросмотра документов. Оно не знает ни о чатах, ни о Vue, ни о
// плагинах: вызывающая сборка передаёт поставщиков разрешённых корней, HTTP-модуль
// превращает результат в API. Содержимое нигде не сохраняется и не индексируется.
import { constants as FS, promises as fs } from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';

const ALLOWED_EXTENSIONS = new Map([
  ['.md', 'markdown'],
  ['.markdown', 'markdown'],
  ['.txt', 'text'],
]);

const DEFAULT_MAX_BYTES = 1_500_000;
const READ_CHUNK_BYTES = 64 * 1024;

export class DocumentReadError extends Error {
  constructor(code, message, statusCode) {
    super(message);
    this.name = 'DocumentReadError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function fail(code, message, statusCode) {
  throw new DocumentReadError(code, message, statusCode);
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function formatOf(filePath) {
  return ALLOWED_EXTENSIONS.get(path.extname(filePath).toLowerCase()) || '';
}

async function canonicalDirectory(entry) {
  const raw = String(entry?.path || '');
  if (!raw || !path.isAbsolute(raw)) return null;
  try {
    const canonical = await fs.realpath(raw);
    const stat = await fs.stat(canonical);
    if (!stat.isDirectory()) return null;
    return {
      id: String(entry.id || path.basename(canonical) || 'root'),
      label: String(entry.label || entry.id || path.basename(canonical) || 'Документы'),
      path: canonical,
    };
  } catch {
    // Исчезнувший или недоступный корень не расширяет область доступа.
    return null;
  }
}

async function readLimited(handle, maxBytes) {
  const chunks = [];
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

function publicReadError(error) {
  if (error instanceof DocumentReadError) return error;
  if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
    return new DocumentReadError('document_not_found', 'Документ не найден', 404);
  }
  if (error?.code === 'EACCES' || error?.code === 'EPERM') {
    return new DocumentReadError('document_unreadable', 'Нет доступа к документу', 403);
  }
  if (error?.code === 'ELOOP') {
    return new DocumentReadError('document_unsafe_path', 'Небезопасный путь к документу', 403);
  }
  return error;
}

export class DocumentReader {
  constructor({ rootProviders = [], maxBytes = DEFAULT_MAX_BYTES } = {}) {
    this.rootProviders = [...rootProviders];
    this.maxBytes = Math.max(1, Number(maxBytes) || DEFAULT_MAX_BYTES);
  }

  /** Зарегистрировать ещё один источник корней на этапе сборки приложения. */
  addRootProvider(provider) {
    if (typeof provider !== 'function') throw new TypeError('document root provider must be a function');
    this.rootProviders.push(provider);
    return this;
  }

  async roots() {
    const declared = [];
    for (const provider of this.rootProviders) {
      const entries = await provider();
      if (Array.isArray(entries)) declared.push(...entries);
    }
    const canonical = (await Promise.all(declared.map(canonicalDirectory))).filter(Boolean);
    const roots = [];
    const byId = new Map();
    const byPath = new Map();
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
    // Самый узкий корень владеет документом при вложенных источниках.
    return roots.sort((a, b) => b.path.length - a.path.length);
  }

  /**
   * Превратить старую абсолютную ссылку агента в стабильный DocumentRef. Этот метод
   * не читает содержимое; HTTP использует его только на входе bridge-route.
   */
  async resolveAbsolute(inputPath) {
    const requested = String(inputPath || '');
    if (!requested || requested.includes('\0') || !path.isAbsolute(requested)) {
      fail('document_bad_path', 'Нужен абсолютный путь к документу', 400);
    }
    if (!formatOf(requested)) {
      fail('document_type_not_allowed', 'Можно просматривать только .md, .markdown и .txt', 415);
    }

    let canonical;
    try {
      canonical = await fs.realpath(requested);
    } catch (error) {
      throw publicReadError(error);
    }
    const format = formatOf(canonical);
    if (!format) {
      fail('document_type_not_allowed', 'Целевой файл имеет неподдерживаемый тип', 415);
    }

    const roots = await this.roots();
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

  async read(documentRef) {
    const sourceId = String(documentRef?.source || '');
    const relativePath = String(documentRef?.path || '');
    if (!sourceId || !relativePath || relativePath.includes('\0') || path.isAbsolute(relativePath)) {
      fail('document_bad_ref', 'Некорректная ссылка на документ', 400);
    }
    if (!formatOf(relativePath)) {
      fail('document_type_not_allowed', 'Можно просматривать только .md, .markdown и .txt', 415);
    }
    const roots = await this.roots();
    const source = roots.find((root) => root.id === sourceId);
    if (!source) fail('document_unknown_source', 'Источник документов не найден', 404);
    const candidate = path.resolve(source.path, relativePath);
    if (!isInside(source.path, candidate)) {
      fail('document_outside_roots', 'Документ находится вне разрешённого корня', 403);
    }
    let canonical;
    try { canonical = await fs.realpath(candidate); }
    catch (error) { throw publicReadError(error); }
    if (!isInside(source.path, canonical)) {
      fail('document_outside_roots', 'Документ находится вне разрешённого корня', 403);
    }
    const format = formatOf(canonical);
    if (!format) fail('document_type_not_allowed', 'Целевой файл имеет неподдерживаемый тип', 415);

    let handle;
    try {
      // O_NOFOLLOW закрывает подмену последнего компонента после realpath, O_NONBLOCK
      // не даёт зависнуть на подложенном FIFO. После open границу проверяем повторно
      // по fd — это ловит и подмену родительского symlink между realpath и open.
      const flags = FS.O_RDONLY | (FS.O_NOFOLLOW || 0) | (FS.O_NONBLOCK || 0);
      handle = await fs.open(canonical, flags);
      const stat = await handle.stat();
      if (!stat.isFile()) fail('document_not_file', 'Путь не является обычным файлом', 415);
      if (stat.size > this.maxBytes) {
        fail('document_too_large', `Документ больше ${this.maxBytes} байт`, 413);
      }

      let openedPath = canonical;
      try { openedPath = await fs.realpath(`/proc/self/fd/${handle.fd}`); } catch { /* не-Linux: остаётся повторная проверка canonical */ }
      if (!isInside(source.path, openedPath)) {
        fail('document_unsafe_path', 'Путь изменился во время открытия', 403);
      }

      const buffer = await readLimited(handle, this.maxBytes);
      if (buffer.includes(0)) fail('document_binary', 'Бинарные файлы не поддерживаются', 415);
      let content;
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
}
