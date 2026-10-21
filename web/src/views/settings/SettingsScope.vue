<template>
  <div class="settings-scope">
    <span class="settings-scope-label">{{ (scope ?? t('settings.allDevices')) }}</span>
    <p><slot>{{ t('settings.changesAreSavedWithApply') }}</slot></p>
  </div>
</template>

<script setup lang="ts">
import { t } from '../../ui.ts';

withDefaults(defineProps<{ scope?: string }>(), { scope: undefined });
</script>

<style scoped>
.settings-scope {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 12px;
  min-width: 0;
  font-size: 11px;
  line-height: 1.6;
}
.settings-scope-label {
  flex: none;
  color: var(--ink-mid);
  font-weight: 500;
}
.settings-scope p {
  flex: 1 1 200px;
  margin: 0;
  color: var(--ink-low);
}
</style>
