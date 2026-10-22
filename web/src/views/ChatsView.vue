<template>
  <div ref="host" class="agents" :class="`m-${pane}`" :style="layoutStyle">
    <ChatList @open="pane = 'chat'" />
    <div ref="splitter" class="lsplit" role="separator" aria-orientation="vertical" tabindex="0"
         aria-label="Ширина списка чатов"
         :aria-valuemin="LIST_MIN_W" :aria-valuemax="Math.round(listMaxW)"
         :aria-valuenow="Math.round(listWidth ?? LIST_DEF_W)"
         v-tooltip="'Потяни — ширина списка. Двойной клик — вернуть обычную'"
         @pointerdown.prevent="startListResize" @pointermove.prevent="moveListResize"
         @pointerup.prevent="finishListResize" @pointercancel.prevent="cancelListResize"
         @dblclick="resetListWidth" @keydown="onListResizeKey">
      <span></span>
    </div>
    <div class="stage">
      <ChatSession v-if="activeId" :key="activeId" :sid="activeId" @back="pane = 'list'" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useChatStore } from '../stores/chat.ts';
import { useUiContextSource } from '../composables/useUiContextSource.ts';
import { useDockViewport } from '../shared/tools/viewport.ts';
import ChatList from './chat/ChatList.vue';
import ChatSession from './chat/ChatSession.vue';
import { vTooltip } from '../ui';

// Рабочее место агентов в телеграм-раскладке: слева список чатов, справа активный чат.
const chat = useChatStore();
const { activeId } = storeToRefs(chat);

// На узком экране колонка одна: показываем либо список, либо открытый чат. Переключение
// держим здесь классом, а не через matchMedia в JS: раскладку и так решает CSS, второй
// источник правды о ширине экрана рассинхронизируется на поворотах и ресайзе.
// Стартуем со списка — как в мессенджерах на телефоне.
const pane = ref('list');

watch(() => chat.revealRequest, (id) => {
  if (id) {
    pane.value = 'chat';
    chat.consumeReveal();
  }
}, { immediate: true });

const { dockCapable } = useDockViewport();
const chatsContext = useUiContextSource('chats', { layer: 'page', active: false });

watch(activeId, (chatId) => {
  if (chatId) {
    chatsContext.focus({ details: { chatId } });
  } else {
    chatsContext.blur();
  }
}, { immediate: true });

// CSS скрывает detail-pane на телефоне, но компонент остаётся mounted. Регистрируем
// фактическую поверхность тем же breakpoint-контрактом, чтобы скрытый чат не гасил
// unread и не подавлял уведомление.
const pageSurface = chat.registerSurface('chats-page', { chatId: null, visible: false });

watch([activeId, dockCapable, pane], ([chatId, wide, currentPane]) => {
  const visible = Boolean(chatId) && (wide || currentPane === 'chat');

  pageSurface.update({ chatId: chatId || null, visible });

  if (visible) {
    chat.markRead(chatId!);
  }
}, { immediate: true });
onMounted(() => {
  chat.ensure();
});

// ── Ширина списка чатов ─────────────────────────────────────────────────────────
// Настройка устройства, а не аккаунта (localStorage, как ширина дока и дерева «Кода»):
// на планшете и на большом мониторе удобны разные списки, а серверные prefs уехали бы
// сразу во все окна. Пока разделитель не трогали, значения нет вовсе — ширину решает
// CSS вместе со своими медиазапросами (см. ChatList).
const LIST_WIDTH_KEY = 'grigdesk-chats-list-width';
const LIST_MIN_W = 220;
const LIST_DEF_W = 300;
// Столько остаётся самому чату. Уже — и ряд настроек в его шапке начинает рваться
// (порог 900 в медиазапросах ChatSession отсчитывается от ширины ОКНА, а не колонки).
const CHAT_MIN_W = 420;

/**
 * Читает только явный положительный выбор ширины из настройки устройства.
 * Отсутствие или отказ storage сохраняют прежнюю раскладку CSS.
 */
function storedListWidth(): number | null {
  try {
    const raw = Number(localStorage.getItem(LIST_WIDTH_KEY));

    return Number.isFinite(raw) && raw > 0 ? raw : null;
  } catch {
    return null;
  }
}

const host = ref<HTMLElement | null>(null);
const splitter = ref<HTMLElement | null>(null);
const listMaxW = ref(560);
// Желаемая ширина отдельно от применённой: при временном сужении окна список ужимается,
// а на широком экране возвращается к выбору человека — как разделитель дерева в «Коде».
const listPreferred = ref(storedListWidth());
const listWidth = computed(() => (
  listPreferred.value == null ? null : clampListWidth(listPreferred.value)
));
const layoutStyle = computed(() => (
  listWidth.value == null ? null : { '--chat-list-w': `${listWidth.value}px` }
));

function clampListWidth(value: number) {
  const max = Math.max(LIST_MIN_W, listMaxW.value);

  return Math.round(Math.min(Math.max(LIST_MIN_W, value), max));
}

/**
 * Ограничивает список измеренной шириной хоста, оставляя место самому чату.
 * Нулевое измерение скрытой страницы не меняет последний доступный потолок.
 */
function measureListMax() {
  const width = host.value?.getBoundingClientRect?.().width;

  if (width === undefined || !(width > 0)) {
    return;
  }

  // Потолок — не фиксированные 560: на широком мониторе человек вправе отдать списку
  // больше, но чату всегда остаётся CHAT_MIN_W.
  listMaxW.value = Math.max(LIST_MIN_W, Math.min(Math.max(560, width * 0.4), width - CHAT_MIN_W));
}

// Текущая ширина для клавиатуры и ARIA. Пока переменная не задана, ширину знает только
// CSS — измеряем её по положению самого разделителя (он стоит ровно на правом краю
// списка), а не по второму медиазапросу в JS.
/**
 * Возвращает применённую ширину либо измеряет обычное положение разделителя.
 * Измерение и клавиатура используют те же границы, что перетаскивание.
 */
function currentListWidth() {
  if (listWidth.value != null) {
    return listWidth.value;
  }

  const rect = splitter.value?.getBoundingClientRect?.();
  const hostRect = host.value?.getBoundingClientRect?.();

  if (rect?.width && hostRect?.width) {
    return clampListWidth(rect.left + rect.width / 2 - hostRect.left);
  }

  return LIST_DEF_W;
}

/**
 * Сохраняет только применённую ширину после действия человека.
 * Закрытый storage не прерывает перетаскивание в текущем окне.
 */
function saveListWidth() {
  if (listWidth.value == null) {
    return;
  }

  try {
    localStorage.setItem(LIST_WIDTH_KEY, String(listWidth.value));
  } catch { /* приватный режим может запретить storage */ }
}

let listPointer: number | null = null;

function listWidthFrom(clientX: number) {
  const rect = host.value?.getBoundingClientRect?.();

  if (!rect?.width) {
    return currentListWidth();
  }

  return clampListWidth(clientX - rect.left);
}
/**
 * Начинает перетаскивание основным указателем и запоминает его id.
 * Захват оставляет дальнейшие события на разделителе до отпускания.
 */
function startListResize(event: PointerEvent) {
  if (event.button !== undefined && event.button !== 0) {
    return;
  }

  listPointer = event.pointerId;

  if (event.currentTarget instanceof HTMLElement) {
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  measureListMax();
  listPreferred.value = listWidthFrom(event.clientX);
}

function moveListResize(event: PointerEvent) {
  if (listPointer !== event.pointerId) {
    return;
  }

  listPreferred.value = listWidthFrom(event.clientX);
}
/**
 * Завершает только текущее перетаскивание и записывает настройку устройства.
 * Событие чужого указателя не сбрасывает действующий захват.
 */
function finishListResize(event: PointerEvent) {
  if (listPointer !== event.pointerId) {
    return;
  }

  listPointer = null;

  if (event.currentTarget instanceof HTMLElement) {
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  }

  saveListWidth();
}
/**
 * Отмена сохраняет уже применённую ширину без чтения ненадёжного clientX.
 * Освобождается только указатель текущего перетаскивания.
 */
function cancelListResize(event: PointerEvent) {
  if (listPointer !== event.pointerId) {
    return;
  }

  listPointer = null;

  if (event.currentTarget instanceof HTMLElement) {
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  }

  // pointercancel не гарантирует осмысленный clientX — сохраняем уже применённую ширину.
  saveListWidth();
}
/**
 * Меняет ширину клавишами с прежним обычным и ускоренным шагом.
 * Обрабатываемая клавиша сохраняет ту же настройку, что мышь.
 */
function onListResizeKey(event: KeyboardEvent) {
  const step = event.shiftKey ? 64 : 16;

  measureListMax();

  if (event.key === 'ArrowLeft') {
    listPreferred.value = clampListWidth(currentListWidth() - step);
  } else if (event.key === 'ArrowRight') {
    listPreferred.value = clampListWidth(currentListWidth() + step);
  } else if (event.key === 'Home') {
    listPreferred.value = LIST_MIN_W;
  } else if (event.key === 'End') {
    listPreferred.value = clampListWidth(listMaxW.value);
  } else {
    return;
  }

  event.preventDefault();
  saveListWidth();
}
// Двойной клик — вернуть ширину по умолчанию. Настройку именно СТИРАЕМ, а не пишем 300:
// иначе список навсегда терял бы более узкий умолчательный размер планшета.
/**
 * Возвращает управление шириной CSS, удаляя явное предпочтение устройства.
 * Удаление сохраняет разные обычные размеры планшета и широкого экрана.
 */
function resetListWidth() {
  listPreferred.value = null;

  try {
    localStorage.removeItem(LIST_WIDTH_KEY);
  } catch { /* настройка недоступна */ }
}

let hostObserver: ResizeObserver | null = null;

onMounted(() => {
  measureListMax();

  if (typeof ResizeObserver === 'function' && host.value) {
    hostObserver = new ResizeObserver(() => measureListMax());
    hostObserver.observe(host.value);
  }
});
onBeforeUnmount(() => {
  hostObserver?.disconnect?.();
  hostObserver = null;
  pageSurface.dispose();
});
</script>

<style scoped>
.agents { display: flex; height: 100%; min-height: 0;
  background: var(--surface); border: 0; border-radius: 0; overflow: hidden; }
.stage { flex: 1; min-width: 0; display: flex; }
.stage :deep(.cs) { flex: 1; }

/* Разделитель стоит ПОВЕРХ границы списка (отрицательные поля), поэтому собственного
   места в раскладке не занимает: без этого включение ресайза сдвинуло бы обе колонки. */
.lsplit { flex: none; width: 9px; margin: 0 -4px; z-index: 2; position: relative;
  display: grid; place-items: center; cursor: col-resize; touch-action: none; outline: none; }
/* Хватку видно и без ховера — как у разделителей дока и «Кода»: невидимая ручка
   означает, что о возможности тянуть человек не узнает вовсе. Токен ярче и полоска
   толще, чем у них (там `--line-2`, 2px): здесь ручка лежит ПОВЕРХ уже нарисованной
   границы, а `--line-2` на `--line` — почти та же краска (замер: разницы нет вовсе). */
.lsplit span { width: 3px; height: 46px; border-radius: 999px;
  background: color-mix(in srgb, var(--ink-mid) 42%, transparent); transition: background .12s; }
.lsplit:hover span, .lsplit:focus-visible span { background: var(--accent); }

/* Узкий экран (планшет-портрет и телефон): на экране только одна колонка — список либо
   чат. Кнопка «назад» в шапке чата возвращает к списку; порог 900 общий с ChatSession. */
@media (max-width: 899px) {
  .agents.m-list .stage { display: none; }
  .agents.m-chat :deep(.cl) { display: none; }
  /* Колонка одна и она во весь экран — двигать нечего */
  .lsplit { display: none; }
}
</style>
