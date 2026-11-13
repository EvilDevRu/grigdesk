<template>
  <form class="scene-form" @submit.prevent="submit">
    <UiField :label="t('core.showcaseEkranNovoyStseny')" class="scene-form__screen">
      <UiSelect v-model="screenId" :disabled="busy || !screens.length">
        <option v-if="!screens.length" value="">{{ t('core.showcaseProfilNeObyavilEkranov') }}</option>
        <option v-for="screen in screens" :key="screen.id" :value="screen.id">
          {{ screen.title }}
        </option>
      </UiSelect>
    </UiField>
    <UiField :label="t('core.showcaseTekstOzvuchki')" class="scene-form__text">
      <UiInput v-model="narration" :disabled="busy" :placeholder="t('core.showcaseOtkryvaemObzorZadach')" />
    </UiField>
    <UiButton type="submit" variant="outline" :aria-disabled="!canAdd">{{ t('core.showcaseDobavitStsenu') }}</UiButton>
  </form>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import { UiButton, UiField, UiInput, UiSelect, t } from '../../ui';
import type { ShowcaseScreen } from '../../../../shared/plugins/showcase/showcaseContracts';

const props = defineProps<{
  screens: ShowcaseScreen[];
  busy: boolean;
}>();

const emit = defineEmits<{
  add: [payload: { screenId: string; narration: string }];
}>();

const screenId = ref('');
const narration = ref('');

const canAdd = computed(() => Boolean(screenId.value) && !props.busy);

// Единственный объявленный экран подставляется сам: выбор ради одного варианта
// только добавляет шаг.
watch(() => props.screens, (list) => {
  if (!list.some((screen) => screen.id === screenId.value)) {
    screenId.value = list[0]?.id ?? '';
  }
}, { immediate: true });

function submit() {
  if (!canAdd.value) {
    return;
  }

  emit('add', { screenId: screenId.value, narration: narration.value });
  narration.value = '';
}
</script>

<style scoped>
.scene-form {
  display: grid;
  grid-template-columns: minmax(180px, 0.8fr) minmax(0, 1.6fr) auto;
  align-items: end;
  gap: 10px;
  min-width: 0;
}

@media (max-width: 720px) {
  .scene-form {
    grid-template-columns: minmax(0, 1fr);
    align-items: stretch;
  }
}
</style>
