import path from 'node:path';

import { refineKind } from '../../../../shared/studio3d/studio3dOperations.ts';
import { inspectImage, inspectModel, MODEL_EXT } from './assetFormats.ts';
import { ensureDirectory, isSafeName, pinDirectory, verifiedHash } from './safePath.ts';
import { JobError, InjectedCrash, fallbackError } from './jobErrors.ts';
import type { DownloadOptions } from './download.ts';
import type { IntentChild, IntentRecord, StudioIntents } from './intents.ts';
import type { DiskVersion, StudioLibrary } from './library.ts';
import type { RemoteTask, Studio3dProvider } from './provider.ts';

export interface JobDownloadsPorts {
  library: StudioLibrary;
  intents: StudioIntents;
  signal: AbortSignal;
  at(): string;
  isStopped(): boolean;
  lookupProvider(id: string): Pick<Studio3dProvider, 'snapshot' | 'isCurrent' | 'poll'> | undefined;
  download(options: DownloadOptions): Promise<{ size: number; sha256: string }>;
  change(intentId: string, childId: string, patch: Partial<IntentChild>): Promise<IntentRecord>;
  notify(intentId: string, childId: string): Promise<void>;
  broadcast(name: string, data: Record<string, unknown>): void;
  injectFault(boundary: string, record: IntentRecord, child?: IntentChild): Promise<void>;
  refreshLease(record: IntentRecord, child: IntentChild): void;
}

/**
 * Файловый результат подтверждается по fd/SHA до публикации версии и ready.
 * Узкие порты не предоставляют права платной отправки или владения lifecycle Jobs.
 */
export function createJobDownloads(ports: JobDownloadsPorts) {
  /**
   * Повтор публикации после сбоя JSON принимает лишь тот же SHA destination.
   * Orphan файл не обслуживается API до явной durable записи его manifest.
   */
  const publishFile = async (record: IntentRecord, child: IntentChild, source: string,
    name: string, role: string, id?: string): Promise<void> => {
    const library = ports.library;

    try {
      await library.copyIn(record.modelId!, child.version!.id, {
        sourceRoot: library.dir,
        source,
        name,
        role,
        id
      });
    } catch (error) {
      if ((error as { code?: string }).code !== 'exists') {
        throw error;
      }

      const sourceInfo = await verifiedHash(library.dir, source);

      await library.adoptVersionFile(record.modelId!, child.version!.id, name, sourceInfo.sha256,
        { role, id });
    }
  };

  /**
   * Протухший CDN URL обновляется только бесплатным poll того же account/task.
   * Смена доступа не подменяет результаты и не вызывает нового POST.
   */
  const refreshOutput = async (record: IntentRecord, child: IntentChild,
    outputId: string): Promise<string> => {
    const provider = ports.lookupProvider(record.provider);
    const captured = provider?.snapshot?.();

    if (!captured || captured.accountKey !== record.accountKey || !provider?.isCurrent?.(captured)) {
      throw new JobError('account_changed');
    }

    const response = await provider.poll!([child.taskId!], captured);
    const remote = response.tasks.find((item) => item.id === child.taskId && item.type === child.taskType);
    const output = remote?.outputs.find((item) => item.id === outputId);

    if (!provider.isCurrent?.(captured) || !output) {
      throw new JobError('output_unavailable');
    }

    return output.url;
  };

  /**
   * Публикуются только полные required roles после подтверждения fd/SHA.
   * Remote success остаётся charged при ошибке CDN и разрешает free redownload.
   */
  const downloadResult = async (intentId: string, childId: string): Promise<void> => {
    const record = (await ports.intents.get(intentId))!;
    const child = record.children.find((item) => item.childId === childId)!;
    const remote = child.remote;

    if (!remote || !record.modelId || !child.version || child.status === 'ready') {
      return;
    }

    try {
      const missing = remote.requiredRoles.filter((role) =>
        !remote.outputs.some((output) => output.role === role));

      if (missing.length || !remote.requiredRoles.length
        || (child.version.kind !== 'views' && remote.mainFileId === null)) {
        throw new Error('missing_outputs');
      }

      const directory = path.join(ports.intents.directory(intentId), 'downloads', childId);

      await ensureDirectory(ports.library.dir, directory);

      const pinned = await pinDirectory(ports.library.dir, directory);
      const completed: {
        output: RemoteTask['outputs'][number];
        path: string;
        sha256: string
      }[] = [];

      let stats = null;
      const required = new Set(remote.requiredRoles.map((role) =>
        remote.outputs.find((output) => output.id === remote.mainFileId && output.role === role)?.id
          ?? remote.outputs.find((output) => output.role === role)?.id));

      if (remote.mainFileId) {
        required.add(remote.mainFileId);
      }

      try {
        for (const output of remote.outputs) {
          try {
            if (!isSafeName(output.name)) {
              throw new Error('unsafe_output');
            }

            const destination = path.join(directory, output.name);
            const existing = await verifiedHash(ports.library.dir, destination).catch(() => null);
            let downloaded = existing;

            if (!downloaded) {
              await pinned.verify();
              downloaded = await ports.download({
                url: output.url,
                dest: pinned.child(output.name),
                refresh: () => refreshOutput(record, child, output.id),
                signal: ports.signal,
              });
              await pinned.verify();
              await pinned.handle.sync();
            }

            const confirmed = await verifiedHash(ports.library.dir, destination);

            if (confirmed.sha256 !== downloaded.sha256 || confirmed.size !== downloaded.size) {
              throw new Error('changed_output');
            }

            if (['model', 'base-model'].includes(output.role)) {
              const inspected = await inspectModel(ports.library.dir, destination,
                ports.signal);

              if (output.id === remote.mainFileId) {
                stats = inspected;
              }
            } else if (output.role === 'file' && MODEL_EXT.has(path.extname(output.name).toLowerCase())) {
              // Экспорт открывается просмотрщиком как контейнер модели, но сводка ему
              // не нужна: битый файл не должен проходить, картинка здесь не ожидается.
              await inspectModel(ports.library.dir, destination, ports.signal);
            } else if (output.role !== 'file') {
              const image = await inspectImage(ports.library.dir, destination,
                undefined, ports.signal);
              const name = path.basename(output.name, path.extname(output.name)) + image.extension;

              completed.push({
                output: { ...output, name },
                path: destination,
                sha256: confirmed.sha256
              });
              await ports.injectFault('after-download', record, child);

              continue;
            }

            completed.push({
              output,
              path: destination,
              sha256: confirmed.sha256
            });
            await ports.injectFault('after-download', record, child);
          } catch (error) {
            if (error instanceof InjectedCrash || required.has(output.id) || ports.isStopped()) {
              throw error;
            }
          }
        }
      } finally {
        await pinned.close();
      }

      for (const item of completed) {
        if (ports.isStopped()) {
          return;
        }

        await publishFile(record, child, item.path, item.output.name, item.output.role, item.output.id);
      }

      await ports.library.updateVersion(record.modelId, child.version.id, {
        stats,
        kind: refineKind(child.version.kind, stats),
        mainFileId: remote.mainFileId,
        views: remote.views as DiskVersion['views'],
      });

      const updated = await ports.change(intentId, childId, {
        stage: 'done',
        status: 'ready',
        progress: 100,
        error: null,
        waitReason: null,
        completedAt: ports.at()
      });

      ports.refreshLease(updated, updated.children.find((item) => item.childId === childId)!);
      
      const entry = await ports.library.readModel(record.modelId);

      if (!entry.model.mainVersion) {
        await ports.library.updateModel(record.modelId, { mainVersion: child.version.id });
      }

      await ports.notify(intentId, childId);
    } catch (error) {
      if (error instanceof InjectedCrash) {
        throw error;
      }

      if (ports.isStopped()) {
        return;
      }

      const updated = await ports.change(intentId, childId, {
        stage: 'accepted',
        status: 'failed',
        error: fallbackError('network',
          'Генерация завершена, но файлы не сохранены. Скачать снова — бесплатно.'),
        waitReason: null,
        completedAt: ports.at()
      });

      ports.refreshLease(updated, updated.children.find((item) => item.childId === childId)!);
      ports.broadcast('studio-changed', {
        intentId,
        childId,
        modelId: record.modelId,
        status: 'failed'
      });
    }
  };

  return {
    publishFile,
    refreshOutput,
    downloadResult,
  };
}
