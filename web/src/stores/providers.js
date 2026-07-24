// Реестр LLM-исполнителей (GET /api/providers): топбар рисует иконки доступных,
// схемы/маршруты смогут выбирать исполнителя по стабильному id из этого списка.
import { defineStore } from 'pinia';
import { api } from '../shared/api-client.js';

export const useProvidersStore = defineStore('providers', {
  state: () => ({ providers: [], loaded: false }),
  actions: {
    async load(refresh = false) {
      try {
        const { providers } = await api.get(`/api/providers${refresh ? '?refresh=1' : ''}`);
        this.providers = providers || [];
      } catch { /* сервер молчит — иконок просто нет */ }
      this.loaded = true;
    },
  },
});
