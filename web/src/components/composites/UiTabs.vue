<template>
  <div
    class="ui-tabs"
    :data-size="normalizedSize"
    role="tablist"
    :aria-label="label"
    :aria-orientation="orientation"
    @keydown="onKeydown"
  >
    <slot />
  </div>
</template>

<script setup lang="ts">
import { computed, reactive } from 'vue';
import { normalizeActionSize, type UiActionSize } from '../../types/uiActions';
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
    size?: UiActionSize;
  }>(),
  {
    label: undefined,
    activation: 'automatic',
    orientation: 'horizontal',
    size: 'default',
  },
);

defineSlots<{ default(): unknown }>();

const model = defineModel<string | number>({ required: true });
const normalizedSize = computed(() => normalizeActionSize(props.size));
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
  ).sort((left, right) => {
    // Vue переносит keyed-вкладки без повторной регистрации, поэтому порядок берётся из DOM.
    // Порядок Map после drag-and-drop больше не соответствует видимой полосе.
    const position = left.element!.compareDocumentPosition(right.element!);

    return position & Node.DOCUMENT_POSITION_FOLLOWING ? -1
      : position & Node.DOCUMENT_POSITION_PRECEDING ? 1 : 0;
  });

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
