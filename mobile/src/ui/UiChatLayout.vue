<template>
  <UiButton class="chat-layout-button" variant="ghost" aria-label="Вид чата" @click="open = true">
    <UiIcon name="panels" />
  </UiButton>
  <UiDialog
    v-if="open"
    title="Вид чата"
    confirm="Применить"
    @close="open = false"
    @confirm="apply"
  >
    <div v-if="tablet" class="chat-layout-list-settings">
      <UiSwitch v-model="listVisible">Показывать список чатов</UiSwitch>
      <label v-if="listVisible" class="mobile-field">
        <span>Ширина списка</span>
        <input
          v-model.number="listWidth"
          class="layout-range"
          type="range"
          min="15"
          max="26"
          step="1"
          aria-label="Ширина списка"
        />
        <span class="layout-range-labels"><span>Уже</span><span>Шире</span></span>
      </label>
    </div>
    <label class="mobile-field">
      <span>Высота поля ввода</span>
      <input
        v-model.number="composerHeight"
        class="layout-range"
        type="range"
        min="3"
        max="15"
        step="1"
        aria-label="Высота поля ввода"
      />
      <span class="layout-range-labels"><span>Ниже</span><span>Выше</span></span>
    </label>
    <UiButton @click="reset">Обычный вид</UiButton>
  </UiDialog>
</template>

<script setup lang="ts">
import { onScopeDispose, ref, watch } from 'vue';

import { useChatLayoutStore } from '../stores/chatLayout.ts';
import UiButton from './UiButton.vue';
import UiDialog from './UiDialog.vue';
import UiIcon from './UiIcon.vue';
import UiSwitch from './UiSwitch.vue';

const layout = useChatLayoutStore();
const open = ref(false);
const listVisible = ref(true);
const listWidth = ref(19);
const composerHeight = ref(3);
const isTablet = () => document.documentElement.dataset.device === 'tablet' && window.innerWidth >= 760;
const tablet = ref(isTablet());
const onResize = () => {
  tablet.value = isTablet();
};

// Недоступные на телефоне настройки не монтируются: скрытый CSS-контрол не должен
// перехватывать фокус диалога или участвовать в обходе клавишей Tab.
window.addEventListener('resize', onResize);
onScopeDispose(() => window.removeEventListener('resize', onResize));

watch(open, (value) => {
  if (value) {
    listVisible.value = layout.listVisible;
    listWidth.value = layout.listWidth;
    composerHeight.value = layout.composerHeight;
  }
});

/**
 * Закрытие диалога отменяет примерку: общая раскладка меняется только по «Применить».
 * Сворачивание списка действует на планшете; на телефоне остаётся штатный возврат.
 */
function apply() {
  layout.listVisible = listVisible.value;
  layout.listWidth = listWidth.value;
  layout.composerHeight = composerHeight.value;
  open.value = false;
}

/**
 * Возвращает исходную геометрию внутри формы, сохраняя возможность отменить решение.
 * Само сохранение выполняет общий обработчик подтверждения диалога.
 */
function reset() {
  listVisible.value = true;
  listWidth.value = 19;
  composerHeight.value = 3;
}
</script>
