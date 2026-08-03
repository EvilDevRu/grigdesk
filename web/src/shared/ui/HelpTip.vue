<script setup>
import { ref, watch, onMounted, onUnmounted } from 'vue';

// Иконка-подсказка «?» с тултипом для человека: что делает настройка.
// Показывается по ховеру и по фокусу (клавиатура/тач).
//
// Тултип ВСЕГДА живёт в <body> (Teleport) и позиционируется от вьюпорта.
// Раньше он был absolute внутри страницы и прятался: любой скролл-контейнер
// (`.content` кокпита, списки, панели) обрезал его по своей границе, а модалки
// и топбар перекрывали по z-index. Из body его нечем обрезать, а z-index выше
// всех слоёв приложения. Координаты считаются на показе и пересчитываются на
// скролле/ресайзе и при изменении размера самой подсказки (содержимое часто
// догружается уже раскрытым — полосы лимитов исполнителей).
//
// Слоты: default — свой триггер вместо «?» (например, бейджи), tip — свой
// контент тултипа вместо текста (разметка, а не строка).
const props = defineProps({
  text: { type: String, default: '' },
  // Куда тянуть тултип от триггера: center (по умолчанию) | left | right.
  // Это лишь предпочтение: у края экрана тултип всё равно поджимается к экрану.
  align: { type: String, default: 'center' },
  // У составного триггера (например, <select>) уже есть собственный фокус. Не добавляем
  // ему второй Tab-stop на обёртке, но фокус внутри по-прежнему покажет подсказку.
  triggerFocusable: { type: Boolean, default: true },
  // Клик по триггеру закрепляет всплывашку открытой (и закрывает повторным кликом).
  // Нужно на планшете: там ховера нет, а тап по триггеру-ссылке уносил со страницы
  // раньше, чем человек успевал прочитать содержимое.
  toggle: { type: Boolean, default: false },
  // Точечная правка вида от места вызова (ширина, отступы). Стилями вызывающего
  // компонента до тултипа не дотянуться: он в body, и scoped-CSS (`:deep(.ht-tip)`)
  // мимо — селектор ищет потомка, а тултип уже не потомок.
  tipStyle: { type: Object, default: null },
});

const rootEl = ref(null);
const icEl = ref(null);
const tipEl = ref(null);
const below = ref(false);
const posStyle = ref({ left: '0px', top: '0px' });

// Показ управляется из JS, а не CSS :hover: тултип отстоит от триггера на зазор,
// и на пути к нему hover слетал — навести мышь на кнопки внутри было невозможно.
// Закрытие с задержкой: успеваем перелететь зазор.
const on = ref(false);
// Закреплена кликом (режим toggle): ховер и потеря фокуса её не закрывают.
const pinned = ref(false);
let hideT = null;
function show() { clearTimeout(hideT); place(); on.value = true; }
function hide() {
  if (pinned.value) return;
  clearTimeout(hideT);
  hideT = setTimeout(() => { on.value = false; }, 180);
}

function onTriggerClick() {
  if (!props.toggle) return;
  if (pinned.value) { close(); return; }
  pinned.value = true;
  show();
}
function close() {
  pinned.value = false;
  clearTimeout(hideT);
  on.value = false;
  // Без снятия фокуса focusin оставил бы подсказку висеть после закрытия.
  icEl.value?.blur?.();
}
// Клик по кнопке внутри подсказки — это действие (уход на страницу, команда):
// закреплённую всплывашку после него держать незачем.
function onTipClick(e) {
  if (pinned.value && e.target?.closest?.('button, a')) close();
}
// Тултип вне корня компонента, поэтому «клик мимо» проверяем по обоим узлам.
function onDocDown(e) {
  if (rootEl.value?.contains(e.target) || tipEl.value?.contains(e.target)) return;
  close();
}
watch(pinned, (v) => {
  if (v) document.addEventListener('pointerdown', onDocDown, true);
  else document.removeEventListener('pointerdown', onDocDown, true);
});

const GAP = 9;   // зазор между триггером и тултипом
const EDGE = 8;  // минимальный отступ от края экрана

function place() {
  const r = icEl.value?.getBoundingClientRect();
  const tip = tipEl.value;
  if (!r || !tip) return;
  // Тултип отрендерен (скрыт прозрачностью) — размеры можно мерить сразу.
  const tw = tip.offsetWidth || 0;
  const th = tip.offsetHeight || 0;
  // Сверху не хватает — раскрываемся вниз; если тесно с обеих сторон, берём просторнее.
  const roomAbove = r.top - GAP - EDGE;
  const roomBelow = window.innerHeight - r.bottom - GAP - EDGE;
  below.value = roomAbove < th && roomBelow > roomAbove;
  const want = props.align === 'right' ? r.right - tw
    : props.align === 'left' ? r.left
    : r.left + r.width / 2 - tw / 2;
  const maxLeft = Math.max(EDGE, window.innerWidth - tw - EDGE);
  const left = Math.min(Math.max(want, EDGE), maxLeft);
  const maxTop = Math.max(EDGE, window.innerHeight - th - EDGE);
  const top = Math.min(Math.max(below.value ? r.bottom + GAP : r.top - th - GAP, EDGE), maxTop);
  // Стрелка смотрит на триггер, даже когда тултип поджат к краю экрана.
  const arrow = Math.min(Math.max(r.left + r.width / 2 - left, 14), Math.max(14, tw - 14));
  posStyle.value = { left: `${left}px`, top: `${top}px`, '--ht-arrow': `${arrow}px` };
}

// Триггер уехал вместе со скроллом — тултип тянется за ним, а уйдя за экран, закрывается
// (иначе он висел бы у края, показывая подсказку к невидимому элементу).
function onMove() {
  const r = icEl.value?.getBoundingClientRect();
  if (!r) return;
  if (r.bottom < 0 || r.top > window.innerHeight) { close(); return; }
  place();
}

let ro = null;
onMounted(() => {
  // Скролл ловим в фазе перехвата: он может идти в любом внутреннем контейнере.
  window.addEventListener('scroll', onMove, { capture: true, passive: true });
  window.addEventListener('resize', onMove);
  // Содержимое подсказки меняется прямо на глазах (догрузились лимиты) — переставляем.
  if (typeof ResizeObserver !== 'undefined' && tipEl.value) {
    ro = new ResizeObserver(() => { if (on.value) place(); });
    ro.observe(tipEl.value);
  }
});
onUnmounted(() => {
  clearTimeout(hideT);
  document.removeEventListener('pointerdown', onDocDown, true);
  window.removeEventListener('scroll', onMove, { capture: true });
  window.removeEventListener('resize', onMove);
  ro?.disconnect();
});
</script>

<template>
  <span ref="rootEl" class="ht" @mouseenter="show" @mouseleave="hide"
        @focusin="show" @focusout="hide" @keydown.esc="close">
    <span v-if="$slots.default" ref="icEl" class="ht-tr" :tabindex="triggerFocusable ? 0 : undefined"
          @click="onTriggerClick"><slot /></span>
    <span v-else ref="icEl" class="ht-ic" tabindex="0" aria-label="Подсказка"
          @click="onTriggerClick">?</span>
    <Teleport to="body">
      <span ref="tipEl" class="ht-tip" :class="{ on, below, pinned }" role="tooltip"
            :style="[posStyle, tipStyle || {}]"
            @mouseenter="show" @mouseleave="hide" @keydown.esc="close" @click="onTipClick">
        <span class="ht-body"><slot name="tip">{{ text }}</slot></span>
      </span>
    </Teleport>
  </span>
</template>

<style scoped>
.ht { position: relative; display: inline-flex; vertical-align: -1px; }
.ht-ic {
  width: 14px; height: 14px; border-radius: 50%;
  border: 1px solid var(--line-2); color: var(--ink-mid);
  font-size: 9.5px; font-weight: 700; line-height: 1;
  display: inline-flex; align-items: center; justify-content: center;
  cursor: help; user-select: none;
}
.ht:hover .ht-ic, .ht-ic:focus { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 55%, var(--line-2)); outline: none; }
/* Свой триггер (слот): без круга, курсор как у подсказки */
.ht-tr { display: inline-flex; align-items: center; cursor: help; outline: none; }

/* Тултип телепортирован в body: координаты — инлайном из place(), фиксированные от
   вьюпорта. z-index выше модалок (120) и баннеров (200): всплывашка поверх всего. */
.ht-tip {
  position: fixed; left: 0; top: 0; z-index: 300;
  opacity: 0; pointer-events: none; transform: translateY(4px);
  transition: opacity .16s ease, transform .16s ease;
  background: var(--surface-2); border: 1px solid var(--line-2); color: var(--ink);
  padding: 9px 12px; border-radius: 10px;
  width: max-content; max-width: 270px;
  font-size: 12px; line-height: 1.5; font-weight: 400;
  text-transform: none; letter-spacing: normal; white-space: normal; text-align: left;
  box-shadow: 0 10px 28px #000a;
}
.ht-tip.below { transform: translateY(-4px); }
/* Видимый тултип кликабелен (внутри бывают кнопки действий) */
.ht-tip.on { opacity: 1; transform: translateY(0); pointer-events: auto; }
/* Длинную подсказку прокручиваем внутри, а не выпускаем за экран.
   Прокрутка на внутренней обёртке: overflow на самом тултипе срезал бы стрелку. */
.ht-body { display: block; max-height: calc(100vh - 24px); overflow: auto; }

/* Стрелка смотрит на триггер (--ht-arrow из place), даже если тултип поджат к краю */
.ht-tip::after {
  content: ''; position: absolute; top: 100%; left: var(--ht-arrow, 50%);
  transform: translateX(-50%);
  border: 5px solid transparent; border-top-color: var(--line-2);
}
.ht-tip.below::after { top: auto; bottom: 100%; border-top-color: transparent; border-bottom-color: var(--line-2); }

@media (prefers-reduced-motion: reduce) { .ht-tip { transition: opacity .16s ease; } }
</style>
