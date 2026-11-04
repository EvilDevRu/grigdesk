<template>
  <div v-if="record?.updateAvailable || record?.checkedAt || record?.checkError"
       class="tracker-update-status" aria-live="polite">
    <p v-if="record?.updateAvailable" class="tracker-update-status__available">
      {{ t('core.trackerUpdateAvailable', { version: record.latest?.version ?? '' }) }}
    </p>
    <p v-else-if="record?.checkedAt && !record.checkError">{{ t('core.trackerUpToDate') }}</p>
    <p v-if="record?.checkedAt">
      {{ t('core.trackerCheckedAt', { time: new Date(record.checkedAt).toLocaleString() }) }}
    </p>
    <UiInlineMessage v-if="record?.checkError" tone="warning">
      {{ record.checkError.message }}
    </UiInlineMessage>
  </div>
</template>

<script setup lang="ts">
import type { PluginInstallInfo } from '../../../../shared/plugins/pluginInstallContracts.ts';
import { t, UiInlineMessage } from '../../ui.ts';

defineProps<{ record?: PluginInstallInfo }>();
</script>

<style scoped>
.tracker-update-status {
  display: grid;
  gap: 6px;
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 1.5;
}

.tracker-update-status p {
  margin: 0;
}

.tracker-update-status .tracker-update-status__available {
  color: var(--accent);
}
</style>
