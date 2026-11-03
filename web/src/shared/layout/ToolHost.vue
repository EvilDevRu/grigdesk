<template>
  <aside v-if="dockCapable" class="tool-rail" :aria-label="t('core.panelTools')">
    <UiIconButton v-for="item in railItems" :key="item.id"
                  :ref="(value) => setRailButton(item.id, value)" role="rail"
                  data-context="tool-rail-item"
                  class="tool-rail-item" :class="{ active: presentedTool === item.id }"
                  v-tooltip.left="railTitle(item)" :label="railTitle(item)"
                  :pressed="presentation === 'dock' && presentedTool === item.id"
                  @click="clickRail(item)">
      <span class="rail-mark">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
             stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path :d="navIconPath(item.icon)" />
        </svg>
        <NavigationCount :badge="toolBadges[item.id]" />
      </span>
      <span v-if="item.id === 'terminal' && ['open', 'connecting'].includes(String(dock.runtime.terminal?.status))"
            class="runtime-dot" :class="String(dock.runtime.terminal?.status || '')" aria-hidden="true"></span>
    </UiIconButton>
  </aside>

  <template v-for="item in tools" :key="item.id">
    <ToolDock v-if="dock.mounted[item.id] && !dock.windowOwners[item.id]"
              :ref="(value) => setDockRef(item.id, value)" :mode="modeOf(item.id)"
              :detachable="canDetach(item.id)" @detach="detach(item.id)"
              :label="item.label" :width="dock.width" :min-width="minWidth" :max-width="maxWidth"
              :workspace="route.meta.layout === 'workspace'"
              :expanded="expandedOf(item.id)" :expanded-width="contentWidth"
              @hide="hideDock(item.id)" @toggle-expanded="toggleDockExpanded"
              @resize="resize($event)" @resize-end="resize($event, true)">
      <UiInlineMessage v-if="dock.runtime[item.id]?.transferError" tone="danger">
        {{ dock.runtime[item.id]?.transferError }}
      </UiInlineMessage>
      <component :is="item.component" :ref="(value: unknown) => setPanelRef(item.id, value)"
                 v-bind="item.panelProps || {}"
                 :active="presentedTool === item.id" :compact="compactOf(item.id)"
                 :presentation="modeOf(item.id)" :intents="dock.intents[item.id] || []"
                 @consume-intent="consumeIntent(item.id, $event)"
                 @status="onStatus(item.id, $event)" @context="onContext(item.id, $event)" />
    </ToolDock>
  </template>

  <section v-if="presentation === 'placeholder'" class="tool-placeholder" role="status">
    <span v-if="routeState === 'pending'">{{ t('core.checkingToolAvailability') }}</span>
    <span v-else>
      {{ t('core.plugin') }}{{ routeItem?.label || t('core.tool') }}{{ t('core.isDisabledEnableItInSettingsPlugins') }}
    </span>
  </section>
</template>

<script setup lang="ts">
import { toolWindowText } from '../tools/toolWindowMessages.ts';
import { getToolWindowCoordinator } from '../../stores/toolWindows.ts';
import { useShellStore } from '../../stores/shell.ts';
import { desktopWindowRole } from '../../../../shared/desktop/desktopWindowContract.ts';
import { setToolPanelPorts } from '../tools/toolWindowState.ts';
import type { ToolPanelHandle, ToolWindowState } from '../tools/toolWindowState.ts';

import { uiLocale } from '../../ui.ts';

import { t } from '../../ui.ts';

import type { ToolMeta } from '../tools/catalog.ts';
import { isRecord } from '../../../../shared/lib/objects.ts';

import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useDockStore, MIN_DOCK_WIDTH } from '../../stores/dock.ts';
import { usePluginsStore } from '../../stores/plugins.ts';
import { useTaskShelfStore } from '../../stores/taskShelf.ts';
import { useUiContextSource } from '../../composables/useUiContextSource.ts';
import { navIconPath } from '../navIcons.ts';
import { toolsOf, toolById, toolAvailability } from '../tools/registry.ts';
import { useDockViewport } from '../tools/viewport.ts';
import { comboFromEvent, formatCombo } from '../hotkeys/combo.ts';
import { useHotkeysStore } from '../../stores/hotkeys.ts';
import ToolDock from './ToolDock.vue';
import NavigationCount from './NavigationCount.vue';
import { shelfNavBadge } from '../navBadges.ts';
import { UiIconButton, UiInlineMessage, useUiLayer, vTooltip } from '../../ui';

const route = useRoute();
const router = useRouter();
const dock = useDockStore();
const shell = useShellStore();
const plugins = usePluginsStore();
const shelf = useTaskShelfStore();
const hotkeys = useHotkeysStore();
const toolContext = useUiContextSource('tool', { layer: 'dock', active: false });
const { dockCapable } = useDockViewport();

// Встроенные панели плюс страницы включённых плагинов: состав меняется тумблером
// плагина, поэтому реестр читается как computed, а не один раз при загрузке.
const tools = computed(() => toolsOf(plugins));

// Страница плагина ведётся общим роутом /ext/:id — инструмент называет адрес.
const routeTool = computed(() => {
  if (route.meta?.tool === 'ext') {
    return String(route.params?.id || '') || null;
  }

  return typeof route.meta?.tool === 'string' ? route.meta.tool || null : null;
});
const routeItem = computed(() => toolById(plugins, routeTool.value));
const routeState = computed(() => (routeItem.value
  ? toolAvailability(routeItem.value, plugins)
  : null));
const presentedTool = computed(() => {
  if (routeItem.value) {
    return routeState.value === 'enabled' && !dock.windowOwners[routeItem.value.id]
      ? routeItem.value.id : null;
  }

  const item = toolById(plugins, dock.activeTool);

  return dockCapable.value && dock.isOpen && !dock.windowOwners[dock.activeTool || '']
    && toolAvailability(item, plugins) === 'enabled'
    ? item!.id
    : null;
});
const presentation = computed(() => {
  if (routeItem.value) {
    return routeState.value === 'enabled' ? 'page' : 'placeholder';
  }

  return presentedTool.value ? 'dock' : 'hidden';
});

const railItems = computed(() => tools.value.filter((item) => {
  if (toolAvailability(item, plugins) !== 'enabled') {
    return false;
  }
  if (!item.plugin) {
    return true;
  }

  return plugins.dockNav.some((nav) => nav.id === item.id);
}));

const toolBadges = computed<Record<string, ReturnType<typeof shelfNavBadge>>>(() => ({
  shelf: shelfNavBadge(shelf.rows, uiLocale),
}));

/**
 * Подсказка и доступное имя называют точное число с причинами внимания.
 * Горячая клавиша остаётся частью того же описания кнопки инструмента.
 */
function railTitle(item: ToolMeta) {
  const combo = formatCombo(hotkeys.comboOf(item.id));
  const detail = toolBadges.value[item.id]?.title;

  return [item.label, detail, combo].filter(Boolean).join(' · ');
}

interface FocusHandle extends ToolPanelHandle {
  focus?: () => void;
  focusHeader?: () => void;
}

const contexts = reactive<Record<string, Record<string, unknown>>>({});
const panelRefs = new Map<string | null, FocusHandle>();
const dockRefs = new Map<string | null, FocusHandle>();
const railButtons = new Map<string | null, FocusHandle>();
const contentWidth = ref(0);
const maxWidth = computed(() => Math.max(0, Math.floor(contentWidth.value * 0.7)));
const minWidth = computed(() => Math.min(MIN_DOCK_WIDTH, maxWidth.value));
let contentObserver: ResizeObserver | null = null;
let publishedContextKey = '';

/**
 * Ручка панели содержит только доступные методы фокуса.
 * Значение template ref проверяется до сохранения в реестре.
 */
function isFocusHandle(value: unknown): value is FocusHandle {
  return isRecord(value)
    && (value.focus == null || typeof value.focus === 'function')
    && (value.focusHeader == null || typeof value.focusHeader === 'function');
}

function modeOf(id: string): 'dock' | 'page' | 'hidden' | 'placeholder' {
  return presentedTool.value === id ? presentation.value : 'hidden';
}

function expandedOf(id: string) {
  return modeOf(id) === 'dock' && dock.isExpanded;
}

function compactOf(id: string) {
  return presentedTool.value === id && (presentation.value === 'dock' || !dockCapable.value);
}

function setPanelRef(id: string, value: unknown) {
  if (isFocusHandle(value)) {
    panelRefs.set(id, value);
  } else {
    panelRefs.delete(id);
  }
}

function setDockRef(id: string, value: unknown) {
  if (isFocusHandle(value)) {
    dockRefs.set(id, value);
  } else {
    dockRefs.delete(id);
  }
}

function setRailButton(id: string, value: unknown) {
  if (isFocusHandle(value)) {
    railButtons.set(id, value);
  } else {
    railButtons.delete(id);
  }
}

function consumeIntent(id: string, intentId: number) {
  dock.consume(id, intentId);
}

function onStatus(id: string, value: Record<string, unknown>) {
  dock.setRuntime(id, value);
}

function onContext(id: string, value: Record<string, unknown> | null) {
  if (value) {
    contexts[id] = value;
  } else {
    delete contexts[id];
  }

  syncUiContext();
}

/**
 * Контекст инструмента содержит только подписи и относительный путь файла.
 * Абсолютный treePath и содержимое редактора остаются внутри CodePanel.
 */
function safeToolDetails(id: string, value: Record<string, unknown>) {
  const details: Record<string, unknown> = { id, presentation: presentation.value };

  if (id !== 'code') {
    return details;
  }

  for (const key of ['project', 'repository', 'context', 'tab', 'file']) {
    if (typeof value?.[key] === 'string' && value[key]) {
      details[key] = value[key];
    }
  }

  if (typeof value.line === 'number' && Number.isSafeInteger(value.line) && value.line > 0) {
    details.line = value.line;
  }

  return details;
}

/**
 * Публикует контекст только видимого инструмента, не меняя владельца панели.
 * Повторное обновление подписи сохраняет фокус уже зарегистрированного источника.
 */
function syncUiContext() {
  const id = presentedTool.value;
  const value = id ? contexts[id] : undefined;

  if (!id || !value || presentation.value === 'hidden' || presentation.value === 'placeholder') {
    publishedContextKey = '';
    toolContext.blur();

    return;
  }

  const contextKey = `${id}:${presentation.value}`;
  const next = {
    layer: presentation.value === 'page' ? 'page' : 'dock',
    details: safeToolDetails(id, value),
  };

  if (contextKey !== publishedContextKey) {
    toolContext.focus(next);
  } else {
    toolContext.update(next);
  }

  publishedContextKey = contextKey;
}

function focusPresented({ dockHeader = false } = {}) {
  const id = presentedTool.value;

  if (!id) {
    return;
  }

  nextTick(() => {
    if (dockHeader && presentation.value === 'dock') {
      dockRefs.get(id)?.focusHeader?.();
    } else {
      panelRefs.get(id)?.focus?.();
    }
  });
}

/**
 * Повторный выбор возвращает фокус, а выбор другого инструмента меняет маршрут или док.
 * Один хост сохраняет уже смонтированную панель и очередь её намерений.
 */
async function clickRail(item: ToolMeta) {
  if (await getToolWindowCoordinator(dock)?.activateIfDetached(item.id)) {
    return;
  }

  if (routeTool.value) {
    if (routeTool.value === item.id) {
      focusPresented();
    } else {
      await router.push(item.route);
    }

    return;
  }
  if (dock.isOpen && dock.activeTool === item.id) {
    hideDock(item.id);

    return;
  }

  dock.open(item.id);
  focusPresented({ dockHeader: true });
}

/**
 * Одна и та же команда «показать инструмент» для рейки и для клавиши. На узком
 * экране дока нет вовсе, поэтому там открывается страница инструмента.
 */
function activateTool(item: ToolMeta) {
  if (routeTool.value || dockCapable.value) {
    return clickRail(item);
  }

  return router.push(item.route);
}

/**
 * Глобальные сочетания слушаются в capture: Monaco и терминал забирают клавиши себе,
 * а панель обязана открываться и поверх них. Сочетание без Ctrl/Alt настройка не
 * принимает, поэтому обычный набор текста сюда не доходит.
 */
function onHotkey(event: KeyboardEvent) {
  if (hotkeys.recording || event.defaultPrevented || event.repeat || event.isComposing) {
    return;
  }

  const id = hotkeys.toolByCombo[comboFromEvent(event)];
  const item = id && railItems.value.some((entry) => entry.id === id) ? toolById(plugins, id) : null;

  if (!item) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  activateTool(item);
}

function canDetach(id: string) {
  return toolById(plugins, id)?.detachable !== false
    && desktopWindowRole(navigator.userAgent) === 'main' && shell.capabilities.includes('windows')
    && !['terminal', 'studio3d'].includes(id);
}

function detach(id: string) {
  void getToolWindowCoordinator(dock)?.detach(id);
}

setToolPanelPorts(dock, {
  async exportState(id) {
    return await panelRefs.get(id)?.exportState?.() ?? { id };
  },
  async unmount(id) {
    dock.setMounted(id, false);
    await nextTick();
  },
/**
 * Восстанавливает локальную панель после фактического unmount окна-источника.
 * Lazy-компонент получает снимок только после появления его публичного handle.
 */
  async mount(id, state: ToolWindowState) {
    delete dock.windowOwners[id];
    dock.setMounted(id, true);
    await nextTick();

    const transfersState = ['code', 'shelf', 'ssh', 'db', 'docker'].includes(id);

    for (let attempt = 0; attempt < 200
      && (!panelRefs.get(id) || transfersState && !panelRefs.get(id)?.importState); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    if (transfersState && !panelRefs.get(id)?.importState) {
      throw new Error(toolWindowText('toolStateNotReady'));
    }

    await panelRefs.get(id)?.importState?.(state);
  },
});

function hideDock(id = dock.activeTool) {
  dock.close();
  nextTick(() => railButtons.get(id)?.focus?.());
}

function toggleDockExpanded() {
  dock.toggleExpanded();
}

function closeDockLayer() {
  if (dock.isExpanded) {
    const id = presentedTool.value;

    dock.setExpanded(false);
    nextTick(() => dockRefs.get(id)?.focusHeader?.());

    return;
  }

  hideDock();
}

useUiLayer('dock', {
  id: 'tool-dock',
  enabled: computed(() => presentation.value === 'dock'),
  onEscape: closeDockLayer,
});

function resize(value: number, persist = false) {
  dock.setWidth(value, {
    min: minWidth.value,
    max: maxWidth.value,
    persist,
  });
}

function measureContent() {
  const content = document.querySelector('.shell > .content');

  contentWidth.value = content?.getBoundingClientRect?.().width
    || 0;
  dock.fitWidth({ min: minWidth.value, max: maxWidth.value });
}

watch([presentedTool, presentation, dockCapable], () => {
  const id = presentedTool.value;

  if (id && !dock.windowOwners[id] && presentation.value !== 'placeholder') {
    dock.setMounted(id, true);
  }
  // В route-only режиме живёт только текущая tool-страница. Уход с неё обязан
  // закрыть PTY/Monaco обычным unmount и сбросить runtime-индикатор.
  if (!dockCapable.value) {
    for (const item of tools.value) {
      if (item.id !== id && dock.mounted[item.id]) {
        dock.resetRuntime(item.id);
      }
    }
  }

  syncUiContext();
}, { immediate: true });

watch(dockCapable, (can, was) => {
  measureContent();

  if (!can && was) {
    dock.close();

    for (const item of tools.value) {
      if (item.id !== routeTool.value) {
        dock.resetRuntime(item.id);
      }
    }
  }
});

// Полноширинный overlay целиком скрывает content-колонку. Если человек выбрал
// другой раздел, возвращаем обычную ширину, чтобы результат навигации сразу был
// виден; сам док и живая Terminal/Code-сессия при этом остаются открыты.
watch(() => route.path, (path, previous) => {
  if (path !== previous && dock.isExpanded) {
    dock.setExpanded(false, { persist: false });
  }
});

watch(() => [
  plugins.loaded,
  ...plugins.list.map((item) => `${item.id}:${item.enabled}:${item.nav?.group || ''}`),
], () => {
  if (!plugins.loaded) {
    return;
  }

  for (const item of tools.value.filter((entry) => entry.plugin)) {
    if (toolAvailability(item, plugins) === 'enabled') {
      continue;
    }
    if (dock.activeTool === item.id) {
      dock.close();
    }

    dock.resetRuntime(item.id);
    delete contexts[item.id];
  }

  const valid = railItems.value.some((item) => item.id === dock.activeTool);

  if (!valid) {
    const fallback = railItems.value[0]?.id || null;

    dock.rememberTool(fallback);

    if (!fallback) {
      dock.close();
    }
  }

  syncUiContext();
}, { immediate: true });

watch(
  () => presentedTool.value ? dock.runtime[presentedTool.value]?.focusNonce : null,
  () => focusPresented({ dockHeader: presentation.value === 'dock' }),
);

onMounted(() => {
  const content = document.querySelector('.shell > .content');

  if (content && typeof ResizeObserver !== 'undefined') {
    contentObserver = new ResizeObserver(measureContent);
    contentObserver.observe(content);
  }

  window.addEventListener('resize', measureContent, { passive: true });
  document.addEventListener('keydown', onHotkey, true);
  measureContent();
});
onBeforeUnmount(() => {
  contentObserver?.disconnect?.();
  window.removeEventListener('resize', measureContent);
  document.removeEventListener('keydown', onHotkey, true);
  dock.resetAllRuntime();
});
</script>

<style scoped>
.tool-rail {
  grid-row: 2; grid-column: 3; z-index: 70; min-height: 0;
  display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 4px 0;
  overflow-y: auto; scrollbar-width: none;
  background: var(--sidebar); border-left: 1px solid var(--line);
}
.tool-rail-item { position: relative; }
.rail-mark { display: grid; justify-items: center; align-content: center; gap: 1px; }
.runtime-dot { position: absolute; right: 3px; bottom: 3px; width: 6px; height: 6px; border-radius: 50%;
  background: var(--good); box-shadow: 0 0 0 2px var(--sidebar); }
.runtime-dot.connecting { background: var(--warn); }
.tool-placeholder { grid-row: 2; grid-column: 2; z-index: 20; min-width: 0; min-height: 0;
  display: grid; place-items: center; padding: var(--page-gutter); background: var(--ground); color: var(--ink-mid);
  text-align: center; line-height: 1.55; }
@media (max-width: 899px) { .tool-rail { display: none; } }
</style>
