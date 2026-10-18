<template>
  <div class="studio-create-panel">
    <div class="studio-create-scroll">
      <div class="studio-create-content">
        <header class="studio-create-heading">
          <h3>Создать модель</h3>
          <p>От идеи до файла в проекте. Выберите, с чего начать.</p>
        </header>
        <UiInlineMessage v-if="error" tone="danger">{{ error }}</UiInlineMessage>
        <div class="studio-create-grid">
          <div class="studio-create-primary">
            <section class="studio-create-card">
              <h4>Источник модели</h4>
              <UiSegmentedControl v-model="mode" :options="modes" :disabled="importing" label="Источник модели"
                data-ui-studio-choice />
              <OperationForm v-if="mode !== 'file' && sourceFields.length" v-model="values"
                :fields="sourceFields" :errors="fieldErrors" />
              <p class="studio-create-hint">{{ sourceHint }}</p>
              <template v-if="mode === 'file'">
                <div class="studio-upload-area">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"
                    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M12 16V3m-5 5 5-5 5 5 M4 15v5h16v-5" />
                  </svg>
                  <strong>Добавьте готовую 3D-модель</strong>
                  <p>GLB, FBX, OBJ, STL или splat · до 150 МиБ</p>
                  <UiFilePicker accept=".glb,.fbx,.obj,.stl,.splat,.gltf"
                    label="Выбрать модель" :busy="uploading || importing" :show-summary="false"
                    :show-reset="false" @change="chooseOwnFile($event[0])" />
                  <span v-if="ownUpload" class="studio-upload-ready">{{ ownName }} · готов к добавлению</span>
                  <UiButton v-if="ownUpload" variant="ghost" :disabled="importing" @click="clearOwn">
                    Убрать файл
                  </UiButton>
                </div>
                <p class="studio-create-hint">Для .gltf сохраните самостоятельный .glb без внешних ресурсов.</p>
              </template>
              <template v-else>
                <div v-if="mode === 'text'" class="studio-create-options">
                  <UiSwitch v-model="firstImage">Сначала эскиз</UiSwitch>
                  <UiSwitch v-model="batch" data-context="studio-batch-toggle">
                    {{ firstImage ? 'Несколько эскизов' : 'Несколько моделей' }}
                  </UiSwitch>
                </div>
                <p v-if="mode === 'text' && firstImage" class="studio-create-hint">
                  Сейчас создаётся только картинка. Проверьте её и запустите модель отдельным шагом.
                </p>
                <template v-if="mode === 'image'">
                  <div class="studio-upload-area">
                    <img v-if="primaryPreview" :src="primaryPreview" :alt="primaryName"
                      class="studio-source-preview" />
                    <strong>Изображение будущей модели</strong>
                    <p>PNG, JPEG или WebP · до 20 МиБ</p>
                    <div class="studio-upload-actions">
                      <UiFilePicker accept=".png,.jpg,.jpeg,.webp" :busy="uploading"
                        :show-summary="false" :show-reset="false"
                        :label="primaryUpload ? 'Заменить картинку' : 'Выбрать картинку'"
                        @change="choosePrimary($event[0])" />
                      <UiButton v-if="primaryUpload" variant="ghost" @click="clearPrimary">Убрать</UiButton>
                    </div>
                    <span v-if="primaryUpload" class="studio-upload-ready">{{ primaryName }}</span>
                  </div>
                  <UiField label="Результат картинки">
                    <UiSelect v-model="imageOperation" aria-label="Результат картинки">
                      <option value="image-to-model">Модель</option>
                      <option value="image-to-splat">Сплат · объёмное фото</option>
                    </UiSelect>
                  </UiField>
                </template>
                <template v-if="mode === 'views'">
                  <p class="studio-create-hint">Загрузите вид спереди и ещё 1–3 ракурса того же объекта.</p>
                  <ViewSlots v-model="viewFiles" />
                  <UiFilePicker accept=".png,.jpg,.jpeg,.webp" label="Разрезать лист видов"
                    @change="sheetFile = $event[0] ?? null" />
                  <SheetCutter :open="Boolean(sheetFile)" :file="sheetFile" @close="sheetFile = null"
                    @confirm="viewFiles = { ...viewFiles, ...$event }" />
                </template>
                <p v-if="batch && mode === 'text'" class="studio-create-hint">
                  Одно описание на строку · до 50 {{ firstImage ? 'эскизов' : 'моделей' }}.
                  Перед запуском появится общая стоимость пачки.
                </p>
              </template>
            </section>
            <section v-if="mode !== 'file' && offer" class="studio-create-card">
              <div class="studio-card-heading">
                <h4>Параметры генерации</h4>
                <span>{{ offer.providerName }}</span>
              </div>
              <UiField v-if="providers.length > 1" label="Исполнитель">
                <UiSelect v-model="providerId">
                  <option v-for="item in providers" :key="item.provider" :value="item.provider">
                    {{ item.providerName }} — {{ formatPrice(item.quote.total, item.quote.unit) }}
                  </option>
                </UiSelect>
              </UiField>
              <UiField v-if="presetOptions.length" label="Готовые наборы">
                <UiSegmentedControl :model-value="selectedPreset" :options="presetOptions"
                  label="Готовые наборы" data-ui-studio-choice @update:model-value="choosePreset" />
              </UiField>
              <p v-if="presetHint" class="studio-create-hint">{{ presetHint }}</p>
              <OperationForm v-model="values" :fields="parameterFields"
                :errors="fieldErrors" />
            </section>
          </div>
          <aside class="studio-create-meta">
            <section class="studio-create-card">
              <h4>В библиотеке</h4>
              <UiField label="Имя" hint="Необязательно. Можно переименовать позже.">
                <UiInput v-model="name" :disabled="importing" maxlength="200"
                  placeholder="Например, настольная лампа" />
              </UiField>
              <UiField label="Проект" hint="Для группировки. Папку сохранения выберете после генерации.">
                <UiSelect v-model="project" :disabled="importing">
                  <option value="">Без проекта</option>
                  <option v-for="item in projects" :key="item.id" :value="item.id">{{ item.title }}</option>
                </UiSelect>
              </UiField>
              <UiField label="Категория">
                <UiSelect v-model="category" :disabled="importing">
                  <option value="">Не выбрана</option>
                  <option v-for="item in MODEL_CATEGORIES" :key="item.id" :value="item.id">{{ item.label }}</option>
                </UiSelect>
              </UiField>
            </section>
            <details class="studio-create-card studio-result-plan">
              <summary>{{ mode === 'file' ? 'После добавления' : 'Что получится' }}</summary>
              <strong>{{ resultLabel }}</strong>
              <ol class="studio-result-steps">
                <li>{{ mode === 'file' ? 'Откройте файл в просмотрщике' : 'Дождитесь результата во вкладке «Задачи»' }}</li>
                <li>{{ firstImage && mode === 'text' ? 'Проверьте эскиз и создайте по нему модель'
                  : 'Оцените модель, при необходимости создайте новую версию' }}</li>
                <li>Сохраните готовый файл в проект</li>
              </ol>
              <p v-if="mode === 'text' && firstImage" class="studio-create-hint">
                В текущую стоимость входит только эскиз.
              </p>
            </details>
            <div class="studio-create-note">
              <strong>{{ mode === 'file' ? 'Бесплатный импорт' : 'Результат останется в библиотеке' }}</strong>
              <p>{{ mode === 'file' ? 'Добавьте файл, чтобы просматривать его и сохранять версии.'
                : 'Можно переключать вкладки: черновик сохранится, пока открыто это окно.' }}</p>
            </div>
          </aside>
        </div>
      </div>
    </div>
    <footer class="studio-create-footer">
      <UiInlineMessage v-if="changedPrice" tone="warning">Цена изменилась — проверьте и нажмите снова.</UiInlineMessage>
      <div v-if="mode === 'file'" class="studio-import-action">
        <span>Импорт в библиотеку · бесплатно</span>
        <UiButton tone="accent" variant="solid" :loading="importing" :disabled="!ownUpload || uploading"
          @click="importOwn">
          Добавить бесплатно
        </UiButton>
      </div>
      <PriceButton v-else :quote="displayQuote" layout="footer"
        :validation="batch && mode === 'text' ? batchValidation : quoted?.validation"
        :balance="resource?.balance?.available ?? null" :billing-url="resource?.billingUrl"
        :verb="createLabel" :fingerprint="buttonFingerprint"
        :disabled-reason="disabledReason" :busy="uploading" :execute="execute"
        @price-changed="priceChanged" @refresh="store.loadState()" />
    </footer>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, shallowRef, watch, onMounted, onUnmounted } from 'vue';
import { UiSegmentedControl, UiField, UiInput, UiSelect, UiButton, UiSwitch,
  UiFilePicker, UiInlineMessage, confirmDialog } from '../../ui.ts';
import { useStudio3dStore } from '../../stores/studio3d.ts';
import { projectsApi } from '../../shared/projectsApi.ts';
import { MODEL_CATEGORIES } from '../../../../shared/studio3d/studio3dContracts.ts';
import type { Studio3dOffer, Studio3dBatchQuote,
  Studio3dQuote } from '../../../../shared/studio3d/studio3dContracts.ts';
import type { ProjectSummary } from '../../../../shared/runtime/projectsContracts.ts';
import type { FieldValues } from '../../../../shared/studio3d/studio3dOperations.ts';
import { pluralForm, formatPrice } from '../../../../shared/studio3d/studio3dOperations.ts';
import { studioFingerprint } from '../../features/studio3d/pendingIntents.ts';
import { lines as creationLines, batchValidation as validateBatch,
  batchRows as createBatchRows } from '../../features/studio3d/creationRequest.ts';
import { useCreationForm } from '../../features/studio3d/useCreationForm.ts';
import { useCreationQuote } from '../../features/studio3d/useCreationQuote.ts';
import { useCreationInputs } from '../../features/studio3d/useCreationInputs.ts';
import OperationForm from './OperationForm.vue';
import PriceButton from './PriceButton.vue';
import ViewSlots from './ViewSlots.vue';
import SheetCutter from './SheetCutter.vue';
import { studioErrorMessage } from '../../features/studio3d/presentation.ts';

const props = withDefaults(defineProps<{ active?: boolean }>(), { active: true });
const emit = defineEmits<{ created: [modelId: string, versionId?: string]; tasks: [] }>();
const store = useStudio3dStore();
const creationOffers = shallowRef<Studio3dOffer[]>([]);
const quoted = shallowRef<Awaited<ReturnType<typeof store.quote>>>(null);
const mode = ref('text');
const modes = [{ value: 'text', label: 'Из текста' }, { value: 'image', label: 'Из картинки' },
  { value: 'views', label: 'По видам' }, { value: 'file', label: 'Свой файл' }];
const name = ref('');
const project = ref('');
const category = ref('');
const providerId = ref('');
const firstImage = ref(false);
const imageOperation = ref('image-to-model');
const batch = ref(false);
const values = ref<FieldValues>({});
const selectedPreset = ref('');
const presetHint = ref('');
const error = ref('');
const creationInputs = useCreationInputs({
  upload: (file) => store.upload(file),
  error,
  isAlive: () => alive
});
const { primaryUpload, primaryPreview, primaryName, ownUpload, ownName, viewUploads, viewFiles,
  uploading, choosePrimary, chooseOwnFile, clearPrimary, clearOwn } = creationInputs;
const sheetFile = shallowRef<File | null>(null);
const importing = ref(false);
const projects = ref<ProjectSummary[]>([]);
const changedPrice = ref(false);
const batchQuoted = shallowRef<Studio3dBatchQuote | null>(null);
let alive = true;

const operation = computed(() => mode.value === 'text' ? firstImage.value ? 'text-to-image' : 'text-to-model'
  : mode.value === 'views' ? 'views-to-model' : imageOperation.value);
const providers = computed(() => creationOffers.value.filter((item) => item.operation === operation.value));
const offer = computed(() => providers.value.find((item) => item.provider === providerId.value)
  ?? providers.value[0]);
const sourceFields = computed(() => (offer.value?.fields ?? []).filter((field) => field.id === 'prompt'));
const parameterFields = computed(() => (offer.value?.fields ?? []).filter((field) => field.id !== 'prompt'));
const presetOptions = computed(() => (offer.value?.presets ?? []).map((preset) => ({
  value: preset.id,
  label: preset.label
})));
const resource = computed(() => store.state?.providers.find((item) => item.id === offer.value?.provider));
const inputs = computed(() => mode.value === 'views' ? viewUploads.value
  : mode.value === 'image' && primaryUpload.value ? [{ role: 'primary',
    uploadId: primaryUpload.value.uploadId }] : []);
const lines = computed(() => creationLines(values.value));
const batchValidation = computed(() => validateBatch(values.value, lines.value));
const displayQuote = computed<Studio3dQuote | null>(() => batch.value && mode.value === 'text'
  ? batchQuoted.value ? {
    total: batchQuoted.value.totalEstimated,
    unit: batchQuoted.value.unit,
    lines: batchQuoted.value.snapshot.rows.map((row,
      index) => ({ label: `Строка ${index + 1}`, amount: row.expectedPrice })),
    usd: null,
    note: 'Расчёт всей сохранённой пачки.'
  } : null : quoted.value?.quote ?? null);
const fieldErrors = computed(() => (quoted.value?.validation.errors ?? []).filter((issue) =>
  issue.field !== 'prompt' || String(values.value.prompt ?? '').trim()));
const sourceHint = computed(() => ({
  text: 'Опишите один объект: форму, материал и стиль. Например: настольная лампа из матового металла.',
  image: 'Выберите картинку с хорошо различимым объектом. Перед запуском проверьте загруженное изображение.',
  views: 'Ракурсы одного объекта помогают задать форму с разных сторон.',
  file: 'Готовую модель можно бесплатно добавить, рассмотреть и сохранить в проект.'
})[mode.value]);
const outputUnit = computed(() => firstImage.value && mode.value === 'text' ? {
  one: 'эскиз',
  few: 'эскиза',
  many: 'эскизов'
} : {
  one: 'модель',
  few: 'модели',
  many: 'моделей'
});
const resultLabel = computed(() => {
  if (mode.value === 'file') {
    return 'Модель из вашего файла';
  }

  const noun = firstImage.value && mode.value === 'text' ? 'эскиз' : 'модель';

  if (batch.value && mode.value === 'text') {
    const count = `${lines.value.length} ${pluralForm(lines.value.length, outputUnit.value)}`;

    return `${count} · отдельный результат для каждой строки`;
  }
  if (noun === 'эскиз') {
    return 'Эскиз для будущей модели';
  }

  return mode.value === 'image' && imageOperation.value === 'image-to-splat'
    ? 'Сплат из изображения' : 'Одна 3D-модель';
});
const createLabel = computed(() => {
  if (batch.value && mode.value === 'text') {
    return `Создать ${lines.value.length}`;
  }

  return firstImage.value && mode.value === 'text' ? 'Создать эскиз' : 'Создать модель';
});
const disabledReason = computed(() => {
  if (!props.active) {
    return 'Вернитесь к форме для запуска.';
  }
  if (!offer.value) {
    return 'Для этого входа нет исполнителя.';
  }
  if (!offer.value.available) {
    return offer.value.reason ?? 'Исполнитель недоступен.';
  }
  if (mode.value === 'image' && !primaryUpload.value) {
    return 'Загрузите картинку.';
  }
  if (mode.value === 'views' && (!viewFiles.value.front ||
    Object.values(viewFiles.value).filter(Boolean).length < 2)) {
    return 'Нужен вид спереди и хотя бы ещё один вид.';
  }
  if (batch.value && mode.value === 'text' && (!lines.value.length || lines.value.length > 50)) {
    return 'Укажите от 1 до 50 описаний, по одному в строке.';
  }
  if (mode.value === 'text' && !String(values.value.prompt ?? '').trim()) {
    return 'Опишите объект, который хотите создать.';
  }
  
  return '';
});
const formFingerprint = computed(() => studioFingerprint({
  libraryId: store.libraryId,
  mode: mode.value,
  provider: offer.value?.provider,
  operation: operation.value,
  values: values.value,
  uploads: inputs.value,
  name: name.value,
  project: project.value,
  category: category.value,
  batch: batch.value
}));
const buttonFingerprint = computed(() => studioFingerprint({ form: formFingerprint.value,
  price: displayQuote.value }));

/**
 * Набор накладывает проверенные простые значения на форму, не исполняет текст hint.
 * Смена набора немедленно инвалидирует цену и запускает новый quote поколения формы.
 */
function applyPreset(preset: Studio3dOffer['presets'][number]): void {
  values.value = { ...values.value, ...JSON.parse(JSON.stringify(preset.values)) as FieldValues };
  selectedPreset.value = preset.id;
  presetHint.value = preset.hint ?? (preset.id === 'character'
    ? 'Обычно дальше: проверка скелета (бесплатно) → скелет 25 → движения по 10.' : '');
}

/**
 * Общий переключатель передаёт идентификатор набора из текущего предложения.
 * Сам набор применяется прежним путём, с пересчётом стоимости формы.
 */
function choosePreset(id: string | number): void {
  const preset = offer.value?.presets.find((item) => item.id === id);

  if (preset) {
    applyPreset(preset);
  }
}

/**
 * Импорт сохраняет метаданные модели и ведёт к созданной файловой версии.
 * Повтор разрешён как новое бесплатное добавление; оплаты и task ID здесь нет.
 */
async function importOwn(): Promise<void> {
  if (!ownUpload.value || uploading.value || importing.value || !props.active) {
    return;
  }

  const libraryId = store.libraryId;

  importing.value = true;
  error.value = '';
  
  try {
    const result = await store.createFromFile({
      uploadId: ownUpload.value.uploadId,
      ...(name.value.trim() && { name: name.value.trim() }),
      project: project.value || null,
      category: category.value || null
    });
    
    if (alive && props.active && libraryId === store.libraryId) {
      emit('created', result.model.id, result.version.id);
    }
  } catch (cause) {
    if (alive && libraryId === store.libraryId) {
      error.value = studioErrorMessage(cause);
    }
  } finally {
    importing.value = false;
  }
}

/**
 * Все строки quote получают общие параметры, затем сервер нормализует собственный snapshot.
 * Неизвестная цена не подставляется нулём и не разрешает запуск пачки.
 */
function batchRows() {
  return createBatchRows({
    selected: offer.value,
    values: values.value,
    name: name.value,
    project: project.value,
    category: category.value
  }, lines.value);
}

const creationQuote = useCreationQuote({
  creationOffers,
  quoted,
  batchQuoted,
  changedPrice,
  error,
  offer,
  mode,
  batch,
  values,
  inputs: () => inputs.value,
  lines: () => lines.value,
  batchRows,
  isAlive: () => alive,
  isActive: () => props.active,
  libraryId: () => store.libraryId,
  loadOffers: (input) => store.loadOffers(input),
  quote: (input) => store.quote(input),
  batchQuote: (rows) => store.batchQuote(rows)
});
const { priceChanged } = creationQuote;

const creationForm = useCreationForm({
  offer,
  disabledReason,
  displayQuote,
  batch,
  mode,
  batchQuoted,
  outputUnit,
  values,
  quoted,
  inputs,
  name,
  project,
  category,
  providerId,
  selectedPreset,
  presetHint,
  formFingerprint: () => formFingerprint.value,
  isAlive: () => alive,
  isActive: () => props.active,
  run: (input, key) => store.run(input, key),
  batchRun: (input, key) => store.batchRun(input, key),
  onTasks: () => emit('tasks'),
  onCreated: (modelId, versionId) => emit('created', modelId, versionId)
});
const { execute } = creationForm;

watch(() => `${offer.value?.provider}:${offer.value?.operation}`, creationForm.rememberDraft,
  { immediate: true });

watch(() => [props.active, store.libraryId, inputs.value], creationQuote.refreshOffers,
  { immediate: true });

watch([formFingerprint, () => props.active, offer], creationQuote.refreshQuote, { immediate: true });

watch(viewFiles, creationInputs.uploadViews);

watch(() => store.libraryId, creationInputs.resetForLibrary);
watch(mode, () => {
  error.value = '';
});
onMounted(() => {
  void projectsApi.list().then((items) => { if (alive) {
    projects.value = items.filter((item) => !item.archivedAt);
  } }).catch(() => {
    if (alive) {
      error.value = 'Не удалось получить список проектов.';
    }
  });
});
onUnmounted(() => {
  alive = false;
  creationInputs.dispose();
  creationQuote.dispose();
});
</script>

<style scoped>
.studio-create-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  container: studio-create / inline-size;
}

.studio-create-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 16px;
  scrollbar-gutter: stable;
}

.studio-create-content {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 1160px;
  margin: 0;
}

.studio-create-heading h3 {
  margin: 0 0 6px;
  font-size: 20px;
  font-weight: 600;
  letter-spacing: -.3px;
}

.studio-create-heading p,
.studio-create-note p,
.studio-upload-area p {
  margin: 0;
  color: var(--ink-mid);
  line-height: 1.6;
  font-size: 13px;
}

.studio-create-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 280px;
  align-items: start;
  gap: 16px;
}

.studio-create-primary,
.studio-create-meta {
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: 16px;
}

.studio-create-card {
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: 14px;
  padding: 16px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
}

.studio-create-card h4 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 13px;
  font-weight: 600;
}

.studio-section-number {
  display: inline-grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border: 1px solid var(--line-2);
  border-radius: 5px;
  color: var(--ink-mid);
  font-size: 10px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}

.studio-card-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
}

.studio-card-heading > span {
  color: var(--ink-mid);
  font-size: 12px;
}

.studio-create-options {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 24px;
}

.studio-create-hint {
  margin: 0;
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 1.6;
}

.studio-create-note {
  padding: 0 4px;
}

.studio-create-note strong {
  display: block;
  margin-bottom: 6px;
  color: var(--ink-mid);
  font-size: 12px;
  font-weight: 600;
}

.studio-create-note p {
  font-size: 12px;
}

.studio-upload-area {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 28px 16px;
  border: 1px dashed var(--line-2);
  border-radius: var(--radius);
  background: var(--ground);
  text-align: center;
}

.studio-upload-area svg {
  width: 28px;
  height: 28px;
  color: var(--accent);
}

.studio-upload-ready {
  overflow-wrap: anywhere;
  color: var(--good);
  font-size: 12px;
}

.studio-upload-actions {
  display: flex;
  justify-content: center;
  flex-wrap: wrap;
  gap: 8px;
}

.studio-source-preview {
  width: 100%;
  max-height: 200px;
  object-fit: contain;
  border-radius: 6px;
}

.studio-result-plan {
  border-top: 2px solid color-mix(in srgb, var(--accent) 65%, var(--line));
}

.studio-result-plan > strong {
  font-size: 16px;
  line-height: 1.5;
}

.studio-result-steps {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding-left: 20px;
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 1.6;
}

.studio-result-steps li::marker {
  color: var(--accent);
  font-weight: 600;
}

.studio-create-footer {
  display: flex;
  flex: none;
  flex-direction: column;
  gap: 8px;
  padding: 12px 20px;
  border-top: 1px solid var(--line);
  background: var(--sidebar);
}

.studio-import-action {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
}

.studio-import-action > span {
  color: var(--ink-mid);
  font-size: 12px;
}

@container studio-create (max-width: 859px) {
  .studio-create-grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .studio-create-note {
    display: none;
  }
}

@container studio-create (max-width: 559px) {
  .studio-create-scroll {
    padding: 12px 16px;
  }

  .studio-create-card {
    padding: 16px;
  }

  .studio-create-footer {
    padding: 8px 16px;
  }
}
@media (max-height: 500px) {
  .studio-create-scroll { padding: 8px 16px; }
  .studio-create-heading { display: none; }
  .studio-create-primary > .studio-create-card:first-child > h4 { display: none; }
  .studio-create-card { padding: 8px; gap: 8px; }
  .studio-create-footer { padding: 8px 16px; }
}
</style>
