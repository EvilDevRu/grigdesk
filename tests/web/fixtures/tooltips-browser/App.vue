<template>
  <main class="tooltip-fixture">
    <h1>Подсказки действий и контролов</h1>
    <section data-test="bash">
      <StepList :steps="shortSteps" live />
    </section>
    <section data-test="long">
      <StepList :steps="longSteps" live />
    </section>
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
import StepList from '../../../../web/src/views/chat/StepList.vue';

const dialogOpen = ref(false);

// Начальный фокус на поверхности даёт первому Tab настоящее событие focusin.
// Так проверка не зависит от автоматического фокуса первой кнопки после щелчка.
const dialogSurface = () => document.querySelector<HTMLElement>('.ui-dialog');
const command = "cd /srv/app && rg -n 'TODO' src | head -20; echo ---; sed -n 1,80p src/main.ts | cat";
const shortSteps = [{
  k: 'tool',
  id: 'short',
  name: 'Bash',
  title: 'Проверить исходники',
  command,
  preview: 'Поиск и просмотр исходников',
  lang: 'bash',
}];
const longSteps = [{
  k: 'tool',
  id: 'long',
  name: 'Bash',
  title: 'Тридцать строк',
  command: Array.from({ length: 30 }, (_, i) => `echo 'строка ${i + 1}'`).join('\n'),
  lang: 'bash',
}];
</script>

<style scoped>
.tooltip-fixture {
  max-width: 900px;
  margin: 0 auto;
  padding: 30px;
}

.tooltip-fixture > section {
  margin-block: 20px;
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
