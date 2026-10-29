<template>
  <div class="executor-fields">
    <div class="executor-field">
      <label :for="`${fieldId}-model`">{{ t('core.stageModel') }}</label>
      <UiSelect :id="`${fieldId}-model`" :model-value="model" disabled
                :aria-describedby="descriptionId">
        <option :value="model">{{ model || t('core.stageProfileDefault') }}</option>
      </UiSelect>
    </div>
    <div class="executor-field">
      <label :for="`${fieldId}-effort`">{{ t('core.stageEffort') }}</label>
      <UiSelect :id="`${fieldId}-effort`" :model-value="effort" disabled
                :aria-describedby="descriptionId">
        <option :value="effort">{{ effort || t('core.stageProfileDefault') }}</option>
      </UiSelect>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, useId } from 'vue';

import { UiSelect, t } from '../../ui.ts';
import { runnerEffortLabel, runnerModelLabel, type RunnerState } from '../../shared/runnerDisplay.ts';

const props = defineProps<{
  runner: RunnerState;
  provider: string;
  descriptionId: string;
}>();

const fieldId = `stage-executor-${useId()}`;
const model = computed(() => runnerModelLabel(props.runner, props.provider));
const effort = computed(() => runnerEffortLabel(props.runner, props.provider));
</script>

<style scoped>
.executor-fields {
  min-width: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(100px, .45fr);
  gap: 12px;
}

.executor-field {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.executor-field label {
  color: var(--ink-mid);
  font-size: 11px;
  line-height: 14px;
}

@media (max-width: 600px) {
  .executor-fields {
    grid-template-columns: minmax(0, 1fr) minmax(95px, .5fr);
    gap: 8px;
  }
}
</style>
