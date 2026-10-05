<template>
  <section class="tool-surface"
           :class="[`is-${mode}`, { 'is-expanded': expanded, 'is-resizing': resizing }]"
           :style="style"
           :role="mode === 'dock' ? 'complementary' : undefined"
           :aria-label="mode === 'dock' ? label : undefined">
    <div v-if="mode === 'dock' && !expanded" class="dock-resizer" role="separator" tabindex="0"
         aria-orientation="vertical" :aria-valuemin="Math.round(minWidth)"
         :aria-valuemax="Math.round(maxWidth)" :aria-valuenow="Math.round(width)"
         @pointerdown.prevent="start" @pointermove.prevent="move"
         @pointerup.prevent="finish" @pointercancel.prevent="cancel" @keydown="onKey">
      <span aria-hidden="true"></span>
    </div>
    <div v-if="mode === 'dock'" class="dock-actions" aria-label="Управление панелью">
      <UiIconButton ref="expandButton" class="expand-action" role="embedded"
                    data-context="tool-dock-expand"
                    :label="expanded ? 'Вернуть ширину панели' : 'Во весь экран'"
                    v-tooltip="expanded ? 'Вернуть ширину панели' : 'Во весь экран'"
                    :pressed="expanded" @click="emit('toggle-expanded')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
             stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path v-if="!expanded" d="M8 3H3v5 M16 3h5v5 M8 21H3v-5 M16 21h5v-5" />
          <path v-else d="M9 3v6H3 M15 3v6h6 M9 21v-6H3 M15 21v-6h6" />
        </svg>
      </UiIconButton>
      <UiIconButton class="hide-action" role="embedded" tone="danger"
                    data-context="tool-dock-hide"
                    label="Скрыть панель" v-tooltip="'Скрыть панель'" @click="emit('hide')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"
             stroke-linecap="round" aria-hidden="true">
          <path d="M6 6l12 12 M18 6 6 18" />
        </svg>
      </UiIconButton>
    </div>
    <div class="tool-body"><slot /></div>
  </section>
</template>

<script setup>
import { computed, ref } from 'vue';
import { UiIconButton, vTooltip } from '../../ui';

const props = defineProps({
  mode: { type: String, default: 'hidden' },
  label: { type: String, required: true },
  width: { type: Number, required: true },
  minWidth: { type: Number, required: true },
  maxWidth: { type: Number, required: true },
  expanded: { type: Boolean, default: false },
  expandedWidth: { type: Number, default: 0 },
});
const emit = defineEmits(['hide', 'toggle-expanded', 'resize', 'resize-end']);
const expandButton = ref(null);
const resizing = ref(false);
let pointer = null;

const style = computed(() => {
  if (props.mode !== 'dock') return null;
  const width = props.expanded && props.expandedWidth > 0 ? props.expandedWidth : props.width;
  return { width: `${width}px` };
});
const nextWidth = (clientX) => window.innerWidth - 44 - clientX;

function start(event) {
  if (event.button !== undefined && event.button !== 0) return;
  pointer = event.pointerId;
  resizing.value = true;
  event.currentTarget?.setPointerCapture?.(event.pointerId);
  emit('resize', nextWidth(event.clientX));
}
function move(event) {
  if (pointer === event.pointerId) emit('resize', nextWidth(event.clientX));
}
function finish(event) {
  if (pointer !== event.pointerId) return;
  pointer = null;
  resizing.value = false;
  event.currentTarget?.releasePointerCapture?.(event.pointerId);
  emit('resize-end', nextWidth(event.clientX));
}
function cancel(event) {
  if (pointer !== event.pointerId) return;
  pointer = null;
  resizing.value = false;
  event.currentTarget?.releasePointerCapture?.(event.pointerId);
  // pointercancel не гарантирует осмысленный clientX; сохраняем последнюю уже
  // применённую ширину, а не прыгаем к краю viewport.
  emit('resize-end', props.width);
}
function onKey(event) {
  const step = event.shiftKey ? 64 : 16;
  let value = props.width;
  if (event.key === 'ArrowLeft') value += step;
  else if (event.key === 'ArrowRight') value -= step;
  else if (event.key === 'Home') value = props.minWidth;
  else if (event.key === 'End') value = props.maxWidth;
  else return;
  event.preventDefault();
  emit('resize-end', value);
}

defineExpose({ focusHeader: () => expandButton.value?.focus?.() });
</script>

<style scoped>
.tool-surface { min-width: 0; min-height: 0; background: var(--ground); overflow: hidden; }
.tool-surface.is-hidden { display: none; }
.tool-surface.is-page { grid-row: 2; grid-column: 2; z-index: 20; padding: 22px; }
.tool-surface.is-dock {
  position: fixed; z-index: 80; top: 54px; right: 44px; bottom: 0;
  --tool-dock-actions-space: 82px;
  --tool-dock-action-size: 30px;
  --tool-dock-action-top: 4px;
  display: grid; grid-template-rows: minmax(0, 1fr);
  border-left: 1px solid var(--line-2); box-shadow: -18px 0 42px #0009;
  transition: width .18s ease-out, box-shadow .18s ease-out;
}
.tool-surface.is-dock.is-expanded { box-shadow: 0 18px 52px #000b; }
.tool-surface.is-dock.is-resizing { transition: none; }
.tool-body { height: 100%; min-width: 0; min-height: 0; overflow: hidden; }
.dock-actions {
  position: absolute; z-index: 4; top: var(--tool-dock-action-top); right: 7px;
  display: flex; gap: 4px;
}
.dock-resizer { position: absolute; z-index: 2; left: -5px; top: 0; bottom: 0; width: 10px;
  display: grid; place-items: center; cursor: col-resize; touch-action: none; outline: none; }
.dock-resizer span { width: 2px; height: 46px; border-radius: 999px; background: var(--line-2); }
.dock-resizer:hover span, .dock-resizer:focus-visible span { background: var(--accent); }

/* Синхронный каркас Code живёт в базовом chunk и занимает финальную геометрию,
   пока lazy chunk с Monaco ещё не готов. Без анимации: сам каркас не должен мерцать. */
:deep(.code-panel-loading) {
  height: 100%; min-width: 0; min-height: 0; display: flex; flex-direction: column;
  container: code-loading / inline-size;
}
:deep(.code-loading-head) {
  min-width: 0; min-height: 36px; display: flex; align-items: center; gap: 10px;
  padding: 0 4px 8px; color: var(--ink);
}
:deep(.code-loading-head strong) { flex: none; font-size: 13px; font-weight: 650; }
:deep(.code-loading-grow) { flex: 1; }
:deep(.code-loading-navigator) {
  width: var(--tool-dock-action-size, 30px); height: var(--tool-dock-action-size, 30px);
  display: inline-flex; align-items: center; justify-content: center; line-height: 1;
  border: 1px solid var(--line); border-radius: 7px; background: var(--surface-2); color: var(--ink-mid);
}
:deep(.code-loading-navigator svg) { width: 16px; height: 16px; }
:deep(.code-panel-loading.compact .code-loading-head) {
  min-height: 40px;
  padding: var(--tool-dock-action-top, 4px) var(--tool-dock-actions-space, 4px) 5px 11px;
  border-bottom: 1px solid var(--line); background: var(--topbar);
}
:deep(.code-panel-loading.compact .code-loading-head strong) { font-size: 12.5px; letter-spacing: .01em; }
:deep(.code-loading-layout) {
  flex: 1; min-width: 0; min-height: 0; display: grid;
  grid-template-columns: 44px minmax(0, min(var(--code-loading-nav-width, 320px), 42%)) 8px minmax(0, 1fr);
  overflow: hidden;
  border: 1px solid var(--line); border-radius: 12px; background: var(--surface); user-select: none;
}
:deep(.code-loading-layout.compact) {
  grid-template-rows: minmax(0, 1fr); border: 0; border-radius: 0;
}
:deep(.code-loading-rail) {
  grid-column: 1; grid-row: 1; display: flex; flex-direction: column; gap: 2px; align-items: center;
  padding: 8px 0; background: var(--sidebar); border-right: 1px solid var(--line);
}
:deep(.code-loading-rail span) { width: 34px; height: 34px; border-radius: 8px; background: var(--surface-2); }
:deep(.code-loading-panel) { min-width: 0; min-height: 0; background: var(--sidebar); border-right: 1px solid var(--line); }
:deep(.code-loading-tree) { display: flex; flex-direction: column; gap: 11px; padding: 15px 17px; }
:deep(.code-loading-tree span) { height: 8px; border-radius: 999px; background: var(--line); opacity: .78; }
:deep(.code-loading-split) {
  grid-column: 3; grid-row: 1; display: grid; place-items: center;
  background: var(--sidebar); border-right: 1px solid var(--line);
}
:deep(.code-loading-split span) { width: 2px; height: 34px; border-radius: 999px; background: var(--line-2); }
:deep(.code-loading-editor) { min-width: 0; min-height: 0; display: flex; flex-direction: column; }
:deep(.code-loading-editor-head) {
  min-height: 37px; display: flex; align-items: center; padding: 7px 12px;
  border-bottom: 1px solid var(--line); background: var(--topbar);
}
:deep(.code-loading-editor-head span) { width: min(42%, 260px); height: 8px; border-radius: 999px; background: var(--line); }
:deep(.code-loading-editor-body) {
  flex: 1; min-height: 0; display: grid; place-items: center; background: #0a0c10;
  color: var(--ink-mid); font-size: 12px;
}
:deep(.code-loading-panel) { grid-column: 2; grid-row: 1; }
:deep(.code-loading-layout.compact .code-loading-panel) { border-right: 0; }
:deep(.code-loading-editor) { grid-column: 4; grid-row: 1; }
@container code-loading (max-width: 759px) {
  :deep(.code-loading-navigator) { display: none; }
  :deep(.code-loading-layout) { grid-template-columns: 44px minmax(0, 1fr); }
  :deep(.code-loading-split), :deep(.code-loading-editor) { display: none; }
}
@media (prefers-reduced-motion: reduce) { .tool-surface.is-dock { transition: none; } }
@media (min-width: 760px) and (max-width: 1099px) { .tool-surface.is-page { padding: 18px; } }
@media (max-width: 759px) { .tool-surface.is-page { grid-column: 1; padding: 16px; } }
</style>
