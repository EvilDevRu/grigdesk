<template>
  <section class="plugin-frame" :class="{ 'is-compact': compact }" :aria-label="label">
    <iframe
      ref="frame"
      class="plugin-frame__view"
      :src="src"
      :title="label"
      referrerpolicy="same-origin"
    ></iframe>
  </section>
</template>

<script setup lang="ts">
import { ref } from 'vue';

// Панель страницы пользовательского плагина. Ядро не знает, что внутри: страница
// приезжает с сервера GrigDesk под /api/ext/<id>/web/ и сама ходит в API с той же
// сессией (тот же origin). Снести папку плагина — панель просто исчезнет из рейки.
const props = defineProps<{
  src: string;
  label: string;
  active?: boolean;
  compact?: boolean;
  presentation?: string;
  intents?: unknown[];
}>();

const frame = ref<HTMLIFrameElement | null>(null);

function focus(): void {
  frame.value?.focus();
}

defineExpose({ focus, src: props.src });
</script>

<style scoped>
.plugin-frame {
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
  height: 100%;
}

.plugin-frame.is-compact {
  padding-top: 36px;
}

.plugin-frame__view {
  flex: 1 1 auto;
  width: 100%;
  min-height: 0;
  border: 0;
  background: var(--surface);
}
</style>
