<template>
  <UiDialog
    v-if="install.visible"
    :open="install.visible"
    :title="title"
    size="content"
    mobile-fullscreen
    data-role="provider-install-dialog"
    @close="install.visible = false"
  >
    <template v-if="job">
      <p><code>{{ job.command }}</code></p>
      <ol class="provider-install-stages">
        <li :aria-current="job.stage === 'download-install' ? 'step' : undefined">
          {{ t('settings.providerInstallationDownloadInstall') }}
        </li>
        <li :aria-current="job.stage === 'version' ? 'step' : undefined">
          {{ t('settings.providerInstallationVersion') }}
        </li>
        <li :aria-current="job.stage === 'models' ? 'step' : undefined">
          {{ t('settings.providerInstallationModels') }}
        </li>
      </ol>
      <UiProgress v-if="job.status === 'running'" indeterminate :label="currentStage" />
      <p v-else role="status">{{ resultText }}</p>
      <pre
        v-if="job.outputTail"
        class="provider-install-output"
        :aria-label="t('settings.providerInstallationOutput')"
      >{{ job.outputTail }}</pre>
      <p v-if="job.status === 'succeeded' && job.operation === 'install'">
        {{ t('settings.providerInstallationOldTerminal') }}
      </p>
    </template>
    <p v-if="install.uncertain">{{ t('settings.providerInstallationUnknown') }}</p>
    <p v-if="install.selectedFailure" role="alert">{{ install.selectedFailure.message }}</p>
    <p v-if="install.snapshot.blockedReason" role="alert">
      {{ providerInstallNoticeText(install.snapshot.blockedReason) }}
    </p>
    <p v-if="install.error" role="alert">{{ install.error }}</p>
    <template #footer>
      <UiButton
        v-if="job?.status === 'succeeded' && job.loginCommand"
        @click="openTerminal(job.loginCommand)"
      >{{ t('settings.providerInstallationLogin') }}</UiButton>
      <UiButton
        v-if="fallbackCommand"
        @click="openTerminal(fallbackCommand)"
      >{{ t('settings.providerInstallationTerminal') }}</UiButton>
      <UiButton v-if="install.error || install.uncertain" @click="install.load()">
        {{ t('settings.providerInstallationRefresh') }}
      </UiButton>
      <UiButton @click="install.visible = false">{{ t('settings.providerInstallationClose') }}</UiButton>
    </template>
  </UiDialog>
</template>

<script setup lang="ts">
import { computed, onMounted, watch } from 'vue';

import { UiButton, UiDialog, UiProgress, t, uiLocale, resolveUiText } from '../ui.ts';
import { useSse } from '../composables/useSse.ts';
import {
  useProviderInstallStore,
  providerInstallResultText,
  providerInstallNoticeText,
} from '../stores/providerInstall.ts';
import { useProvidersStore } from '../stores/providers.ts';
import { useAuthStore } from '../stores/auth.ts';
import { useSettingsStore } from '../stores/settings.ts';
import { createSettingsActions } from '../features/settings/actions.ts';
import { useToolLauncher } from './tools/launcher.ts';

const install = useProviderInstallStore();
const providers = useProvidersStore();
const settings = useSettingsStore();
const auth = useAuthStore();
const launcher = useToolLauncher();
const job = computed(() => install.selectedJob);
const fallbackCommand = computed(() => install.selectedFailure?.fallbackCommand
  || (job.value && ['failed', 'interrupted'].includes(job.value.status) ? job.value.fallbackCommand : ''));
const title = computed(() => {
  const provider = providers.providers.find((entry) => entry.id === install.providerId);

  return `${t('settings.providerInstallationTitle')}${provider ? ` · ${provider.name}` : ''}`;
});
const currentStage = computed(() => {
  if (job.value?.stage === 'version') {
    return t('settings.providerInstallationVersion');
  }
  if (job.value?.stage === 'models') {
    return t('settings.providerInstallationModels');
  }

  return t('settings.providerInstallationDownloadInstall');
});
const resultText = computed(() => job.value ? providerInstallResultText(job.value) : '');
const actions = createSettingsActions({
  requestAction: (run) => settings.isOpen ? settings.requestAction(run) : run(),
  notify: (text) => {
    install.error = resolveUiText(text);
  },
  openTerminal: launcher.openTerminal,
  openChat: async () => false,
}, uiLocale);

/**
 * Общий dirty-переход может отказаться от открытия терминала без потери окна.
 * Launcher получает только вставку команды: установка и Enter здесь не выполняются.
 */
async function openTerminal(command: string): Promise<void> {
  if (await actions.openTerminal(command)) {
    install.visible = false;
  }
}

useSse((name, data) => {
  if (name === 'provider-install') {
    install.applySnapshot(data);
  } else if (name === 'hello') {
    void install.load();
  }
});

onMounted(() => {
  if (auth.authenticated) {
    void install.load();
  }
});

watch(() => [auth.clientScope, auth.authenticated], () => {
  if (auth.authenticated) {
    void install.load();
  }
});
</script>

<style scoped>
.provider-install-stages {
  padding-inline-start: 1.5rem;
}

.provider-install-stages [aria-current="step"] {
  font-weight: 700;
}

.provider-install-output {
  max-height: min(30vh, 18rem);
  max-width: 100%;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

code {
  overflow-wrap: anywhere;
}
</style>
