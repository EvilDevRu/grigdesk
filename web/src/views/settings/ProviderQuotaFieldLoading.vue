<template>
  <div class="quota-field-loading" data-ui-settings-field aria-busy="true">
    <div class="quota-field-copy">
      <span>{{ t('settings.providerUsageAutoRefresh') }}</span>
      <small>{{ t('settings.providerUsageAutoRefreshHint') }}</small>
    </div>
    <UiSkeleton class="quota-field-switch" width="30px" height="17px" />
  </div>
</template>

<script setup lang="ts">
import { t, UiSkeleton } from '../../ui';
</script>

<style scoped>
.quota-field-loading {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 16px;
}
.quota-field-copy {
  display: grid;
  gap: 2px;
  font-size: 13px;
  line-height: 18px;
}
.quota-field-copy small {
  max-width: 78ch;
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 16px;
}
.quota-field-switch { border-radius: 999px; }
</style>
