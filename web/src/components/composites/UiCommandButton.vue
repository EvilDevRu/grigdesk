<template>
  <UiButton
    v-bind="$attrs"
    class="ui-command-button"
    variant="ghost"
    :tone="tone"
    :disabled="disabled"
    :loading="loading"
    @click="$emit('click', $event)"
    ><code><slot /></code
  ></UiButton>
</template>

<script setup lang="ts">
import type { UiActionTone } from '../../types/uiActions';
import UiButton from '../primitives/UiButton.vue';

defineOptions({ inheritAttrs: false });
withDefaults(
  defineProps<{
    tone?: UiActionTone;
    disabled?: boolean;
    loading?: boolean;
  }>(),
  {
    tone: 'neutral',
    disabled: false,
    loading: false,
  },
);
defineSlots<{ default(): unknown }>();
defineEmits<{ click: [event: MouseEvent] }>();
</script>
