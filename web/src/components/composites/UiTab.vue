<template>
  <UiPressable
    ref="button"
    class="ui-tab"
    role="tab"
    :disabled="disabled"
    :aria-selected="String(active)"
    :aria-controls="controls"
    :id="id"
    :tabindex="active ? 0 : -1"
    @click="select"
    @keydown="onKeydown"
    ><slot
  /></UiPressable>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useUiTabsContext } from '../../composables/useUiTabsContext';
import UiPressable from '../primitives/UiPressable.vue';

const props = withDefaults(
  defineProps<{
    value: string | number;
    disabled?: boolean;
    controls?: string;
    id?: string;
  }>(),
  {
    disabled: false,
    controls: undefined,
    id: undefined,
  },
);

defineSlots<{ default(): unknown }>();

const context = useUiTabsContext();
const token = Symbol('ui-tab');
const button = ref<InstanceType<typeof UiPressable> | null>(null);
const active = computed(() => Object.is(context.modelValue(), props.value));

function registration() {
  return {
    value: props.value,
    element: button.value?.el ?? null,
    disabled: props.disabled,
  };
}

function sync(): void {
  context.update(token, registration());
}

onMounted(() => {
  context.register(token, registration());
});
onBeforeUnmount(() => context.unregister(token));
watch(() => [props.value, props.disabled, button.value?.el], sync);

function select(): void {
  if (!props.disabled) {
    context.select(props.value);
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (
    context.activation() === 'manual' &&
    (event.key === 'Enter' || event.key === ' ')
  ) {
    event.preventDefault();
    select();
  }
}
</script>
