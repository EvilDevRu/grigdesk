<template>
  <div
    class="ui-selectable-row"
    :class="{ 'is-selected': selected, 'is-disabled': disabled }"
  >
    <UiPressable
      class="ui-selectable-row__primary"
      :disabled="disabled"
      :aria-pressed="pressed === undefined ? undefined : String(pressed)"
      :aria-selected="selected === undefined ? undefined : String(selected)"
      @click="$emit('select', $event)"
      ><slot
    /></UiPressable>
    <div v-if="$slots.actions" class="ui-selectable-row__actions">
      <slot name="actions" />
    </div>
  </div>
</template>

<script setup lang="ts">
import UiPressable from '../primitives/UiPressable.vue';

withDefaults(
  defineProps<{
    selected?: boolean;
    pressed?: boolean;
    disabled?: boolean;
  }>(),
  {
    selected: undefined,
    pressed: undefined,
    disabled: false,
  },
);
defineSlots<{ default(): unknown; actions?(): unknown }>();
defineEmits<{ select: [event: MouseEvent] }>();
</script>
