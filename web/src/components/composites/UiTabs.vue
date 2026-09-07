<template>
  <div
    class="ui-tabs"
    role="tablist"
    :aria-label="label"
    :aria-orientation="orientation"
    @keydown="onKeydown"
  >
    <slot />
  </div>
</template>

<script setup lang="ts">
import { reactive } from 'vue';
import {
  provideUiTabsContext,
  type UiTabRegistration,
} from '../../composables/useUiTabsContext';
import type { UiTabsActivation } from '../../types/uiSelection';

const props = withDefaults(
  defineProps<{
    label?: string;
    activation?: UiTabsActivation;
    orientation?: 'horizontal' | 'vertical';
  }>(),
  {
    label: undefined,
    activation: 'automatic',
    orientation: 'horizontal',
  },
);

defineSlots<{ default(): unknown }>();

const model = defineModel<string | number>({ required: true });
const registrations = reactive(new Map<symbol, UiTabRegistration>());

provideUiTabsContext({
  modelValue: () => model.value,
  activation: () => props.activation,
  select: (value) => {
    model.value = value;
  },
  register: (token, tab) => registrations.set(token, tab),
  update: (token, tab) => registrations.set(token, tab),
  unregister: (token) => registrations.delete(token),
});

/**
 * Стрелки двигают roving focus по доступным вкладкам с циклическим переходом.
 * В automatic-режиме фокус одновременно меняет модель, в manual — только фокус.
 */
function onKeydown(event: KeyboardEvent): void {
  const horizontal = props.orientation === 'horizontal';
  const previousKey = horizontal ? 'ArrowLeft' : 'ArrowUp';
  const nextKey = horizontal ? 'ArrowRight' : 'ArrowDown';

  if (![previousKey, nextKey, 'Home', 'End'].includes(event.key)) {
    return;
  }

  const tabs = [...registrations.values()].filter(
    (tab) => !tab.disabled && tab.element,
  );

  if (!tabs.length) {
    return;
  }

  const current = tabs.findIndex(
    (tab) => tab.element === document.activeElement,
  );
  let index = current < 0 ? 0 : current;

  if (event.key === 'Home') {
    index = 0;
  } else if (event.key === 'End') {
    index = tabs.length - 1;
  } else if (event.key === nextKey) {
    index = (index + 1) % tabs.length;
  } else {
    index = (index - 1 + tabs.length) % tabs.length;
  }

  event.preventDefault();
  tabs[index]?.element?.focus();

  const next = tabs[index];

  if (props.activation === 'automatic' && next) {
    model.value = next.value;
  }
}
</script>
