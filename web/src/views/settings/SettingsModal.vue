<template>
  <UiDialog
    :open="settings.isOpen"
    size="workspace"
    label="Настройки"
    :body-inset="false"
    :busy="busy"
    data-role="settings-modal"
    @close="settings.requestClose"
  >
    <template #header>
      <div class="settings-heading">
        <h2>Настройки</h2>
        <UiIconButton
          label="Закрыть настройки"
          :disabled="busy"
          @click="settings.requestClose('action')"
        >
          <span aria-hidden="true">×</span>
        </UiIconButton>
      </div>
    </template>
    <div class="settings-content" :inert="busy || undefined">
      <SettingsWorkspace v-if="settings.isOpen" />
    </div>
    <template #footer>
      <div class="settings-footer">
        <div role="status" aria-live="polite">
          <p>
            {{ settings.snapshot.statusMessage || (settings.snapshot.dirtyCount
              ? `Изменений: ${settings.snapshot.dirtyCount}` : 'Нет неприменённых изменений') }}
          </p>
          <div v-if="settings.snapshot.lastResult" class="settings-apply-results">
            <p
              v-for="(field, index) in settings.snapshot.lastResult.saved"
              :key="`saved-${index}`"
              data-settings-saved
            >
              {{ fieldLabel(field.address) }}:
              {{ field.normalized ? `сохранено как ${JSON.stringify(field.serverValue)}` : 'сохранено' }}
            </p>
            <p
              v-for="(field, index) in settings.snapshot.lastResult.remaining"
              :key="`remaining-${index}`"
              data-settings-remaining
            >
              {{ fieldLabel(field.address) }}: осталось применить
            </p>
            <p v-for="error in settings.snapshot.lastResult.errors" :key="error.resourceId">
              {{ error.message }}
            </p>
          </div>
        </div>
        <div class="settings-actions">
          <UiButton v-if="settings.snapshot.delayed" @click="settings.stopWaiting">
            Прекратить ожидание
          </UiButton>
          <UiButton :disabled="busy" @click="settings.cancel">Отмена</UiButton>
          <UiButton :disabled="busy || !settings.snapshot.dirtyCount" @click="settings.apply('apply')">
            Применить
          </UiButton>
          <UiButton
            variant="solid"
            tone="accent"
            :disabled="busy"
            @click="settings.apply('ok')"
          >
            ОК
          </UiButton>
        </div>
      </div>
    </template>
  </UiDialog>
  <SettingsCloseDialog :open="settings.isOpen && settings.closeChoiceOpen" @choose="settings.chooseClose" />
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from 'vue';
import { UiButton, UiDialog, UiIconButton } from '../../ui.ts';
import { useSettingsStore } from '../../stores/settings.ts';
import type { FieldAddress } from '../../features/settings/contracts.ts';
import { useUiContextSource } from '../../composables/useUiContextSource.ts';
import SettingsWorkspace from './SettingsWorkspace.vue';
import SettingsCloseDialog from './SettingsCloseDialog.vue';

const settings = useSettingsStore();
const busy = computed(() => settings.snapshot.applying || settings.actionRunning);
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
.settings-heading, .settings-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.settings-heading {
  justify-content: space-between;
  width: 100%;
}
.settings-heading h2, .settings-footer p {
  margin: 0;
}
.settings-content {
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
.settings-footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
}
.settings-apply-results {
  max-height: 120px;
  overflow: auto;
  overflow-wrap: anywhere;
}
.settings-actions {
  flex-wrap: wrap;
  margin-left: auto;
}
</style>
