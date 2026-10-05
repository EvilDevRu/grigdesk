<template>
  <Teleport to="body">
    <Transition name="ui-tooltip">
      <span
        v-if="state"
        id="ui-tooltip-host"
        ref="surface"
        class="ui-tooltip ui-tooltip--plain"
        role="tooltip"
        data-state="open"
        :data-placement="actualPlacement"
        :data-ui-layer="layerProps['data-ui-layer']"
        :style="[layerProps.style, positionStyle]"
      >{{ state.text }}</span>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue';

import { useUiLayer } from '../../composables/useUiLayer';
import { computeOverlayPlacement } from '../../services/overlayPlacement.ts';
import {
  hideTooltip,
  resetTooltips,
  subscribeTooltip,
  type TooltipState,
} from '../../services/tooltips.ts';
import type { UiOverlayPlacement } from '../../types/uiOverlays';

const state = shallowRef<TooltipState | null>(null);
const surface = ref<HTMLElement | null>(null);
const actualPlacement = ref<UiOverlayPlacement>('top');
const positionStyle = ref<Record<string, string>>({ visibility: 'hidden' });
let resizeObserver: ResizeObserver | null = null;

const unsubscribe = subscribeTooltip((snapshot) => {
  state.value = snapshot;
});
const { layerProps } = useUiLayer('tooltip', {
  enabled: computed(() => state.value !== null),
  element: surface,
  onEscape: () => {
    hideTooltip();

    return true;
  },
});

/**
 * Хост читает DOM только после появления поверхности и передаёт размеры чистому расчёту.
 * Координаты и якорь записываются вместе, чтобы flip не оставлял прежнюю стрелку.
 */
function place(): void {
  const current = state.value;
  const element = surface.value;

  if (!current || !element || typeof window === 'undefined') {
    return;
  }

  const rect = current.target.getBoundingClientRect();

  if (!current.target.isConnected || rect.bottom < 0 || rect.top > window.innerHeight
    || rect.right < 0 || rect.left > window.innerWidth) {
    hideTooltip();

    return;
  }

  const result = computeOverlayPlacement({
    trigger: rect,
    surface: { width: element.offsetWidth, height: element.offsetHeight },
    viewport: { width: window.innerWidth, height: window.innerHeight },
    placement: current.placement,
    offset: 9,
  });

  actualPlacement.value = result.placement;
  positionStyle.value = {
    position: 'fixed',
    left: `${result.left}px`,
    top: `${result.top}px`,
    visibility: 'visible',
    '--ui-overlay-anchor-x': `${result.anchorX}px`,
    '--ui-overlay-anchor-y': `${result.anchorY}px`,
  };
}

/**
 * Только видимая подсказка наблюдает scroll, resize и размеры собственного текста.
 * Очистка выполняется перед каждой новой подпиской и при размонтировании хоста.
 */
function stopWatching(): void {
  if (typeof window !== 'undefined') {
    window.removeEventListener('scroll', place, true);
    window.removeEventListener('resize', place);
  }

  resizeObserver?.disconnect();
  resizeObserver = null;
}

watch(state, async (current) => {
  stopWatching();
  positionStyle.value = { visibility: 'hidden' };

  if (!current || typeof window === 'undefined') {
    return;
  }

  window.addEventListener('scroll', place, { capture: true, passive: true });
  window.addEventListener('resize', place, { passive: true });
  await nextTick();

  if (state.value !== current) {
    return;
  }

  place();

  if (surface.value && typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(place);
    resizeObserver.observe(surface.value);
  }
}, { flush: 'post' });

if (typeof window !== 'undefined') {
  window.addEventListener('blur', hideTooltip);
}

onBeforeUnmount(() => {
  unsubscribe();
  stopWatching();

  if (typeof window !== 'undefined') {
    window.removeEventListener('blur', hideTooltip);
  }

  resetTooltips();
});
</script>
