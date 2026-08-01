<script setup>
import { ref, watch, onUnmounted } from 'vue';

// Иконка-подсказка «?» с тултипом для человека: что делает настройка.
// Показывается по ховеру и по фокусу (клавиатура/тач). Если сверху не хватает
// места (иконка у верха экрана) — тултип автоматически раскрывается вниз.
// Слоты: default — свой триггер вместо «?» (например, бейджи), tip — свой
// контент тултипа вместо текста (разметка, а не строка).
// fixed — позиционирование от вьюпорта: нужно внутри скролл-контейнеров
// (overflow режет absolute-тултип), координаты считаются на ховере.
const props = defineProps({
  text: { type: String, default: '' },
  // Куда раскрывать тултип, если элемент у края: center (по умолчанию) | left | right
  align: { type: String, default: 'center' },
  fixed: { type: Boolean, default: false },
  // У составного триггера (например, <select>) уже есть собственный фокус. Не добавляем
  // ему второй Tab-stop на обёртке, но :focus-within по-прежнему покажет подсказку.
  triggerFocusable: { type: Boolean, default: true },
  // Клик по триггеру закрепляет всплывашку открытой (и закрывает повторным кликом).
  // Нужно на планшете: там ховера нет, а тап по триггеру-ссылке уносил со страницы
  // раньше, чем человек успевал прочитать содержимое.
  toggle: { type: Boolean, default: false },
});

const rootEl = ref(null);
const icEl = ref(null);
const tipEl = ref(null);
const below = ref(false);
const tipStyle = ref({});

// Показ управляется из JS, а не CSS :hover: тултип в fixed-режиме отстоит от
// триггера на зазор, и на пути к нему hover слетал — навести мышь на кнопки
// внутри было невозможно. Закрытие с задержкой: успеваем перелететь зазор.
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
  // Без снятия фокуса :focus-within оставил бы подсказку висеть после закрытия.
  icEl.value?.blur?.();
}
// Клик по кнопке внутри подсказки — это действие (уход на страницу, команда):
// закреплённую всплывашку после него держать незачем.
function onTipClick(e) {
  if (pinned.value && e.target?.closest?.('button, a')) close();
}
function onDocDown(e) { if (!rootEl.value?.contains(e.target)) close(); }
watch(pinned, (v) => {
  if (v) document.addEventListener('pointerdown', onDocDown, true);
  else document.removeEventListener('pointerdown', onDocDown, true);
});
onUnmounted(() => { clearTimeout(hideT); document.removeEventListener('pointerdown', onDocDown, true); });

function place() {
  const r = icEl.value?.getBoundingClientRect();
  // ~120px — высота тултипа с запасом; меньше сверху → раскрываемся вниз.
  below.value = (r?.top ?? 999) < 120;
  if (!props.fixed || !r || !tipEl.value) return;
  // Тултип отрендерен (скрыт прозрачностью) — размеры можно мерить сразу.
  const tw = tipEl.value.offsetWidth || 0;
  const th = tipEl.value.offsetHeight || 0;
  below.value = r.top - th - 12 < 8;
  const want = props.align === 'right' ? r.right - tw : props.align === 'left' ? r.left : r.left + r.width / 2 - tw / 2;
  const left = Math.min(Math.max(want, 8), window.innerWidth - tw - 8);
  const top = below.value ? r.bottom + 9 : r.top - th - 9;
  tipStyle.value = { left: `${left}px`, top: `${top}px` };
}
</script>

<template>
  <span ref="rootEl" class="ht" :class="[`al-${align}`, { below, fx: fixed, on, pinned }]"
        @mouseenter="show" @mouseleave="hide" @keydown.esc="close">
    <span v-if="$slots.default" ref="icEl" class="ht-tr" :tabindex="triggerFocusable ? 0 : undefined"
          @focus="show" @blur="hide" @click="onTriggerClick"><slot /></span>
    <span v-else ref="icEl" class="ht-ic" tabindex="0" aria-label="Подсказка"
          @focus="show" @blur="hide" @click="onTriggerClick">?</span>
    <span ref="tipEl" class="ht-tip" role="tooltip" :style="fixed ? tipStyle : undefined"
          @click="onTipClick"><slot name="tip">{{ text }}</slot></span>
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

.ht-tip {
  position: absolute; bottom: calc(100% + 9px); left: 50%;
  transform: translateX(-50%) translateY(4px);
  opacity: 0; pointer-events: none;
  transition: opacity .16s ease, transform .16s ease;
  background: var(--surface-2); border: 1px solid var(--line-2); color: var(--ink);
  padding: 9px 12px; border-radius: 10px;
  width: max-content; max-width: 270px;
  font-size: 12px; line-height: 1.5; font-weight: 400;
  text-transform: none; letter-spacing: normal; white-space: normal;
  z-index: 60; box-shadow: 0 10px 28px #000a;
}
/* стрелка (вниз — тултип над иконкой) */
.ht-tip::after {
  content: ''; position: absolute; top: 100%; left: 50%; transform: translateX(-50%);
  border: 5px solid transparent; border-top-color: var(--line-2);
}
.ht.on .ht-tip, .ht:focus-within .ht-tip { opacity: 1; transform: translateX(-50%) translateY(0); }
/* Видимый тултип кликабелен (внутри бывают кнопки действий) */
.ht.on .ht-tip, .ht:focus-within .ht-tip { pointer-events: auto; }
/* Свой триггер (слот): без круга, курсор как у подсказки */
.ht-tr { display: inline-flex; align-items: center; cursor: help; outline: none; }

/* fixed-режим: координаты от вьюпорта (inline-стилем из place), стрелку не рисуем —
   тултип может быть прижат к краю и стрелка укажет мимо триггера. */
.ht.fx .ht-tip, .ht.fx.below .ht-tip { position: fixed; bottom: auto; right: auto; transform: translateY(4px); }
.ht.fx.on .ht-tip, .ht.fx:focus-within .ht-tip { transform: translateY(0); }
.ht.fx .ht-tip::after { display: none; }

/* Раскрытие вниз, когда сверху нет места */
.ht.below .ht-tip { bottom: auto; top: calc(100% + 9px); transform: translateX(-50%) translateY(-4px); }
.ht.below.on .ht-tip, .ht.below:focus-within .ht-tip { transform: translateX(-50%) translateY(0); }
.ht.below .ht-tip::after { top: auto; bottom: 100%; border-top-color: transparent; border-bottom-color: var(--line-2); }

/* Раскрытие у края: тултип прижат к левому/правому краю иконки */
.al-left .ht-tip { left: -6px; transform: translateY(4px); }
.al-left.on .ht-tip, .al-left:focus-within .ht-tip { transform: translateY(0); }
.al-left .ht-tip::after { left: 10px; transform: none; }
.al-left.below .ht-tip { transform: translateY(-4px); }
.al-left.below.on .ht-tip, .al-left.below:focus-within .ht-tip { transform: translateY(0); }
.al-right .ht-tip { left: auto; right: -6px; transform: translateY(4px); }
.al-right.on .ht-tip, .al-right:focus-within .ht-tip { transform: translateY(0); }
.al-right .ht-tip::after { left: auto; right: 10px; transform: none; }
.al-right.below .ht-tip { transform: translateY(-4px); }
.al-right.below.on .ht-tip, .al-right.below:focus-within .ht-tip { transform: translateY(0); }

@media (prefers-reduced-motion: reduce) { .ht-tip { transition: opacity .16s ease; } }
</style>
