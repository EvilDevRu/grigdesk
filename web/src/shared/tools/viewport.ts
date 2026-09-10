import { onBeforeUnmount, onMounted, ref } from 'vue';
import type { Ref } from 'vue';

// Ниже этой ширины постоянная панель не помещается рядом с содержимым, и инструмент
// открывается отдельной страницей. Порог один на всех: launcher читает его синхронно,
// ToolHost — реактивно, и разойтись они не имеют права.
export const DOCK_BREAKPOINT = 900;
export const DOCK_MEDIA = `(min-width: ${DOCK_BREAKPOINT}px)`;

/**
 * Помещается ли постоянная панель прямо сейчас. Отсутствие `matchMedia` — не отказ:
 * в тестовой среде и старом движке остаётся честное сравнение ширины окна.
 */
export function viewportCanDock(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  if (typeof window.matchMedia === 'function') {
    return window.matchMedia(DOCK_MEDIA).matches;
  }

  return Number(window.innerWidth) >= DOCK_BREAKPOINT;
}

/**
 * Реактивный breakpoint для ToolHost; launcher читает тот же контракт синхронно.
 * Подписка снимается при размонтировании: панель живёт дольше одного экрана.
 */
export function useDockViewport(): { dockCapable: Ref<boolean> } {
  const dockCapable = ref(viewportCanDock());
  let media: MediaQueryList | null = null;
  const update = () => {
    dockCapable.value = viewportCanDock();
  };

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
