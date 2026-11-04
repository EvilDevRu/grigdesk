<template>
  <div
    class="ui-field"
    :class="{ 'is-invalid': invalid, 'is-required': required }"
  >
    <div v-if="label && help" class="ui-field__heading">
      <label class="ui-field__label" :for="controlId">
        {{ label }}<span v-if="required" class="ui-field__required" aria-hidden="true"> *</span>
      </label>
      <UiTooltip :text="help">
        <UiIconButton :label="`${label}: ${t('core.tooltip')}`" data-context="field-help">
          <UiHelpIcon />
        </UiIconButton>
      </UiTooltip>
    </div>
    <label v-else-if="label" class="ui-field__label" :for="controlId">
      {{ label
      }}<span v-if="required" class="ui-field__required" aria-hidden="true">
        *</span
      >
    </label>
    <div class="ui-field__control"><slot /></div>
    <div v-if="error" :id="errorId" class="ui-field__error" role="alert">
      {{ error }}
    </div>
    <div v-else-if="hint" :id="hintId" class="ui-field__hint">{{ hint }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed, toRef, useId } from 'vue';
import { provideUiFieldContext } from '../../composables/useUiFieldContext';
import { t } from '../../services/locale.ts';
import UiHelpIcon from '../primitives/UiHelpIcon.vue';
import UiIconButton from '../primitives/UiIconButton.vue';
import UiTooltip from '../overlays/UiTooltip.vue';

const props = withDefaults(
  defineProps<{
    label?: string;
    help?: string;
    hint?: string;
    error?: string;
    required?: boolean;
    id?: string;
  }>(),
  {
    label: undefined,
    help: undefined,
    hint: undefined,
    error: undefined,
    required: false,
    id: undefined,
  },
);

defineSlots<{ default(): unknown }>();

const generatedId = `ui-field-${useId().replace(/:/g, '')}`;
const controlId = computed(() => props.id || generatedId);
const hintId = computed(() => `${controlId.value}-hint`);
const errorId = computed(() => `${controlId.value}-error`);
const invalid = computed(() => Boolean(props.error));
const describedBy = computed(() =>
  props.error ? errorId.value : props.hint ? hintId.value : undefined,
);

provideUiFieldContext({
  controlId,
  describedBy,
  invalid,
  required: toRef(props, 'required'),
});
</script>
