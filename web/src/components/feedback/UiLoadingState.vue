<template>
  <div class="ui-loading-state" :class="{ 'ui-loading-state--custom': $slots.default }"
       :data-variant="normalizedVariant" data-ui-loading
    :data-perf-failed="failed ? '' : undefined">
    <div class="ui-loading-state__status" role="status" aria-live="polite" aria-atomic="true">
      <span class="ui-loading-state__mark" :class="{ 'ui-loading-state__hidden': !visibleLabel }"
            aria-hidden="true">
        <UiSpinner decorative role="standalone" />
      </span>
      <div class="ui-loading-state__copy">
        <strong class="ui-loading-state__label" :class="{ 'ui-loading-state__hidden': !visibleLabel }">
          {{ label || t('core.loading') }}
        </strong>
        <p v-if="description" class="ui-loading-state__description">{{ description }}</p>
      </div>
    </div>
    <div v-if="normalizedVariant !== 'inline' && !failed"
         class="ui-loading-state__skeleton" aria-hidden="true">
      <slot>
        <UiSkeletonLayout :layout="normalizedVariant === 'document' ? 'text' : 'list'" />
      </slot>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import UiSpinner from '../primitives/UiSpinner.vue';
import UiSkeletonLayout from './UiSkeletonLayout.vue';
import { t } from '../../services/locale.ts';

const props = withDefaults(defineProps<{
  label?: string;
  description?: string;
  variant?: 'rows' | 'cards' | 'document' | 'inline';
  showLabel?: boolean;
  failed?: boolean;
}>(), {
  label: undefined,
  description: undefined,
  variant: 'rows',
  showLabel: undefined,
  failed: false,
});

const normalizedVariant = computed(() => (
  ['rows', 'cards', 'document', 'inline'].includes(props.variant) ? props.variant : 'rows'
));

const visibleLabel = computed(() => props.showLabel ?? normalizedVariant.value === 'inline');
</script>
