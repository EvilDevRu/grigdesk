// Входы worker разрешаются из manifest или временной загрузки, затем копируются
// в независимый snapshot. Native provenance никогда не берётся из родителя.
import { createHash } from 'node:crypto';
import { fstatSync, lstatSync, realpathSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import { parseStudio3d } from '../../../../shared/studio3d/studio3dContracts.ts';
import type { InputSnapshot, IntentRecord, RunRequest, StudioIntents } from './intents.ts';
import { IntentError } from './intents.ts';
import type { DiskVersion, StudioLibrary } from './library.ts';
import { inputContext } from './providers.ts';
import { START_CONTEXT } from './provider.ts';
import type { AccountSnapshot, InputContext, ResolvedInput, Studio3dProvider } from './provider.ts';
import { borrowedReadStream } from './fileStreams.ts';
import {
  ensureDirectory,
  fileRevision,
  isSafeName,
  openVerified,
  pinDirectory,
  readJson,
  safeCopy,
  verifiedHash,
} from './safePath.ts';

export interface JobInputSelection {
  context: InputContext;
  version: DiskVersion | null;
  inputs: ResolvedInput[];
  release(): void;
}

/**
 * FD снимков остаются открыты вокруг prepare и durable submitting. Полные SHA
 * проверяются заранее, последняя сверка ревизий/root выполняется без await.
 */
export async function pinSnapshots(library: StudioLibrary, intents: StudioIntents,
  record: IntentRecord): Promise<{ verifyNow(): void; close(): Promise<void> }> {
  const pinned: Awaited<ReturnType<typeof openVerified>>[] = [];

  try {
    for (const snapshot of record.inputs) {
      if (!snapshot.name) {
        continue;
      }

      const opened = await openVerified(library.dir, intents.inputPath(record.intentId, snapshot.name));

      pinned.push(opened);

      const hash = createHash('sha256');

      await pipeline(borrowedReadStream(opened.handle, opened.canonical), hash);
      await opened.verify();

      if (opened.size !== snapshot.size || hash.digest('hex') !== snapshot.sha256) {
        throw new IntentError('snapshot_changed');
      }
    }

    return {
      /**
       * Последняя проверка не уступает управление между durable submitting и POST.
       * Замена пути или содержимого открытого снимка отменяет отправку.
       */
      verifyNow() {
        library.assertOwnerNow();

        for (const opened of pinned) {
          const current = fstatSync(opened.handle.fd, { bigint: true });
          const atPath = lstatSync(opened.canonical, { bigint: true });

          if (fileRevision(current) !== opened.revision || fileRevision(atPath) !== opened.revision
            || !atPath.isFile() || atPath.isSymbolicLink()
            || realpathSync(opened.canonical) !== opened.canonical) {
            throw new IntentError('snapshot_changed');
          }
        }
      },
      close: async () => {
        await Promise.all(pinned.map((opened) => opened.handle.close()));
      }
    };
  } catch (error) {
    await Promise.all(pinned.map((opened) => opened.handle.close()));

    throw error;
  }
}

/**
 * Существующая версия обязана принадлежать указанной модели; отдельный modelId
 * не предоставляет файлового входа. Каждый manifest файл проверяется по SHA.
 */
export async function selectJobInputs(
  library: StudioLibrary,
  request: RunRequest,
  provider: Studio3dProvider,
  captured: AccountSnapshot | undefined,
): Promise<JobInputSelection> {
  const releases: (() => void)[] = [];

  try {
    if (request.versionId && !request.modelId) {
      throw new IntentError('invalid_input');
    }

    const entry = request.modelId ? await library.readModel(request.modelId) : null;
    const version = entry?.versions.find((item) => item.id === request.versionId) ?? null;

    if (request.versionId && !version) {
      throw new IntentError('invalid_input');
    }

    if (version && request.uploads?.length) {
      throw new IntentError('invalid_input');
    }

    const context = inputContext(version, provider, captured);
    const inputs: ResolvedInput[] = [];

    if (version && request.modelId) {
      releases.push(library.leaseVersion(request.modelId, version.id, request.idempotencyKey));

      const native = context.nativeTaskType && version.task && captured ? {
        taskId: version.task.id,
        taskType: version.task.type,
        accountKey: captured.accountKey
      } : null;
      const files = version.kind === 'views'
        ? version.files.filter((file) => ['front', 'left', 'back', 'right'].includes(file.role))
        : [version.files.find((file) => file.id === version.mainFileId)
          ?? version.files.find((file) => ['model', 'file', 'image'].includes(file.role))].filter(Boolean);

      for (const file of files) {
        const opened = await library.openVersionFile(request.modelId, version.id, file!.name);

        await opened.handle.close();
        inputs.push({
          role: version.kind === 'views' ? file!.role as ResolvedInput['role'] : 'primary',
          native,
          file: {
            path: opened.canonical,
            root: library.dir,
            name: file!.name
          }
        });
      }

      if (!files.length && native) {
        inputs.push({
          role: 'primary',
          native,
          file: null
        });
      }
    }

    const roles = new Set<string>();

    for (const item of request.uploads ?? []) {
      if (!isSafeName(item.uploadId) || roles.has(item.role)) {
        throw new IntentError('invalid_input');
      }

      roles.add(item.role);
      releases.push(library.leaseUpload(item.uploadId, request.idempotencyKey));

      const folder = path.join(library.dir, '.uploads', item.uploadId);
      const upload = parseStudio3d.upload(await readJson(library.dir, path.join(folder, 'upload.json')));

      if (upload.libraryId !== library.libraryId || upload.uploadId !== item.uploadId
        || !isSafeName(upload.name)) {
        throw new IntentError('invalid_input');
      }

      const file = path.join(folder, upload.name);
      const checked = await verifiedHash(library.dir, file);

      if (checked.size !== upload.size) {
        throw new IntentError('invalid_input');
      }

      inputs.push({
        role: item.role,
        native: null,
        file: {
          path: file,
          name: upload.name,
          root: library.dir
        }
      });
      context.kind = item.role === 'primary' ? upload.kind : 'views';
      context.format = path.extname(upload.name).slice(1).toLowerCase();
      context.stats = upload.stats;

      // Проверка операций по видам читает роли из context.views: без списка
      // собственные загрузки не проходят проверку «нужен вид спереди».
      if (item.role !== 'primary') {
        context.views = [...context.views, item.role];
      }
    }

    if (request.operation === 'views-to-model'
      && (inputs.length < 2 || inputs.length > 4 || !inputs.some((input) => input.role === 'front')
        || inputs.some((input) => input.role === 'primary'))) {
      throw new IntentError('invalid_input');
    }

    return {
      context,
      version,
      inputs,
      release: () => releases.forEach((release) => release())
    };
  } catch (error) {
    releases.forEach((release) => release());

    throw error;
  }
}

/**
 * Snapshot уже не зависит от upload TTL или удалённого родителя. Native-only
 * ссылка допускается без файла и не заменяется фиктивными байтами.
 */
export async function snapshotInputs(
  library: StudioLibrary,
  intents: StudioIntents,
  intentId: string,
  inputs: readonly ResolvedInput[],
): Promise<{ inputs: ResolvedInput[]; snapshots: InputSnapshot[] }> {
  await ensureDirectory(library.dir, path.join(intents.directory(intentId), 'inputs'));

  const snapshots: InputSnapshot[] = [];
  const resolved: ResolvedInput[] = [];

  for (const [index, input] of inputs.entries()) {
    const extension = input.file ? path.extname(input.file.name).toLowerCase() : '';
    const name = input.file ? `${index + 1}-${input.role}${extension}` : null;
    let info: { size: number; sha256: string } | null = null;

    if (input.file && name) {
      info = await safeCopy({
        sourceRoot: input.file.root ?? path.dirname(input.file.path),
        source: input.file.path,
        targetRoot: library.dir,
        target: intents.inputPath(intentId, name),
        maxBytes: 150 * 1024 * 1024
      });
    }

    const native = input.native?.accountKey ? {
      taskId: input.native.taskId,
      taskType: input.native.taskType,
      accountKey: input.native.accountKey
    } : null;

    snapshots.push({
      role: input.role,
      name,
      size: info?.size ?? null,
      sha256: info?.sha256 ?? null,
      native
    });
    resolved.push({
      role: input.role,
      native,
      file: name ? {
        path: intents.inputPath(intentId, name),
        name,
        root: library.dir
      } : null
    });
  }

  return { inputs: resolved, snapshots };
}

/**
 * Проверка повторной отправки использует сохранённые суммы всех снимков.
 * Убраные после TTL inputs закрывают retry с объяснением, сохраняя журнал денег.
 */
export async function retainedInputs(
  library: StudioLibrary, intents: StudioIntents, intentId: string, snapshots: InputSnapshot[],
): Promise<boolean> {
  for (const input of snapshots) {
    if (!input.name) {
      continue;
    }

    try {
      const info = await verifiedHash(library.dir, intents.inputPath(intentId, input.name));

      if (info.size !== input.size || info.sha256 !== input.sha256) {
        return false;
      }
    } catch {
      return false;
    }
  }

  return true;
}

/**
 * Уборка orphan до принятия удаляет только собственную inputs папку.
 * Durable intent и его ключ никогда не удаляются этим rollback.
 */
export async function discardInputs(library: StudioLibrary, intents: StudioIntents,
  intentId: string): Promise<void> {
  await library.assertOwner();

  const parent = await pinDirectory(library.dir, intents.directory(intentId)).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }

    throw error;
  });

  if (!parent) {
    return;
  }

  try {
    await parent.verify();
    await fs.rm(parent.child('inputs'), { recursive: true, force: true });
    await parent.handle.sync();
    await parent.verify();
  } finally {
    await parent.handle.close();
  }
}
