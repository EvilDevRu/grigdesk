<template>
  <section class="route-prompt-preview">
    <h3>Предпросмотр инструкции</h3>
    <p>Введите синтетический JSON-контекст. Команды завершения движок добавит только при
      реальном запуске; здесь не используются данные задачи или вызовы ИИ.</p>
    <label>Контекст
      <UiTextarea v-model="contextText" data-test="preview-context" />
    </label>
    <p v-if="inputError" class="bad" role="alert">{{ inputError }}</p>
    <UiButton data-test="preview-run" :disabled="busy" @click="requestPreview">
      Показать инструкцию
    </UiButton>
    <p v-if="stale" class="bad">Предпросмотр устарел после правки черновика.</p>
    <template v-if="result">
      <div v-if="result.includedBlocks.length">
        <strong>Включены блоки</strong>
        <ul><li v-for="file in result.includedBlocks" :key="file">{{ file }}</li></ul>
      </div>
      <div v-if="result.excludedBlocks.length">
        <strong>Выключены блоки</strong>
        <ul><li v-for="file in result.excludedBlocks" :key="file">{{ file }}</li></ul>
      </div>
      <div v-if="result.issues.length" role="alert">
        <strong>Недостающие секции и проблемы</strong>
        <ul><li v-for="(issue, index) in result.issues" :key="index">
          {{ issue.path }}: {{ issue.message }}
        </li></ul>
      </div>
      <pre v-if="result.text" data-test="preview-text">{{ result.text }}</pre>
    </template>
  </section>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { UiButton, UiTextarea } from '../../ui';

defineProps<{
  result: {
  text: string;
  includedBlocks: string[];
  excludedBlocks: string[];
  issues: Array<{
    code: string;
    path: string;
    message: string
  }>
} | null;
  stale: boolean;
  busy: boolean
}>();

const emit = defineEmits<{ request: [context: Record<string, unknown>] }>();
const contextText = ref('{"task":{"kind":"normal"}}');
const inputError = ref('');

/**
 * Разбирает контекст и запрашивает итоговый текст блока.
 * Ошибочный контекст не отправляется в API проверки промпта.
 */
function requestPreview(): void {
  try {
    const context: unknown = JSON.parse(contextText.value);

    if (!context || typeof context !== 'object' || Array.isArray(context)) {
      inputError.value = 'Контекст должен быть JSON-объектом.';

      return;
    }

    inputError.value = '';
    emit('request', context as Record<string, unknown>);
  } catch {
    inputError.value = 'Исправьте синтаксис JSON-контекста.';
  }
}
</script>

<style scoped>
.route-prompt-preview { border: 1px solid var(--line); border-radius: 8px; padding: 12px; }
.route-prompt-preview label { display: grid; gap: 6px; }
.route-prompt-preview pre { overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere;
  background: var(--surface-2); padding: 10px; }
.bad { color: var(--bad); }
</style>
