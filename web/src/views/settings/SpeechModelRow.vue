<template>
  <li class="settings-speech-model" :data-model="model.modelId">
    <div class="settings-speech-model-copy">
      <strong>{{ model.modelId }}</strong>
      <small>{{ model.repo }} · {{ sizeLabel }}</small>
      <small v-if="selectedFor" data-speech-model-selected>{{ selectedFor }}</small>
    </div>
    <span class="settings-speech-model-status" :data-cached="verified && model.cached">
      {{ !verified ? t('settings.speechSetupUnknown')
        : model.cached ? t('settings.speechSetupInstalled') : t('settings.notDownloaded') }}
    </span>
    <div class="settings-speech-actions">
      <UiButton
        v-if="verified && !model.cached"
        data-context="workspace-form-wrap"
        :data-download="model.modelId"
        :disabled="busy || !canDownload"
        @click="$emit('start', 'download', model.modelId)"
      >
        {{ t('settings.download') }}
      </UiButton>
      <UiButton
        v-if="verified && !model.cached"
        data-context="workspace-form-wrap"
        :data-copy="model.modelId"
        :disabled="busy || !canDownload"
        @click="$emit('start', 'copy', model.modelId)"
      >
        {{ t('settings.copyFromSharedCache') }}
      </UiButton>
      <UiButton
        v-if="active"
        data-context="workspace-form-wrap"
        :data-cancel="model.modelId"
        :disabled="cancelling"
        @click="$emit('cancel', job)"
      >
        {{ t('settings.cancel2') }}
      </UiButton>
    </div>
    <p v-if="job" role="status">{{ speechJobLabel(job, uiLocale) }}</p>
    <UiProgress
      v-if="job?.percent != null"
      :label="t('settings.modelProgress')"
      :value="job.percent"
    />
    <p v-if="job?.error" role="alert">{{ job.error }}</p>
  </li>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import { UiButton, UiProgress, t, uiLocale } from '../../ui.ts';
import { formatNumber } from '../../../../shared/i18n/formats.ts';
import type { SpeechModel } from '../../features/settings/resources/speech.ts';
import { speechJobLabel, type SpeechJob } from '../../features/settings/speechOperations.ts';

const props = withDefaults(defineProps<{
  model: SpeechModel;
  selectedFor?: string;
  job?: SpeechJob;
  busy: boolean;
  active: boolean;
  cancelling: boolean;
  verified?: boolean;
  canDownload?: boolean;
}>(), {
  verified: true,
  canDownload: true,
});

defineEmits<{
  start: [kind: 'download' | 'copy', modelId: string];
  cancel: [job?: SpeechJob];
}>();

const sizeLabel = computed(() => {
  const size = props.model.sizeMb;

  if (size <= 0) {
    return t('settings.unknownSize');
  }

  const gigabytes = size >= 1024;
  const digits = gigabytes || size < 100 ? 1 : 0;

  const parameters = {
    value1: formatNumber(gigabytes ? size / 1024 : size, uiLocale, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }),
  };

  return gigabytes ? t('settings.gb', parameters) : t('settings.mb', parameters);
});
</script>

<style scoped>
.settings-speech-model {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 6px 16px;
  min-width: 0;
  padding: 10px 0;
  border-bottom: 1px solid var(--line);
  overflow-wrap: anywhere;
}
.settings-speech-model > :is(p, .ui-progress) {
  grid-column: 1 / -1;
  margin: 0;
  color: var(--ink-mid);
  font-size: 12px;
}
.settings-speech-model-copy {
  display: grid;
  gap: 2px;
  min-width: 0;
}
.settings-speech-model-copy strong {
  font-size: 13px;
  font-weight: 500;
}
.settings-speech-model-copy small,
.settings-speech-model-status {
  color: var(--ink-mid);
  font-size: 12px;
}
.settings-speech-model-status[data-cached='true'] {
  color: var(--good);
}
.settings-speech-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
@container settings-page (max-width: 480px) {
  .settings-speech-model {
    grid-template-columns: minmax(0, 1fr) auto;
  }
  .settings-speech-actions {
    grid-column: 1 / -1;
  }
}
</style>
