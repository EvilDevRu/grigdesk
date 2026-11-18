<template>
  <UiDialog
    :open="settings.isOpen"
    size="workspace"
    :title="t('settings.settings')"
    :body-inset="false"
    :busy="busy"
    :close-label="t('settings.closeSettings')"
    :footer-status="footerStatus"
    :footer-pending="footerPending"
    data-role="settings-modal"
    data-ui-workspace
    @close="settings.requestClose"
  >
    <template #title>
        <div class="settings-heading-title">
          <span class="settings-heading-icon"><SettingsIcon /></span>
          <h2>{{ t('settings.settings') }}</h2>
        </div>
    </template>
    <div class="settings-content" :inert="busy || undefined">
      <SettingsWorkspace v-if="settings.isOpen" />
    </div>
    <template #footer-details>
      <template v-if="settings.snapshot.lastResult">
          <p
            v-for="(field, index) in settings.snapshot.lastResult.saved"
            :key="`saved-${index}`"
            data-settings-saved
          >
            {{ fieldLabel(field.address) }}:
            {{ field.normalized
              ? t('settings.savedAs', { value1: JSON.stringify(field.serverValue) }) : t('settings.saved') }}
          </p>
          <p
            v-for="(field, index) in settings.snapshot.lastResult.remaining"
            :key="`remaining-${index}`"
            data-settings-remaining
          >
            {{ fieldLabel(field.address) }}{{ t('settings.remainingToApply') }}
          </p>
          <p v-for="error in settings.snapshot.lastResult.errors" :key="error.resourceId">
            {{ error.message }}
          </p>
      </template>
    </template>
    <template #footer>
        <UiButton v-if="settings.snapshot.delayed" @click="settings.stopWaiting">
          {{ t('settings.stopWaiting') }}
        </UiButton>
        <UiButton :disabled="busy" @click="settings.cancel">{{ t('settings.cancel') }}</UiButton>
        <UiButton :disabled="busy || !settings.snapshot.dirtyCount" @click="settings.apply('apply')">
          {{ t('settings.apply') }}
        </UiButton>
        <UiButton variant="solid" tone="accent" :disabled="busy" @click="settings.apply('ok')">
          {{ t('settings.ok') }}
        </UiButton>
    </template>
  </UiDialog>
  <SettingsCloseDialog :open="settings.isOpen && settings.closeChoiceOpen" @choose="settings.chooseClose" />
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from 'vue';

import { UiButton, UiDialog, t } from '../../ui.ts';
import { useSettingsStore } from '../../stores/settings.ts';
import type { FieldAddress } from '../../features/settings/contracts.ts';
import { useUiContextSource } from '../../composables/useUiContextSource.ts';
import SettingsWorkspace from './SettingsWorkspace.vue';
import SettingsCloseDialog from './SettingsCloseDialog.vue';
import SettingsIcon from './SettingsIcon.vue';

const settings = useSettingsStore();
const busy = computed(() => settings.snapshot.applying || settings.actionRunning);
const footerPending = computed(() => Boolean(settings.snapshot.dirtyCount));
const footerStatus = computed(() => settings.snapshot.statusMessage || (settings.snapshot.dirtyCount
  ? t('settings.changes', { settingsSnapshotDirtyCount: settings.snapshot.dirtyCount })
  : t('settings.noChanges')));
const context = useUiContextSource('settings', { layer: 'overlay', active: false });

function fieldLabel(address: FieldAddress): string {
  return settings.fieldMetadata(address)?.label || address.fieldPath?.at(-1) || address.pageId;
}

watch(() => [settings.isOpen, settings.pageId, settings.entityId], () => {
  context.update({
    active: settings.isOpen,
    details: {
      page: settings.pageId,
      ...(settings.entityId ? { entity: settings.entityId } : {}),
    },
  });
}, { immediate: true });

onBeforeUnmount(() => settings.dispose('unmount'));
</script>

<style scoped>
.settings-heading-title {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.settings-heading-icon {
  color: var(--ink-mid);
}
.settings-heading-title h2 {
  margin: 0;
}
.settings-content {
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
</style>
