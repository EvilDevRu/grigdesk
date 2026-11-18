<template>
  <section v-if="embedded && open" :id="id" class="workdir-picker-inline"
           data-role="workdir-picker" role="region" :aria-label="t('core.workdirTitle')">
    <slot />
  </section>
  <UiDialog v-else-if="!embedded" v-model:open="open" :id="id" layer="confirm"
            :title="t('core.workdirTitle')" size="compact" mobile-sheet :body-inset="false"
            :busy="busy" :dismissible="!busy" data-role="workdir-picker" data-ui-workspace
            :close-label="t('core.close')">
    <template #title>
      <span class="workdir-heading">
        <span class="workdir-heading-copy">
          <span>{{ t('core.workdirTitle') }}</span>
          <span class="workdir-caption">{{ t('core.workdirOnComputer') }}</span>
        </span>
      </span>
    </template>
    <slot />
  </UiDialog>
</template>

<script setup lang="ts">
import { UiDialog, t } from '../../ui.ts';

defineProps<{
  id: string;
  embedded: boolean;
  busy: boolean;
}>();

const open = defineModel<boolean>('open', { required: true });
</script>

<style scoped>
.workdir-picker-inline {
  min-width: 0;
}

.workdir-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.workdir-heading-copy {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.workdir-caption {
  color: var(--ink-mid);
  font-size: 12px;
  font-weight: 400;
  line-height: 1.5;
}
</style>
