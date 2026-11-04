<template>
  <div ref="element" class="browser-viewport" data-browser-viewport>
    <img v-if="preview" :src="preview" class="browser-viewport__preview" alt="" aria-hidden="true" />
  </div>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';

import { getUiLayerDiagnostics, subscribeToasts, subscribeUiLayerDiagnostics } from '../../ui.ts';
import { browserRect } from './browserGeometry.ts';

const element = ref<HTMLElement | null>(null);
const preview = ref<string | null>(null);
const instance = crypto.randomUUID();
let revision = 0;
let generation = 0;
let alive = false;
let mounted = false;
let observer: ResizeObserver | null = null;
let stopLayers: (() => void) | null = null;
let stopToasts: (() => void) | null = null;
let hasToasts = false;
let appliedRect: ReturnType<typeof browserRect> = null;
let covered = false;

function blocked(): boolean {
  return document.visibilityState !== 'visible' || getUiLayerDiagnostics().length > 0 || hasToasts;
}

/**
 * Синхронный hide выполняется в уведомлении layer stack до следующего DOM paint.
 * Его revision обесценивает и измерение после nextTick, и позднее IPC сообщение layout.
 */
function hide(): void {
  generation += 1;
  revision += 1;
  appliedRect = null;
  covered = false;
  preview.value = null;
  window.grigdeskBrowser?.hide({
    operation: 'hide',
    instance,
    revision
  });
}

/**
 * Меню получает DOM-подложку из последнего показанного кадра до снятия guest.
 * Повторные слои сохраняют её: уже скрытая вкладка нового кадра не отдаёт.
 */
function cover(): void {
  if (covered && appliedRect === null) {
    return;
  }

  if (!alive || !mounted || document.visibilityState !== 'visible' || !window.grigdeskBrowser?.cover) {
    hide();

    return;
  }

  generation += 1;
  revision += 1;
  appliedRect = null;
  covered = true;

  const frame = window.grigdeskBrowser.cover({
    operation: 'cover',
    instance,
    revision,
  });

  if (frame) {
    preview.value = `data:image/jpeg;base64,${frame}`;
  }
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

  if (rect && appliedRect && Object.keys(rect).every((key) =>
    rect[key as keyof typeof rect] === appliedRect![key as keyof typeof rect])) {
    return;
  }

  revision += 1;
  appliedRect = rect;
  await window.grigdeskBrowser?.invoke({
    operation: 'layout',
    instance,
    revision,
    rect
  })
    .catch(() => {
      if (expected === generation) {
        appliedRect = null;
      }
    });

  if (expected === generation && !blocked()) {
    covered = false;
    preview.value = null;
  }
}

/**
 * Stack уведомляет и о tooltip, который не перекрывает native viewport.
 * Скрываем guest лишь при действительном блокере; закрытие слоя возвращает layout.
 */
function refreshLayers(): void {
  if (blocked()) {
    cover();
  } else if (alive && mounted) {
    void measure();
  }
}

/**
 * Любая смена геометрии сначала убирает native view из старого прямоугольника.
 * Overlay закрывается тем же путём: следующий видимый layout ждёт Vue DOM update.
 */
function refresh(): void {
  if (blocked() && document.visibilityState === 'visible') {
    cover();

    return;
  }

  hide();

  if (alive && mounted && !blocked()) {
    void measure();
  }
}

onMounted(async () => {
  alive = true;
  stopToasts = subscribeToasts((toasts) => {
    const visible = toasts.length > 0;

    if (hasToasts !== visible) {
      hasToasts = visible;
      refresh();
    }
  });
  stopLayers = subscribeUiLayerDiagnostics(refreshLayers);
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
  stopToasts?.();
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
  position: relative;
  flex: 1;
  min-width: 0;
  min-height: 0;
  width: 100%;
}

.browser-viewport__preview {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: fill;
  pointer-events: none;
}
</style>
