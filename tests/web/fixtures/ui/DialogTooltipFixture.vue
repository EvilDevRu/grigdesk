<template>
  <UiDialog v-model:open="open" title="Проба" label="Проба">
    <template #default="{ isTop }">
      <span data-top>{{ String(isTop) }}</span>
      <UiTooltip text="Подсказка" :show-delay="0">
        <template #trigger>
          <UiButton data-first>Первая</UiButton>
        </template>
      </UiTooltip>
      <UiButton data-last>Последняя</UiButton>
    </template>
  </UiDialog>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { UiButton, UiDialog, UiTooltip } from '../../../../web/src/ui';

const open = ref(true);
</script>
