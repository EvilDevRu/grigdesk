<template>
  <div class="project-switcher">
    <UiControlGroup label="Проект">
      <UiButton
        v-for="project in profiles"
        :key="project"
        class="mono"
        variant="ghost"
        :tone="project === model ? 'accent' : 'neutral'"
        :pressed="project === model"
        @click="model = project"
      >
        {{ project }}
      </UiButton>

      <UiIconButton
        label="Новый проект"
        title="Новый проект"
        tone="accent"
        :loading="creating"
        @click="addProject"
      >
        +
      </UiIconButton>
    </UiControlGroup>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { api } from '../../shared/apiClient.ts';
import {
  alertDialog,
  promptDialog,
  UiButton,
  UiControlGroup,
  UiIconButton,
} from '../../ui';

const props = defineProps({
  profiles: {
    type: Array,
    required: true,
  },
});
const emit = defineEmits(['created']);
const model = defineModel({
  type: String,
  required: true,
});

const creating = ref(false);
const PROJECT_ID_PATTERN = /^[a-z0-9_-]+$/;

function errorMessage(error) {
  return error instanceof Error && error.message
    ? error.message
    : 'Неизвестная ошибка';
}

/**
 * Создание проекта начинается в управляемом UI-диалоге. До запроса на сервер
 * отсекаем идентификаторы, которые сам интерфейс объявляет недопустимыми.
 */
async function addProject() {
  const answer = await promptDialog({
    title: 'Новый проект',
    text: 'Идентификатор: строчные латинские буквы, цифры, дефис или подчёркивание.',
    placeholder: 'my-project',
    okText: 'Создать',
  });
  const id = answer?.trim() || '';

  if (!id) {
    return;
  }
  if (!PROJECT_ID_PATTERN.test(id)) {
    await alertDialog('Используй только a–z, 0–9, дефис и подчёркивание.', {
      title: 'Недопустимый идентификатор',
    });

    return;
  }

  creating.value = true;

  try {
    const response = await api.post('/api/profiles', { id });

    emit('created', {
      id,
      profiles: response.profiles || [],
    });
  } catch (error) {
    await alertDialog(`Не удалось создать проект: ${errorMessage(error)}`);
  } finally {
    creating.value = false;
  }
}
</script>

<style scoped>
.project-switcher {
  padding: 0 4px 10px;
}
</style>
