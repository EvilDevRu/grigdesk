<template>
  <main class="tooltip-fixture">
    <h1>Подсказки контролов</h1>
    <div class="tooltip-fixture__controls">
      <UiButton v-tooltip="'Обычная справка'" data-test="plain">Кнопка</UiButton>
      <a v-tooltip="'Справка ссылки'" href="#nested" data-test="link">
        Ссылка
        <span v-tooltip="'Справка чипа'" class="tooltip-fixture__chip" data-test="chip">Чип</span>
      </a>
      <UiButton v-tooltip="'Причина недоступности'" disabled data-test="disabled">
        Недоступно
      </UiButton>
      <UiButton data-test="open-dialog" @click="dialogOpen = true">Открыть диалог</UiButton>
    </div>
    <UiTooltipHost />
    <UiDialog v-model:open="dialogOpen" title="Проверка диалога" :initial-focus="dialogSurface">
      <UiButton v-tooltip="'Справка в диалоге'" data-test="dialog-tip">Справка</UiButton>
    </UiDialog>
  </main>
</template>

<script setup lang="ts">
import { ref } from 'vue';

import { UiButton, UiDialog, UiTooltipHost, vTooltip } from '../../../../web/src/ui.ts';

const dialogOpen = ref(false);

// Начальный фокус на поверхности даёт первому Tab настоящее событие focusin.
// Так проверка не зависит от автоматического фокуса первой кнопки после щелчка.
const dialogSurface = () => document.querySelector<HTMLElement>('.ui-dialog');
</script>

<style scoped>
.tooltip-fixture {
  max-width: 900px;
  margin: 0 auto;
  padding: 30px;
}

.tooltip-fixture__controls {
  display: flex;
  align-items: center;
  gap: 20px;
  margin-top: 30px;
}

.tooltip-fixture__chip {
  display: inline-block;
  padding: 8px 12px;
  border: 1px solid var(--line);
  border-radius: 12px;
}
</style>
