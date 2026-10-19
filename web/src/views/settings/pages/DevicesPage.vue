<template>
  <section data-settings-devices>
    <p>Имя и адрес сохраняются в черновике этого открытия настроек. Код выдаётся по явной кнопке.</p>
    <SettingsField v-for="key in ['name', 'address']" :key="key"
                   :address="{ pageId: 'connections.devices', fieldPath: [key] }">
      <UiInput v-model="draft[key as 'name' | 'address']" />
    </SettingsField>
    <DevicesPanel :draft="draft" />
  </section>
</template>

<script setup lang="ts">
import { reactive } from 'vue';
import { UiInput } from '../../../ui.ts';
import { useSettingsStore } from '../../../stores/settings.ts';
import SettingsField from '../SettingsField.vue';
import DevicesPanel from '../DevicesPanel.vue';

const settings = useSettingsStore();
const draft = settings.sessionService('devicePairing', () => reactive({ name: '', address: '' }));
</script>
