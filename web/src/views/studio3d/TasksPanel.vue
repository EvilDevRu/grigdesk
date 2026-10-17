<template>
  <section class="studio-tasks">
    <header class="studio-tasks-heading">
      <div>
        <h3>Задачи</h3>
        <p>Ход генерации, история заказов и расходы.</p>
      </div>
      <div class="studio-task-actions">
        <UiButton :loading="busy" @click="refresh">Обновить</UiButton>
        <UiButton variant="ghost" :disabled="busy" @click="scan">Найти прошлые заказы на диске</UiButton>
      </div>
    </header>
    <UiInlineMessage v-if="scanResult">{{ scanResult }}</UiInlineMessage>
    <UiInlineMessage v-if="error" tone="danger">{{ error }}</UiInlineMessage>
    <template v-if="store.tasks">
      <dl class="studio-task-summary">
        <div :class="{ 'studio-task-attention': attentionRows.length }">
          <dt>Требуют внимания</dt><dd>{{ attentionRows.length }}</dd>
        </div>
        <div><dt>В работе</dt><dd>{{ runningRows.length }}</dd></div>
        <div><dt>Готовы за 24 часа</dt><dd>{{ readyCount }}</dd></div>
      </dl>
      <p v-if="runningRows.length" class="studio-task-empty">
        Можно уйти из раздела. Принятые задачи продолжатся, готовые результаты останутся в библиотеке.
      </p>
      <UiInlineMessage v-if="store.tasks.historyPartial || store.tasks.week.partial" tone="warning">
        История неполная. Показаны только известные заказы; это не полный счёт аккаунта.
        {{ store.tasks.historyError }}
      </UiInlineMessage>
      <section v-for="group in rowGroups" :key="group.id" class="studio-task-group" :data-group="group.id">
        <h4>{{ group.label }} <span>{{ group.rows.length }}</span></h4>
        <p v-if="group.id === 'attention'">Проверьте причину и доступные действия у каждого заказа.</p>
        <p v-if="!group.rows.length" class="studio-task-empty">{{ group.id === 'active'
          ? 'Сейчас нет задач в работе.' : 'За последние сутки завершённых задач нет.' }}</p>
        <article v-for="row in group.rows" :key="`${row.intentId}:${row.childId}`" class="studio-task-row">
          <div class="studio-task-title"><strong>{{ row.modelName || 'Модель удалена' }} · {{ row.label }}</strong>
            <span class="studio-task-status" :data-status="row.status">
              {{ providerLabel(row.provider, store.state?.providers) }} · {{ statusLabels[row.status] }}
            </span>
          </div>
          <UiProgress v-if="group.id === 'active'" :value="row.progress" :label="`Прогресс ${row.label}`" />
          <p v-if="group.id === 'active' && row.etaSeconds !== null || row.waitReason">
            {{ group.id === 'active' && row.etaSeconds !== null
              ? `≈ ${Math.max(1, Math.ceil(row.etaSeconds / 60))} мин` : '' }}
            {{ row.waitReason }}</p>
          <p>{{ paymentText({ estimated: row.estimated, actual: row.actual, unit: row.unit,
            state: row.paymentState, free: row.paymentState === 'free' }) }}</p>
          <UiInlineMessage v-if="row.error" tone="danger">{{ row.error.message }}</UiInlineMessage>
          <div class="studio-task-footer">
            <div class="studio-task-actions">
              <UiButton v-if="row.modelId" :tone="row.status === 'ready' ? 'accent' : 'neutral'"
                @click="$emit('open', row.modelId, row.versionId || undefined)">
                {{ row.status === 'ready' ? 'Посмотреть результат' : 'Открыть модель' }}</UiButton>
              <UiButton v-if="row.status === 'waiting'" variant="ghost" :disabled="busy"
                @click="cancel(row)">Отменить</UiButton>
            </div>
            <UnknownOrder v-if="['unknown', 'unresolved'].includes(row.status)
              || row.waitReason === MISSING_TASK_WAIT_REASON" :row="row" />
          </div>
          <p v-if="row.retryReason">{{ row.retryReason }}</p>
        </article>
      </section>
      <section class="studio-task-group">
        <h4>Сделано вне раздела <span>{{ store.tasks.external.length }}</span></h4>
        <p v-if="!store.tasks.external.length" class="studio-task-empty">Нет новых наблюдений.</p>
        <article v-for="row in store.tasks.external" :key="`${row.provider}:${row.taskId}`" class="studio-task-row">
          <strong>{{ row.label }} · {{ taskTypeLabel(row.type) }}</strong>
          <p>{{ providerLabel(row.provider, store.state?.providers) }} · {{ row.credits === null ? 'Сумма неизвестна' : `Списано ${row.credits}` }} ·
            {{ row.createdAt ? new Date(row.createdAt).toLocaleString('ru-RU') : 'Дата неизвестна' }}</p>
          <UiButton :disabled="busy" @click="importTask(row.provider, row.taskId)">Забрать в библиотеку</UiButton>
        </article>
      </section>
      <section class="studio-task-group">
        <h4>За 7 дней по известным заказам</h4>
        <p v-if="!store.tasks.week.groups.length" class="studio-task-empty">Подтверждённых расходов пока нет.</p>
        <div v-for="group in store.tasks.week.groups" :key="`${group.provider}:${group.unit?.many}`">
          <p>{{ providerLabel(group.provider, store.state?.providers) }} {{ formatPrice(group.actual, group.unit) }} —
            в разделе {{ group.sectionActual }}, вне раздела {{ group.externalActual }}</p>
          <p>Оценки заказов: {{ formatPrice(group.estimated, group.unit) }} ·
            резерв заказов раздела: {{ formatPrice(group.reserved, group.unit) }} ·
            возврат подтверждён: {{ formatPrice(group.refunded, group.unit) }}</p>
          <p v-if="group.unknownCount">Списание неизвестно: {{ group.unknownCount }} заказов,
            оценка {{ formatPrice(group.unknownEstimated, group.unit) }}</p>
        </div>
      </section>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch, onUnmounted } from 'vue';
import { UiButton, UiProgress, UiInlineMessage, confirmDialog } from '../../ui.ts';
import { useStudio3dStore } from '../../stores/studio3d.ts';
import { formatPrice, MISSING_TASK_WAIT_REASON } from '../../../../shared/studio3d/studio3dOperations.ts';
import {
  paymentText,
  statusLabels,
  studioErrorMessage,
  providerLabel,
  taskTypeLabel
} from '../../features/studio3d/presentation.ts';
import type { Studio3dTaskRow } from '../../../../shared/studio3d/studio3dContracts.ts';
import UnknownOrder from './UnknownOrder.vue';

const emit = defineEmits<{ open: [modelId: string, versionId?: string] }>();
const store = useStudio3dStore();
const busy = ref(false);
const scanResult = ref('');
const error = ref('');
let alive = true;

const needsAttention = (row: Studio3dTaskRow) => ['unknown', 'unresolved', 'failed'].includes(row.status)
  || row.waitReason === MISSING_TASK_WAIT_REASON;
const attentionRows = computed(() => [...store.tasks?.active ?? [], ...store.tasks?.recent ?? []]
  .filter(needsAttention));
const runningRows = computed(() => (store.tasks?.active ?? []).filter((row) => !needsAttention(row)));
const readyCount = computed(() => store.tasks?.recent.filter((row) => row.status === 'ready').length ?? 0);
const rowGroups = computed(() => [
  ...(attentionRows.value.length ? [{
    id: 'attention',
    label: 'Требуют внимания',
    rows: attentionRows.value
  }] : []),
  {
    id: 'active',
    label: 'В работе',
    rows: runningRows.value
  },
  {
    id: 'recent',
    label: 'Завершены · 24 часа',
    rows: (store.tasks?.recent || []).filter((row) => !needsAttention(row))
  },
]);

watch(() => store.libraryId, () => {
  error.value = '';
  scanResult.value = '';
  busy.value = false;
});
onUnmounted(() => {
  alive = false;
});

/**
 * Действие держит локальный lock и marker библиотеки до своего последнего эффекта.
 * Старый ответ не показывает результат сканирования или импорт новой библиотеке.
 */
async function act(work: (libraryId: string) => Promise<void>): Promise<void> {
  if (busy.value) {
    return;
  }
  
  const libraryId = store.libraryId;
  
  busy.value = true;
  error.value = '';
  
  try {
    await work(libraryId);
  }
  catch (cause) {
    if (alive && libraryId === store.libraryId) {
      error.value = studioErrorMessage(cause);
    }
  } finally { if (alive && libraryId === store.libraryId) {
    busy.value = false;
  } }
}

const refresh = () => act(async () => {
  await store.loadTasks(true);
});

/**
 * Сканирование показывает фактические imported/skipped и причины частичного результата.
 * Его бесплатный ответ не меняет unknown или оплату уже отправленного заказа.
 */
async function scan(): Promise<void> {
  await act(async (libraryId) => {
    const result = await store.scan();
    
    if (alive && libraryId === store.libraryId && result.libraryId === libraryId) {
      scanResult.value = `Найдено ${result.found}, добавлено ${result.imported}, пропущено ${result.skipped}`
        + (result.partial ? ` · неполно: ${result.reasons.join(', ')}` : '');
    }
  });
}

/**
 * Неотправленная позиция отменяется без оплаты: сервер не делает POST и
 * закрывает запись. Отправленные и неизвестные заказы сюда не попадают.
 */
async function cancel(row: Studio3dTaskRow): Promise<void> {
  if (!await confirmDialog(`Отменить заказ «${row.label}»? Он ещё не отправлен, оплаты не было.`)) {
    return;
  }

  await act(async () => {
    await store.closeUnknownChild(row.intentId, row.childId);
  });
}

/**
 * Явный внешний импорт возвращает серверный modelId, не подменяется повторной генерацией.
 * Переход к модели допускается только в той библиотеке, где было нажатие.
 */
async function importTask(provider: string, taskId: string): Promise<void> {
  await act(async (libraryId) => {
    const result = await store.importExternal(provider, taskId);
    
    if (alive && libraryId === store.libraryId && result.libraryId === libraryId) {
      emit('open', result.modelId);
    }
  });
}
</script>

<style scoped>
.studio-tasks {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 1200px;
  margin: 0 auto;
}

.studio-tasks-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 4px;
}

.studio-tasks-heading h3 {
  margin: 0 0 6px;
  font-size: 20px;
  font-weight: 600;
}

.studio-tasks p {
  margin: 0;
  color: var(--ink-mid);
  font-size: 13px;
  line-height: 1.6;
}

.studio-task-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.studio-task-group {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
}

.studio-task-group h4 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 13px;
  font-weight: 600;
}

.studio-task-summary {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
  margin: 0;
}

.studio-task-summary > div {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
}

.studio-task-summary dt {
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 1.5;
}

.studio-task-summary dd {
  margin: 0;
  font-size: 20px;
  font-variant-numeric: tabular-nums;
}

.studio-task-summary > .studio-task-attention,
.studio-task-group[data-group='attention'] {
  border-color: color-mix(in srgb, var(--warn) 45%, var(--line));
}

.studio-task-group h4 > span {
  padding: 2px 6px;
  border-radius: 5px;
  background: var(--surface-2);
  color: var(--ink-mid);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.studio-task-empty {
  padding: 4px 0;
}

.studio-task-row {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 12px;
  border-top: 1px solid var(--line);
  overflow-wrap: anywhere;
}

.studio-task-footer {
  display: flex;
  align-items: flex-start;
  flex-wrap: wrap;
  gap: 8px;
}

@container studio (max-width: 559px) {
  .studio-task-summary > div {
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
  }
}

.studio-task-title {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 8px;
}

.studio-task-status {
  color: var(--ink-mid);
  font-size: 12px;
}

.studio-task-status[data-status='running'],
.studio-task-status[data-status='submitted'],
.studio-task-status[data-status='downloading'] {
  color: var(--accent);
}

.studio-task-status[data-status='ready'] {
  color: var(--good);
}

.studio-task-status[data-status='unknown'],
.studio-task-status[data-status='waiting'] {
  color: var(--warn);
}

.studio-task-status[data-status='failed'] {
  color: var(--bad);
}
</style>
