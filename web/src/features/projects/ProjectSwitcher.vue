<template>
  <div class="project-switcher">
    <UiControlGroup v-if="compact" label="Проект" data-context="workspace-project">
      <UiSelect :model-value="model" aria-label="Проект" data-context="workspace-project"
                @update:model-value="model = String($event ?? '')">
        <option v-for="project in profiles" :key="project" :value="project">{{ project }}</option>
      </UiSelect>
      <UiIconButton label="Новый проект" v-tooltip="'Новый проект'"
                    data-context="workspace-form" tone="accent" @click="emit('create')">+</UiIconButton>
    </UiControlGroup>
    <UiControlGroup v-else label="Проект">
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
        v-tooltip="'Новый проект'"
        tone="accent"
        @click="emit('create')"
      >
        +
      </UiIconButton>
    </UiControlGroup>
    <UiButton v-if="model" variant="ghost" data-context="workspace-toolbar"
      @click="emit('manage', model)">
      Управление проектом
    </UiButton>
  </div>
</template>

<script setup lang="ts">
// Переключатель проекта: выбор открытого профиля и просьба завести новый.
//
// Заведение проекта — не его дело: форма, проверка идентификатора и запись живут
// в разделе «Проекты», и второй вход создавал бы вторую запись в том же реестре.
import type { PropType } from 'vue';
import { UiButton, UiControlGroup, UiIconButton, UiSelect, vTooltip } from '../../ui';

defineProps({
  compact: Boolean,
  profiles: {
    type: Array as PropType<string[]>,
    required: true,
  },
});

const emit = defineEmits<{ create: []; manage: [id: string] }>();

const model = defineModel({
  type: String,
  required: true,
});
</script>

<style scoped>
.project-switcher {
  padding: 0 4px 10px;
}
</style>
