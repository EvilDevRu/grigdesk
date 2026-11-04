<template>
  <section class="ui-workspace-page">
    <UiPaneHeader v-if="$slots.title || $slots.meta || $slots.actions">
      <template v-if="$slots.title" #title><slot name="title" /></template>
      <template v-if="$slots.meta" #meta><slot name="meta" /></template>
      <template v-if="$slots.actions" #actions><slot name="actions" /></template>
    </UiPaneHeader>
    <div class="ui-workspace-page__body"><slot /></div>
  </section>
</template>

<script setup lang="ts">
import UiPaneHeader from './UiPaneHeader.vue';

// Полноразмерный раздел использует ту же шапку, что каталоги и рабочие панели.
// Прокрутка и поля принадлежат телу; действия и состояние остаются у потребителя.
defineSlots<{
  default(): unknown;
  title?(): unknown;
  meta?(): unknown;
  actions?(): unknown;
}>();
</script>
