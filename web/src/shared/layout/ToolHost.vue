<template>
  <aside v-if="dockCapable" class="tool-rail" aria-label="Инструменты в панели">
    <UiIconButton v-for="item in railItems" :key="item.id"
                  :ref="(value) => setRailButton(item.id, value)" role="rail"
                  data-context="tool-rail-item"
                  class="tool-rail-item" :class="{ active: presentedTool === item.id }"
                  :title="railTitle(item)" :label="item.label"
                  :pressed="presentation === 'dock' && presentedTool === item.id"
                  @click="clickRail(item)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
           stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path :d="NAV_ICONS[item.icon] || NAV_ICONS.plugin" />
      </svg>
      <span v-if="item.id === 'terminal' && ['open', 'connecting'].includes(dock.runtime.terminal?.status)"
            class="runtime-dot" :class="dock.runtime.terminal.status" aria-hidden="true"></span>
      <span v-if="toolBadges[item.id]" class="tool-badge"
            :class="{ wait: toolBadges[item.id].wait, pulse: toolBadges[item.id].wait }">
        {{ toolBadges[item.id].count }}
      </span>
    </UiIconButton>
  </aside>

  <template v-for="item in TOOL_REGISTRY" :key="item.id">
    <ToolDock v-if="dock.mounted[item.id]"
              :ref="(value) => setDockRef(item.id, value)" :mode="modeOf(item.id)"
              :label="item.label" :width="dock.width" :min-width="minWidth" :max-width="maxWidth"
              :expanded="expandedOf(item.id)" :expanded-width="contentWidth"
              @hide="hideDock(item.id)" @toggle-expanded="toggleDockExpanded"
              @resize="resize($event)" @resize-end="resize($event, true)">
      <component :is="item.component" :ref="(value) => setPanelRef(item.id, value)"
                 :active="presentedTool === item.id" :compact="compactOf(item.id)"
                 :presentation="modeOf(item.id)" :intents="dock.intents[item.id] || []"
                 @consume-intent="consumeIntent(item.id, $event)"
                 @status="onStatus(item.id, $event)" @context="onContext(item.id, $event)" />
    </ToolDock>
  </template>

  <section v-if="presentation === 'placeholder'" class="tool-placeholder" role="status">
    <span v-if="routeState === 'pending'">Проверяю доступность инструмента…</span>
    <span v-else>
      Плагин «{{ routeItem?.label || 'Инструмент' }}» выключен.
      Включить его можно в «Настройки → Плагины».
    </span>
  </section>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useDockStore, MIN_DOCK_WIDTH } from '../../stores/dock.js';
import { usePluginsStore } from '../../stores/plugins.js';
import { useTaskShelfStore } from '../../stores/taskShelf.ts';
import { useUiContextSource } from '../../composables/useUiContextSource.ts';
import { NAV_ICONS } from '../navIcons.ts';
import { TOOL_REGISTRY, TOOL_BY_ID, toolAvailability } from '../tools/registry.ts';
import { useDockViewport } from '../tools/viewport.ts';
import { comboFromEvent, formatCombo } from '../hotkeys/combo.ts';
import { useHotkeysStore } from '../../stores/hotkeys.js';
import ToolDock from './ToolDock.vue';
import { UiIconButton, useUiLayer } from '../../ui';

const route = useRoute();
const router = useRouter();
const dock = useDockStore();
const plugins = usePluginsStore();
const shelf = useTaskShelfStore();
const hotkeys = useHotkeysStore();
const toolContext = useUiContextSource('tool', { layer: 'dock', active: false });
const { dockCapable } = useDockViewport();

const routeTool = computed(() => route.meta?.tool || null);
const routeItem = computed(() => TOOL_BY_ID.get(routeTool.value) || null);
const routeState = computed(() => (routeItem.value
  ? toolAvailability(routeItem.value, plugins)
  : null));
const presentedTool = computed(() => {
  if (routeItem.value) return routeState.value === 'enabled' ? routeItem.value.id : null;
  const item = TOOL_BY_ID.get(dock.activeTool);
  return dockCapable.value && dock.isOpen && toolAvailability(item, plugins) === 'enabled'
    ? item.id
    : null;
});
const presentation = computed(() => {
  if (routeItem.value) return routeState.value === 'enabled' ? 'page' : 'placeholder';
  return presentedTool.value ? 'dock' : 'hidden';
});

const railItems = computed(() => TOOL_REGISTRY.filter((item) => {
  if (toolAvailability(item, plugins) !== 'enabled') return false;
  if (!item.plugin) return true;
  return plugins.dockNav.some((nav) => nav.id === item.id);
}));

function railTitle(item) {
  const combo = formatCombo(hotkeys.comboOf(item.id));
  return combo ? `${item.label} · ${combo}` : item.label;
}

const toolBadges = computed(() => ({
  shelf: shelf.totalCount > 0
    ? { count: shelf.litCount || shelf.totalCount, wait: shelf.litCount > 0 }
    : null,
}));

const contexts = reactive({});
const panelRefs = new Map();
const dockRefs = new Map();
const railButtons = new Map();
const contentWidth = ref(0);
const maxWidth = computed(() => Math.max(0, Math.floor(contentWidth.value * 0.7)));
const minWidth = computed(() => Math.min(MIN_DOCK_WIDTH, maxWidth.value));
let contentObserver = null;
let publishedContextKey = '';

function modeOf(id) {
  return presentedTool.value === id ? presentation.value : 'hidden';
}
function expandedOf(id) {
  return modeOf(id) === 'dock' && dock.isExpanded;
}
function compactOf(id) {
  return presentedTool.value === id && (presentation.value === 'dock' || !dockCapable.value);
}
function setPanelRef(id, value) {
  if (value) panelRefs.set(id, value);
  else panelRefs.delete(id);
}
function setDockRef(id, value) {
  if (value) dockRefs.set(id, value);
  else dockRefs.delete(id);
}
function setRailButton(id, value) {
  if (value) railButtons.set(id, value);
  else railButtons.delete(id);
}
function consumeIntent(id, intentId) { dock.consume(id, intentId); }
function onStatus(id, value) { dock.setRuntime(id, value); }
function onContext(id, value) {
  if (value) contexts[id] = value;
  else delete contexts[id];
  syncUiContext();
}
function safeToolDetails(id, value) {
  const details = { id, presentation: presentation.value };
  if (id !== 'code') return details;
  // CodePanel знает рабочую копию, но ToolHost пропускает только подписи и
  // относительный файл. Абсолютный treePath и содержимое Monaco сюда не входят.
  for (const key of ['project', 'repository', 'context', 'tab', 'file']) {
    if (typeof value?.[key] === 'string' && value[key]) details[key] = value[key];
  }
  if (Number.isSafeInteger(value?.line) && value.line > 0) details.line = value.line;
  return details;
}
function syncUiContext() {
  const id = presentedTool.value;
  const value = contexts[id];
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
  if (contextKey !== publishedContextKey) toolContext.focus(next);
  else toolContext.update(next);
  publishedContextKey = contextKey;
}

function focusPresented({ dockHeader = false } = {}) {
  const id = presentedTool.value;
  if (!id) return;
  nextTick(() => {
    if (dockHeader && presentation.value === 'dock') dockRefs.get(id)?.focusHeader?.();
    else panelRefs.get(id)?.focus?.();
  });
}

async function clickRail(item) {
  if (routeTool.value) {
    if (routeTool.value === item.id) focusPresented();
    else await router.push(item.route);
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
function activateTool(item) {
  if (routeTool.value || dockCapable.value) return clickRail(item);
  return router.push(item.route);
}

/**
 * Глобальные сочетания слушаются в capture: Monaco и терминал забирают клавиши себе,
 * а панель обязана открываться и поверх них. Сочетание без Ctrl/Alt настройка не
 * принимает, поэтому обычный набор текста сюда не доходит.
 */
function onHotkey(event) {
  if (hotkeys.recording || event.defaultPrevented || event.repeat || event.isComposing) return;

  const id = hotkeys.toolByCombo[comboFromEvent(event)];
  const item = id && railItems.value.some((entry) => entry.id === id) ? TOOL_BY_ID.get(id) : null;
  if (!item) return;

  event.preventDefault();
  event.stopPropagation();
  activateTool(item);
}

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

function resize(value, persist = false) {
  dock.setWidth(value, { min: minWidth.value, max: maxWidth.value, persist });
}

function measureContent() {
  const content = document.querySelector('.shell > .content');
  contentWidth.value = content?.getBoundingClientRect?.().width
    || Math.max(0, window.innerWidth - 62 - (dockCapable.value ? 44 : 0));
  resize(dock.width, false);
}

watch([presentedTool, presentation, dockCapable], () => {
  const id = presentedTool.value;
  if (id && presentation.value !== 'placeholder') dock.setMounted(id, true);
  // В route-only режиме живёт только текущая tool-страница. Уход с неё обязан
  // закрыть PTY/Monaco обычным unmount и сбросить runtime-индикатор.
  if (!dockCapable.value) {
    for (const item of TOOL_REGISTRY) {
      if (item.id !== id && dock.mounted[item.id]) dock.resetRuntime(item.id);
    }
  }
  syncUiContext();
}, { immediate: true });

watch(dockCapable, (can, was) => {
  measureContent();
  if (!can && was) {
    dock.close();
    for (const item of TOOL_REGISTRY) {
      if (item.id !== routeTool.value) dock.resetRuntime(item.id);
    }
  }
});

// Полноширинный overlay целиком скрывает content-колонку. Если человек выбрал
// другой раздел, возвращаем обычную ширину, чтобы результат навигации сразу был
// виден; сам док и живая Terminal/Code-сессия при этом остаются открыты.
watch(() => route.path, (path, previous) => {
  if (path !== previous && dock.isExpanded) dock.setExpanded(false, { persist: false });
});

watch(() => [plugins.loaded, ...plugins.list.map((item) => `${item.id}:${item.enabled}:${item.nav?.group || ''}`)], () => {
  if (!plugins.loaded) return;
  for (const item of TOOL_REGISTRY.filter((entry) => entry.plugin)) {
    if (toolAvailability(item, plugins) === 'enabled') continue;
    if (dock.activeTool === item.id) dock.close();
    dock.resetRuntime(item.id);
    delete contexts[item.id];
  }
  const valid = railItems.value.some((item) => item.id === dock.activeTool);
  if (!valid) {
    const fallback = railItems.value[0]?.id || null;
    dock.rememberTool(fallback);
    if (!fallback) dock.close();
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
  display: flex; flex-direction: column; align-items: center; gap: 5px; padding: 8px 5px;
  background: var(--sidebar); border-left: 1px solid var(--line);
}
.tool-rail-item { position: relative; }
.runtime-dot { position: absolute; right: 3px; bottom: 3px; width: 6px; height: 6px; border-radius: 50%;
  background: var(--good); box-shadow: 0 0 0 2px var(--sidebar); }
.runtime-dot.connecting { background: var(--warn); }
.tool-badge {
  position: absolute; top: -2px; right: -3px; min-width: 16px; height: 16px;
  display: inline-grid; place-items: center; box-sizing: border-box; padding: 0 4px;
  border: 1px solid var(--line-2); border-radius: 999px; background: var(--surface-2);
  color: var(--ink-mid); font-size: 9px; font-weight: 750; line-height: 1;
}
.tool-badge.wait { border-color: var(--warn); background: var(--warn); color: #17130a; }
.tool-badge.pulse { animation: tool-badge-pulse 1.6s ease-in-out infinite; }
@keyframes tool-badge-pulse { 50% { opacity: .5; } }
@media (prefers-reduced-motion: reduce) { .tool-badge.pulse { animation: none; } }
.tool-placeholder { grid-row: 2; grid-column: 2; z-index: 20; min-width: 0; min-height: 0;
  display: grid; place-items: center; padding: 24px; background: var(--ground); color: var(--ink-mid);
  text-align: center; line-height: 1.55; }
@media (max-width: 899px) { .tool-rail { display: none; } }
@media (max-width: 759px) { .tool-placeholder { grid-column: 1; padding: 16px; } }
</style>
