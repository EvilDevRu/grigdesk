<template>
  <div class="executor-fields" :class="{ 'executor-fields--speed': showSpeed }">
    <div class="executor-field">
      <label :for="`${fieldId}-model`" v-tooltip="t(props.draft?.model != null
        ? 'core.stageSourceLocal' : 'core.stageSourceProfile')">{{ t('core.stageModel') }}</label>
      <UiSelect :id="`${fieldId}-model`" :model-value="selectedModel" :disabled="!editable"
                :aria-describedby="descriptionId" @update:model-value="updateModel">
        <option :value="inheritValue">{{ t('core.stageInheritModel', { value: inheritedModel }) }}</option>
        <option v-if="unlistedModel" :value="draft!.model" disabled>{{ draft!.model }}</option>
        <option v-for="item in options?.models || []" :key="item.id" :value="item.id">
          {{ item.label || item.id }}
        </option>
      </UiSelect>
    </div>
    <div class="executor-field">
      <label :for="`${fieldId}-effort`" v-tooltip="t(props.draft?.effort != null
        ? 'core.stageSourceLocal' : 'core.stageSourceProfile')">{{ t('core.stageEffort') }}</label>
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
    </div>
    <div v-if="showSpeed" class="executor-field">
      <label :for="`${fieldId}-speed`" v-tooltip="t(props.draft?.speed != null
        ? 'core.stageSourceLocal' : 'core.stageSourceProfile')">{{ t('core.chatSpeedLabel') }}</label>
      <UiSelect :id="`${fieldId}-speed`" :model-value="draft?.speed ?? inheritValue"
                :disabled="!editable" :aria-describedby="`${descriptionId} ${fieldId}-speed-cost`"
                data-test="stage-runner-speed" @update:model-value="updateSpeed">
        <option :value="inheritValue">{{ t('core.stageSpeedProfile', { value: inheritedSpeedLabel }) }}</option>
        <option v-if="unlistedSpeed" :value="unlistedSpeed" disabled>{{ t(speedLabels[unlistedSpeed]) }}</option>
        <option v-for="mode in speedModes" :key="mode" :value="mode">{{ t(speedLabels[mode]) }}</option>
      </UiSelect>
    </div>
    <p v-if="showSpeed" :id="`${fieldId}-speed-cost`" class="executor-speed-cost">
      {{ t('core.stageSpeedCost') }}
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed, useId } from 'vue';

import { isChatSpeed, type ChatSpeed } from '../../../../shared/chat/chatSpeed.ts';
import { UiSelect, t, vTooltip } from '../../ui.ts';
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

const emit = defineEmits<{
  model: [value: string | null];
  effort: [value: string | null];
  speed: [value: ChatSpeed | null];
}>();
const fieldId = `stage-executor-${useId()}`;
const inheritValue = "\u0001inherit";
const speedLabels = {
  standard: 'core.chatSpeedStandard',
  fast: 'core.chatSpeedFast',
  ultrafast: 'core.chatSpeedUltrafast',
} as const;
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
const modelId = computed(() => props.draft?.model ?? inheritedModel.value);
const exactModel = computed(() => props.options?.models.find((item) => item.id === modelId.value));
const currentModel = computed(() => exactModel.value
  ?? props.options?.models.find((item) => item.aliases?.includes(modelId.value)));
const efforts = computed(() => currentModel.value?.efforts ?? []);
const unlistedEffort = computed(() => props.draft?.effort !== null && props.draft?.effort !== undefined
  && !efforts.value.includes(props.draft.effort));
const supportsStandard = computed(() =>
  props.options?.models.some((item) => item.speedModes?.includes('standard')) === true);
const speedModes = computed<ChatSpeed[]>(() => {
  const modes = exactModel.value?.speedModes ?? [];

  return supportsStandard.value && !modes.includes('standard') ? ['standard', ...modes] : modes;
});
const showSpeed = computed(() => speedModes.value.length > 0 || props.draft?.speed != null);
const unlistedSpeed = computed(() => {
  const selected = props.draft?.speed;

  return selected && !speedModes.value.includes(selected) ? selected : null;
});
const inheritedSpeedLabel = computed(() => {
  const selection = props.options?.inherited ?? props.options?.effective;

  if (selection?.speedIssue === 'invalid_profile') {
    return t('core.stageSpeedInvalidProfileShort');
  }

  return t(selection?.speed ? speedLabels[selection.speed] : 'core.stageSpeedNative');
});

function updateModel(value: string | number | null) {
  emit('model', value === inheritValue ? null : String(value ?? ''));
}

function updateEffort(value: string | number | null) {
  emit('effort', value === inheritValue ? null : String(value ?? ''));
}

/**
 * Выбор наследования отправляет явный null.
 * В редактор попадает только публичная скорость из вариантов каталога.
 */
function updateSpeed(value: string | number | null) {
  if (value === inheritValue) {
    emit('speed', null);
  } else if (typeof value === 'string' && isChatSpeed(value)) {
    emit('speed', value);
  }
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

.executor-fields--speed {
  grid-template-columns: minmax(0, 1fr) minmax(90px, .45fr) minmax(115px, .65fr);
}

.executor-speed-cost {
  grid-column: 1 / -1;
  margin: 0;
  color: var(--ink-mid);
  font-size: 11px;
}

.executor-field label {
  color: var(--ink-mid);
  font-size: 11px;
  line-height: 14px;
}

@media (max-width: 600px) {
  .executor-fields {
    grid-template-columns: minmax(0, 1fr);
    gap: 8px;
  }
}
</style>
