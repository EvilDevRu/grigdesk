import type { FastifyInstance } from 'fastify';
import type { PluginCore, PluginFileLockOptions } from '../../../../packages/plugin-types/src/server.ts';
import type { PluginRuntimeServices } from '../../../../packages/plugin-types/src/coreRuntime.ts';
import type { DocumentReader } from '../../lib/documents/reader.ts';
import { getProviderAdapters } from '../../lib/executors/index.ts';
import { acquireKernelFileLock } from '../../lib/kernelLock.ts';
import { withPathLock } from '../../lib/pathLock.ts';
import { parseByteRange } from '../../lib/httpRange.ts';
import { createProviderCapabilities } from './providerCapabilities.ts';
import { decodePluginNotification } from '../../../../shared/plugins/pluginNotifications.ts';

/**
 * Набор замыкает идентификатор плагина и использует экземпляры сервисов приложения.
 * Читатель выдаётся только на чтение; отсутствие зависимости обнаруживается при вызове.
 */
export function createPluginCore(
  fastify: FastifyInstance, pluginId: string, reader?: DocumentReader,
  runtime?: PluginRuntimeServices,
  notificationGeneration?: () => string | null,
): PluginCore {
  const capabilities = createProviderCapabilities();
  const documents = () => {
    if (!reader) {
      throw new Error('Чтение документов недоступно: экземпляр reader не передан приложением.');
    }

    return reader;
  };

  return Object.freeze({
    ...runtime,
    ...(runtime ? {
      modelText: (input: Parameters<PluginRuntimeServices['modelText']>[0]) => runtime.modelText({
        ...input,
        beforeCall: () => {
          if (!fastify.pluginEnabled(pluginId)) {
            throw new Error('plugin_disabled');
          }

          input.beforeCall?.();
        },
      }),
    } : {}),
    getProviders: async (type: unknown) => capabilities(await getProviderAdapters(), type),
    /**
     * Имя SSE и идентификатор задаёт ядро, данные остаются внутри отдельного поля.
     * Проверка имени не позволяет вставить дополнительный фрейм в общий поток.
     */
    emit(event: string, data?: unknown) {
      if (typeof event !== 'string' || !event.length || event.length > 128
        || /[\x00-\x1f\x7f]/u.test(event)) {
        throw new TypeError(
          'Имя события плагина должно быть строкой до 128 символов без управляющих знаков.',
        );
      }

      if (event === 'notification') {
        const notification = decodePluginNotification(data);

        if (!notification) {
          throw new TypeError('Некорректное серверное уведомление плагина.');
        }

        const generation = notificationGeneration?.();

        if (generation && typeof fastify.sse?.broadcast === 'function') {
          fastify.sse.broadcast('plugin-event', {
            pluginId,
            generation,
            event,
            data: notification,
          });
        }

        return;
      }

      if (typeof fastify.sse?.broadcast !== 'function') {
        throw new Error('Общий поток событий недоступен.');
      }

      fastify.sse.broadcast('plugin-event', {
        pluginId,
        event,
        data: data === undefined ? null : data,
      });
    },
    withPathLock,
    /**
     * Публичный фасад принимает только объявленные настройки kernel flock.
     * Дескриптор, выбор binary и фабрика ошибок остаются внутри ядра.
     */
    async acquireKernelFileLock(options: PluginFileLockOptions) {
      const handle = await acquireKernelFileLock({
        lockPath: options.lockPath,
        mode: options.mode,
        timeoutMs: options.timeoutMs,
        timeoutCode: options.timeoutCode,
        unavailableCode: options.unavailableCode,
        lostCode: options.lostCode,
        label: options.label,
      });

      return Object.freeze({
        assertHeld: () => handle.assertHeld(),
        assertPathIdentity: () => handle.assertPathIdentity(),
        assertPathIdentityNow: () => handle.assertPathIdentityNow(),
        release: () => handle.release(),
      });
    },
    parseByteRange,
    documents: Object.freeze({
      roots: (...args: Parameters<DocumentReader['roots']>) => documents().roots(...args),
      resolveAbsolute: (...args: Parameters<DocumentReader['resolveAbsolute']>) =>
        documents().resolveAbsolute(...args),
      read: (...args: Parameters<DocumentReader['read']>) => documents().read(...args),
      readAsset: (...args: Parameters<DocumentReader['readAsset']>) => documents().readAsset(...args),
    }),
  });
}
