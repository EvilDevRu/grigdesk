<template>
  <div class="speech-installation" data-speech-installation>
    <UiLoadingState v-if="!snapshot && !controller.error.value" :label="t('settings.checking')" />
    <template v-if="snapshot">
      <p role="status" data-speech-installation-status>
        {{ statusLabel }}
      </p>
      <div v-if="dependencies.length" class="speech-installation-actions">
        <UiButton
          v-for="dependency in dependencies"
          :key="dependency.id"
          variant="link"
          tone="accent"
          :data-speech-dependency="dependency.id"
          v-tooltip="t('settings.speechDependencyTerminal')"
          :disabled="disabled"
          @click="emit('installDependency', dependency.id)"
        >{{ t('settings.speechDependencyInstall', { package: dependency.package }) }}</UiButton>
      </div>
      <p v-if="!snapshot.managed">{{ t('settings.speechRuntimeExternal') }}</p>
      <template v-else>
        <div class="speech-installation-actions">
          <UiButton
            v-if="!snapshot.installed"
            variant="solid"
            tone="accent"
            data-speech-install="install"
            :disabled="disabled"
            @click="controller.start('install')"
          >{{ t('settings.speechRuntimeInstall') }}</UiButton>
          <template v-else>
            <UiButton
              data-speech-install="update"
              :disabled="disabled"
              @click="controller.start('update')"
            >{{ t('settings.speechRuntimeUpdate') }}</UiButton>
            <UiButton
              tone="danger"
              data-speech-install="uninstall"
              :disabled="disabled"
              @click="controller.start('uninstall')"
            >{{ t('settings.speechRuntimeUninstall') }}</UiButton>
          </template>
        </div>
      </template>
      <template v-if="snapshot.job">
        <UiProgress v-if="running" indeterminate :label="stageLabel" />
        <div v-if="snapshot.job.output">
          <UiDisclosureButton v-model:open="detailsOpen" :controls="outputId">
            {{ t('settings.providerInstallationDetails') }}
          </UiDisclosureButton>
          <pre v-if="detailsOpen" :id="outputId">{{ snapshot.job.output }}</pre>
        </div>
      </template>
    </template>
    <UiInlineMessage v-if="controller.error.value && !snapshot" tone="danger">
      {{ controller.error.value }}
    </UiInlineMessage>
    <UiButton v-if="controller.error.value || controller.uncertain.value" @click="controller.load()">
      {{ t('settings.speechSetupRecheck') }}
    </UiButton>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, useId } from 'vue';

import {
  UiButton,
  UiDisclosureButton,
  UiInlineMessage,
  UiLoadingState,
  UiProgress,
  t,
  vTooltip,
} from '../../ui.ts';
import type { SpeechInstallationController } from '../../features/settings/speechInstallation.ts';
import type { SpeechDependencyAction } from '../../features/settings/speechDependencies.ts';
import type { SpeechInstallDependency } from '../../../../shared/media/speechInstallation.ts';

const props = withDefaults(defineProps<{
  controller: SpeechInstallationController;
  ready: boolean;
  environmentReady: boolean;
  dependencies?: SpeechDependencyAction[];
}>(), { dependencies: () => [] });

const emit = defineEmits<{ installDependency: [id: SpeechInstallDependency] }>();

const detailsOpen = ref(false);
const outputId = `speech-install-output-${useId().replaceAll(':', '')}`;
const snapshot = computed(() => props.controller.snapshot.value);
const running = computed(() => snapshot.value?.job?.status === 'running');
const disabled = computed(() => running.value
  || props.controller.busy.value || props.controller.uncertain.value);
const stageLabel = computed(() => ({
  environment: t('settings.speechRuntimeEnvironment'),
  packages: t('settings.speechRuntimePackages'),
  gpu: t('settings.speechRuntimeGpu'),
  model: t('settings.speechModelDownloading'),
  verification: t('settings.speechRuntimeVerification'),
  removal: t('settings.speechRuntimeRemoval'),
  done: t('settings.done2'),
})[snapshot.value?.job?.stage ?? 'environment']);
const statusLabel = computed(() => {
  const job = snapshot.value?.job;

  if (props.controller.error.value || job?.error) {
    return props.controller.error.value || job?.error;
  }
  if (job?.status === 'running') {
    return t('settings.speechRuntimeWorking', { stage: stageLabel.value });
  }
  if (job?.status === 'interrupted') {
    return t('settings.speechRuntimeInterrupted');
  }
  if (job?.status === 'failed') {
    return t('settings.speechRuntimeFailed');
  }

  if (!snapshot.value?.managed && props.ready) {
    return t('settings.speechRuntimeInstalled');
  }
  if (!snapshot.value?.installed) {
    return t('settings.speechRuntimeMissing');
  }

  return !props.environmentReady ? t('settings.speechRuntimeRepair')
    : props.ready ? t('settings.speechRuntimeInstalled') : t('settings.speechModelPreparing');
});
</script>

<style scoped>
.speech-installation {
  display: grid;
  gap: 12px;
  min-width: 0;
  padding: 12px 0;
}
.speech-installation p {
  margin: 0;
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 1.6;
}
.speech-installation-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.speech-installation pre {
  max-height: 220px;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 11px;
}
</style>
