<template>
  <div class="ui-loading-state" :data-variant="normalizedVariant" data-ui-loading>
    <div class="ui-loading-state__status" role="status" aria-live="polite" aria-atomic="true">
      <span class="ui-loading-state__mark" aria-hidden="true">
        <UiSpinner decorative role="standalone" />
      </span>
      <div class="ui-loading-state__copy">
        <strong class="ui-loading-state__label">{{ label || t('core.loading') }}</strong>
        <p v-if="description" class="ui-loading-state__description">{{ description }}</p>
      </div>
    </div>
    <div v-if="normalizedVariant !== 'inline'" class="ui-loading-state__skeleton" aria-hidden="true">
      <div v-for="index in 4" :key="index" class="ui-loading-state__item">
        <span class="ui-loading-state__avatar" />
        <span class="ui-loading-state__lines">
          <span class="ui-loading-state__line" />
          <span class="ui-loading-state__line ui-loading-state__line--short" />
        </span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import UiSpinner from '../primitives/UiSpinner.vue';
import { t } from '../../services/locale.ts';

const props = withDefaults(defineProps<{
  label?: string;
  description?: string;
  variant?: 'rows' | 'cards' | 'document' | 'inline';
}>(), {
  label: undefined,
  description: undefined,
  variant: 'rows',
});

const normalizedVariant = computed(() => (
  ['rows', 'cards', 'document', 'inline'].includes(props.variant) ? props.variant : 'rows'
));
</script>
