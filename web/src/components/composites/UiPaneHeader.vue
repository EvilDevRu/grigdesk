<template>
  <header class="ui-pane-header" :data-inset="inset"
          :data-layout="$slots.title || $slots.meta ? 'title' : 'controls'">
    <div class="ui-pane-header__layout">
      <div v-if="$slots.navigation" class="ui-pane-header__navigation"><slot name="navigation" /></div>
      <div class="ui-pane-header__main">
        <div v-if="$slots.title || $slots.meta" class="ui-pane-header__identity">
          <div v-if="$slots.title" class="ui-pane-header__title"><slot name="title" /></div>
          <div v-if="$slots.meta" class="ui-pane-header__meta"><slot name="meta" /></div>
        </div>
        <slot />
      </div>
      <div v-if="$slots.actions" class="ui-pane-header__actions"><slot name="actions" /></div>
    </div>
  </header>
</template>

<script setup lang="ts">
// Шапка панели не знает сущностей и действий экрана: слоты сохраняют их семантику.
// Размеры зависят от общего toolbar-токена и ширины самой панели, а не окна.
withDefaults(defineProps<{ inset?: 'compact' | 'content' }>(), { inset: 'compact' });

defineSlots<{
  default?(): unknown;
  navigation?(): unknown;
  title?(): unknown;
  meta?(): unknown;
  actions?(): unknown;
}>();
</script>
