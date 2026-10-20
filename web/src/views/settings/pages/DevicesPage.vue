<template>
  <section class="settings-devices" data-settings-devices>
    <SettingsScope scope="Эта машина">Имя и адрес используются при добавлении устройства.</SettingsScope>
    <SettingsField
      v-for="key in ['name', 'address']"
      :key="key"
      :address="{ pageId: 'connections.devices', fieldPath: [key] }"
    >
      <UiInput
        v-model="draft[key as 'name' | 'address']"
        :placeholder="key === 'name' ? 'Например, рабочий ноутбук' : 'Необязательно'"
      />
    </SettingsField>
    <SettingsSection><DevicesPanel :draft="draft" /></SettingsSection>
  </section>
</template>

<script setup lang="ts">
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
  gap: 16px;
  min-width: 0;
}
</style>
