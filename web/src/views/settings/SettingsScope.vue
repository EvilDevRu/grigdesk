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
  align-items: center;
  gap: 4px 10px;
  min-width: 0;
  font-size: 12px;
  line-height: 1.6;
}
/* Область — тихая метка рядом с фразой о сохранении, а не ещё одна строка текста. */
.settings-scope-label {
  flex: none;
  padding: 0 8px;
  border: 1px solid var(--line-2);
  border-radius: 999px;
  color: var(--ink-mid);
  font-size: 11px;
  font-weight: 500;
  line-height: 18px;
}
.settings-scope p {
  flex: 1 1 200px;
  margin: 0;
  color: var(--ink-low);
}
</style>
