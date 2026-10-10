<template>
  <div class="mobile-error" role="alert">
    <UiIcon name="alert" />
    <p>{{ text }}</p>
    <UiButton v-if="onRetry" @click="onRetry()">Повторить</UiButton>
  </div>
</template>

<script setup lang="ts">
import UiButton from './UiButton.vue';
import UiIcon from './UiIcon.vue';

// Обработчик `@retry` объявлен свойством: кнопка показывается, только если экрану есть
// что перечитать. Событие через defineEmits оставляло её скрытой всегда.
defineProps<{
  text: string;
  onRetry?: () => unknown;
}>();
</script>
