<template>
  <div class="ui-inline-confirm" :aria-busy="loading ? 'true' : undefined">
    <UiButton
      v-if="!open"
      :tone="tone"
      :variant="variant"
      :disabled="disabled"
      @click="open = true"
      ><slot
    /></UiButton>
    <template v-else>
      <span class="ui-inline-confirm__question">{{ question }}</span>
      <UiButton
        :tone="tone"
        variant="solid"
        :loading="loading"
        :disabled="disabled"
        @click="$emit('confirm')"
      >
        {{ confirmText }}
      </UiButton>
      <UiButton :disabled="disabled || loading" @click="open = false">{{
        cancelText
      }}</UiButton>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import type { UiActionTone, UiActionVariant } from '../../types/uiActions';
import UiButton from '../primitives/UiButton.vue';

withDefaults(
  defineProps<{
    question: string;
    confirmText?: string;
    cancelText?: string;
    tone?: UiActionTone;
    variant?: UiActionVariant;
    disabled?: boolean;
    loading?: boolean;
  }>(),
  {
    confirmText: 'Подтвердить',
    cancelText: 'Отмена',
    tone: 'danger',
    variant: 'outline',
    disabled: false,
    loading: false,
  },
);
defineSlots<{ default(): unknown }>();
defineEmits<{ confirm: [] }>();

const open = ref(false);

defineExpose({
  close: () => {
    open.value = false;
  },
});
</script>
