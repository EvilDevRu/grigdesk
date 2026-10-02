<template>
  <!-- Распорки стоят соседями строк, а не обёрткой: строки остаются прямыми детьми
       контейнера потребителя, и его раскладка и селекторы не меняются. -->
  <div v-if="active" ref="topGap" class="virtual-rows-gap" data-virtual-gap="before"
       :style="{ height: `${frame.before}px` }" aria-hidden="true"></div>
  <template v-for="entry in visible" :key="entry.key">
    <slot :item="entry.item" :index="entry.index" />
  </template>
  <div v-if="active" ref="bottomGap" class="virtual-rows-gap" data-virtual-gap="after"
       :style="{ height: `${frame.after}px` }" aria-hidden="true"></div>
</template>

<script setup lang="ts" generic="Item">
// Виртуальное окно длинного списка строк одинаковой высоты: рисуются только строки у
// видимой области прокручиваемого предка, остальное занимают две распорки. Короткий
// список (до порога) рисуется целиком, как обычный v-for, без замеров и слушателей.

import { computed, nextTick, onBeforeUnmount, onMounted, onUpdated, ref, shallowRef, watch } from 'vue';
import {
  VIRTUAL_ROWS_OVERSCAN,
  VIRTUAL_ROWS_THRESHOLD,
  measuredRowStep,
  virtualRowsWindow,
} from './virtualRows';
import type { VirtualRowsWindow } from './virtualRows';

interface VisibleRow {
  item: Item;
  index: number;
  key: string | number;
}

// rowHeight — только догадка до первого замера: настоящий шаг строки берётся из DOM.
const props = withDefaults(
  defineProps<{
    items: readonly Item[];
    itemKey: (item: Item, index: number) => string | number;
    rowHeight?: number;
    threshold?: number;
    overscan?: number;
  }>(),
  {
    rowHeight: 28,
    threshold: VIRTUAL_ROWS_THRESHOLD,
    overscan: VIRTUAL_ROWS_OVERSCAN,
  },
);

defineSlots<{ default(props: { item: Item; index: number }): unknown }>();

const topGap = ref<HTMLElement | null>(null);
const bottomGap = ref<HTMLElement | null>(null);
const frame = shallowRef<VirtualRowsWindow>({
  start: 0,
  end: 0,
  before: 0,
  after: 0,
});
let step = props.rowHeight;
let view = {
  top: 0,
  height: fallbackViewHeight(),
};
let scroller: HTMLElement | null = null;
let resizeObserver: ResizeObserver | null = null;
let intersectionObserver: IntersectionObserver | null = null;
let syncRequest: ReturnType<typeof setTimeout> | number | null = null;

const active = computed(() => props.items.length > props.threshold);
const visible = computed<VisibleRow[]>(() => {
  const items = props.items;
  const start = active.value ? Math.min(frame.value.start, items.length) : 0;
  const end = active.value ? Math.min(frame.value.end, items.length) : items.length;
  const rows: VisibleRow[] = [];

  for (let index = start; index < end; index += 1) {
    const item = items[index] as Item;

    rows.push({
      item,
      index,
      key: props.itemKey(item, index),
    });
  }

  return rows;
});

// Высота области до первого замера: скрытая панель меряет 0, и без запаса она
// показала бы при раскрытии пустую распорку на кадр.
function fallbackViewHeight() {
  return typeof window === 'undefined' ? 800 : window.innerHeight || 800;
}

/**
 * Пересчитывает окно по последнему замеру области и шагу строки. Новое окно присваивается,
 * только если поменялись границы: прокрутка внутри тех же строк не перерисовывает список.
 */
function applyWindow() {
  const next = virtualRowsWindow({
    count: props.items.length,
    rowHeight: step,
    viewTop: view.top,
    viewHeight: view.height,
    overscan: props.overscan,
  });
  const current = frame.value;

  if (next.start !== current.start || next.end !== current.end
    || next.before !== current.before || next.after !== current.after) {
    frame.value = next;
  }
}

/**
 * Ищет ближайшего прокручиваемого предка: окно считается по его видимой области. Без
 * такого предка (тестовый DOM без стилей) опорой служит прямой родитель списка.
 */
function scrollParent(element: HTMLElement) {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;

    if (overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay') {
      return node;
    }
  }

  return element.parentElement;
}

/**
 * Замеряет шаг нарисованных строк и положение списка относительно видимой области
 * предка, затем обновляет окно. Чтение геометрии идёт до записи состояния, поэтому за
 * один вызов раскладка пересчитывается не больше одного раза.
 */
function sync() {
  syncRequest = null;

  const top = topGap.value;
  const bottom = bottomGap.value;

  if (!active.value || !top || !bottom || !scroller || !scroller.contains(top)) {
    return;
  }

  const scrollerBox = scroller.getBoundingClientRect();

  // Скрытая панель (свёрнутый док) не имеет раскладки: окно остаётся прежним, а при
  // показе его пересчитает наблюдатель размера.
  if (!scroller.clientHeight && !scrollerBox.height) {
    return;
  }

  const topBox = top.getBoundingClientRect();
  const bottomBox = bottom.getBoundingClientRect();
  const rendered = Math.max(0, frame.value.end - frame.value.start);
  const measured = measuredRowStep(topBox.bottom, bottomBox.top, rendered, step);

  if (Math.abs(measured - step) > 0.01) {
    step = measured;
  }

  view = {
    top: scrollerBox.top + scroller.clientTop - topBox.top,
    height: scroller.clientHeight || fallbackViewHeight(),
  };
  applyWindow();
}

/**
 * Откладывает замер на кадр: несколько поводов подряд (рендер, наблюдатели) сливаются
 * в один. Без кадров браузера (тестовый DOM) роль кадра играет короткий таймер.
 */
function scheduleSync() {
  if (syncRequest !== null) {
    return;
  }

  syncRequest = typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame(sync)
    : setTimeout(sync, 16);
}

/**
 * Снимает отложенный замер тем же способом, каким он был поставлен: кадром браузера
 * либо таймером там, где кадров нет (тестовый DOM).
 */
function cancelSync() {
  if (syncRequest === null) {
    return;
  }

  if (typeof cancelAnimationFrame === 'function' && typeof syncRequest === 'number') {
    cancelAnimationFrame(syncRequest);
  } else {
    clearTimeout(syncRequest as ReturnType<typeof setTimeout>);
  }

  syncRequest = null;
}

/**
 * Подписывает окно на всё, что двигает список относительно видимой области: прокрутку,
 * размер предка и появление распорки в кадре. Последнее ловит сдвиг списка из-за соседей
 * выше (свернули группу над ним), когда ни прокрутки, ни смены размера предка нет.
 */
function attach() {
  detach();

  const top = topGap.value;
  const bottom = bottomGap.value;

  scroller = top ? scrollParent(top) : null;

  if (!scroller || !top || !bottom) {
    return;
  }

  scroller.addEventListener('scroll', sync, { passive: true });

  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(scheduleSync);
    resizeObserver.observe(scroller);
  }

  if (typeof IntersectionObserver !== 'undefined') {
    intersectionObserver = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        scheduleSync();
      }
    }, { root: scroller });
    intersectionObserver.observe(top);
    intersectionObserver.observe(bottom);
  }

  sync();
}

/**
 * Отписывает окно от предка и наблюдателей. Вызывается и при уходе под порог, и при
 * размонтировании: распорок больше нет, и мерить нечего.
 */
function detach() {
  cancelSync();
  scroller?.removeEventListener('scroll', sync);
  resizeObserver?.disconnect();
  intersectionObserver?.disconnect();
  scroller = null;
  resizeObserver = null;
  intersectionObserver = null;
}

watch([() => props.items.length, () => props.overscan], applyWindow, { immediate: true });

// Порог пересекли на живом списке: распорки только что появились или исчезли.
watch(active, async (value) => {
  await nextTick();

  if (value) {
    attach();
  } else {
    detach();
  }
});

onMounted(() => {
  if (active.value) {
    attach();
  }
});

// Рендер мог сдвинуть список или поменять высоту строк — сверяем окно на следующем кадре.
onUpdated(() => {
  if (active.value) {
    scheduleSync();
  }
});

onBeforeUnmount(detach);
</script>

<style scoped>
/* Распорка не годится в якорь прокрутки браузера: её высота меняется вместе с окном,
   и якорь на ней дёргал бы список при каждом сдвиге окна. */
.virtual-rows-gap {
  display: block;
  flex: none;
  overflow-anchor: none;
  pointer-events: none;
}
</style>
