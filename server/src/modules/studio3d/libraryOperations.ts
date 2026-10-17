// Ручки библиотеки используют manifest, live scope и независимые копии.
// Все эффекты принадлежат захваченному контексту; worker определяет оплачиваемый retry.
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { parseStudio3d } from '../../../../shared/studio3d/studio3dContracts.ts';
import { versionProjection } from '../../lib/studio3d/library.ts';
import type { DiskModel, DiskVersion } from '../../lib/studio3d/library.ts';
import { retryInfo } from '../../lib/studio3d/jobProjections.ts';
import { searchModels, summarizeModel } from '../../lib/studio3d/search.ts';
import type { SearchQuery } from '../../lib/studio3d/search.ts';
import { atomicWrite, ensureDirectory, isExternalName, isSafeName, openVerified, pinDirectory, readJson,
  safeCopy, verifiedHash } from '../../lib/studio3d/safePath.ts';
import { inspectImage, inspectModel, MODEL_LIMIT } from './formats.ts';
import type { StudioContext, StudioProjectService } from './runtime.ts';
import { StudioHttpError } from './errors.ts';

export interface ImportFileRequest {
  uploadId?: string;
  path?: string;
  scope?: string;
  incoming?: string;
  parentVersionId?: string;
  label?: string;
  name?: string;
  project?: string | null;
  category?: DiskModel['category'];
}

export interface SaveRequest {
  projectId: string;
  repoKey: string;
  folder: string;
  fileName: string;
  overwrite?: boolean;
  expectedSha256?: string;
}

interface OperationsOptions {
  check(): void;
  projects?: () => StudioProjectService | undefined;
  broadcast?: (name: string, data: Record<string, unknown>) => void;
}

/**
 * URLs адресуют только зарегистрированные файлы библиотеки и экранируют basename.
 * Перенос библиотеки инвалидирует поколения API, а не переписывает эти пути.
 */
export function studioFileUrl(modelId: string, versionId: string, name: string): string {
  return `/api/studio3d/files/${encodeURIComponent(modelId)}/${encodeURIComponent(versionId)}`
    + `/${encodeURIComponent(name)}`;
}

/**
 * Сервис создаётся на конкретный захваченный context, не ищет новый после await.
 * Перед публикацией файла check повторяет допуск, а source остаётся открытым.
 */
export function createLibraryOperations(context: StudioContext, options: OperationsOptions) {
  const { library, intents } = context;

  /**
   * Changed содержит libraryId и вызывается только после успешного persist.
   * Уведомление не заменяет результат операции и не раскрывает private journal.
   */
  const changed = (modelId: string, versionId: string | null = null, status = 'ready') => {
    options.broadcast?.('studio-changed', {
      libraryId: library.libraryId,
      modelId,
      versionId,
      status,
      at: new Date().toISOString()
    });
  };

  /**
   * Retry availability вычисляется по durable child и retained inputs.
   * Обычная файловая версия не приобретает фиктивный оплачиваемый intent.
   */
  const projection = async (modelId: string, version: DiskVersion) => {
    const record = version.intentId ? await intents.get(version.intentId) : null;
    const child = record?.children.find((item) => item.childId === version.childId);
    const retry = record && child ? await retryInfo(record, child, library, intents)
      : { available: false, reason: null };

    return versionProjection(version, library.libraryId,
      (name) => studioFileUrl(modelId, version.id, name), retry);
  };

  /**
   * Версия ищется только внутри выбранной модели; standalone vid прав не даёт.
   * Тот же helper используют все файловые и оплачиваемые действия версии.
   */
  const version = async (modelId: string, versionId: string) => {
    const entry = await library.readModel(modelId);
    const item = entry.versions.find((item) => item.id === versionId);

    if (!item) {
      throw new StudioHttpError(404, 'version_not_found', 'Версия не найдена.');
    }

    return item;
  };

  /**
   * Деталь включает путь папки модели для явного выбора workspace нового чата.
   * Incoming перечисляется по whitelist и не попадает в manifest автоматически.
   */
  const detail = async (modelId: string) => {
    const entry = await library.readModel(modelId);

    return parseStudio3d.model({
      libraryId: library.libraryId,
      model: summarizeModel(entry.model, entry.versions, studioFileUrl),
      notes: entry.model.notes,
      versions: await Promise.all(entry.versions.map((item) => projection(modelId, item))),
      incoming: await library.incoming(modelId),
      modelDirectory: path.join(library.dir, modelId),
      saveFolders: (await library.settings()).saveFolders,
    });
  };

  /**
   * Source разрешается из ровно одного upload/path/incoming и остаётся открытым.
   * Живой scope и upload manifest проверяются до создания модели или версии.
   */
  const sourceFor = async (input: ImportFileRequest, modelId?: string) => {
    if ([input.uploadId, input.path, input.incoming].filter((value) => value !== undefined).length !== 1) {
      throw new StudioHttpError(400, 'invalid_input', 'Выберите ровно один источник файла.');
    }

    let release = () => {};

    try {
      if (input.path) {
        const source = await context.files.openSource(input.path, input.scope ?? '');

        return { ...source, release };
      }

      let file: string;

      if (input.uploadId) {
        if (!isSafeName(input.uploadId)) {
          throw new StudioHttpError(400, 'invalid_input', 'Некорректная загрузка.');
        }

        release = library.leaseUpload(input.uploadId, randomUUID());

        const folder = path.join(library.uploadsDir(), input.uploadId);
        const upload = parseStudio3d.upload(await readJson(library.dir, path.join(folder, 'upload.json')));

        if (upload.libraryId !== library.libraryId || upload.uploadId !== input.uploadId
          || !isSafeName(upload.name) || upload.kind !== 'model') {
          throw new StudioHttpError(415, 'unsupported_type', 'Для модели нужен самостоятельный 3D-файл.');
        }

        file = path.join(folder, upload.name);
      } else {
        if (!modelId || !isExternalName(input.incoming)
          || !(await library.incoming(modelId)).includes(input.incoming!)) {
          throw new StudioHttpError(404, 'file_not_found', 'Файл incoming не найден.');
        }

        file = path.join(library.dir, modelId, 'incoming', input.incoming!);
      }

      return {
        opened: await openVerified(library.dir, file),
        root: library.dir,
        release
      };
    } catch (error) {
      release();

      throw error;
    }
  };

  /**
   * Import копирует проверенный источник в независимый inode и считает GLB сводку.
   * Failure удаляет только свою новую версию; original source никогда не изменяется.
   */
  const addFile = async (modelId: string, input: ImportFileRequest,
    source: Awaited<ReturnType<typeof sourceFor>>) => {
    const entry = await library.readModel(modelId);

    if (input.parentVersionId && !entry.versions.some((item) => item.id === input.parentVersionId)) {
      throw new StudioHttpError(404, 'version_not_found', 'Родительская версия не найдена.');
    }

    const stats = await inspectModel(source.root, source.opened.canonical);

    await source.opened.verify();
    options.check();

    const created = await library.addVersion(modelId, {
      kind: 'model',
      origin: 'file',
      parent: input.parentVersionId ?? null,
      label: input.label?.trim() || 'Свой файл',
      stats
    });
    const release = library.leaseVersion(modelId, created.id, randomUUID());

    try {
      const name = `model${path.extname(source.opened.canonical).toLowerCase()}`;

      await library.copyIn(modelId, created.id, {
        sourceRoot: source.root,
        source: source.opened.canonical,
        name,
        role: 'model',
        maxBytes: MODEL_LIMIT,
        beforePublish: async () => {
          await source.opened.verify();
          options.check();
        }
      });
      options.check();

      const item = await version(modelId, created.id);

      changed(modelId, item.id);

      return projection(modelId, item);
    } catch (error) {
      release();
      await library.deleteVersion(modelId, created.id).catch(() => {});

      throw error;
    } finally {
      release();
    }
  };

  /**
   * Бесплатное создание отвечает createdModel без ложного intentId.
   * Поддержка standalone формата доказана до появления модельной папки.
   */
  const createModel = async (input: ImportFileRequest) => {
    const source = await sourceFor(input);
    let modelId: string | null = null;

    try {
      await inspectModel(source.root, source.opened.canonical);
      await source.opened.verify();
      options.check();

      const model = await library.createModel({
        name: input.name?.trim() || path.basename(source.opened.canonical,
          path.extname(source.opened.canonical)),
        project: input.project ?? null,
        category: input.category ?? null,
        origin: 'file'
      });

      modelId = model.id;

      const imported = await addFile(model.id, input, source);
      const result = await detail(model.id);

      return parseStudio3d.createdModel({
        libraryId: library.libraryId,
        model: result.model,
        version: imported
      });
    } catch (error) {
      if (modelId) {
        await library.deleteModel(modelId).catch(() => {});
      }

      throw error;
    } finally {
      await source.opened.handle.close();
      source.release();
    }
  };

  /**
   * Incoming/upload становится версией только после независимого copy и анализа.
   * Parent проверяется в выбранной модели, чужой ID не создаёт связь графа.
   */
  const fromFile = async (modelId: string, input: ImportFileRequest) => {
    const source = await sourceFor(input, modelId);

    try {
      return await addFile(modelId, input, source);
    } finally {
      await source.opened.handle.close();
      source.release();
    }
  };

  /**
   * Сохранение использует серверный repoKey и относительную пользовательскую папку.
   * Overwrite сверяет показанный SHA; источник закреплён до atomic публикации.
   */
  const save = async (modelId: string, versionId: string, input: SaveRequest) => {
    const service = options.projects?.();
    const project = await service?.read(input.projectId);
    const repo = project?.repos.find((repo) => repo.key === input.repoKey);

    if (!repo || project?.archived || project?.archivedAt) {
      throw new StudioHttpError(404, 'project_not_found', 'Репозиторий проекта не найден.');
    }

    if (path.isAbsolute(input.folder) || input.folder.includes('\\')
      || (input.folder !== '' && input.folder.split('/').some((part) => !isExternalName(part)))
      || !isExternalName(input.fileName)) {
      throw new StudioHttpError(400, 'invalid_folder', 'Выберите относительную папку и обычное имя файла.');
    }

    const item = await version(modelId, versionId);
    const file = item.files.find((file) => file.id === item.mainFileId);

    if (!file) {
      throw new StudioHttpError(404, 'file_not_found', 'Основной файл отсутствует.');
    }

    if (path.extname(input.fileName).toLowerCase() !== path.extname(file.name).toLowerCase()) {
      throw new StudioHttpError(400, 'format_requires_export',
        'Расширение должно совпадать с готовым файлом. Для другого формата используйте шаг «Экспорт».');
    }

    const root = await fs.realpath(repo.dir);
    const target = path.join(root, input.folder, input.fileName);
    const opened = await library.openVersionFile(modelId, versionId, file.name);
    const release = library.leaseVersion(modelId, versionId, randomUUID());

    try {
      options.check();
      await ensureDirectory(root, path.dirname(target));

      let result;

      try {
        result = await safeCopy({
          sourceRoot: library.dir,
          source: opened.canonical,
          targetRoot: root,
          target,
          overwrite: input.overwrite,
          expectedSha256: input.expectedSha256,
          beforePublish: async () => {
            await opened.verify();
            options.check();

            const fresh = await service!.read(input.projectId);

            const freshRepo = fresh.repos.find((repo) => repo.key === input.repoKey)?.dir ?? '';

            if (fresh.archived || fresh.archivedAt || await fs.realpath(freshRepo) !== root) {
              throw new StudioHttpError(409, 'project_changed', 'Репозиторий проекта изменился.');
            }
          }
        });
      } catch (error) {
        const code = (error as { code?: string }).code;

        if (code === 'exists' || code === 'changed') {
          const previous = await verifiedHash(root, target).catch(() => null);

          throw new StudioHttpError(409, code, 'Файл назначения изменился. Подтвердите актуальный SHA.',
            { sha256: previous?.sha256 ?? null });
        }

        throw error;
      }

      const at = new Date().toISOString();

      await library.updateVersion(modelId, versionId, (current) => ({
        savedTo: [...current.savedTo.filter((saved) => saved.path !== target), {
          path: target,
          at,
          sha256: result.sha256
        }],
      }));
      await library.saveSettings({ saveFolders: { [input.projectId]: { [input.repoKey]: input.folder } } });
      changed(modelId, versionId);

      return parseStudio3d.save({
        libraryId: library.libraryId,
        path: target,
        overwritten: !!input.overwrite
      });
    } finally {
      release();
      await opened.handle.close();
    }
  };

  /**
   * Preview принимает декодируемые PNG/WebP до пяти МиБ и заменяет только preview.
   * Собственная temporary папка убирается при успешном и неуспешном decode.
   */
  const preview = async (modelId: string, versionId: string, bytes: Buffer, mime: string) => {
    await version(modelId, versionId);

    if (bytes.length > 5 * 1024 * 1024) {
      throw new StudioHttpError(413, 'too_large', 'Превью должно быть до 5 МиБ.');
    }

    if (!['image/png', 'image/webp'].includes(mime)) {
      throw new StudioHttpError(415, 'unsupported_type', 'Превью должно быть PNG или WebP.');
    }

    const ext = mime === 'image/png' ? '.png' : '.webp';
    const name = `preview${ext}`;
    const folderName = randomUUID();
    const folder = path.join(library.uploadsDir(), folderName);

    await ensureDirectory(library.dir, folder);

    const parent = await pinDirectory(library.dir, library.uploadsDir());
    const release = library.leaseVersion(modelId, versionId, randomUUID());

    try {
      await atomicWrite({
        root: library.dir,
        target: path.join(folder, name),
        data: bytes
      });
      await inspectImage(library.dir, path.join(folder, name), mime);
      options.check();
      await library.writeVersionFile(modelId, versionId, name, bytes, { role: 'preview', replace: true });
      changed(modelId, versionId);

      return projection(modelId, await version(modelId, versionId));
    } finally {
      release();
      await parent.verify();
      await fs.rm(parent.child(folderName), { recursive: true, force: true });
      await parent.close();
    }
  };

  /**
   * Поиск не обращается к поставщику: сводки и broken берутся из библиотеки.
   * Параметры пагинации проверяются схемой API до вызова этой проекции.
   */
  const list = async (query: SearchQuery) => {
    const current = await library.listModels();

    return parseStudio3d.models({
      libraryId: library.libraryId,
      ...searchModels(current.entries, query, studioFileUrl),
      broken: current.broken
    });
  };

  return {
    detail,
    projection,
    version,
    list,
    createModel,
    fromFile,
    save,
    preview,
    changed
  };
}
