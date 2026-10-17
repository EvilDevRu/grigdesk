<template>
  <div class="studio-unknown-order">
    <UiButton v-if="!opened" variant="ghost" @click="open">Разобрать заказ</UiButton>
    <template v-else>
      <p>Заказ мог быть принят и оплачен. Связывание номера заказа только проверяет и продолжает этот заказ.</p>
      <UiField v-if="child?.candidates.length" label="Возможный заказ">
        <UiSelect v-model="taskId" data-context="studio-candidate" :disabled="busy">
          <option value="">Выберите после проверки</option>
          <option v-for="item in child.candidates" :key="item.taskId" :value="item.taskId">
            {{ taskTypeLabel(item.type) }} · {{ item.createdAt || 'дата неизвестна' }}
          </option>
        </UiSelect>
      </UiField>
      <UiField label="Номер заказа" hint="Можно указать вручную; сервер проверит аккаунт и тип заказа">
        <UiInput v-model="taskId" :maxlength="200" :disabled="busy" />
      </UiField>
      <UiButton :disabled="!child || !taskId.trim() || busy" @click="reconcile">Связать заказ</UiButton>
      <UiButton v-if="row.status === 'unknown' || row.waitReason === MISSING_TASK_WAIT_REASON"
        variant="ghost" :disabled="busy || !child"
        @click="closeUnknown">Оставить неразобранным</UiButton>
      <UiInlineMessage v-if="error" tone="danger">{{ error }}</UiInlineMessage>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, onUnmounted } from 'vue';
import { UiButton, UiField, UiSelect, UiInput, UiInlineMessage, confirmDialog } from '../../ui.ts';
import type { Studio3dTaskRow, Studio3dJob } from '../../../../shared/studio3d/studio3dContracts.ts';
import { MISSING_TASK_WAIT_REASON } from '../../../../shared/studio3d/studio3dOperations.ts';
import { useStudio3dStore } from '../../stores/studio3d.ts';
import {
  studioErrorMessage,
  taskTypeLabel
} from '../../features/studio3d/presentation.ts';

const props = defineProps<{ row: Studio3dTaskRow }>();
const store = useStudio3dStore();
const opened = ref(false);
const busy = ref(false);
const taskId = ref('');
const error = ref('');
const job = ref<Studio3dJob | null>(null);
let generation = 0;
let alive = true;

const marker = computed(() => `${store.libraryId}:${props.row.intentId}:${props.row.childId}`);
const child = computed(() => job.value?.children.find((item) => item.childId === props.row.childId));

watch(marker, () => {
  generation += 1;
  opened.value = false;
  busy.value = false;
  taskId.value = '';
  job.value = null;
  error.value = '';
});
onUnmounted(() => {
  alive = false;
  generation += 1;
});

/**
 * Кандидаты принадлежат точному childId, включая проверку без versionId.
 * Поздний job другой библиотеки не даёт разрешения на связывание текущего заказа.
 */
async function open(): Promise<void> {
  const current = ++generation;
  const libraryId = store.libraryId;
  
  opened.value = true;
  busy.value = true;
  error.value = '';
  
  try {
    const result = await store.loadJob(props.row.intentId);
    
    if (alive && current === generation && libraryId === store.libraryId && result.libraryId === libraryId) {
      job.value = result;
    }
  } catch (cause) {
    if (alive && current === generation) {
      error.value = studioErrorMessage(cause);
    }
  } finally {
    if (alive && current === generation) {
      busy.value = false;
    }
  }
}

/**
 * Разбор и close захватывают адрес intent/child и повторяют marker после вопроса.
 * Local busy исключает два одновременных решения, а сервер сохраняет сам переход durable.
 */
async function decide(close: boolean): Promise<void> {
  if (!child.value || busy.value) {
    return;
  }
  
  const current = marker.value;
  const intent = props.row.intentId;
  const childId = props.row.childId;
  const task = taskId.value.trim();
  
  busy.value = true;
  error.value = '';
  
  try {
    const question = close
      ? 'Оставить заказ неразобранным? Это освобождает локальный резерв, но не отменяет заказ '
        + 'у поставщика и не подтверждает возврат. Списание останется неизвестным.'
      : `Связать выбранный облачный заказ с «${props.row.label}»? Новый оплачиваемый заказ не создаётся.`;
    
    if (!await confirmDialog(question) || !alive || current !== marker.value) {
      return;
    }
    if (close) {
      await store.closeUnknownChild(intent, childId);
    }
    else {
      await store.reconcileChild(intent, childId, task);
    }
    if (alive && current === marker.value) {
      opened.value = false;
    }
  } catch (cause) {
    if (alive && current === marker.value) {
      error.value = studioErrorMessage(cause);
    }
  } finally {
    if (alive && current === marker.value) {
      busy.value = false;
    }
  }
}

const reconcile = () => decide(false);
const closeUnknown = () => decide(true);
</script>

<style scoped>
.studio-unknown-order { display: flex; flex-direction: column; gap: 8px; }
</style>
