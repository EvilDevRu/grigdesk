<template>
  <section v-if="detail && version" class="studio-model-page" :class="{ 'is-inspector': section === 'details' }">
    <template v-if="section === 'viewer'">
      <header class="studio-model-heading">
        <div class="studio-model-title">
          <span class="studio-model-breadcrumb">Модели / {{ version.label }}</span>
          <h2>{{ detail.model.name }}</h2>
        </div>
        <div class="studio-model-version">
          <span>v{{ String(version.seq).padStart(2, '0') }}</span>
          <span class="studio-model-status" :data-status="version.status">{{ statusLabels[version.status] }}</span>
        </div>
        <div v-if="version.status === 'ready' && mainFile" class="studio-model-shortcuts"
          :class="{ 'is-forced': showSaveShortcut }">
          <UiButton tone="accent" variant="solid" @click="$emit('save')">Сохранить в проект</UiButton>
        </div>
      </header>
      <UiInlineMessage v-for="name in detail.incoming" :key="name">
        Агент положил {{ name }} — добавить версией?
        <UiButton variant="ghost" :disabled="busy" @click="addIncoming(name)">Добавить версией</UiButton>
      </UiInlineMessage>
      <template v-if="ACTIVE_STATUSES.includes(version.status) && version.status !== 'unknown'">
        <UiProgress :value="version.progress" :label="`Прогресс ${version.label}`" />
        <p>{{ statusLabels[version.status] }} · {{ eta }} {{ version.waitReason }}</p>
        <p class="studio-model-hint">Можно продолжать работу в других вкладках. Результат останется в библиотеке.</p>
        <UiButton v-if="version.waitReason === MISSING_TASK_WAIT_REASON" @click="$emit('tasks')">
          Разобрать заказ</UiButton>
      </template>
      <UiInlineMessage v-else-if="version.status === 'unknown'" tone="warning">
        Исход отправки неизвестен. Повторная оплата заблокирована.
        <UiButton @click="$emit('tasks')">Разобрать заказ</UiButton>
      </UiInlineMessage>
      <template v-else-if="version.status === 'failed' || version.status === 'unresolved'">
        <UiInlineMessage tone="danger">{{ version.error?.message || statusLabels[version.status] }} ·
          {{ paymentText(version.cost) }}</UiInlineMessage>
        <UiButton v-if="version.task && version.status !== 'unresolved'" :disabled="busy"
          @click="act(() => store.redownload(detail!.model.id, version!.id))">Скачать снова</UiButton>
        <UiButton v-if="version.retryAvailable && !retryQuote" :disabled="busy"
          @click="quoteRetry">Узнать цену повторного заказа</UiButton>
        <PriceButton v-if="retryQuote" :quote="retryQuote" :validation="retryValidation"
          :balance="balance" :billing-url="provider?.billingUrl" verb="Повторить заказ"
          :fingerprint="`${detail.libraryId}:${version.id}:retry`" :execute="retry"
          @price-changed="retryQuote = $event" />
        <p v-if="version.retryReason">{{ version.retryReason }}</p>
      </template>
      <div v-else-if="version.kind === 'image' || version.kind === 'views'" class="studio-gallery">
        <figure v-for="file in imageFiles" :key="file.id"><img :src="file.url" :alt="valueLabels[file.role]" />
          <figcaption>{{ valueLabels[file.role] || 'Картинка' }}</figcaption></figure>
      </div>
      <template v-else-if="mainFile">
        <slot v-if="active" name="viewer" :src="mainFile.url" :ext="extension" :model-name="detail.model.name"
          :compare-src="compareFile?.url" :compare-ext="compareFile?.name.split('.').at(-1)"
          :auto-snapshot="!version.preview" :snapshot="snapshotHandler">
          <ModelViewer :key="`${detail.libraryId}:${version.id}`" :src="mainFile.url" :ext="extension"
            :name="detail.model.name" :compare-src="compareFile?.url"
            :compare-ext="compareFile?.name.split('.').at(-1)" :auto-snapshot="!version.preview"
            @snapshot="snapshotHandler" />
        </slot>
      </template>
      <p v-else>Локальный файл отсутствует. <UiButton v-if="version.task" :disabled="busy"
        @click="act(() => store.redownload(detail!.model.id, version!.id))">Скачать снова</UiButton></p>
      <UiInlineMessage v-if="version.stats && version.stats.triangles > 100000" tone="warning">
        Для игры много — {{ version.stats.triangles.toLocaleString('ru-RU') }} треугольников.
      </UiInlineMessage>
    </template>
    <template v-else>
      <section class="studio-model-result">
        <h3>{{ resultHeading }}</h3>
        <p v-if="isImage || version.status !== 'ready' || !mainFile" class="studio-model-hint">{{ resultHint }}</p>
        <dl class="studio-model-properties">
          <div><dt>Версия</dt><dd>v{{ String(version.seq).padStart(2, '0') }} · {{ version.label }}</dd></div>
          <div v-if="mainFile"><dt>Формат</dt><dd>{{ extension.toUpperCase() }}</dd></div>
          <div><dt>Расходы</dt><dd>{{ paymentText(version.cost) }}</dd></div>
        </dl>
        <template v-if="version.status === 'ready' && mainFile">
          <UiButton :tone="isImage ? 'neutral' : 'accent'" variant="solid" :disabled="busy" @click="openSave">
            <template #leading>
              <svg class="studio-save-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" />
              </svg>
            </template>
            Сохранить в проект
          </UiButton>
          <span class="studio-save-hint">Копирование в проект бесплатно</span>
        </template>
        <UiButton v-else-if="ACTIVE_STATUSES.includes(version.status) || version.status === 'unresolved'"
          @click="$emit('tasks')">{{ version.status === 'unknown' || version.status === 'unresolved'
            ? 'Разобрать заказ' : 'Открыть очередь' }}</UiButton>
        <UiInlineMessage v-if="savedPath">Сохранено: {{ savedPath }}</UiInlineMessage>
      </section>
      <NextSteps v-if="version.status === 'ready'" :model-id="detail.model.id" :version-id="version.id"
        :open-operation="nextOperation" :heading="isImage ? 'Создать 3D-модель' : 'Доработать модель'"
        @created="(model, vid) => $emit('created', model, vid)" />
      <UiButton variant="ghost" :disabled="!mainFile || busy" @click="askAgent">Спросить агента</UiButton>
      <div class="studio-model-section">
        <UiDisclosureButton v-model:open="compareOpen" :controls="`${sectionId}-compare`"
          data-context="studio-inspector-section">
          Сравнение и основная версия
        </UiDisclosureButton>
        <div v-show="compareOpen" :id="`${sectionId}-compare`" class="studio-model-fields">
          <UiField label="Сравнить с версией"><UiSelect v-model="compareId">
            <option value="">Без сравнения</option><option v-for="item in compareVersions" :key="item.id"
              :value="item.id">{{ item.label }}</option>
          </UiSelect></UiField>
          <UiButton :disabled="!compareId && !compareVersionId"
            @click="$emit('compare', compareVersionId ? '' : compareId)">
            {{ compareVersionId ? 'Убрать сравнение' : 'Сравнить' }}</UiButton>
          <UiButton :disabled="busy || detail.model.mainVersion === version.id"
            @click="act(() => store.patchModel(detail!.model.id, { mainVersion: version!.id }))">
            Сделать основной
          </UiButton>
        </div>
      </div>
      <div class="studio-model-section">
        <UiDisclosureButton v-model:open="infoOpen" :controls="`${sectionId}-info`"
          data-context="studio-inspector-section">
          Параметры и расходы
        </UiDisclosureButton>
        <div v-show="infoOpen" :id="`${sectionId}-info`" class="studio-model-fields">
          <p>{{ providerLabel(version.provider, store.state?.providers) }} ·
            {{ version.task ? taskTypeLabel(version.task.type) : 'без облачного заказа' }}</p>
          <p>{{ paymentText(version.cost) }}</p>
          <p>{{ statsText(version.stats) }}</p>
          <ul v-if="Object.keys(version.params).length" class="studio-version-params">
            <li v-for="(param, index) in parameterRows(version.params)" :key="index">
              {{ param.name }}: {{ param.value }}</li>
          </ul>
          <p v-for="saved in version.savedTo" :key="saved.path">Сохранена: {{ saved.path }}</p>
        </div>
      </div>
      <div class="studio-model-section">
        <UiDisclosureButton v-model:open="manageOpen" :controls="`${sectionId}-manage`"
          data-context="studio-inspector-section">
          Управление моделью и файлами
        </UiDisclosureButton>
        <div v-show="manageOpen" :id="`${sectionId}-manage`" class="studio-model-fields">
          <UiButton :disabled="busy" @click="editOpen = true">Переименовать</UiButton>
          <UiButton v-if="canCancelWaiting" :disabled="busy" @click="cancelWaiting">Отменить</UiButton>
          <UiButton v-if="version.task" :disabled="busy"
            @click="act(() => store.redownload(detail!.model.id, version!.id))">Скачать снова</UiButton>
          <UiButton :disabled="busy || !version.files.length" @click="lighten">Облегчить</UiButton>
          <p class="studio-model-hint">«Облегчить» удаляет локальные файлы версии, сохраняя историю.</p>
          <UiButton tone="danger" variant="ghost" :disabled="busy" @click="remove">Удалить версию</UiButton>
          <UiButton tone="danger" variant="ghost" :disabled="busy" @click="removeModel">Удалить модель</UiButton>
        </div>
      </div>
      <ModelEditDialog :open="editOpen" :model="detail.model" @close="editOpen = false" />
      <SaveDialog :open="saveOpen" :model="detail.model" :version="version" :folders="detail.saveFolders"
        @close="saveOpen = false" @saved="savedPath = $event" @export="openExport" />
    </template>
    <UiInlineMessage v-if="version.rigCheck" data-context="studio-rig-check"
      :tone="version.rigCheck.status === 'failed' ? 'danger' : 'neutral'">
      {{ rigCheckText(version.rigCheck) }}</UiInlineMessage>
    <UiInlineMessage v-if="error" tone="danger">{{ error }}</UiInlineMessage>
  </section>
  <p v-else>Выберите версию модели.</p>
</template>

<script setup lang="ts">
import { computed, ref, watch, onUnmounted, useId } from 'vue';
import { useRouter } from 'vue-router';
import { UiButton, UiField, UiSelect, UiInlineMessage, UiProgress, UiDisclosureButton,
  confirmDialog } from '../../ui.ts';
import { useStudio3dStore } from '../../stores/studio3d.ts';
import { useChatStore } from '../../stores/chat.js';
import { ACTIVE_STATUSES } from '../../../../shared/studio3d/studio3dContracts.ts';
import type { Studio3dQuote, Studio3dValidation } from '../../../../shared/studio3d/studio3dContracts.ts';
import { formatPrice, MISSING_TASK_WAIT_REASON } from '../../../../shared/studio3d/studio3dOperations.ts';
import { studio3dApi } from '../../features/studio3d/studio3dApi.ts';
import {
  paymentText,
  rigCheckText,
  statsText,
  statusLabels,
  studioErrorMessage,
  parameterRows,
  providerLabel,
  taskTypeLabel,
  valueLabels
} from '../../features/studio3d/presentation.ts';
import { askStudioAgent } from '../../features/studio3d/askAgent.ts';
import NextSteps from './NextSteps.vue';
import SaveDialog from './SaveDialog.vue';
import ModelEditDialog from './ModelEditDialog.vue';
import PriceButton from './PriceButton.vue';
import ModelViewer from '../../shared/viewer3d/ModelViewer.vue';

const props = withDefaults(defineProps<{
  section?: 'viewer' | 'details';
  compareVersionId?: string;
  showSaveShortcut?: boolean;
  active?: boolean
}>(), {
  section: 'viewer',
  compareVersionId: '',
  showSaveShortcut: false,
  active: true
});
const emit = defineEmits<{
  created: [modelId: string, versionId?: string];
  tasks: [];
  save: [];
  compare: [versionId: string]
}>();
const store = useStudio3dStore();
const chat = useChatStore();
const router = useRouter();
const error = ref('');
const busy = ref(false);
const saveOpen = ref(false);
const editOpen = ref(false);
const exportStep = ref('');
const compareId = ref('');
const compareOpen = ref(false);
const infoOpen = ref(false);
const manageOpen = ref(false);
const savedPath = ref('');
const sectionId = `studio-model-${useId()}`;
const retryQuote = ref<Studio3dQuote | null>(null);
const retryValidation = ref<Studio3dValidation | null>(null);
let alive = true;

const detail = computed(() => store.detail);
const version = computed(() => detail.value?.versions.find((item) => item.id === store.selectedVersion));
const mainFile = computed(() => version.value?.files.find((item) => item.id === version.value?.mainFileId));
const extension = computed(() => mainFile.value?.name.split('.').at(-1) || 'glb');
const isImage = computed(() => ['image', 'views'].includes(version.value?.kind ?? ''));
const nextOperation = computed(() => exportStep.value || (version.value?.kind === 'image' ? 'image-to-model'
  : version.value?.kind === 'views' ? 'views-to-model' : ''));
const resultHeading = computed(() => {
  if (version.value?.status === 'ready') {
    return isImage.value ? 'Исходник готов'
      : mainFile.value ? 'Готово к использованию' : 'Файлы не загружены';
  }

  return version.value && ACTIVE_STATUSES.includes(version.value.status) && version.value.status !== 'unknown'
    ? 'Работа продолжается' : 'Заказ требует внимания';
});
const resultHint = computed(() => {
  if (version.value?.status !== 'ready') {
    return 'Статус и расходы доступны в «Задачах». Переключение вкладок не прерывает работу.';
  }
  if (isImage.value) {
    return 'Проверьте изображение. Следующим шагом можно создать по нему объёмную модель.';
  }

  return mainFile.value ? 'Сохраните эту версию в проект или доработайте её отдельным шагом.'
    : 'История сохранена. Попробуйте «Скачать снова» в управлении файлами, '
      + 'если у версии есть облачный заказ.';
});
const imageFiles = computed(() => version.value?.files
  .filter((item) => /\.(png|jpe?g|webp)$/i.test(item.name)) || []);
const compareVersions = computed(() => detail.value?.versions.filter((item) => item.id !== version.value?.id
  && item.mainFileId && !['image', 'views'].includes(item.kind)) || []);
const compareFile = computed(() => {
  const other = compareVersions.value.find((item) => item.id === props.compareVersionId);
  
  return other?.files.find((item) => item.id === other.mainFileId);
});
const provider = computed(() => store.state?.providers.find((item) => item.id === version.value?.provider));
const balance = computed(() => provider.value?.balance?.available ?? null);
const canCancelWaiting = computed(() => version.value?.status === 'waiting'
  && Boolean(version.value.intentId) && Boolean(version.value.childId));
const marker = computed(() => `${store.libraryId}:${detail.value?.model.id}:${version.value?.id}`);
const eta = computed(() => version.value?.etaSeconds === null ? ''
  : `≈ ${Math.max(1, Math.ceil((version.value?.etaSeconds || 0) / 60))} мин`);

watch(marker, () => {
  editOpen.value = false;
  saveOpen.value = false;
  savedPath.value = '';
  exportStep.value = '';
  error.value = '';
  retryQuote.value = null;
  retryValidation.value = null;
  compareId.value = '';
});
watch(() => props.compareVersionId, (id) => {
  if (id) {
    compareOpen.value = true;
  }
});
onUnmounted(() => {
  alive = false;
});

/**
 * Переход из сохранения раскрывает экспорт без запуска платного действия.
 * Сброс между открытиями позволяет снова выбрать экспорт после другого шага.
 */
function openExport(): void {
  saveOpen.value = false;
  exportStep.value = 'export';
}

/**
 * Новое открытие сохранения разрешает повторный переход к экспорту из того же диалога.
 * Файл копируется только после выбора проекта и явного нажатия в SaveDialog.
 */
function openSave(): void {
  exportStep.value = '';
  saveOpen.value = true;
}

defineExpose({ openSave });

/**
 * Действие фиксирует selection, чтобы поздний отказ не появлялся у новой версии.
 * HAS_CHILDREN объясняет порядок удаления, а остальные ошибки сохраняют серверный текст.
 */
async function act(work: () => Promise<unknown>): Promise<void> {
  if (busy.value) {
    return;
  }
  
  const current = marker.value;
  
  busy.value = true;
  error.value = '';
  
  try {
    await work();
  }
  catch (cause) {
    if (alive && marker.value === current) {
      error.value = (cause as { code?: string }).code === 'has_children'
      ? 'Сначала удалите версии, сделанные из этой.' : studioErrorMessage(cause);
    }
  } finally { if (alive) {
    busy.value = false;
  } }
}

/**
 * Удаление всей модели требует отдельного подтверждения с её названием.
 * Ответ диалога применяется только к прежней библиотеке и выбранной модели.
 */
async function removeModel(): Promise<void> {
  const model = detail.value?.model;
  const current = marker.value;

  if (!model) {
    return;
  }

  await act(async () => {
    const confirmed = await confirmDialog(`Удалить модель «${model.name}» и все её версии?`);

    if (confirmed && alive && current === marker.value) {
      await store.deleteModel(model.id);
    }
  });
}

/**
 * Файл incoming добавляется независимой версией текущей модели после обычной проверки сервера.
 * Имя никогда не превращается в произвольный абсолютный путь из текста агента.
 */
async function addIncoming(name: string): Promise<void> {
  const model = detail.value?.model.id;
  const parentVersionId = version.value?.id;
  
  if (model) {
    await act(() => store.addFromFile(model, { incoming: name, parentVersionId }));
  }
}

/**
 * Удаление показывает точную выбранную версию и не расширяет действие на всё дерево.
 * Смена selection за время вопроса отзывает подтверждение прежнего снимка.
 */
async function remove(): Promise<void> {
  const model = detail.value?.model.id;
  const item = version.value;
  const current = marker.value;
  
  if (!model || !item || !await confirmDialog(`Удалить версию «${item.label}»?`)) {
    return;
  }
  if (alive && marker.value === current) {
    await act(() => store.deleteVersion(model, item.id));
  }
}

/**
 * Облегчение основной версии требует отдельного явного согласия force.
 * Manifest и история оплаты остаются серверными, интерфейс показывает только освобождённый размер.
 */
async function lighten(): Promise<void> {
  const entry = detail.value;
  const item = version.value;
  const current = marker.value;
  
  if (!entry || !item) {
    return;
  }
  
  const force = entry.model.mainVersion === item.id;
  
  if (!await confirmDialog(`Облегчить ${force ? 'основную ' : ''}версию «${item.label}»? `
    + 'Локальные файлы будут удалены, история сохранится.')) {
      return;
    }
  if (alive && marker.value === current) {
    await act(() => store.lighten(entry.model.id, item.id, force));
  }
}

/**
 * Ждущая денег версия отменяется до отправки: сервер не делает POST и
 * закрывает позицию без оплаты. Подтверждение защищает от случайного клика.
 */
async function cancelWaiting(): Promise<void> {
  const item = version.value;
  const current = marker.value;

  if (!item?.intentId || !item.childId) {
    return;
  }

  const intentId = item.intentId;
  const childId = item.childId;

  if (!await confirmDialog(`Отменить заказ «${item.label}»? Он ещё не отправлен, оплаты не было.`)) {
    return;
  }
  if (alive && marker.value === current) {
    await act(() => store.closeUnknownChild(intentId, childId));
  }
}

/**
 * Проверка папки происходит до создания разговора и не запускает модель сама.
 * После ухода или смены библиотеки отложенный preview не создаёт чат для старого selection.
 */
async function askAgent(): Promise<void> {
  const entry = detail.value;
  const item = version.value;
  const current = marker.value;
  
  if (!entry || !item) {
    return;
  }
  
  await act(() => askStudioAgent(entry, item, chat, router, async (body) => {
    const { api } = await import('../../shared/apiClient.ts');
    const result = await api.post('/api/chat/workdir/preview', body);
    
    if (!alive || current !== marker.value) {
      throw new Error('Выбор модели изменился.');
    }
    
    return result;
  }));
}

/**
 * Повтор получает свежую цену без создания заказа и требует отдельного нажатия PriceButton.
 * Retry availability и стоимость снова проверяются сервером непосредственно перед POST поставщику.
 */
async function quoteRetry(): Promise<void> {
  const item = version.value;
  const entry = detail.value;
  const current = marker.value;
  
  if (!item?.provider || !item.operation || !entry) {
    return;
  }
  
  await act(async () => {
    const result = await studio3dApi.quote({
      libraryId: store.libraryId,
      modelId: entry.model.id,
      versionId: item.id,
      provider: item.provider,
      operation: item.operation,
      values: item.params
    });
    
    if (alive && marker.value === current) {
      retryQuote.value = result.quote;
      retryValidation.value = result.validation;
    }
  });
}

/**
 * Повтор использует durable UUID кнопки и существующий серверный исходный snapshot.
 * Unknown и unresolved не имеют этой кнопки и не превращаются в новую оплату.
 */
async function retry(key: string): Promise<unknown> {
  if (!version.value || !detail.value || retryQuote.value?.total === null || !retryQuote.value) {
    return { cancelled: true };
  }
  
  return store.retry(detail.value.model.id, version.value.id, retryQuote.value.total, key);
}

/**
 * Автоматический кадр принадлежит той версии, которая была открыта во время события.
 * Двоичный endpoint проверяет image/WebP, размер и libraryId заново.
 */
const snapshotHandler = computed(() => {
  const item = version.value;
  const entry = detail.value;
  const current = marker.value;

  return async (blob: Blob): Promise<void> => {
    if (!item || !entry || !alive || current !== marker.value) {
      return;
    }
    
    await act(async () => {
      await studio3dApi.preview(entry.model.id, item.id, entry.libraryId, blob);
      
      if (alive && current === marker.value) {
        await store.openModel(entry.model.id, item.id);
      }
    });
  };
});
</script>

<style scoped>
.studio-model-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-height: 0;
  min-width: 0;
  overflow-wrap: anywhere;
}

.studio-model-page:not(.is-inspector) {
  height: 100%;
  --studio-viewer-min-height: 200px;
  --studio-canvas-min-height: 140px;
  --studio-canvas-height: auto;
  --studio-canvas-flex: 1;
}

.studio-model-page > :deep(.studio-viewer) { flex: 1; }
.studio-model-page > :not(.studio-viewer) { flex: none; }

.studio-model-page h2,
.studio-model-page h3,
.studio-model-page p {
  margin: 0;
}

.studio-model-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px 16px;
}

.studio-model-title {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  flex: 1;
}

.studio-model-version {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--ink-mid);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.studio-model-status {
  padding: 3px 7px;
  border: 1px solid var(--line);
  border-radius: 4px;
}

.studio-model-status[data-status='ready'] {
  color: var(--good);
  border-color: color-mix(in srgb, var(--good) 25%, var(--line));
  background: color-mix(in srgb, var(--good) 6%, transparent);
}

.studio-model-status[data-status='unknown'],
.studio-model-status[data-status='unresolved'],
.studio-model-status[data-status='failed'] {
  color: var(--warn);
}

.studio-model-shortcuts {
  display: none;
}

.studio-model-shortcuts.is-forced {
  display: flex;
}

.studio-model-heading h2 {
  font-size: 18px;
  font-weight: 600;
}

.studio-model-breadcrumb,
.studio-model-hint {
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 1.6;
}

.studio-model-result,
.studio-model-fields {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.studio-model-result {
  padding-bottom: 16px;
  border-bottom: 1px solid var(--line);
}

.studio-model-result h3 {
  font-size: 13px;
  font-weight: 600;
}

.studio-model-properties {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0 0 4px;
  font-size: 12px;
  line-height: 1.5;
}

.studio-model-properties > div {
  display: grid;
  grid-template-columns: 60px minmax(0, 1fr);
  gap: 12px;
}

.studio-model-properties dt {
  color: var(--ink-mid);
}

.studio-model-properties dd {
  margin: 0;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.studio-save-icon {
  width: 16px;
  height: 16px;
}

.studio-save-hint {
  color: var(--ink-mid);
  font-size: 11px;
  text-align: center;
}

.studio-model-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--line);
}

.studio-model-fields {
  font-size: 13px;
  line-height: 1.6;
}

.studio-model-page.is-inspector {
  gap: 12px;
}

.studio-version-params {
  margin: 0;
  padding-left: 18px;
}

.studio-gallery {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 160px), 1fr));
  gap: 8px;
}

.studio-gallery figure {
  margin: 0;
}

.studio-gallery img {
  max-width: 100%;
}

@container studio (max-width: 1099px) {
  .studio-model-shortcuts {
    display: flex;
  }
}

@media (max-height: 500px) {
  .studio-model-page { gap: 8px; }
  .studio-model-page:not(.is-inspector) {
    --studio-viewer-min-height: 120px;
    --studio-canvas-min-height: 60px;
  }
  .studio-model-breadcrumb { display: none; }
  .studio-model-heading { gap: 8px; }
  .studio-model-heading h2 { font-size: 16px; }
}
</style>
