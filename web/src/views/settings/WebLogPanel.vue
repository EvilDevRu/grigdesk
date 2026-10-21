<template>
  <div class="web-log-panel">
    <h3>{{ t('settings.windowLog') }}</h3>
    <p class="muted small">
      {{ t('settings.whenAProblemOccursAddAMarker') }}
    </p>
    <p v-if="status.level === 'off'" class="muted small">
      {{ t('settings.diagnosticLoggingIsDisabledByTheShared') }}
    </p>
    <p v-else-if="status.level === null" class="muted small">
      {{ t('settings.waitingForTheDiagnosticLoggingLevelFrom') }}
    </p>
    <label for="web-log-comment">{{ t('settings.problemComment') }}</label>
    <UiTextarea
      id="web-log-comment"
      v-model="comment"
      maxlength="500"
      rows="3"
      data-context="settings-field"
    />
    <p class="muted small">{{ t('settings.theCommentIsSavedInTheLocal') }}</p>
    <div class="web-log-actions">
      <UiButton
        data-role="settings-action"
        :disabled="!status.level || status.level === 'off'"
        @click="createMark"
      >
        {{ t('settings.markAProblem') }}
      </UiButton>
      <UiButton
        data-role="settings-action"
        :disabled="downloading"
        @click="downloadToday"
      >
        {{ downloading ? t('settings.downloading') : t('settings.downloadTodaySLogUTC') }}
      </UiButton>
    </div>
    <p v-if="markMessage" role="status">{{ markMessage }}</p>
    <p v-if="downloadError" role="alert">{{ resolveUiText(downloadError) }}</p>
    <p class="muted small">
      {{ t('settings.inTheBuffer') }} {{ status.ringCount }} {{ t('settings.entriesWaitingToSend') }} {{ status.pendingCount }}.
      <span v-if="status.ringFrom">{{ t('settings.coverage') }} {{ status.ringFrom }} — {{ status.ringTo }}.</span>
      <span v-if="status.lossCount">{{ t('settings.undeliveredEntries') }} {{ status.lossCount }}.</span>
    </p>
  </div>
</template>

<script setup lang="ts">
import { t, messageRef, resolveUiText, type UiText } from '../../ui.ts';

import { saveFile } from '../../shared/saveFile.ts';
import { computed, onMounted, onUnmounted, ref } from 'vue';

import { UiButton, UiTextarea } from '../../ui';
import { api } from '../../shared/apiClient.ts';
import { getWebLogRuntime } from '../../shared/webLogRuntime.ts';
import { useWebLogStore } from '../../stores/webLog.ts';

import type { WebLogKey } from '../../../../shared/web-log/webLogContracts.ts';

const status = useWebLogStore();
const comment = ref('');
const markState = ref<'idle' | 'pending' | 'ack' | 'drop' | 'evicted' | 'failed'>('idle');
const currentMark = ref<WebLogKey | null>(null);
const downloading = ref(false);
const downloadError = ref<UiText>('');
let stopDelivery: (() => void) | null = null;

const markMessage = computed(() => {
  if (markState.value === 'failed') {
    return status.level === 'off' || status.level === null
      ? t('settings.diagnosticLoggingIsDisabled')
      : t('settings.couldNotCreateAMarker');
  }
  if (markState.value === 'ack') {
    return t('settings.savedOnTheServer');
  }
  if (markState.value === 'drop') {
    return t('settings.markerNotSavedDiscardedByTheLogging');
  }
  if (markState.value === 'evicted') {
    return t('settings.saveConfirmationNotReceived');
  }
  if (markState.value === 'pending') {
    return status.storageAvailable
      ? t('settings.waitingToSend')
      : t('settings.savingAfterReloadIsUnavailable');
  }

  return '';
});

/**
 * Статус относится ровно к последней отметке, а не к произвольному ACK пачки:
 * подтверждение других записей не превращается в успех текущей.
 */
function onDelivery(event: { key: WebLogKey; status: string }): void {
  if (
    !currentMark.value ||
    event.key.page !== currentMark.value.page ||
    event.key.seq !== currentMark.value.seq
  ) {
    return;
  }
  if (event.status === 'ack' || event.status === 'drop' || event.status === 'evicted') {
    markState.value = event.status;
  }
}

/**
 * Создаём отметку и запоминаем её ключ до ответа сервера.
 * Сообщение об успехе появляется только после ACK этого ключа.
 */
function createMark(): void {
  const runtime = getWebLogRuntime();
  const key = runtime?.mark(comment.value.slice(0, 500)) ?? null;

  currentMark.value = key;
  markState.value = key ? 'pending' : 'failed';
}

/**
 * Имя берём из проверенного GET-helper; временный URL освобождаем даже если
 * браузер или диалог скачивания бросит исключение.
 */
async function downloadToday(): Promise<void> {
  downloading.value = true;
  downloadError.value = '';

  try {
    const day = new Date().toISOString().slice(0, 10);
    const file = await api.downloadGet(`/api/web-log/download?day=${day}`);

    const filename = /^web-log-\d{4}-\d{2}-\d{2}\.ndjson$/u.test(file.filename || '')
      ? file.filename!
      : `web-log-${day}.ndjson`;

    await saveFile(file.blob, filename);
  } catch {
    downloadError.value = messageRef('settings.couldNotDownloadTodaySLog');
  } finally {
    downloading.value = false;
  }
}

onMounted(() => {
  stopDelivery = getWebLogRuntime()?.transport.subscribeDelivery(onDelivery) ?? null;
});
onUnmounted(() => {
  stopDelivery?.();
});
</script>

<style scoped>
.web-log-panel {
  display: grid;
  gap: 10px;
  width: 100%;
  min-width: 0;
}
.web-log-panel h3 {
  margin: 0 0 4px;
  font-size: 14px;
  font-weight: 600;
}
.web-log-panel p {
  margin: 0;
  line-height: 1.6;
}
.web-log-panel label {
  margin-top: 6px;
  font-size: 12px;
  font-weight: 600;
}
.web-log-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
</style>
