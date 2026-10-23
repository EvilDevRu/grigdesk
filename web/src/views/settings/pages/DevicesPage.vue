<template>
  <section class="settings-devices" data-settings-devices>
    <SettingsScope :scope="t('settings.thisMachine')">{{ t('settings.theNameAndAddressAreUsedWhen') }}</SettingsScope>
    <SettingsField
      v-for="key in ['name', 'address']"
      :key="key"
      :address="{ pageId: 'connections.devices', fieldPath: [key] }"
    >
      <UiInput
        v-model="draft[key as 'name' | 'address']"
        :placeholder="key === 'name' ? t('settings.forExampleWorkLaptop') : t('settings.optional')"
      />
    </SettingsField>
    <SettingsSection><DevicesPanel :draft="draft" /></SettingsSection>
  </section>
</template>

<script setup lang="ts">
import { t, uiLocale } from '../../../ui.ts';

import { reactive } from 'vue';
import { UiInput } from '../../../ui.ts';
import { useSettingsStore } from '../../../stores/settings.ts';
import SettingsField from '../SettingsField.vue';
import DevicesPanel from '../DevicesPanel.vue';
import SettingsScope from '../SettingsScope.vue';
import SettingsSection from '../SettingsSection.vue';

const settings = useSettingsStore();
const draft = settings.sessionService('devicePairing', () => reactive({ name: '', address: '' }));
</script>

<style scoped>
.settings-devices {
  display: grid;
  gap: 12px;
  min-width: 0;
}
.settings-devices > [data-settings-field] + [data-settings-field] {
  margin-top: -12px;
}
</style>
