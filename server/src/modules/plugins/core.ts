import type { FastifyInstance } from 'fastify';
import type { PluginCore } from '../../../../packages/plugin-types/src/server.ts';
import type { DocumentReader } from '../../lib/documents/reader.ts';
import { getProviderAdapters } from '../../lib/executors/index.ts';
import { acquireKernelFileLock } from '../../lib/kernelLock.ts';
import { withPathLock } from '../../lib/pathLock.ts';
import { parseByteRange } from '../../lib/httpRange.ts';
import { createProviderCapabilities } from './providerCapabilities.ts';

/**
 * Набор замыкает идентификатор плагина и использует экземпляры сервисов приложения.
 * Читатель выдаётся только на чтение; отсутствие зависимости обнаруживается при вызове.
 */
export function createPluginCore(
  fastify: FastifyInstance, pluginId: string, reader?: DocumentReader,
): PluginCore {
  const capabilities = createProviderCapabilities();
  const documents = () => {
    if (!reader) {
      throw new Error('Чтение документов недоступно: экземпляр reader не передан приложением.');
    }

    return reader;
  };

  return Object.freeze({
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
    acquireKernelFileLock,
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
