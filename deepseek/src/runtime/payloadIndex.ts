import { createHash } from 'node:crypto';

import { Unzip, UnzipInflate } from 'fflate';

import { contractDecoders } from '../../../shared/lib/contractDecoders.ts';

export type PayloadEntry = {
  path: string;
  mode: number;
} & (
  | {
    type: 'file';
    size: number;
    sha256: string;
  }
  | { type: 'dir' }
  | { type: 'link'; target: string }
);

export interface PayloadDescriptor {
  entries: PayloadEntry[];
  sha256: string;
  size: number;
}

export interface PayloadSink {
  write(bytes: Uint8Array): void;
  close(): void;
  abort(): void;
}

/**
 * Ошибка архива не раскрывает исходные пути сборки или сырые filesystem details.
 * Один код используется до распаковки и при нарушении индекса во время чтения ZIP.
 */
export function invalidPayload(): never {
  throw Object.assign(new Error('Индекс или архив поставки DeepSeek повреждён'), {
    code: 'deepseek_payload_invalid',
  });
}

const decode = contractDecoders(invalidPayload);
const hashPattern = /^[a-f0-9]{64}$/u;

/**
 * Пути индекса канонические и относительные; нормализация не скрывает дубль или traversal.
 * Backslash запрещён независимо от платформы, NUL не доходит до файлового API.
 */
function entryPath(value: unknown): string {
  const name = decode.text(value, 'path');

  if (name.includes('\0') || name.includes('\\') || name.split('/').some(
    (part) => part === '' || part === '.' || part === '..',
  )) {
    invalidPayload();
  }

  return name;
}

/**
 * Декодер закрывает набор типов, mode и размер, не доверяя приведению JSON к интерфейсу.
 * Дополнительные поля не участвуют в файловых эффектах.
 */
function decodeEntry(value: unknown): PayloadEntry {
  const source = decode.record(value, 'entry');
  const name = entryPath(source.path);
  const mode = decode.wholeNumber(source.mode, 'mode');
  const type = decode.oneOf('file', 'dir', 'link')(source.type, 'type');

  if (mode > 0o777) {
    invalidPayload();
  }

  if (type === 'file') {
    const size = decode.wholeNumber(source.size, 'size');
    const sha256 = decode.text(source.sha256, 'sha256');

    if (!hashPattern.test(sha256)) {
      invalidPayload();
    }

    return {
      path: name,
      type,
      mode,
      size,
      sha256,
    };
  }

  if (type === 'link') {
    const target = decode.text(source.target, 'target');

    if (!target || target.startsWith('/') || target.includes('\0') || target.includes('\\')) {
      invalidPayload();
    }

    return {
      path: name,
      type,
      mode,
      target,
    };
  }

  return {
    path: name,
    type,
    mode,
  };
}

/**
 * Цепочка разрешается по компонентам: '..' после symlink применяется к его настоящей цели.
 * Каждый промежуточный каталог есть в индексе, цикл и выход за корень запрещены.
 */
function resolveLink(
  parts: string[],
  entries: Map<string, PayloadEntry>,
  visited = new Set<string>(),
): string {
  const current: string[] = [];

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!;

    if (part === '' || part === '.') {
      continue;
    }

    if (part === '..') {
      if (current.length === 0) {
        invalidPayload();
      }

      current.pop();
      continue;
    }

    current.push(part);

    const name = current.join('/');
    const entry = entries.get(name);

    if (!entry) {
      invalidPayload();
    }

    if (entry.type === 'link') {
      if (visited.has(name)) {
        invalidPayload();
      }

      visited.add(name);

      return resolveLink([
        ...current.slice(0, -1),
        ...entry.target.split('/'),
        ...parts.slice(index + 1),
      ], entries, visited);
    }

    if (index < parts.length - 1 && entry.type !== 'dir') {
      invalidPayload();
    }
  }

  const name = current.join('/');

  if (!entries.has(name)) {
    invalidPayload();
  }

  return name;
}

/**
 * Индекс проверяется целиком до первого файлового эффекта: дубли и родители недопустимы.
 * Запись через symlink запрещена, а сами относительные links остаются внутри payload.
 */
export function decodePayloadIndex(value: unknown): PayloadEntry[] {
  const list = decode.listOf(decodeEntry)(value, 'entries');
  const entries = new Map<string, PayloadEntry>();

  for (const entry of list) {
    if (entries.has(entry.path)) {
      invalidPayload();
    }

    entries.set(entry.path, entry);
  }

  for (const entry of list) {
    const parts = entry.path.split('/');

    for (let length = 1; length < parts.length; length += 1) {
      if (entries.get(parts.slice(0, length).join('/'))?.type !== 'dir') {
        invalidPayload();
      }
    }

    if (entry.type === 'link') {
      resolveLink([...parts.slice(0, -1), ...entry.target.split('/')], entries);
    }
  }

  return list;
}

/**
 * Описание связывает индекс с полными байтами ZIP, включая его окончание.
 * Truncated archive не считается готовым только потому, что первый файл распакован.
 */
export function decodePayloadDescriptor(value: unknown): PayloadDescriptor {
  const source = decode.record(value, 'payload');
  const sha256 = decode.text(source.sha256, 'sha256');
  const size = decode.wholeNumber(source.size, 'size');

  if (!hashPattern.test(sha256) || size < 22) {
    invalidPayload();
  }

  return {
    entries: decodePayloadIndex(source.entries),
    sha256,
    size,
  };
}

/**
 * Потоковое чтение принимает только индексированные файлы, проверяет размер и SHA каждого.
 * Sink нужен распаковщику; без него та же функция проверяет архив без файловых эффектов.
 */
export async function consumePayloadArchive(
  chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  description: PayloadDescriptor,
  open?: (entry: PayloadEntry & { type: 'file' }) => PayloadSink,
): Promise<void> {
  const payload = decodePayloadDescriptor(description);
  const entries = new Map(payload.entries.map((entry) => [entry.path, entry]));
  const seen = new Set<string>();
  const complete = new Set<string>();
  const active = new Set<PayloadSink>();
  const archiveHash = createHash('sha256');
  let archiveSize = 0;
  const unzip = new Unzip((file) => {
    const entry = entries.get(file.name);

    if (!entry || entry.type !== 'file' || seen.has(file.name)) {
      invalidPayload();
    }

    seen.add(file.name);

    const sink = open?.(entry);
    const hash = createHash('sha256');
    let size = 0;

    if (sink) {
      active.add(sink);
    }

    file.ondata = (error, bytes, final) => {
      if (error) {
        if (typeof error.code === 'number') {
          invalidPayload();
        }

        throw error;
      }

      size += bytes.length;

      if (size > entry.size) {
        invalidPayload();
      }

      hash.update(bytes);
      sink?.write(bytes);

      if (final) {
        if (size !== entry.size || hash.digest('hex') !== entry.sha256) {
          invalidPayload();
        }

        sink?.close();

        if (sink) {
          active.delete(sink);
        }

        complete.add(entry.path);
      }
    };
    file.start();
  });

  unzip.register(UnzipInflate);

  try {
    for await (const bytes of chunks) {
      archiveSize += bytes.length;

      if (archiveSize > payload.size) {
        invalidPayload();
      }

      archiveHash.update(bytes);
      unzip.push(bytes, false);
    }

    unzip.push(new Uint8Array(), true);

    if (archiveSize !== payload.size || archiveHash.digest('hex') !== payload.sha256
      || complete.size !== payload.entries.filter((entry) => entry.type === 'file').length) {
      invalidPayload();
    }
  } catch (error) {
    for (const sink of active) {
      sink.abort();
    }

    if (typeof (error as { code?: unknown }).code === 'number') {
      invalidPayload();
    }

    throw error;
  }
}
