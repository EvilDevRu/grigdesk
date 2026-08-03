// Плагины кокпита: список с сервера, вкл/выкл, настройки.
// Питает блок плагинов в сайдбаре (под разделителем) и вкладку «Настройки → Плагины».
import { defineStore } from 'pinia';
import { api } from '../shared/api-client.js';

export const usePluginsStore = defineStore('plugins', {
  state: () => ({ list: [], loaded: false }),
  getters: {
    // Пункты сайдбара: только включённые плагины с навигацией.
    navItems: (s) => s.list.filter((p) => p.enabled && p.nav)
      .map((p) => ({ to: p.nav.path, label: p.nav.label, icon: p.nav.icon || 'plugin' })),
    byId: (s) => (id) => s.list.find((p) => p.id === id) || null,
    enabled: (s) => (id) => !!s.list.find((p) => p.id === id)?.enabled,
  },
  actions: {
    async load() {
      try {
        const { plugins } = await api.get('/api/plugins');
        this.list = plugins || [];
        this.loaded = true;
      } catch { /* без сервера блок плагинов просто пуст */ }
    },
    async toggle(id, enabled) {
      const p = this.byId(id);
      if (!p) return;
      p.enabled = enabled; // оптимистично — мгновенный отклик тумблера
      try { await api.post(`/api/plugins/${id}/toggle`, { enabled }); }
      catch { p.enabled = !enabled; }
    },
    async saveSettings(id, values) {
      const p = this.byId(id);
      if (!p) return;
      const r = await api.put(`/api/plugins/${id}/settings`, { values });
      p.values = r.values;
    },
  },
});
