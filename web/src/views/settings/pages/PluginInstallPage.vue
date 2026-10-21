<template>
  <SettingsSection
    :heading="t('settings.sectionAddGrigdeskFeatures')"
    :description="t('settings.installAPluginFromAGitRepository')"
  >
    <SettingsScope :scope="t('settings.separateAction')">{{ t('settings.installationStartsImmediatelyAfterConfirmation') }}</SettingsScope>
    <p v-if="installer.job">{{ t('settings.installationJob') }} {{ installer.job.status }}.</p>
    <p v-if="installer.recoveryError" role="alert">{{ installer.recoveryError.message }}</p>
    <UiButton variant="solid" tone="accent" @click="open = true">{{ t('settings.openGitInstallation') }}</UiButton>
    <PluginInstallDialog
      v-if="open"
      v-model:open="open"
      mode="install"
      :plugin="null"
    />
  </SettingsSection>
</template>

<script setup lang="ts">
import { t } from '../../../ui.ts';

import { ref } from 'vue';
import { UiButton } from '../../../ui.ts';
import { usePluginInstallStore } from '../../../stores/pluginInstall.ts';
import PluginInstallDialog from '../PluginInstallDialog.vue';
import SettingsSection from '../SettingsSection.vue';
import SettingsScope from '../SettingsScope.vue';

const installer = usePluginInstallStore();
const open = ref(true);
</script>
