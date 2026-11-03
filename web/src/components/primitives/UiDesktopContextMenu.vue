<template>
  <Teleport to="body">
    <div v-if="request" ref="surface" class="ui-context-menu" role="menu"
         v-bind="layer.layerProps.value" :style="[layer.layerProps.value.style, position]"
         @pointerdown.prevent @contextmenu.prevent.stop>
      <template v-for="(item, index) in request.items" :key="index">
        <div v-if="!item" class="ui-context-menu__separator" role="separator" />
        <button v-else type="button" role="menuitem" class="ui-context-menu__item"
                :class="{ 'is-active': active === index }" @pointermove="active = index"
                @click="close(index)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"
               stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path :d="icons[item.action] || icons.link" />
          </svg>
          <span>{{ item.label }}</span>
          <kbd v-if="item.shortcut">{{ item.shortcut }}</kbd>
        </button>
      </template>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { useUiLayer } from '../../composables/useUiLayer';
import { closeTopLayer } from '../../services/layers/stack';
import type { DesktopContextMenuRequest } from '../../../../shared/desktop/contextMenu.ts';

const request = ref<(DesktopContextMenuRequest & { channel: string }) | null>(null);
const surface = ref<HTMLElement | null>(null);
const position = ref({ left: '0px', top: '0px' });
const active = ref(-1);
const layer = useUiLayer('popover', {
  enabled: () => Boolean(request.value),
  element: surface,
  onEscape: () => close(),
});
const icons: Record<string, string> = {
  cut: 'M9 9l11 11M9 15L20 4M4 4a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM4 14a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z',
  copy: 'M9 9h11v11H9zM15 9V4H4v11h5',
  paste: 'M9 5H5v16h14V5h-4M9 3h6v4H9zM9 12h6M9 16h6',
  selectAll: 'M9 3H3v6M15 3h6v6M21 15v6h-6M9 21H3v-6M8 8h8v8H8z',
  link: 'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2',
};

/**
 * Указатель не забирает фокус у редактора: нативная команда работает с прежним выделением.
 * После управления клавишами возвращаем фокус до отправки результата в Electron.
 */
function close(index: number | null = null): boolean {
  const current = request.value;

  if (!current) {
    return false;
  }

  restoreFocus();
  request.value = null;
  window.dispatchEvent(new CustomEvent(current.channel, { detail: index }));

  return true;
}

/**
 * Повторный запрос завершает предыдущий, а геометрия измеряется после Teleport.
 * Меню помещается в видимый viewport даже у нижнего и правого края окна.
 */
async function open(event: Event): Promise<void> {
  close();

  const detail = (event as CustomEvent).detail;

  request.value = detail;
  active.value = -1;
  position.value = { left: '0px', top: '0px' };
  await nextTick();

  if (request.value?.channel !== detail.channel || !surface.value) {
    return;
  }

  const bounds = surface.value.getBoundingClientRect();

  position.value = {
    left: `${Math.max(8, Math.min(detail.x, window.innerWidth - bounds.width - 8))}px`,
    top: `${Math.max(8, Math.min(detail.y, window.innerHeight - bounds.height - 8))}px`,
  };
}

/**
 * Клавиши навигации не попадают в редактор под меню и пропускают разделители.
 * Выбор по Enter использует тот же индекс, что и щелчок указателя.
 */
function onKey(event: KeyboardEvent): void {
  if (!request.value || !layer.isTopLayer.value) {
    return;
  }

  if (event.key === 'Escape') {
    closeTopLayer(event);

    return;
  }

  const indices = request.value.items.flatMap((item, index) => item ? [index] : []);

  if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    event.preventDefault();
    event.stopImmediatePropagation();

    const step = event.key === 'ArrowUp' ? -1 : 1;
    const start = active.value < 0 ? (step < 0 ? 0 : -1) : indices.indexOf(active.value);
    const offset = (start + step + indices.length) % indices.length;

    active.value = (event.key === 'Home' ? indices[0]
      : event.key === 'End' ? indices.at(-1) : indices[offset]) ?? -1;
    surface.value?.querySelectorAll<HTMLButtonElement>('button')[indices.indexOf(active.value)]?.focus();
  } else if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    event.stopImmediatePropagation();
    restoreFocus();
    close(active.value < 0 ? null : active.value);
  } else {
    close();
  }
}

let previousFocus: HTMLElement | null = null;

function restoreFocus(): void {
  previousFocus?.focus({ preventScroll: true });
}

function onOpen(event: Event): void {
  if (request.value) {
    close();
  }

  previousFocus = document.activeElement as HTMLElement | null;
  void open(event);
}

function dismiss(event: Event): void {
  if (request.value && !surface.value?.contains(event.target as Node)) {
    restoreFocus();
    close();
  }
}

function dismissWindow(): void {
  if (request.value) {
    close();
  }
}

onMounted(() => {
  document.documentElement.setAttribute('data-desktop-context-menu', '');
  window.addEventListener('grigdesk:context-menu', onOpen);
  window.addEventListener('pointerdown', dismiss, true);
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('blur', dismissWindow);
  window.addEventListener('resize', dismissWindow);
  document.addEventListener('scroll', dismiss, true);
});

onBeforeUnmount(() => {
  close();
  document.documentElement.removeAttribute('data-desktop-context-menu');
  window.removeEventListener('grigdesk:context-menu', onOpen);
  window.removeEventListener('pointerdown', dismiss, true);
  window.removeEventListener('keydown', onKey, true);
  window.removeEventListener('blur', dismissWindow);
  window.removeEventListener('resize', dismissWindow);
  document.removeEventListener('scroll', dismiss, true);
});
</script>
