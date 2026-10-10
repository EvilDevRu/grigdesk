<template>
  <section class="app-page pane">
    <UiPaneHeader title="Настройки" brand status />
    <div class="pane-body">
      <div class="pane-content pane-narrow">
        <section class="settings-group">
          <h2 class="section-title">Подключение</h2>
          <UiCard>
            <div class="settings-head">
              <span class="row-avatar" aria-hidden="true">
                {{ initial(link.state?.brainName || 'К') }}
              </span>
              <div class="settings-name">
                <strong>{{ link.state?.brainName || 'Кокпит' }}</strong>
                <span class="mobile-muted">{{ link.state?.deviceName }}</span>
              </div>
            </div>
            <UiListRow to="/relays" label="Посредники">
              <template #lead><UiIcon name="relay" /></template>
              <span class="row-title row-title-wrap">Посредники</span>
              <span class="row-sub" :aria-label="relaySummary">{{ relaySummary }}</span>
              <template #aside><UiIcon name="forward" /></template>
            </UiListRow>
          </UiCard>
        </section>
        <section class="settings-group">
          <h2 class="section-title">Приложение</h2>
          <UiCard>
            <p>Версия приложения: {{ version }}</p>
            <UiButton :busy="busy" @click="check">
              <UiIcon name="refresh" />
              <span>Проверить обновление</span>
            </UiButton>
            <p v-if="checked && !update">Установлена последняя версия</p>
            <p v-if="update">Доступна версия {{ update.version }}</p>
            <UiButton v-if="update" kind="primary" variant="solid" :busy="busy" @click="download">
              <UiIcon name="download" />
              <span>Скачать и установить</span>
            </UiButton>
            <UiError v-if="error" :text="error" />
            <details class="settings-diagnostics">
              <summary>Диагностика</summary>
              <p class="mobile-muted">
                Размер окна: {{ width }}×{{ height }}, шрифт ×{{ link.state?.fontScale || 1 }}
              </p>
            </details>
          </UiCard>
        </section>
        <section v-if="operations.length" class="settings-group">
          <h2 class="section-title">Незавершённые действия</h2>
          <UiCard>
            <p>
              Результат этих действий ещё не подтверждён. Проверьте состояние перед новым решением.
            </p>
            <div v-for="operation in operations" :key="operation.idempotencyKey">
              <p class="mobile-prose">{{ operationLabel(operation) }}</p>
              <UiButton @click="verify(operation)">Проверить результат</UiButton>
            </div>
            <p v-if="operationNotice" role="status">{{ operationNotice }}</p>
          </UiCard>
        </section>
        <UiButton kind="danger" @click="resetting = true">
          <UiIcon name="unlink" />
          <span>Отвязать телефон</span>
        </UiButton>
      </div>
    </div>
    <UiDialog
      v-if="resetting"
      title="Отвязать телефон?"
      confirm="Отвязать"
      danger
      :busy="link.busy"
      @close="resetting = false"
      @confirm="
        link.reset();
        resetting = false;
      "
    >
      <p>Привязка и локальные ключи будут удалены. Для входа понадобится новый QR-код.</p>
    </UiDialog>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';

import type { AppUpdate } from '../api/contract.ts';
import type { OperationIntent } from '../link/types.ts';
import { isNewer } from '../api/version.ts';
import { UiButton, UiCard, UiDialog, UiError, UiIcon, UiListRow, UiPaneHeader } from '../ui.ts';
import { initial } from '../ui/format.ts';
import { useLinkStore } from '../stores/link.ts';

const link = useLinkStore();
const version = import.meta.env.VITE_APP_VERSION || '0.1.0';
const width = ref(window.innerWidth);
const height = ref(window.innerHeight);
const checked = ref(false);
const update = ref<AppUpdate | null>(null);
const busy = ref(false);
const error = ref('');
const resetting = ref(false);
const operations = ref<OperationIntent[]>([]);
const operationNotice = ref('');
const relaySummary = computed(() => {
  const relay = link.state?.relays.find((item) => item.id === link.state?.activeRelayId);
  const count = link.state?.relays.length || 0;

  if (!relay) {
    return count ? 'Не выбран' : 'Нет посредников';
  }

  return relay.name + (count > 1 ? ` и ещё ${count - 1}` : '');
});
const resize = () => {
  width.value = window.innerWidth;
  height.value = window.innerHeight;
};

/**
 * Незавершённое действие называется языком интерфейса, без маршрута API и внутренних ID.
 * Неизвестный вид остаётся нейтральным: приложение не угадывает, какой эффект уже произошёл.
 */
function operationLabel(operation: OperationIntent) {
  if (operation.path.includes('/waiting/')) {
    return 'Ответ агенту';
  }

  const action = operation.path.split('/').at(-1) || '';

  return ({
    stop: 'Остановка работы',
    resume: 'Продолжение задачи',
    gate: 'Решение по воротам',
    launch: 'Запуск на конвейере',
    chats: 'Создание чата',
    settings: 'Модель и эффорт чата',
    workspace: 'Задача и папка чата',
    preview: 'Предпросмотр папки чата',
    read: 'Отметка прочтения чата',
  })[action] || 'Действие в Кокпите';
}

/**
 * Проверенный app DTO предлагает установку только более новой версии.
 * Ошибка доступа к APK остаётся видимой и не выдаётся за отсутствие обновлений.
 */
async function check() {
  busy.value = true;
  error.value = '';

  try {
    const value = await link.api!.getApp();

    update.value = isNewer(value.version, version) ? value : null;
    checked.value = true;
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : 'Проверка не завершена.';
  } finally {
    busy.value = false;
  }
}

/**
 * Native скачивает APK через тот же pinned brain и сверяет байты до выдачи URI установщику.
 * JS не получает URL APK или право загрузки внешнего файла.
 */
async function download() {
  busy.value = true;

  try {
    await link.bridge!.downloadUpdate();
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : 'Обновление не загружено.';
  } finally {
    busy.value = false;
  }
}

/**
 * Восстановленное действие только сверяется по прежнему ключу, без повторной отправки.
 * Durable result снимает локальную запись; неизвестный исход сохраняется для следующей сверки.
 */
async function verify(operation: OperationIntent) {
  try {
    const result = await link.api!.getOperation(operation.idempotencyKey);

    operationNotice.value =
      result.state === 'done'
        ? 'Результат получен. Проверьте актуальное состояние в соответствующем разделе.'
        : 'Результат пока неизвестен. Проверьте состояние в кокпите.';

    if (result.state === 'done') {
      await link.bridge!.removeOutbox({ idempotencyKey: operation.idempotencyKey });
      operations.value = operations.value.filter(
        (item) => item.idempotencyKey !== operation.idempotencyKey,
      );
    }
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : 'Результат недоступен.';
  }
}

onMounted(async () => {
  window.addEventListener('resize', resize);
  operations.value = (await link.bridge!.getOutbox()).items.filter((item) => !item.clientId);
});
onUnmounted(() => {
  window.removeEventListener('resize', resize);
});
</script>
