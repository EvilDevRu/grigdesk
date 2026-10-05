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
        v-tooltip="'Новый проект'"
        tone="accent"
        @click="emit('create')"
      >
        +
      </UiIconButton>
    </UiControlGroup>
  </div>
</template>

<script setup>
// Переключатель проекта: выбор открытого профиля и просьба завести новый.
//
// Заведение проекта — не его дело: форма, проверка идентификатора и запись живут
// в разделе «Проекты», и второй вход создавал бы вторую запись в том же реестре.
import { UiButton, UiControlGroup, UiIconButton, vTooltip } from '../../ui';

defineProps({
  profiles: {
    type: Array,
    required: true,
  },
});
const emit = defineEmits(['create']);
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
