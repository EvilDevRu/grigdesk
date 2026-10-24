<template>
  <UiPopover
    ref="popover"
    v-bind="$attrs"
    class="ui-topbar-panel"
    :attachment="attachment === 'topbar' ? 'topbar' : undefined"
    :placement="placement"
    :offset="attachment === 'topbar' ? 0 : 8"
    :trigger-mode="triggerMode"
    :hover-delay="160"
    :aria-label="label || title"
    @open="onOpen"
    @close="onClose"
  >
    <template #trigger="trigger">
      <slot name="trigger" v-bind="trigger" />
    </template>
    <template #default="content">
      <header v-if="title || $slots.title" class="ui-topbar-panel__head">
        <div class="ui-topbar-panel__title">
          <slot name="title">{{ title }}</slot>
        </div>
        <span v-if="$slots.meta" class="ui-topbar-panel__meta"><slot name="meta" /></span>
        <div v-if="$slots.actions" class="ui-topbar-panel__actions">
          <slot name="actions" v-bind="content" />
        </div>
      </header>
      <div class="ui-topbar-panel__body">
        <slot v-bind="content" />
      </div>
      <footer v-if="$slots.footer" class="ui-topbar-panel__footer">
        <slot name="footer" v-bind="content" />
      </footer>
    </template>
  </UiPopover>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';

import UiPopover from './UiPopover.vue';
import { claimTopbarPanel, releaseTopbarPanel } from '../../services/topbarPanels';
import type {
  UiOverlayContentSlotProps,
  UiOverlayPlacement,
  UiOverlayTriggerSlotProps,
  UiPopoverCloseReason,
  UiPopoverTriggerMode,
} from '../../types/uiOverlays';
import type { VNode } from 'vue';

defineOptions({ inheritAttrs: false });

withDefaults(defineProps<{
  title?: string;
  label?: string;
  triggerMode?: UiPopoverTriggerMode;
  attachment?: 'topbar' | 'trigger';
  placement?: UiOverlayPlacement;
}>(), {
  title: '',
  label: '',
  triggerMode: 'both',
  attachment: 'topbar',
  placement: 'bottom-end',
});

defineSlots<{
  trigger(props: UiOverlayTriggerSlotProps): VNode[];
  title?(): VNode[];
  meta?(): VNode[];
  actions?(props: UiOverlayContentSlotProps): VNode[];
  default(props: UiOverlayContentSlotProps): VNode[];
  footer?(props: UiOverlayContentSlotProps): VNode[];
}>();

const emit = defineEmits<{
  open: [];
  close: [reason: UiPopoverCloseReason];
}>();
const popover = ref<InstanceType<typeof UiPopover> | null>(null);
const closeForSibling = () => popover.value?.close('outside');

function onOpen(): void {
  claimTopbarPanel(closeForSibling);
  emit('open');
}

function onClose(reason: UiPopoverCloseReason): void {
  releaseTopbarPanel(closeForSibling);
  emit('close', reason);
}

onBeforeUnmount(() => releaseTopbarPanel(closeForSibling));
</script>
