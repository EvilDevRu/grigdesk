<template>
  <div
    class="ui-inline-message"
    :class="`ui-inline-message--${normalizedTone}`"
    :role="tone === 'danger' ? 'alert' : 'status'"
  >
    <slot />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { UiActionTone } from '../../types/uiActions';
import { normalizeActionTone } from '../../types/uiActions';

const props = withDefaults(defineProps<{ tone?: UiActionTone }>(), {
  tone: 'neutral',
});

defineSlots<{ default(): unknown }>();

const normalizedTone = computed(() => normalizeActionTone(props.tone));
</script>
