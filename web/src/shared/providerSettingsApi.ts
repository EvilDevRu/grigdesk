// Сетевые ответы получают доменный тип только после runtime-декодера.
// Сохранение подтверждает запись prefs для следующего открытия сессии.

import { api } from './apiClient.ts';
import type { ApiClient } from './apiClient.ts';
import { decodeProviderSettingsCatalog } from '../../../shared/providerSettingsContracts.ts';
import type {
  ProviderSettingsCatalog,
  ProviderSettingsOverrideRequest,
  ProviderSettingsOverrideResponse,
} from '../../../shared/providerSettingsContracts.ts';

export interface ProviderSettingsApi {
  catalog: (id: string, refresh?: boolean) => Promise<ProviderSettingsCatalog>;
  override: (
    id: string,
    request: ProviderSettingsOverrideRequest,
  ) => Promise<ProviderSettingsOverrideResponse>;
}

/**
 * API использует отдельные адреса каталога и overrides, сохраняя старые ручки.
 * Клиент не передаёт путь файла, cwd или метод нативного RPC.
 */
export function createProviderSettingsApi(
  client: Pick<ApiClient, 'get' | 'post'> = api,
): ProviderSettingsApi {
  return {
    async catalog(id, refresh = false) {
      const suffix = refresh ? '?refresh=1' : '';
      const value = await client.get(`/api/providers/${encodeURIComponent(id)}/settings/catalog${suffix}`);

      return decodeProviderSettingsCatalog(value);
    },
    /**
     * Успешный HTTP-ответ подтверждает запись только после проверки wire-формы.
     * Форма получает проверенный серверный каталог и его новую ревизию.
     */
    async override(id, request) {
      const value = await client.post(`/api/providers/${encodeURIComponent(id)}/settings/overrides`, request);
      const response = value as {
        ok?: unknown;
        changed?: unknown;
        catalog?: unknown;
      } | null;

      if (response?.ok !== true || typeof response.changed !== 'boolean') {
        throw new Error('Некорректный ответ сохранения настроек');
      }

      return {
        ok: true,
        changed: response.changed,
        catalog: decodeProviderSettingsCatalog(response.catalog),
      };
    },
  };
}

export const providerSettingsApi = createProviderSettingsApi();
