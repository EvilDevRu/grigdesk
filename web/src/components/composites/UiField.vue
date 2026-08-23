<template>
  <div
    class="ui-field"
    :class="{ 'is-invalid': invalid, 'is-required': required }"
  >
    <label v-if="label" class="ui-field__label" :for="controlId">
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

const props = withDefaults(
  defineProps<{
    label?: string;
    hint?: string;
    error?: string;
    required?: boolean;
    id?: string;
  }>(),
  {
    label: undefined,
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
