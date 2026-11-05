<template>
  <div
    class="ui-inline-message"
    :class="`ui-inline-message--${normalizedTone}`"
    :data-structured="Boolean(heading || dismissible) || undefined"
    :role="normalizedTone === 'danger' ? 'alert' : 'status'"
  >
    <template v-if="heading || dismissible">
      <svg class="ui-inline-message__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path :d="iconPath" />
      </svg>
      <div class="ui-inline-message__body">
        <div v-if="heading" class="ui-inline-message__title">{{ heading }}</div>
        <div class="ui-inline-message__detail"><slot /></div>
        <div v-if="$slots.actions" class="ui-inline-message__actions"><slot name="actions" /></div>
      </div>
      <UiIconButton v-if="dismissible" :label="t('core.close')" v-tooltip="t('core.close')"
                    class="ui-inline-message__dismiss" @click="$emit('dismiss')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
             stroke-linecap="round" aria-hidden="true">
          <path d="m6 6 12 12M18 6 6 18" />
        </svg>
      </UiIconButton>
    </template>
    <slot v-else />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import UiIconButton from '../primitives/UiIconButton.vue';
import { t } from '../../services/locale.ts';
import { vTooltip } from '../../services/tooltipDirective.ts';
import type { UiActionTone } from '../../types/uiActions';
import { normalizeActionTone } from '../../types/uiActions';

const props = withDefaults(defineProps<{
  tone?: UiActionTone;
  heading?: string;
  dismissible?: boolean;
}>(), {
  tone: 'neutral',
  heading: undefined,
  dismissible: false,
});

defineSlots<{
  default(): unknown;
  actions?(): unknown;
}>();
defineEmits<{ dismiss: [] }>();

const normalizedTone = computed(() => normalizeActionTone(props.tone));
const iconPath = computed(() => {
  if (normalizedTone.value === 'success') {
    return 'm5 12 4 4L19 6';
  }

  if (normalizedTone.value === 'warning') {
    return 'm10.3 3.9-8.2 14.2A2 2 0 0 0 3.8 21h16.4a2 2 0 0 0 1.7-2.9'
      + 'L13.7 3.9a2 2 0 0 0-3.4 0M12 9v4m0 4h.01';
  }

  const circle = 'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0';

  return circle + (normalizedTone.value === 'danger' ? 'M12 7v6m0 4h.01' : 'M12 8h.01M12 11v5');
});
</script>
