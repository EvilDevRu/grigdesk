import { onBeforeUnmount, onMounted, ref } from 'vue';

export const DOCK_BREAKPOINT = 900;
export const DOCK_MEDIA = `(min-width: ${DOCK_BREAKPOINT}px)`;

export function viewportCanDock() {
  if (typeof window === 'undefined') return false;
  if (typeof window.matchMedia === 'function') return window.matchMedia(DOCK_MEDIA).matches;
  return Number(window.innerWidth) >= DOCK_BREAKPOINT;
}

/** Реактивный breakpoint для ToolHost; launcher читает тот же контракт синхронно. */
export function useDockViewport() {
  const dockCapable = ref(viewportCanDock());
  let media = null;
  const update = () => { dockCapable.value = viewportCanDock(); };
  onMounted(() => {
    media = typeof window.matchMedia === 'function' ? window.matchMedia(DOCK_MEDIA) : null;
    media?.addEventListener?.('change', update);
    window.addEventListener('resize', update, { passive: true });
    update();
  });
  onBeforeUnmount(() => {
    media?.removeEventListener?.('change', update);
    window.removeEventListener('resize', update);
  });
  return { dockCapable };
}
