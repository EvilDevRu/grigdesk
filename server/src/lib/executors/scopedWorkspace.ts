import { constants } from 'node:fs';
import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';

import { isRecord } from '../../../../shared/lib/objects.ts';
import type { WorkToolsPort } from './workIpc.ts';

export interface ScopedWorkspaceAccess {
  readableRoots: string[];
  writableRoots: string[];
  networkAccess?: boolean;
}

interface Descriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TEXT_LIMIT = 512 * 1024;
const IMAGE_LIMIT = 10 * 1024 * 1024;
const FILE_LIMIT = 2000;
const SKIPPED = new Set(['.git', 'node_modules', '__pycache__']);
const TOOL_ALIASES: Record<string, readonly string[]> = {
  read_file: ['Read'],
  read_image: ['Read'],
  list_files: ['Glob'],
  search_files: ['Grep'],
  write_file: ['Write', 'Edit'],
};

const fields = {
  path: { type: 'string', description: 'Абсолютный путь из разрешённой рабочей области.' },
};

function fileTool(
  name: string,
  description: string,
  properties: Record<string, unknown> = {},
  required: string[] = [],
): Descriptor {
  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      required: ['path', ...required],
      properties: { ...fields, ...properties },
      additionalProperties: false,
    },
  };
}

const descriptors: Descriptor[] = [
  fileTool('read_file',
    'Прочитать текст файла кода или входных данных. Возвращает строки с номерами.', {
      startLine: { type: 'integer', minimum: 1 },
      maxLines: {
        type: 'integer',
        minimum: 1,
        maximum: 1000,
      },
    }),
  fileTool('list_files',
    'Перечислить файлы каталога рекурсивно, без перехода по символическим ссылкам.'),
  fileTool('search_files',
    'Найти буквальный текст в файлах каталога; поиск учитывает регистр и ограничен по объёму.', {
      text: {
        type: 'string',
        minLength: 1,
        maxLength: 1000,
      },
    }, ['text']),
  fileTool('write_file',
    'Записать JSON оценки или заметку только в выделенный каталог результата триажа.', {
      content: { type: 'string', maxLength: 2 * 1024 * 1024 },
    }, ['content']),
  fileTool('read_image',
    'Открыть изображение из разрешённых файлов и вернуть его модели как изображение.'),
];

function inside(file: string, root: string): boolean {
  const relative = path.relative(root, file);

  return relative === '' || (!relative.startsWith(`..${path.sep}`)
    && relative !== '..' && !path.isAbsolute(relative));
}

/**
 * Корни поступают только от владельца запуска; отсутствующий или относительный путь закрывает запуск.
 * Модель не может расширить область чтения, записи или сетевого доступа аргументами инструмента.
 */
export async function resolveScopedWorkspace(value: unknown): Promise<ScopedWorkspaceAccess> {
  if (!isRecord(value) || value.networkAccess === true) {
    throw new Error('Некорректная изолированная область триажа.');
  }

  const roots = async (input: unknown): Promise<string[]> => {
    if (!Array.isArray(input)
      || input.some((entry) => typeof entry !== 'string' || !path.isAbsolute(entry))) {
      throw new Error('Корни триажа должны быть абсолютными каталогами.');
    }

    const canonical = await Promise.all(input.map(async (entry: string) => {
      const resolved = await fs.realpath(entry);

      if (!(await fs.stat(resolved)).isDirectory()) {
        throw new Error('Корень триажа не является каталогом.');
      }

      return resolved;
    }));

    return [...new Set(canonical)];
  };

  return {
    readableRoots: await roots(value.readableRoots),
    writableRoots: await roots(value.writableRoots),
    networkAccess: false,
  };
}

/**
 * Проверяем именно открытый inode до чтения; замена ссылки между realpath и open не раскрывает файл.
 * Дескриптор каталога закрепляет родителя при записи, а hardlink проверяется до truncate.
 */
async function checkedFile(file: string, roots: string[], write = false): Promise<FileHandle> {
  if (!path.isAbsolute(file) || file.includes('\0')) {
    throw new Error('scoped_path_denied');
  }

  const parentPath = await fs.realpath(path.dirname(file));
  const parent = await fs.open(parentPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);

  try {
    const anchoredParent = `/proc/self/fd/${parent.fd}`;
    const actualParent = await fs.realpath(anchoredParent);

    if (!roots.some((root) => inside(actualParent, root))) {
      throw new Error('scoped_path_denied');
    }

    const handle = await fs.open(path.join(anchoredParent, path.basename(file)),
      constants.O_NOFOLLOW | constants.O_NONBLOCK
        | (write ? constants.O_WRONLY | constants.O_CREAT : constants.O_RDONLY), 0o600);

    try {
      const actual = await fs.realpath(`/proc/self/fd/${handle.fd}`);
      const stat = await handle.stat();

      if (!stat.isFile() || !roots.some((root) => inside(actual, root)) || write && stat.nlink !== 1) {
        throw new Error('scoped_path_denied');
      }

      return handle;
    } catch (error) {
      await handle.close();

      throw error;
    }
  } finally {
    await parent.close();
  }
}

/**
 * Ограничение действует до выделения буфера; двоичные файлы не превращаются в мегабайты текста.
 * Чтение и поиск используют один и тот же проверенный файловый дескриптор.
 */
async function readBytes(file: string, roots: string[], limit: number): Promise<Buffer> {
  const handle = await checkedFile(file, roots);

  try {
    const size = (await handle.stat()).size;

    if (size > limit) {
      throw new Error('scoped_file_too_large');
    }

    const buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, size, 0);

    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Поиск не следует ссылкам и ограничивает количество посещённых записей и глубину обхода.
 * Каталоги проверяются повторно после canonicalization, включая каждое вложенное открытие.
 */
async function listFiles(directory: string, roots: string[], signal?: AbortSignal) {
  const files: string[] = [];
  let visited = 0;

  /**
   * Один каталог не расширяет разрешённые корни через ссылку или слишком глубокую вложенность.
   * Общий счётчик включает пропущенные записи, чтобы ограничение нельзя было обойти пустыми папками.
   */
  const visit = async (requested: string, depth: number): Promise<void> => {
    signal?.throwIfAborted();

    const current = await fs.realpath(requested);

    if (!roots.some((root) => inside(current, root)) || depth > 25 || visited >= FILE_LIMIT) {
      return;
    }

    const handle = await fs.open(current, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);

    try {
      const anchored = `/proc/self/fd/${handle.fd}`;
      const actual = await fs.realpath(anchored);

      if (!roots.some((root) => inside(actual, root))) {
        return;
      }

      const directoryHandle = await fs.opendir(anchored);

      for await (const entry of directoryHandle) {
        if (++visited > FILE_LIMIT) {
          break;
        }
        if (entry.isSymbolicLink() || SKIPPED.has(entry.name)) {
          continue;
        }

        const file = path.join(actual, entry.name);

        if (entry.isDirectory()) {
          await visit(file, depth + 1);
        } else if (entry.isFile()) {
          files.push(file);
        }
      }
    } finally {
      await handle.close();
    }
  };
  const root = await fs.realpath(directory);

  if (!roots.some((allowed) => inside(root, allowed))) {
    throw new Error('scoped_path_denied');
  }

  await visit(root, 0);

  return { files, truncated: visited >= FILE_LIMIT };
}

/**
 * Один серверный брокер обслуживает три исполнителя; собственные native tools им не нужны.
 * Внешние действия отсутствуют, а единственный дополнительный инструмент — bounded repo_history.
 */
export async function createScopedWorkspaceTools(
  value: unknown,
  extra?: WorkToolsPort | null,
  signal?: AbortSignal,
): Promise<WorkToolsPort & { descriptors: Descriptor[] }> {
  const scope = await resolveScopedWorkspace(value);
  const reads = [...new Set([...scope.readableRoots, ...scope.writableRoots])];
  const requested = isRecord(value) && Array.isArray(value.tools) ? new Set(value.tools) : null;
  const enabled = descriptors.filter((tool) => !requested || requested.has(tool.name)
    || TOOL_ALIASES[tool.name]?.some((name) => requested.has(name)));
  const history = Array.isArray(extra?.descriptors)
    ? extra.descriptors.filter((entry) => isRecord(entry) && entry.name === 'repo_history'
      && (!requested || requested.has(entry.name))) as Descriptor[]
    : [];
  const allowed = new Set([...enabled, ...history].map((tool) => tool.name));

  /**
   * Каждая операция повторно проверяет фактический путь перед файловым эффектом.
   * Ошибки не раскрывают закрытые пути и оставляют модели возможность уточнить допустимый запрос.
   */
  const invoke = async (name: string, input: Record<string, unknown>): Promise<unknown> => {
    signal?.throwIfAborted();

    try {
      if (!allowed.has(name)) {
        return { ok: false, error: 'tool_not_found' };
      }
      if (name === 'repo_history' && history.length && extra) {
        return await extra.invoke(name, input);
      }

      const file = typeof input.path === 'string' ? input.path : '';

      if (name === 'read_file') {
        const bytes = await readBytes(file, reads, TEXT_LIMIT);

        if (bytes.includes(0)) {
          throw new Error('scoped_binary_file');
        }

        const lines = bytes.toString('utf8').split('\n');
        const start = Math.max(1, Math.floor(Number(input.startLine) || 1));
        const count = Math.min(1000, Math.max(1, Math.floor(Number(input.maxLines) || 250)));

        return {
          ok: true,
          text: lines.slice(start - 1, start - 1 + count)
            .map((line, index) => `${start + index}: ${line}`).join('\n'),
          totalLines: lines.length,
        };
      }
      if (name === 'list_files') {
        const listing = await listFiles(file, reads, signal);

        return { ok: true, ...listing };
      }
      if (name === 'search_files') {
        if (typeof input.text !== 'string' || !input.text || input.text.length > 1000) {
          throw new Error('scoped_search_invalid');
        }

        const matches: Array<{
          path: string;
          line: number;
          text: string;
        }> = [];
        let scanned = 0;
        const listing = await listFiles(file, reads, signal);

        for (const candidate of listing.files) {
          signal?.throwIfAborted();

          if (scanned >= 8 * 1024 * 1024 || matches.length >= 100) {
            break;
          }

          const bytes = await readBytes(candidate, reads, TEXT_LIMIT).catch(() => null);

          if (!bytes || bytes.includes(0)) {
            continue;
          }

          scanned += bytes.length;

          const lines = bytes.toString('utf8').split('\n');

          for (let index = 0; index < lines.length && matches.length < 100; index += 1) {
            if (lines[index]!.includes(input.text)) {
              matches.push({
                path: candidate,
                line: index + 1,
                text: lines[index]!.slice(0, 500),
              });
            }
          }
        }

        return {
          ok: true,
          matches,
          truncated: listing.truncated || scanned >= 8 * 1024 * 1024 || matches.length >= 100,
        };
      }
      if (name === 'write_file') {
        if (typeof input.content !== 'string' || Buffer.byteLength(input.content) > 2 * 1024 * 1024) {
          throw new Error('scoped_content_invalid');
        }

        const handle = await checkedFile(file, scope.writableRoots, true);

        try {
          signal?.throwIfAborted();
          await handle.truncate(0);
          await handle.writeFile(input.content, 'utf8');
        } finally {
          await handle.close();
        }

        return { ok: true };
      }
      if (name === 'read_image') {
        const bytes = await readBytes(file, reads, IMAGE_LIMIT);
        const mimeType = bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ? 'image/png'
          : bytes[0] === 0xff && bytes[1] === 0xd8 ? 'image/jpeg'
            : bytes.subarray(0, 3).toString() === 'GIF' ? 'image/gif'
              : bytes.subarray(0, 4).toString() === 'RIFF'
                && bytes.subarray(8, 12).toString() === 'WEBP' ? 'image/webp' : '';

        if (!mimeType) {
          throw new Error('scoped_image_invalid');
        }

        return { format: 'grigdesk-work-content-v1', content: [{
          type: 'image',
          data: bytes.toString('base64'),
          mimeType,
        }] };
      }

      return { ok: false, error: 'tool_not_found' };
    } catch (error) {
      signal?.throwIfAborted();

      const reason = error instanceof Error ? error.message : '';

      return { ok: false, error: reason.startsWith('scoped_') ? reason : 'scoped_file_unavailable' };
    }
  };

  return { descriptors: [...structuredClone(enabled), ...history], invoke };
}
