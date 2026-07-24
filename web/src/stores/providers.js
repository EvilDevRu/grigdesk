// Реестр LLM-исполнителей (GET /api/providers): топбар рисует иконки доступных,
// схемы/маршруты смогут выбирать исполнителя по стабильному id из этого списка.
import { defineStore } from 'pinia';
import { api } from '../shared/api-client.js';

let usageAt = 0;

export const useProvidersStore = defineStore('providers', {
  state: () => ({ providers: [], usage: {}, loaded: false }),
  actions: {
    async load(refresh = false) {
      try {
        const { providers } = await api.get(`/api/providers${refresh ? '?refresh=1' : ''}`);
        this.providers = providers || [];
      } catch { /* сервер молчит — иконок просто нет */ }
      this.loaded = true;
    },
    // Потребление лимитов (прогрессбары в тултипе иконки исполнителя). Кэш минута.
    async loadUsage() {
      if (Date.now() - usageAt < 60_000) return;
      usageAt = Date.now();
      try {
        const { usage } = await api.get('/api/providers/usage');
        this.usage = usage || {};
      } catch { /* эндпоинта нет / сервер молчит — баров просто нет */ }
    },
  },
});
