// Новый блок имеет отдельный каталог и отдельный валидированный writer.
// Старые локальные ручки продолжают пользоваться своим контрактом.

import type { FastifyInstance } from 'fastify';
import type { ExecutorAdapter } from '../../lib/executors/index.ts';
import type { PrefsStore } from '../../lib/prefsStore.ts';
import { PrefsCorruptedError } from '../../lib/prefsStore.ts';
import {
  decodeProviderSettingsOverrideRequest,
  ProviderSettingsContractError,
} from '../../../../shared/chat/providerSettingsContracts.ts';
import { ProviderSettingsCatalogCache } from '../../lib/executorSettings/catalog.ts';
import { nativeSettingsContext } from '../../lib/executorSettings/context.ts';
import { NativeSettingsError } from '../../lib/executorSettings/errors.ts';
import {
  readNativeSettingsStorage,
  updateNativeSettingsOverride,
} from '../../lib/executorSettings/overrides.ts';
import { projectNativeSettingsCatalog } from '../../lib/executorSettings/projection.ts';

export interface ProviderNativeSettingsOptions {
  config: unknown;
  prefs?: PrefsStore;
  adaptersOf: () => Promise<Map<string, ExecutorAdapter>>;
}

interface NativeSettingsRoute {
  Params: { id: string };
  Querystring: { refresh?: string };
  Body: unknown;
}

/**
 * Обнаружение выполняется только при обращении к каталогу выбранной карточки.
 * Общий реестр не оплачивает запуск CLI ради нативных настроек.
 */
export function registerProviderNativeSettings(
  fastify: FastifyInstance,
  { config, prefs, adaptersOf }: ProviderNativeSettingsOptions,
): void {
  const cache = new ProviderSettingsCatalogCache();

  fastify.get<NativeSettingsRoute>('/api/providers/:id/settings/catalog', async (request, reply) => {
    const adapter = (await adaptersOf()).get(request.params.id);

    if (!adapter) {
      return reply.code(404).send({ error: 'unknown_provider' });
    }

    try {
      const context = await nativeSettingsContext(adapter, config);
      const read = adapter.nativeSettings
        ? await cache.read(adapter.nativeSettings, context, { refresh: request.query.refresh === '1' })
        : cache.peek(context);
      const storage = readNativeSettingsStorage(prefs?.readForWrite().providerSettings, adapter.id);

      return projectNativeSettingsCatalog(read, storage);
    } catch (error) {
      const code = error instanceof NativeSettingsError ? error.code : 'prefs_corrupted';

      return reply.code(500).send({ error: code, message: 'Не удалось прочитать настройки исполнителя' });
    }
  });

  fastify.post<NativeSettingsRoute>('/api/providers/:id/settings/overrides', async (request, reply) => {
    const adapter = (await adaptersOf()).get(request.params.id);

    if (!adapter) {
      return reply.code(404).send({ error: 'unknown_provider' });
    }

    try {
      const operation = decodeProviderSettingsOverrideRequest(request.body);

      if (operation.operation === 'set' && !adapter.nativeSettings) {
        throw new NativeSettingsError('settings_unavailable', 503, 'Источник нативных настроек недоступен');
      }

      const read =
        operation.operation === 'set' && adapter.nativeSettings
          ? await cache.read(adapter.nativeSettings, await nativeSettingsContext(adapter, config), {
              refresh: true,
            })
          : cache.peekProvider(adapter.id);

      if (!prefs) {
        throw new NativeSettingsError('settings_storage_invalid', 500, 'Хранилище настроек недоступно');
      }

      const result = updateNativeSettingsOverride(
        prefs,
        adapter.id,
        operation,
        read,
        () => operation.operation === 'unset' || cache.isCurrent(read),
      );

      return {
        ok: true,
        changed: result.changed,
        catalog: projectNativeSettingsCatalog(read, result.storage),
      };
    } catch (error) {
      if (error instanceof ProviderSettingsContractError) {
        return reply
          .code(400)
          .send({ error: 'bad_settings_request', message: 'Некорректная операция настройки' });
      }

      if (error instanceof NativeSettingsError) {
        return reply.code(error.statusCode).send({ error: error.code, message: error.message });
      }

      const code = error instanceof PrefsCorruptedError ? 'prefs_corrupted' : 'settings_storage_invalid';

      return reply.code(500).send({ error: code, message: 'Не удалось сохранить настройки исполнителя' });
    }
  });
}
