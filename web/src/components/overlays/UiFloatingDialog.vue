<template>
  <UiPopover
    ref="popover"
    class="ui-floating-dialog"
    :open="open"
    :default-open="defaultOpen"
    has-popup="dialog"
    :focus-policy="focusPolicy"
    :trigger-mode="triggerMode"
    :placement="placement"
    :layer="layer"
    :trigger-label="triggerLabel"
    :offset="offset"
    :hover-delay="hoverDelay"
    :return-focus="returnFocus"
    :aria-label="hasTitle ? undefined : label"
    :aria-labelledby="hasTitle ? titleId : undefined"
    :aria-describedby="hasDescription ? descriptionId : undefined"
    :aria-busy="busy || undefined"
    @update:open="emit('update:open', $event)"
    @open="emit('open')"
    @close="emit('close', $event)"
  >
    <template #trigger="triggerProps">
      <slot name="trigger" v-bind="triggerProps" />
    </template>

    <template #default="contentProps">
      <header
        v-if="hasTitle || hasDescription"
        class="ui-floating-dialog__header"
      >
        <div v-if="hasTitle" :id="titleId" class="ui-floating-dialog__title">
          <slot name="title">{{ title }}</slot>
        </div>
        <div
          v-if="hasDescription"
          :id="descriptionId"
          class="ui-floating-dialog__description"
        >
          <slot name="description">{{ description }}</slot>
        </div>
      </header>
      <div class="ui-floating-dialog__body">
        <slot v-bind="contentProps" />
      </div>
    </template>
  </UiPopover>
</template>

<script setup lang="ts">
import { computed, ref, useId, type VNode } from 'vue';
import UiPopover from './UiPopover.vue';
import type { UiLayerName } from '../../types/uiLayers';
import type {
  UiOverlayContentSlotProps,
  UiOverlayPlacement,
  UiOverlayTriggerSlotProps,
  UiPopoverCloseReason,
  UiPopoverFocusPolicy,
  UiPopoverTriggerMode,
} from '../../types/uiOverlays';

interface Props {
  open?: boolean;
  defaultOpen?: boolean;
  title?: string;
  description?: string;
  label?: string;
  busy?: boolean;
  focusPolicy?: UiPopoverFocusPolicy;
  triggerMode?: UiPopoverTriggerMode;
  placement?: UiOverlayPlacement;
  layer?: UiLayerName;
  triggerLabel?: string;
  offset?: number;
  hoverDelay?: number;
  returnFocus?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  open: undefined,
  defaultOpen: false,
  title: '',
  description: '',
  label: 'Всплывающее окно',
  busy: false,
  focusPolicy: 'auto',
  triggerMode: 'click',
  placement: 'bottom-start',
  layer: 'popover',
  triggerLabel: 'Открыть',
  offset: 8,
  hoverDelay: 120,
  returnFocus: true,
});
const emit = defineEmits<{
  'update:open': [value: boolean];
  open: [];
  close: [reason: UiPopoverCloseReason];
}>();
const slots = defineSlots<{
  trigger(props: UiOverlayTriggerSlotProps): VNode[];
  title?(): VNode[];
  description?(): VNode[];
  default(props: UiOverlayContentSlotProps): VNode[];
}>();

const baseId = useId().replaceAll(':', '');
const titleId = `ui-floating-dialog-title-${baseId}`;
const descriptionId = `ui-floating-dialog-description-${baseId}`;
const hasTitle = computed(() => Boolean(props.title || slots.title));
const hasDescription = computed(() =>
  Boolean(props.description || slots.description),
);
const popover = ref<{
  open(): void;
  close(reason?: UiPopoverCloseReason): void;
  toggle(): void;
  focus(): void;
} | null>(null);

defineExpose({
  open: () => popover.value?.open(),
  close: (reason: UiPopoverCloseReason = 'programmatic') =>
    popover.value?.close(reason),
  toggle: () => popover.value?.toggle(),
  focus: () => popover.value?.focus(),
});
</script>
