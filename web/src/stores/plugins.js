// Плагины кокпита: список с сервера, вкл/выкл, настройки.
// Питает блок плагинов в сайдбаре (под разделителем) и вкладку «Настройки → Плагины».
import { defineStore } from 'pinia';
import { api } from '../shared/apiClient.ts';
import { normalizePluginCategory } from '../../../shared/pluginsContracts.ts';

export const NAV_GROUPS = ['rail', 'tools', 'dock'];

// Совместимость при поэтапной выкладке: production-бандл обновляется без рестарта,
// а уже запущенный сервер до рестарта продолжает отдавать старые SYSTEM-манифесты
// без group/order. Только для известных встроенных плагинов восстанавливаем их новое
// положение; пользовательский legacy-manifest по-прежнему честно остаётся в rail.
const LEGACY_SYSTEM_NAV = {
  video: { group: 'tools', order: 10 },
  code: { group: 'dock', order: 10 },
  inbox: { group: 'rail', order: 30 },
  telegram: { group: 'tools', order: 20 },
  github: { group: 'tools', order: 30 },
};

// Тот же случай, что и с nav: свежий бандл встречает ещё не перезапущенный сервер,
// который отдаёт манифесты без category. Без запасной карты все встроенные модули
// уехали бы в «Прочее», и раздел выглядел бы сломанным до рестарта.
const LEGACY_SYSTEM_CATEGORY = {
  video: 'work',
  code: 'dev',
  analysis: 'work',
  shelf: 'work',
  inbox: 'work',
  telegram: 'work',
  github: 'work',
  knowledge: 'knowledge',
  ssh: 'dev',
  db: 'dev',
  docker: 'dev',
  showcase: 'knowledge',
};

/** Категория плагина для раздела настроек: заявленная манифестом или запасная. */
export function pluginCategoryOf(plugin) {
  const declared = plugin?.category
    || (plugin?.system ? LEGACY_SYSTEM_CATEGORY[plugin.id] : '');

  return normalizePluginCategory(declared);
}

export function normalizeNavItem(plugin) {
  if (!plugin?.nav?.path) return null;
  const legacy = plugin.system && plugin.nav.group == null
    ? LEGACY_SYSTEM_NAV[plugin.id]
    : null;
  const requested = String(plugin.nav.group ?? legacy?.group ?? 'rail');
  const group = NAV_GROUPS.includes(requested) ? requested : 'rail';
  const rawOrder = plugin.nav.order ?? legacy?.order;
  const order = typeof rawOrder === 'number' ? rawOrder : Number.NaN;
  return {
    id: plugin.id,
    to: plugin.nav.path,
    label: plugin.nav.label,
    icon: plugin.nav.icon || 'plugin',
    group,
    order: Number.isFinite(order) ? order : Number.MAX_SAFE_INTEGER,
  };
}

export function sortNavItems(items) {
  return [...items].sort((a, b) => a.order - b.order
    || String(a.label).localeCompare(String(b.label), 'ru')
    || String(a.id).localeCompare(String(b.id), 'ru'));
}

export const usePluginsStore = defineStore('plugins', {
  state: () => ({ list: [], loaded: false }),
  getters: {
    // Размещение объявляет manifest, но Vue-страницу/панель он не загружает.
    navItems: (s) => s.list.filter((p) => p.enabled && p.nav)
      .map(normalizeNavItem).filter(Boolean).sort((a, b) => a.order - b.order
        || String(a.label).localeCompare(String(b.label), 'ru')
        || String(a.id).localeCompare(String(b.id), 'ru')),
    railNav() { return this.navItems.filter((item) => item.group === 'rail'); },
    toolsNav() { return this.navItems.filter((item) => item.group === 'tools'); },
    dockNav() { return this.navItems.filter((item) => item.group === 'dock'); },
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
      try {
        await api.post(`/api/plugins/${id}/toggle`, { enabled });
        if (id === 'analysis') {
          const { useAnalysisStore } = await import('./analysis.js');
          const analysis = useAnalysisStore();
          if (enabled) analysis.startPolling();
          else {
            analysis.error = null;
            analysis.stopPolling();
          }
        }
      }
      catch { p.enabled = !enabled; }
    },
    async saveSettings(id, values) {
      const p = this.byId(id);
      if (!p) return;
      const r = await api.put(`/api/plugins/${id}/settings`, { values });
      p.values = r.values;
    },
    // Готовность плагина: ручку объявляет манифест, форму ответа — общий контракт.
    // Установка запускается по пункту и только по нажатию человека.
    async loadSetup(plugin) {
      return api.get(plugin.setup.path);
    },
    async runSetup(plugin, itemId) {
      return api.post(`${plugin.setup.path}/${encodeURIComponent(itemId)}`, {});
    },
    async cancelSetup(plugin, itemId) {
      return api.post(`${plugin.setup.path}/${encodeURIComponent(itemId)}/cancel`, {});
    },
  },
});
