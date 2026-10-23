import { reactive } from 'vue';

import { useSettingsStore } from '../../stores/settings.ts';

/**
 * Список и вкладки принадлежат открытой сессии настроек, а не локальному mount страницы.
 * Это сохраняет выбор при возврате и не создаёт второй черновик параметров плагинов.
 */
export function usePluginMarketplaceState() {
  const settings = useSettingsStore();

  return settings.sessionService('plugin-marketplace', () => reactive({
    tab: settings.entityId ? 'installed' : 'catalog',
    query: '',
    category: 'all',
    origin: 'all',
    detailId: '',
    showDetail: false,
    detailTab: 'description',
    version: '',
  }));
}
