<template>
  <div class="conflict" data-role="project-conflict">
    <p class="ttl">Проект изменён в другом окне.</p>
    <p class="sub">
      Загрузите версию с сервера или замените её своими изменениями.
      Текущая версия: {{ conflict.currentRevision }}. Ваши изменения:
    </p>
    <ul class="fields">
      <li v-for="field in labels" :key="field">{{ field }}</li>
    </ul>

    <div class="acts">
      <UiButton
        data-role="project-conflict-reload"
        data-context="project-conflict-action"
        tone="accent"
        :disabled="busy"
        @click="emit('reload')"
      >
        Загрузить версию
      </UiButton>
      <UiButton
        data-role="project-conflict-overwrite"
        data-context="project-conflict-action"
        variant="text"
        :disabled="busy"
        @click="emit('overwrite')"
      >
        Заменить моей
      </UiButton>
    </div>
  </div>
</template>

<script setup lang="ts">
// Расхождение ревизий: чья версия паспорта новее — решает человек.
//
// Действий ровно два, и оба — на всю форму: пофилевое слияние здесь только
// запутало бы, а выбор «какая версия главнее» человек делает один раз.
import { computed } from 'vue';

import { UiButton } from '../../ui';
import type { ProjectConflict } from '../../stores/projects';

const props = defineProps<{
  conflict: ProjectConflict;
  busy: boolean;
}>();

const emit = defineEmits<{
  reload: [];
  overwrite: [];
}>();

// Поля называются по-русски: «defaultRepoKey» человеку ничего не говорит,
// а «Репозиторий по умолчанию» — говорит.
const LABELS: Record<string, string> = {
  title: 'Название',
  description: 'Описание',
  tags: 'Метки',
  repos: 'Репозитории',
  defaultRepoKey: 'Репозиторий по умолчанию',
};

const labels = computed(() => props.conflict.changedFields.map((field) => LABELS[field] ?? field));
</script>

<style scoped>
.conflict {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid var(--warn-border, #e0b070);
  border-radius: var(--radius);
}

.ttl {
  margin: 0;
  font-weight: 600;
}

.sub,
.fields {
  margin: 0;
  font-size: 12px;
  opacity: 0.85;
}

.fields {
  padding-left: 18px;
}

.acts {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 4px;
}
</style>
