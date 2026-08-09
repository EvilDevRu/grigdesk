<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useDockStore, MIN_DOCK_WIDTH } from '../../stores/dock.js';
import { usePluginsStore } from '../../stores/plugins.js';
import { useUiContextStore } from '../../stores/ui-context.js';
import { NAV_ICONS } from '../nav-icons.js';
import { registerLayer } from '../ui/layer-stack.js';
import { TOOL_REGISTRY, TOOL_BY_ID, toolAvailability } from '../tools/registry.js';
import { useDockViewport } from '../tools/viewport.js';
import ToolDock from './ToolDock.vue';

const route = useRoute();
const router = useRouter();
const dock = useDockStore();
const plugins = usePluginsStore();
const ui = useUiContextStore();
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

const contexts = reactive({});
const panelRefs = new Map();
const dockRefs = new Map();
const railButtons = new Map();
const contentWidth = ref(0);
const maxWidth = computed(() => Math.max(0, Math.floor(contentWidth.value * 0.7)));
const minWidth = computed(() => Math.min(MIN_DOCK_WIDTH, maxWidth.value));
let contentObserver = null;
let unregisterDockLayer = null;

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
function syncUiContext() {
  const value = contexts[presentedTool.value];
  if (value) ui.set('tool', value);
  else ui.clear('tool');
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
  const codeState = toolAvailability(TOOL_BY_ID.get('code'), plugins);
  if (codeState !== 'enabled') {
    if (dock.activeTool === 'code') dock.close();
    dock.resetRuntime('code');
    delete contexts.code;
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

watch(presentation, (mode) => {
  unregisterDockLayer?.();
  unregisterDockLayer = null;
  if (mode === 'dock') {
    unregisterDockLayer = registerLayer('tool-dock', { priority: 80, close: closeDockLayer });
  }
});

onMounted(() => {
  const content = document.querySelector('.shell > .content');
  if (content && typeof ResizeObserver !== 'undefined') {
    contentObserver = new ResizeObserver(measureContent);
    contentObserver.observe(content);
  }
  window.addEventListener('resize', measureContent, { passive: true });
  measureContent();
});
onBeforeUnmount(() => {
  unregisterDockLayer?.();
  contentObserver?.disconnect?.();
  window.removeEventListener('resize', measureContent);
  ui.clear('tool');
  dock.resetAllRuntime();
});
</script>

<template>
  <aside v-if="dockCapable" class="tool-rail" aria-label="Инструменты в панели">
    <button v-for="item in railItems" :key="item.id"
            :ref="(value) => setRailButton(item.id, value)" type="button"
            class="tool-rail-item" :class="{ active: presentedTool === item.id }"
            :title="item.label" :aria-label="item.label"
            :aria-pressed="presentation === 'dock' && presentedTool === item.id"
            @click="clickRail(item)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
           stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path :d="NAV_ICONS[item.icon] || NAV_ICONS.plugin" />
      </svg>
      <span v-if="item.id === 'terminal' && ['open', 'connecting'].includes(dock.runtime.terminal?.status)"
            class="runtime-dot" :class="dock.runtime.terminal.status" aria-hidden="true"></span>
    </button>
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

<style scoped>
.tool-rail {
  grid-row: 2; grid-column: 3; z-index: 70; min-height: 0;
  display: flex; flex-direction: column; align-items: center; gap: 5px; padding: 8px 5px;
  background: var(--sidebar); border-left: 1px solid var(--line);
}
.tool-rail-item { position: relative; width: 34px; height: 34px; display: grid; place-items: center;
  border: 0; border-radius: 8px; background: transparent; color: var(--ink-mid); cursor: pointer; }
.tool-rail-item:hover { color: var(--ink); background: var(--surface); }
.tool-rail-item.active { color: var(--accent); background: color-mix(in srgb, var(--accent) 14%, transparent); }
.tool-rail-item:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.tool-rail-item svg { width: 19px; height: 19px; }
.runtime-dot { position: absolute; right: 3px; bottom: 3px; width: 6px; height: 6px; border-radius: 50%;
  background: var(--good); box-shadow: 0 0 0 2px var(--sidebar); }
.runtime-dot.connecting { background: var(--warn); }
.tool-placeholder { grid-row: 2; grid-column: 2; z-index: 20; min-width: 0; min-height: 0;
  display: grid; place-items: center; padding: 24px; background: var(--ground); color: var(--ink-mid);
  text-align: center; line-height: 1.55; }
@media (max-width: 899px) { .tool-rail { display: none; } }
@media (max-width: 759px) { .tool-placeholder { grid-column: 1; padding: 16px; } }
</style>
