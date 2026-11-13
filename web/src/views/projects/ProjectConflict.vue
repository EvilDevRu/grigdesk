<template>
  <div class="conflict" data-role="project-conflict">
    <p class="ttl">{{ t('core.projectProektIzmenenVDrugom') }}</p>
    <p class="sub"> {{ t('core.projectZagruziteVersiyuSServera') }} {{ conflict.currentRevision }}{{ t('core.projectVashiIzmeneniya') }} </p>
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
      > {{ t('core.projectZagruzitVersiyu') }} </UiButton>
      <UiButton
        data-role="project-conflict-overwrite"
        data-context="project-conflict-action"
        variant="text"
        :disabled="busy"
        @click="emit('overwrite')"
      > {{ t('core.projectZamenitMoey') }} </UiButton>
    </div>
  </div>
</template>

<script setup lang="ts">
// Расхождение ревизий: чья версия паспорта новее — решает человек.
//
// Действий ровно два, и оба — на всю форму: пофилевое слияние здесь только
// запутало бы, а выбор «какая версия главнее» человек делает один раз.
import { computed } from 'vue';

import { UiButton, t } from '../../ui';
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
  get title() {
    return t('core.taskTitle');
  },
  get description() {
    return t('core.taskDescription');
  },
  get tags() {
    return t('core.projectMetki');
  },
  get repos() {
    return t('core.projectRepozitorii');
  },
  get defaultRepoKey() {
    return t('core.projectRepozitoriyPoUmolchaniyu');
  },
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
