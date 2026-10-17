// Потоки используют manifest/SHA и тот же открытый fd. Viewer token ограничивает
// папку, но не заменяет auth, живой scope или включённость плагина.
import { randomBytes, createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { parseByteRange } from '../../lib/httpRange.ts';
import type { DocumentReader } from '../../lib/documents/reader.ts';
import type { StudioLibrary } from '../../lib/studio3d/library.ts';
import { insideRoot, openVerified } from '../../lib/studio3d/safePath.ts';
import { borrowedReadStream } from '../../lib/studio3d/fileStreams.ts';
import { StudioHttpError } from './errors.ts';
import { validateGltf, validateGlbResources } from '../../lib/studio3d/gltfResources.ts';

export { validateGltf, validateGlbResources } from '../../lib/studio3d/gltfResources.ts';

const VIEW_MODELS = new Set(['.glb', '.gltf', '.fbx', '.obj', '.stl', '.splat']);
const NEIGHBORS = new Set(['.bin', '.png', '.jpg', '.jpeg', '.webp']);
const MIME: Record<string, string> = {
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

interface ViewerToken {
  expires: number;
  main: string;
  directory: string;
  root: string;
  scope: string;
  revisions: Map<string, string>;
}

interface FilesOptions {
  library: StudioLibrary;
  reader: Pick<DocumentReader, 'roots'>;
  now?: () => number;
  enabled: () => boolean;
  projectRoots: () => Promise<string[]>;
}

type Opened = Awaited<ReturnType<typeof openVerified>>;

/**
 * ETag считается из того же fd и проверяется после чтения, не из повторного open.
 * Manifest поток использует уже подтверждённый SHA, viewer — собственный digest.
 */
async function hashOpened(opened: Opened): Promise<string> {
  const hash = createHash('sha256');

  await pipeline(borrowedReadStream(opened.handle, opened.canonical), hash);
  await opened.verify();

  return hash.digest('hex');
}

/**
 * Range/HEAD применяются к размеру открытого inode. Завершение потока проверяет
 * revision до EOF; клиент не получает успешный поток подменённого источника.
 */
export async function sendStudioFile(request: FastifyRequest, reply: FastifyReply,
  opened: Opened, sha256: string) {
  const etag = `"${sha256}"`;
  const ifRange = request.headers['if-range'];
  const header = ifRange && ifRange !== etag ? undefined : request.headers.range;
  const range = parseByteRange(header, opened.size);

  const contentType = MIME[path.extname(opened.canonical).toLowerCase()] ?? 'application/octet-stream';

  reply.header('Content-Type', contentType);
  reply.header('ETag', etag);
  reply.header('Accept-Ranges', 'bytes');
  reply.header('Cache-Control', 'private, no-cache');
  reply.header('X-Content-Type-Options', 'nosniff');

  if (range === 'invalid' || (header && range === null)) {
    await opened.handle.close();

    return reply.code(416).header('Content-Range', `bytes */${opened.size}`).send();
  }

  const start = range?.start ?? 0;
  const end = range?.end ?? opened.size - 1;

  reply.code(range ? 206 : 200);
  reply.header('Content-Length', range ? end - start + 1 : opened.size);

  if (range) {
    reply.header('Content-Range', `bytes ${start}-${end}/${opened.size}`);
  }

  if (request.method === 'HEAD' || opened.size === 0) {
    await opened.verify();
    await opened.handle.close();

    return reply.send();
  }

  const source = createReadStream(opened.canonical, {
    fd: opened.handle,
    autoClose: false,
    start,
    end,
  });
  const guard = new Transform({
    transform(chunk, _encoding, callback) {
      callback(null, chunk);
    },
    flush(callback) {
      opened.verify().then(() => callback(), () => callback(new Error('file_changed')));
    },
  });

  source.on('error', (error) => guard.destroy(error));
  guard.on('close', () => {
    source.destroy();
    void opened.handle.close();
  });
  source.pipe(guard);

  return reply.send(guard);
}

/**
 * Сервис имеет собственный набор токенов поколения библиотеки; clear отзывает все.
 * Любой запрос повторно получает корни scope из DocumentReader и проекта.
 */
export function createStudioFiles(options: FilesOptions) {
  const tokens = new Map<string, ViewerToken>();
  const now = options.now ?? Date.now;

  /**
   * Каждый запрос получает актуальные scope и корни проектов перед канонизацией.
   * Недоступный root исключается, сохранившиеся токены не расширяют разрешения.
   */
  const roots = async (scope: string) => {
    const declared = await options.reader.roots(scope);
    const projects = await options.projectRoots();
    const paths = [...declared.map((root) => root.path), ...projects, options.library.dir];
    const canonical = await Promise.all(paths.map((root) => fsRoot(root)));

    return [...new Set(canonical.filter((root): root is string => Boolean(root)))];
  };

  /**
   * Раскрытие пути проверяет самый узкий текущий root и открывает обычный файл.
   * Token закрепляет главный файл и каталог, подписанные URL в него не принимаются.
   */
  const openSource = async (input: string, scope = '') => {
    if (!options.enabled() || !path.isAbsolute(input) || input.includes('\0')) {
      throw new StudioHttpError(403, 'outside_roots', 'Путь вне разрешённой области.');
    }

    const currentRoots = (await roots(scope)).sort((a, b) => b.length - a.length);
    const root = currentRoots.find((root) => input === root || input.startsWith(`${root}${path.sep}`));

    if (!root || !await insideRoot(root, input)) {
      throw new StudioHttpError(403, 'outside_roots', 'Модель находится вне разрешённых корней.');
    }

    return { opened: await openVerified(root, input), root };
  };

  /**
   * Resolver использует тот же живой scope, что бесплатный импорт файла.
   * Token закрепляет главный inode, а URL не становится самостоятельным доступом.
   */
  const resolve = async (input: string, scope = '') => {
    const { opened, root } = await openSource(input, scope);

    try {
      const ext = path.extname(opened.canonical).toLowerCase();

      if (!VIEW_MODELS.has(ext)) {
        throw new StudioHttpError(415, 'unsupported_type', 'Файл не является поддерживаемой моделью.');
      }

      if (opened.size > 150 * 1024 * 1024) {
        throw new StudioHttpError(413, 'too_large', 'Просмотр модели доступен до 150 МиБ.');
      }

      if (ext === '.gltf') {
        if (opened.size > 16 * 1024 * 1024) {
          throw new StudioHttpError(413, 'too_large', 'JSON модели слишком большой.');
        }

        validateGltf(JSON.parse(await opened.handle.readFile('utf8')));
      }

      if (ext === '.glb') {
        await validateGlbResources(opened);
      }

      const sha256 = await hashOpened(opened);
      const token = randomBytes(24).toString('hex');

      for (const [id, entry] of tokens) {
        if (entry.expires <= now()) {
          tokens.delete(id);
        }
      }

      if (tokens.size >= 256) {
        tokens.delete(tokens.keys().next().value!);
      }

      tokens.set(token, {
        expires: now() + 3_600_000,
        main: opened.canonical,
        directory: path.dirname(opened.canonical),
        root,
        scope,
        revisions: new Map([[opened.canonical, opened.revision]]),
      });

      let libraryRef: { modelId: string; versionId: string } | null = null;

      for (const entry of (await options.library.listModels()).entries) {
        for (const version of entry.versions) {
          if (version.files.some((file) => file.sha256 === sha256
            && path.join(options.library.dir, entry.model.id, version.id, file.name) === opened.canonical)
            || version.savedTo.some((saved) => saved.path === opened.canonical && saved.sha256 === sha256)) {
            libraryRef = { modelId: entry.model.id, versionId: version.id };
          }
        }
      }

      return {
        libraryId: options.library.libraryId,
        url: `/api/studio3d/viewer/file/${token}/${encodeURIComponent(path.basename(opened.canonical))}`,
        name: path.basename(opened.canonical),
        ext: ext.slice(1),
        size: opened.size,
        libraryRef,
      };
    } finally {
      await opened.handle.close();
    }
  };

  /**
   * Каждый stream повторяет scope, срок, inode и запрет соседей вне папки.
   * Token отозванного root/библиотеки даёт 404, авторизация проверяется самим модулем.
   */
  const viewerFile = async (token: string, relative: string) => {
    const entry = tokens.get(token);

    if (!entry || !options.enabled() || entry.expires <= now()
      || relative.startsWith('/') || relative.includes('\\') || relative.includes('%')
      || relative.split('/').some((part) => !part || part === '..' || part === '.')) {
      throw new StudioHttpError(404, 'not_found', 'Ссылка просмотра больше недоступна.');
    }

    const file = path.resolve(entry.directory, relative);

    if (file !== entry.main && !NEIGHBORS.has(path.extname(file).toLowerCase())) {
      throw new StudioHttpError(404, 'not_found', 'Ресурс модели не найден.');
    }

    if (!(await roots(entry.scope)).includes(entry.root) || !await insideRoot(entry.directory, file)) {
      throw new StudioHttpError(404, 'not_found', 'Область просмотра изменилась.');
    }

    const opened = await openVerified(entry.root, file);

    try {
      const revision = entry.revisions.get(file);

      if (revision && revision !== opened.revision) {
        throw new StudioHttpError(404, 'not_found', 'Файл модели изменился.');
      }

      entry.revisions.set(file, opened.revision);

      return { opened, sha256: await hashOpened(opened) };
    } catch (error) {
      await opened.handle.close();

      throw error;
    }
  };

  return {
    openSource,
    resolve,
    viewerFile,
    clear: () => tokens.clear()
  };
}

/**
 * Ошибка отдельного provider root не превращается в разрешение широкого префикса.
 * Только существующий канонический каталог становится источником просмотра.
 */
async function fsRoot(root: string): Promise<string | null> {
  const { promises: fs } = await import('node:fs');

  try {
    const canonical = await fs.realpath(root);

    return (await fs.stat(canonical)).isDirectory() ? canonical : null;
  } catch {
    return null;
  }
}
