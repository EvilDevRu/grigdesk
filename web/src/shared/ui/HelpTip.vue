<template>
  <span class="ht">
    <!-- Старые toggle-call sites пока остаются интерактивными: для них tooltip-семантика
         была бы неверной, поэтому compatibility path использует общий popover runtime. -->
    <UiPopover
      v-if="toggle"
      ref="popover"
      class="ht-tip"
      trigger-mode="both"
      focus-policy="none"
      :placement="placement"
      :return-focus="false"
      :style="tipStyle || undefined"
      @click="onPopoverContentClick"
    >
      <template #trigger>
        <span
          v-if="$slots.default"
          class="ht-tr"
          :tabindex="triggerFocusable ? 0 : undefined"
        ><slot /></span>
        <span v-else class="ht-ic" tabindex="0" aria-label="Подсказка">?</span>
      </template>
      <template #default>
        <slot name="tip">{{ text }}</slot>
      </template>
    </UiPopover>

    <UiTooltip
      v-else
      :text="text"
      :placement="placement"
      surface-class="ht-tip"
      :surface-style="tipStyle || undefined"
    >
      <template #trigger>
        <span
          v-if="$slots.default"
          class="ht-tr"
          :tabindex="triggerFocusable ? 0 : undefined"
        ><slot /></span>
        <span v-else class="ht-ic" tabindex="0" aria-label="Подсказка">?</span>
      </template>
      <template #tip>
        <slot name="tip">{{ text }}</slot>
      </template>
    </UiTooltip>
  </span>
</template>

<script setup lang="ts">
import { computed, ref, type CSSProperties } from 'vue';
import { UiPopover, UiTooltip } from '../../ui';
import type { UiOverlayPlacement } from '../../types/uiOverlays';

interface Props {
  text?: string;
  align?: 'left' | 'center' | 'right';
  triggerFocusable?: boolean;
  toggle?: boolean;
  tipStyle?: CSSProperties | null;
}

const props = withDefaults(defineProps<Props>(), {
  text: '',
  align: 'center',
  triggerFocusable: true,
  toggle: false,
  tipStyle: null,
});

const placement = computed<UiOverlayPlacement>(() => {
  if (props.align === 'left') return 'top-start';
  if (props.align === 'right') return 'top-end';
  return 'top';
});

const popover = ref<{ close(reason?: 'action'): void } | null>(null);

function onPopoverContentClick(event: MouseEvent): void {
  if (event.target instanceof Element && event.target.closest('button, a')) {
    popover.value?.close('action');
  }
}
</script>
