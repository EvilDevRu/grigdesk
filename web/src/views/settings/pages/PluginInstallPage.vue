<template>
  <SettingsSection
    heading="Добавьте возможности GrigDesk"
    description="Установите плагин из Git-репозитория."
  >
    <SettingsScope scope="Отдельная операция">Установка выполняется сразу после подтверждения.</SettingsScope>
    <p v-if="installer.job">Есть задание установки: {{ installer.job.status }}.</p>
    <p v-if="installer.recoveryError" role="alert">{{ installer.recoveryError.message }}</p>
    <UiButton variant="solid" tone="accent" @click="open = true">Открыть установку из git</UiButton>
    <PluginInstallDialog
      v-if="open"
      v-model:open="open"
      mode="install"
      :plugin="null"
    />
  </SettingsSection>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { UiButton } from '../../../ui.ts';
import { usePluginInstallStore } from '../../../stores/pluginInstall.ts';
import PluginInstallDialog from '../PluginInstallDialog.vue';
import SettingsSection from '../SettingsSection.vue';
import SettingsScope from '../SettingsScope.vue';

const installer = usePluginInstallStore();
const open = ref(true);
</script>
