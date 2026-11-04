<template>
  <section v-if="embedded && open" :id="id" class="workdir-picker-inline"
           data-role="workdir-picker" role="region" :aria-label="t('core.workdirTitle')">
    <slot />
  </section>
  <UiDialog v-else-if="!embedded" v-model:open="open" :id="id" layer="confirm"
            :title="t('core.workdirTitle')" size="compact" mobile-sheet :body-inset="false"
            :busy="busy" :dismissible="!busy" data-role="workdir-picker" data-ui-workspace>
    <template #title>
      <span class="workdir-heading">
        <span class="workdir-heading-copy">
          <span>{{ t('core.workdirTitle') }}</span>
          <span class="workdir-caption">{{ t('core.workdirOnComputer') }}</span>
        </span>
        <UiIconButton :label="t('core.close')" :disabled="busy" @click="open = false">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
               stroke-linecap="round" aria-hidden="true">
            <path d="m6 6 12 12M6 18 18 6" />
          </svg>
        </UiIconButton>
      </span>
    </template>
    <slot />
  </UiDialog>
</template>

<script setup lang="ts">
import { UiDialog, UiIconButton, t } from '../../ui.ts';

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
