<template>
  <div class="executor-fields">
    <div class="executor-field">
      <label :for="`${fieldId}-model`">{{ t('core.stageModel') }}</label>
      <UiSelect :id="`${fieldId}-model`" :model-value="selectedModel" :disabled="!editable"
                :aria-describedby="descriptionId" @update:model-value="updateModel">
        <option :value="inheritValue">{{ t('core.stageInheritModel', { value: inheritedModel }) }}</option>
        <option v-if="unlistedModel" :value="draft!.model" disabled>{{ draft!.model }}</option>
        <option v-for="item in options?.models || []" :key="item.id" :value="item.id">
          {{ item.label || item.id }}
        </option>
      </UiSelect>
      <small>{{ t(props.draft?.model !== null && props.draft?.model !== undefined
        ? 'core.stageSourceLocal' : 'core.stageSourceProfile') }}</small>
    </div>
    <div class="executor-field">
      <label :for="`${fieldId}-effort`">{{ t('core.stageEffort') }}</label>
      <UiSelect :id="`${fieldId}-effort`" :model-value="selectedEffort" :disabled="!editable"
                :aria-describedby="descriptionId" @update:model-value="updateEffort">
        <option :value="inheritValue">{{ t('core.stageInheritEffort', { value: inheritedEffort }) }}</option>
        <option v-if="unlistedEffort" :value="draft!.effort" disabled>
          {{ draft!.effort || t('core.stageNoEffort') }}
        </option>
        <option v-for="level in efforts" :key="level" :value="level">
          {{ level || t('core.stageNoEffort') }}
        </option>
      </UiSelect>
      <small>{{ t(props.draft?.effort !== null && props.draft?.effort !== undefined
        ? 'core.stageSourceLocal' : 'core.stageSourceProfile') }}</small>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, useId } from 'vue';

import { UiSelect, t } from '../../ui.ts';
import { runnerEffortLabel, runnerModelLabel, type RunnerState } from '../../shared/runnerDisplay.ts';
import type {
  StageRunnerOptions, StageRunnerSelection,
} from '../../../../shared/pipeline/stageRunnerSettings.ts';

const props = defineProps<{
  runner: RunnerState;
  provider: string;
  descriptionId: string;
  options?: StageRunnerOptions | null;
  draft?: StageRunnerSelection | null;
  editable?: boolean;
}>();

const emit = defineEmits<{ model: [value: string | null]; effort: [value: string | null] }>();
const fieldId = `stage-executor-${useId()}`;
const inheritValue = '\u0001inherit';
const model = computed(() => runnerModelLabel(props.runner, props.provider));
const effort = computed(() => runnerEffortLabel(props.runner, props.provider));
const inheritedModel = computed(() => (
  props.options?.inherited?.model ?? props.options?.effective.model ?? model.value
));
const inheritedEffort = computed(() => (
  props.options?.inherited?.effort ?? props.options?.effective.effort ?? effort.value
));
const selectedModel = computed(() => props.draft?.model ?? inheritValue);
const selectedEffort = computed(() => props.draft?.effort ?? inheritValue);
const unlistedModel = computed(() => props.draft?.model !== null && props.draft?.model !== undefined
  && !props.options?.models.some((item) => item.id === props.draft?.model));
const efforts = computed(() => {
  const selected = props.draft?.model ?? inheritedModel.value;

  return props.options?.models.find((item) => item.id === selected || item.aliases?.includes(selected || ''))
    ?.efforts || [];
});
const unlistedEffort = computed(() => props.draft?.effort !== null && props.draft?.effort !== undefined
  && !efforts.value.includes(props.draft.effort));

function updateModel(value: string | number | null) {
  emit('model', value === inheritValue ? null : String(value ?? ''));
}

function updateEffort(value: string | number | null) {
  emit('effort', value === inheritValue ? null : String(value ?? ''));
}
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
