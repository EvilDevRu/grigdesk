<template>
  <span
    class="ui-spinner"
    :class="`ui-spinner--${normalizedRole}`"
    :role="decorative ? undefined : 'status'"
    :aria-hidden="decorative ? 'true' : undefined"
    :aria-label="decorative ? undefined : label"
  />
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { UiSpinnerRole } from '../../types/uiActions';

const props = withDefaults(
  defineProps<{
    label?: string;
    decorative?: boolean;
    role?: UiSpinnerRole;
  }>(),
  {
    label: 'Загрузка',
    decorative: false,
    role: 'inline',
  },
);

const normalizedRole = computed<UiSpinnerRole>(() =>
  ['inline', 'standalone', 'large'].includes(props.role)
    ? props.role
    : 'inline',
);
</script>
