<template>
  <div class="web-log-panel">
    <h3>Журнал окна</h3>
    <p class="muted small">
      При сбое сделайте отметку: журнал сохранит её вместе с недавними событиями окна.
    </p>
    <p v-if="status.level === 'off'" class="muted small">
      Диагностическое логирование выключено общей настройкой выше.
    </p>
    <p v-else-if="status.level === null" class="muted small">
      Ожидаем уровень диагностического логирования от сервера.
    </p>
    <label for="web-log-comment">Комментарий к сбою</label>
    <UiTextarea
      id="web-log-comment"
      v-model="comment"
      maxlength="500"
      rows="3"
      data-context="settings-field"
    />
    <p class="muted small">Комментарий сохраняется в локальном журнале.</p>
    <div class="web-log-actions">
      <UiButton data-role="settings-action" :disabled="!status.level || status.level === 'off'"
        @click="createMark">Отметить сбой</UiButton>
      <UiButton data-role="settings-action" :disabled="downloading" @click="downloadToday">
        {{ downloading ? 'Скачиваю…' : 'Скачать журнал за сегодня (UTC)' }}
      </UiButton>
    </div>
    <p v-if="markMessage" role="status">{{ markMessage }}</p>
    <p v-if="downloadError" role="alert">{{ downloadError }}</p>
    <p class="muted small">
      В кольце {{ status.ringCount }} записей, ожидают отправки {{ status.pendingCount }}.
      <span v-if="status.ringFrom">Охват: {{ status.ringFrom }} — {{ status.ringTo }}.</span>
      <span v-if="status.lossCount"> Не доставлено записей: {{ status.lossCount }}.</span>
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';

import { UiButton, UiTextarea } from '../../ui';
import { api } from '../../shared/apiClient.ts';
import { getWebLogRuntime } from '../../shared/webLogRuntime.ts';
import { useWebLogStore } from '../../stores/webLog.ts';

import type { WebLogKey } from '../../../../shared/webLogContracts.ts';

const status = useWebLogStore();
const comment = ref('');
const markState = ref<'idle' | 'pending' | 'ack' | 'drop' | 'evicted' | 'failed'>('idle');
const currentMark = ref<WebLogKey | null>(null);
const downloading = ref(false);
const downloadError = ref('');
let stopDelivery: (() => void) | null = null;

const markMessage = computed(() => {
  if (markState.value === 'failed') {
    return status.level === 'off' || status.level === null
      ? 'Диагностическое логирование выключено'
      : 'Не удалось создать отметку';
  }
  if (markState.value === 'ack') {
    return 'Сохранено на сервере';
  }
  if (markState.value === 'drop') {
    return 'Отметка не сохранена: её отбросили уровень или суточная квота журнала';
  }
  if (markState.value === 'evicted') {
    return 'Подтверждение сохранения не получено';
  }
  if (markState.value === 'pending') {
    return status.storageAvailable
      ? 'Ожидает отправки'
      : 'Сохранение после перезагрузки недоступно';
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

  let objectUrl: string | null = null;

  try {
    const day = new Date().toISOString().slice(0, 10);
    const file = await api.downloadGet(`/api/web-log/download?day=${day}`);

    objectUrl = URL.createObjectURL(file.blob);

    const link = document.createElement('a');

    link.href = objectUrl;
    link.download = /^web-log-\d{4}-\d{2}-\d{2}\.ndjson$/u.test(file.filename || '')
      ? file.filename!
      : `web-log-${day}.ndjson`;
    document.body.append(link);

    try {
      link.click();
    } finally {
      link.remove();
    }
  } catch {
    downloadError.value = 'Не удалось скачать журнал за сегодня.';
  } finally {
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
    }

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
}
.web-log-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
</style>
