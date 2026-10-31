<template>
  <div ref="element" class="browser-viewport" data-browser-viewport />
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';

import { getUiLayerDiagnostics, subscribeUiLayerDiagnostics } from '../../ui.ts';
import { browserRect } from './browserGeometry.ts';

const element = ref<HTMLElement | null>(null);
const instance = crypto.randomUUID();
let revision = 0;
let generation = 0;
let alive = false;
let mounted = false;
let observer: ResizeObserver | null = null;
let stopLayers: (() => void) | null = null;

function blocked(): boolean {
  return document.visibilityState !== 'visible' || getUiLayerDiagnostics().length > 0;
}

/**
 * Синхронный hide выполняется в уведомлении layer stack до следующего DOM paint.
 * Его revision обесценивает и измерение после nextTick, и позднее IPC сообщение layout.
 */
function hide(): void {
  generation += 1;
  revision += 1;
  window.grigdeskBrowser?.hide({
    operation: 'hide',
    instance,
    revision
  });
}

/**
 * Измерение разрешается лишь текущему живому mount после ACK native регистрации.
 * Геометрия не публикуется, если за время nextTick появился модал или другой layout.
 */
async function measure(): Promise<void> {
  const expected = ++generation;

  await nextTick();

  if (!alive || !mounted || expected !== generation || blocked() || !element.value) {
    return;
  }

  const box = element.value.getBoundingClientRect();
  const rect = browserRect(box, { width: window.innerWidth, height: window.innerHeight },
    true, getUiLayerDiagnostics().length);

  revision += 1;
  await window.grigdeskBrowser?.invoke({
    operation: 'layout',
    instance,
    revision,
    rect
  })
    .catch(() => undefined);
}

/**
 * Любая смена геометрии сначала убирает native view из старого прямоугольника.
 * Overlay закрывается тем же путём: следующий видимый layout ждёт Vue DOM update.
 */
function refresh(): void {
  hide();

  if (alive && mounted && !blocked()) {
    void measure();
  }
}

onMounted(async () => {
  alive = true;
  stopLayers = subscribeUiLayerDiagnostics(refresh);
  window.addEventListener('resize', refresh);
  window.addEventListener('scroll', refresh, true);
  window.addEventListener('pagehide', hide);
  window.addEventListener('pageshow', refresh);
  document.addEventListener('visibilitychange', refresh);
  observer = new ResizeObserver(refresh);

  if (element.value) {
    observer.observe(element.value);
  }

  try {
    await window.grigdeskBrowser?.invoke({ operation: 'viewport-mount', instance });

    if (!alive) {
      return;
    }

    mounted = true;
    refresh();
  } catch {
    hide();
  }
});

onBeforeUnmount(() => {
  alive = false;
  mounted = false;
  hide();
  stopLayers?.();
  observer?.disconnect();
  window.removeEventListener('resize', refresh);
  window.removeEventListener('scroll', refresh, true);
  window.removeEventListener('pagehide', hide);
  window.removeEventListener('pageshow', refresh);
  document.removeEventListener('visibilitychange', refresh);
  void window.grigdeskBrowser?.invoke({ operation: 'viewport-unmount', instance })
    .catch(() => undefined);
});
</script>

<style scoped>
.browser-viewport {
  flex: 1;
  min-width: 0;
  min-height: 0;
  width: 100%;
}
</style>
