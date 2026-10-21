import { localeTranslator } from '../../../shared/i18n/catalogs.ts';
// Плагины GrigDesk: список с сервера, вкл/выкл, настройки.
// Питает блок плагинов в сайдбаре (под разделителем) и вкладку «Настройки → Плагины».
import { uiLocalePort as uiLocale } from '../shared/uiLocalePort.ts';
import { translator } from '../../../shared/i18n/catalogs.ts';
import { classifyWriteError } from '../features/settings/contracts.ts';
import { defineStore } from 'pinia';
import { api, failureText } from '../shared/apiClient.ts';
import { pluginPageRoute } from '../shared/tools/catalog.ts';
import { normalizePluginCategory } from '../../../shared/plugins/pluginsContracts.ts';
import { decodeOptionalInstall } from '../shared/pluginInstallApi.ts';

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
    to: !plugin.system && plugin.web ? pluginPageRoute(plugin.id) : plugin.nav.path,
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

const t = localeTranslator(uiLocale);

export const usePluginsStore = defineStore('plugins', {
  state: () => ({
    list: [],
    loaded: false,
    loadError: null,
    restartPending: {},
  }),
  getters: {
    // Размещение объявляет manifest, но Vue-страницу/панель он не загружает.
    navItems: (s) => sortNavItems(s.list.filter((plugin) => plugin.enabled && plugin.nav)
      .map(normalizeNavItem).filter(Boolean)).map((item) => ({
        ...item,
        sourceLabel: item.label,
        label: s.list.find((plugin) => plugin.id === item.id)?.system
          ? translator.t(uiLocale.value, `core.builtinNavigation.${item.id}`, {}, item.label)
          : item.label,
      })),
    railNav() { return this.navItems.filter((item) => item.group === 'rail'); },
    toolsNav() { return this.navItems.filter((item) => item.group === 'tools'); },
    dockNav() { return this.navItems.filter((item) => item.group === 'dock'); },
    // Страницы пользовательских плагинов: включённые, со своей папкой web и пунктом
    // навигации. Из них реестр панелей собирает инструменты рейки.
    webPages: (s) => s.list
      .filter((p) => p.enabled && !p.system && p.web && p.nav)
      .map((p) => ({
        id: p.id,
        src: p.web,
        label: p.nav.label || p.name,
        icon: p.nav.icon || 'plugin',
        order: typeof p.nav.order === 'number' ? p.nav.order : Number.MAX_SAFE_INTEGER,
        group: NAV_GROUPS.includes(p.nav.group) ? p.nav.group : 'rail',
      })),
    byId: (s) => (id) => s.list.find((p) => p.id === id) || null,
    enabled: (s) => (id) => !!s.list.find((p) => p.id === id)?.enabled,
    // Включено ли размещение плагина в слоте. Незаявленное в манифесте место — выключено:
    // реестр веба может знать больше, чем манифест, но решает манифест.
    placementEnabled: (s) => (id, slot) => !!(s.list.find((p) => p.id === id)?.placements || [])
      .find((placement) => placement.slot === slot)?.enabled,
  },
  actions: {
    /**
     * Полный ответ проверяется до публикации install capabilities в каталоге.
     * Повреждённая карточка сохраняет прежний список целиком, без смешения DTO.
     */
    async load() {
      try {
        const { plugins } = await api.get('/api/plugins');

        if (!Array.isArray(plugins)) {
          throw new Error(t('settings.invalidPluginCatalog'));
        }

        const checked = plugins.map((plugin) => ({
          ...plugin,
          ...(Object.hasOwn(plugin, 'install') ? { install: decodeOptionalInstall(plugin.install) } : {}),
        }));

        this.list = checked;
        this.loaded = true;
        this.loadError = null;
      } catch (error) {
        this.loadError = error instanceof Error ? error.message : t('settings.pluginCatalogFailure');
      }
    },
    /**
     * Доменный тумблер вызывается только из операции сохранения, возвращая явный исход.
     * Ошибка восстанавливает прежнее состояние и не выглядит успешным resolved Promise.
     */
    async toggle(id, enabled) {
      const p = this.byId(id);

      if (!p) {
        return {
          ok: false,
          outcome: 'failed',
          message: t('settings.pluginGone'),
        };
      }

      const before = p.enabled;

      p.enabled = enabled;

      try {
        const reply = await api.post(`/api/plugins/${encodeURIComponent(id)}/toggle`, { enabled });

        if (reply?.ok !== true || typeof reply.enabled !== 'boolean') {
          p.enabled = before;

          return {
            ok: false,
            outcome: reply?.ok === false ? 'failed' : 'unknown',
            message: t('settings.pluginToggleUnconfirmed'),
          };
        }

        p.enabled = reply.enabled;

        if (p.needsRestart) {
          this.restartPending = { ...this.restartPending, [id]: true };
        }
        if (id === 'analysis') {
          const { useAnalysisStore } = await import('./analysis.js');
          const analysis = useAnalysisStore();

          if (p.enabled) {
            analysis.startPolling();
          } else {
            analysis.error = null;
            analysis.stopPolling();
          }
        }

        return { ok: true, enabled: reply.enabled };
      } catch (error) {
        p.enabled = before;

        return { ...classifyWriteError(error, uiLocale), message: failureText(error) };
      }
    },
    /**
     * Сервер заменяет values целиком; полный набор собирает адаптер общей сессии.
     * Только явный ответ обновляет доменное состояние и подтверждает поля формы.
     */
    async saveSettings(id, values, placements = null) {
      const p = this.byId(id);

      if (!p) {
        return {
          ok: false,
          outcome: 'failed',
          message: t('settings.pluginGone'),
        };
      }

      try {
        const reply = await api.put(`/api/plugins/${encodeURIComponent(id)}/settings`, {
          values,
          ...(placements && { placements }),
        });

        if (reply?.ok !== true || !reply.values || typeof reply.values !== 'object') {
          return {
            ok: false,
            outcome: reply?.ok === false ? 'failed' : 'unknown',
            message: t('settings.pluginSettingsUnconfirmed'),
          };
        }

        p.values = reply.values;

        if (Array.isArray(reply.placements)) {
          p.placements = reply.placements;
        }

        return {
          ok: true,
          values: reply.values,
          placements: reply.placements,
        };
      } catch (error) {
        return { ...classifyWriteError(error, uiLocale), message: failureText(error) };
      }
    },
    // Готовность плагина: ручку объявляет манифест, форму ответа — общий контракт.
    // Установка запускается по пункту и только по нажатию человека.
    async loadSetup(plugin, signal) {
      return api.get(plugin.setup.path, { signal });
    },
    async runSetup(plugin, itemId) {
      return api.post(`${plugin.setup.path}/${encodeURIComponent(itemId)}`, {});
    },
    async cancelSetup(plugin, itemId) {
      return api.post(`${plugin.setup.path}/${encodeURIComponent(itemId)}/cancel`, {});
    },
  },
});
