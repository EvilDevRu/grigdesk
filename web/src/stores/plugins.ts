import { localeTranslator } from '../../../shared/i18n/catalogs.ts';
// Плагины GrigDesk: список с сервера, вкл/выкл, настройки.
// Питает блок плагинов в сайдбаре (под разделителем) и вкладку «Настройки → Плагины».
import { uiLocalePort as uiLocale } from '../shared/uiLocalePort.ts';
import { translator } from '../../../shared/i18n/catalogs.ts';
import { classifyWriteError } from '../features/settings/contracts.ts';
import { isRecord } from '../../../shared/lib/objects.ts';
import type { PluginListItem, PluginPlacementState } from '../../../shared/plugins/pluginsContracts.ts';
import { defineStore } from 'pinia';
import { ApiError, api, failureText } from '../shared/apiClient.ts';
import { pluginPageRoute } from '../shared/tools/catalog.ts';
import { normalizePluginCategory } from '../../../shared/plugins/pluginsContracts.ts';
import { decodeOptionalInstall } from '../shared/pluginInstallApi.ts';
import { isPluginModuleDescriptor } from '../pluginRuntime/descriptor.ts';

type PluginCard = Partial<PluginListItem> & Pick<PluginListItem, 'id' | 'name' | 'enabled'>;
type NavItem = {
  id: string;
  to: string;
  label: string;
  icon: string;
  group: string;
  order: number;
};

/**
 * Старые манифесты могут опускать новые поля, но переданные поля проверяются.
 * Список сохраняет неизвестные расширения и исходные значения без проекции.
 */
function isPlugin(value: unknown): value is PluginCard {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.name !== 'string'
    || typeof value.enabled !== 'boolean') {
    return false;
  }

  return ['version', 'description', 'category', 'web', 'serverError'].every((key) => (
    value[key] == null || typeof value[key] === 'string'
  )) && ['system', 'needsRestart'].every((key) => value[key] == null || typeof value[key] === 'boolean')
    && (value.nav == null || (isRecord(value.nav)
      && ['path', 'label', 'icon', 'group'].every((key) => (
        value.nav && isRecord(value.nav) && (value.nav[key] == null || typeof value.nav[key] === 'string')
      )) && (value.nav.order == null || typeof value.nav.order === 'number')))
    && (value.settings == null || (Array.isArray(value.settings) && value.settings.every(isRecord)))
    && (value.values == null || isRecord(value.values))
    && (value.placements == null || isPlacements(value.placements))
    && (value.webModule == null || isPluginModuleDescriptor(value.id, value.webModule));
}

/**
 * Размещения меняют доступность слотов, поэтому принимаются только полным списком.
 * Проверка используется и карточкой, и подтверждением сохранения настроек.
 */
function isPlacements(value: unknown): value is PluginPlacementState[] {
  return Array.isArray(value) && value.every((item) => isRecord(item)
    && typeof item.slot === 'string' && typeof item.enabled === 'boolean'
    && (item.label == null || typeof item.label === 'string'));
}

/**
 * Отказ проверки плагина не означает внешнего изменения настроек.
 * Только код revision_conflict сохраняет смысл конфликта версий; HTTP-код и причина не меняются.
 */
function pluginWriteFailure(error: unknown): ReturnType<typeof classifyWriteError> {
  const failure = { ...classifyWriteError(error, uiLocale), message: failureText(error) };

  if (error instanceof ApiError && error.status === 409 && isRecord(error.data)
    && typeof error.data.error === 'string'
    && error.data.error !== 'revision_conflict') {
    return { ...failure, outcome: 'failed' };
  }

  return failure;
}

export const NAV_GROUPS = ['rail', 'tools', 'dock'];

// Совместимость при поэтапной выкладке: production-бандл обновляется без рестарта,
// а уже запущенный сервер до рестарта продолжает отдавать старые SYSTEM-манифесты
// без group/order. Только для известных встроенных плагинов восстанавливаем их новое
// положение; пользовательский legacy-manifest по-прежнему честно остаётся в rail.
const LEGACY_SYSTEM_NAV: Record<string, { group: string; order: number }> = {
  video: { group: 'tools', order: 10 },
  code: { group: 'dock', order: 10 },
  inbox: { group: 'rail', order: 30 },
  telegram: { group: 'tools', order: 20 },
  github: { group: 'tools', order: 30 },
};

// Тот же случай, что и с nav: свежий бандл встречает ещё не перезапущенный сервер,
// который отдаёт манифесты без category. Без запасной карты все встроенные модули
// уехали бы в «Прочее», и раздел выглядел бы сломанным до рестарта.
const LEGACY_SYSTEM_CATEGORY: Record<string, string> = {
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

/**
 * Категория берётся из манифеста или из карты совместимости системных плагинов.
 * Неизвестное значение нормализуется общим правилом раздела настроек.
 */
export function pluginCategoryOf(plugin: PluginCard | null | undefined) {
  const declared = plugin?.category
    || (plugin?.system ? LEGACY_SYSTEM_CATEGORY[plugin.id] : '');

  return normalizePluginCategory(declared);
}

/**
 * Размещение объявляет манифест, для старых системных карточек действует запасная карта.
 * Пользовательский плагин без нового group остаётся в рейке.
 */
export function normalizeNavItem(plugin: PluginCard): NavItem | null {
  if (!plugin?.nav?.path) {
    return null;
  }

  const legacy = plugin.system && plugin.nav.group == null
    ? LEGACY_SYSTEM_NAV[plugin.id]
    : null;
  const requested = String(plugin.nav.group ?? legacy?.group ?? 'rail');
  const group = NAV_GROUPS.includes(requested) ? requested : 'rail';
  const rawOrder = plugin.nav.order ?? legacy?.order;
  const order = typeof rawOrder === 'number' ? rawOrder : Number.NaN;

  return {
    id: plugin.id,
    to: !plugin.system && (plugin.web || plugin.webModule) ? pluginPageRoute(plugin.id) : plugin.nav.path,
    label: plugin.nav.label,
    icon: plugin.nav.icon || 'plugin',
    group,
    order: Number.isFinite(order) ? order : Number.MAX_SAFE_INTEGER,
  };
}

/**
 * Сортировка сохраняет порядок манифеста, затем русскую подпись и стабильный id.
 * Входной список остаётся неизменным для остальных читателей стора.
 */
export function sortNavItems(items: NavItem[]) {
  return [...items].sort((a, b) => a.order - b.order
    || String(a.label).localeCompare(String(b.label), 'ru')
    || String(a.id).localeCompare(String(b.id), 'ru'));
}

const t = localeTranslator(uiLocale);

export const usePluginsStore = defineStore('plugins', {
  state: () => ({
    list: [] as PluginCard[],
    loaded: false,
    loadError: null as string | null,
    restartPending: {} as Record<string, boolean>,
  }),
  getters: {
    // Размещение объявляет manifest, но Vue-страницу/панель он не загружает.
    navItems: (s) => sortNavItems(s.list.filter((plugin) => plugin.enabled && plugin.nav)
      .map(normalizeNavItem).filter((item): item is NavItem => item !== null)).map((item) => ({
        ...item,
        sourceLabel: item.label,
        label: s.list.find((plugin) => plugin.id === item.id)?.system
          ? translator.t(uiLocale.value, `core.builtinNavigation.${item.id}`, {}, item.label)
          : item.label,
      })),
    railNav(): NavItem[] {
      return this.navItems.filter((item) => item.group === 'rail');
    },
    toolsNav(): NavItem[] {
      return this.navItems.filter((item) => item.group === 'tools');
    },
    dockNav(): NavItem[] {
      return this.navItems.filter((item) => item.group === 'dock');
    },
    // Страницы пользовательских плагинов: включённые, со своей папкой web и пунктом
    // навигации. Из них реестр панелей собирает инструменты рейки.
    webPages: (s) => s.list
      .filter((p) => p.enabled && !p.system && p.web && p.nav)
      .map((p) => ({
        id: p.id,
        src: p.web!,
        label: p.nav!.label || p.name,
        icon: p.nav!.icon || 'plugin',
        order: typeof p.nav!.order === 'number' ? p.nav!.order : Number.MAX_SAFE_INTEGER,
        group: NAV_GROUPS.includes(p.nav!.group) ? p.nav!.group : 'rail',
      })),
    modulePages: (s) => s.list
      .filter((p) => p.enabled && !p.system && p.webModule && p.nav)
      .map((p) => ({
        id: p.id,
        descriptor: p.webModule!,
        label: p.nav!.label || p.name,
        icon: p.nav!.icon || 'plugin',
        order: typeof p.nav!.order === 'number' ? p.nav!.order : Number.MAX_SAFE_INTEGER,
      })),
    byId: (s) => (id: string) => s.list.find((p) => p.id === id) || null,
    enabled: (s) => (id: string) => !!s.list.find((p) => p.id === id)?.enabled,
    // Включено ли размещение плагина в слоте. Незаявленное в манифесте место — выключено:
    // реестр веба может знать больше, чем манифест, но решает манифест.
    placementEnabled: (s) => (id: string, slot: string) => !!(s.list
      .find((p) => p.id === id)?.placements || [])
      .find((placement) => placement.slot === slot)?.enabled,
  },
  actions: {
    /**
     * Полный ответ проверяется до публикации install capabilities в каталоге.
     * Повреждённая карточка сохраняет прежний список целиком, без смешения DTO.
     */
    async load() {
      try {
        const reply = await api.get('/api/plugins');
        const plugins = isRecord(reply) ? reply.plugins : undefined;

        if (!Array.isArray(plugins) || !plugins.every(isPlugin)) {
          throw new Error(t('settings.invalidPluginCatalog'));
        }

        const checked = plugins.map((plugin) => ({
          ...plugin,
          ...(Object.hasOwn(plugin, 'install') ? { install: decodeOptionalInstall(plugin.install) } : {}),
        }));

        const restartPending = { ...this.restartPending };

        for (const plugin of checked) {
          if (typeof plugin.needsRestart === 'boolean') {
            restartPending[plugin.id] = plugin.needsRestart;
          }
        }

        this.restartPending = restartPending;
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
    async toggle(id: string, enabled: boolean) {
      const p = this.byId(id);

      if (!p) {
        return {
          ok: false,
          outcome: 'failed',
          message: t('settings.pluginGone'),
        };
      }

      const before = p.enabled;

      try {
        const reply = await api.post(`/api/plugins/${encodeURIComponent(id)}/toggle`, { enabled });

        if (!isRecord(reply) || reply.ok !== true || typeof reply.enabled !== 'boolean') {
          p.enabled = before;

          return {
            ok: false,
            outcome: isRecord(reply) && reply.ok === false ? 'failed' : 'unknown',
            message: t('settings.pluginToggleUnconfirmed'),
          };
        }

        p.enabled = reply.enabled;

        if (typeof reply.needsRestart === 'boolean') {
          p.needsRestart = reply.needsRestart;
          this.restartPending = { ...this.restartPending, [id]: reply.needsRestart };
        } else if (p.needsRestart) {
          this.restartPending = { ...this.restartPending, [id]: true };
        }

        if (id === 'analysis') {
          const { useAnalysisStore } = await import('./analysis.ts');
          const analysis = useAnalysisStore() as ReturnType<typeof useAnalysisStore> & {
            startPolling(): void;
            stopPolling(): void };

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

        return pluginWriteFailure(error);
      }
    },
    /**
     * Сервер заменяет values целиком; полный набор собирает адаптер общей сессии.
     * Только явный ответ обновляет доменное состояние и подтверждает поля формы.
     */
    async saveSettings(id: string, values: Record<string, unknown>,
      placements: PluginPlacementState[] | null = null) {
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

        if (!isRecord(reply) || reply.ok !== true || !isRecord(reply.values)
          || (reply.placements != null && !isPlacements(reply.placements))) {
          return {
            ok: false,
            outcome: isRecord(reply) && reply.ok === false ? 'failed' : 'unknown',
            message: t('settings.pluginSettingsUnconfirmed'),
          };
        }

        p.values = reply.values;

        if (isPlacements(reply.placements)) {
          p.placements = reply.placements;
        }

        return {
          ok: true,
          values: reply.values,
          placements: reply.placements,
        };
      } catch (error) {
        return pluginWriteFailure(error);
      }
    },
    // Готовность плагина: ручку объявляет манифест, форму ответа — общий контракт.
    // Установка запускается по пункту и только по нажатию человека.
    async loadSetup(plugin: Pick<PluginListItem, 'setup'>, signal?: AbortSignal) {
      return api.get(plugin.setup!.path, { signal });
    },
    async runSetup(plugin: Pick<PluginListItem, 'setup'>, itemId: string) {
      return api.post(`${plugin.setup!.path}/${encodeURIComponent(itemId)}`, {});
    },
    async cancelSetup(plugin: Pick<PluginListItem, 'setup'>, itemId: string) {
      return api.post(`${plugin.setup!.path}/${encodeURIComponent(itemId)}/cancel`, {});
    },
  },
});
