<template>
  <div class="conflict" data-role="project-conflict">
    <p class="ttl">Паспорт изменился после того, как форма его прочитала.</p>
    <p class="sub">
      Серверная ревизия: {{ conflict.currentRevision }}. Ваши правки не потеряны:
    </p>
    <ul class="fields">
      <li v-for="field in labels" :key="field">{{ field }}</li>
    </ul>

    <div class="acts">
      <UiButton
        data-role="project-conflict-reload"
        tone="accent"
        :disabled="busy"
        @click="emit('reload')"
      >
        Перечитать серверную версию
      </UiButton>
      <UiButton
        data-role="project-conflict-overwrite"
        variant="text"
        :disabled="busy"
        @click="emit('overwrite')"
      >
        Сохранить мой черновик поверх свежей ревизии
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
  border-radius: 8px;
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
