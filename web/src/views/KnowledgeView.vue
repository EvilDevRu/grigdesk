<template>
  <main class="knowledge-view">
    <header class="knowledge-view__header">
      <div>
        <h1>Знания</h1>
        <p>Проверенные факты для адресного поиска и чтения агентами.</p>
      </div>
      <div class="knowledge-view__actions">
        <UiButton :disabled="Boolean(draft) || transferBusy" @click="exportKnowledge">
          Экспортировать
        </UiButton>
        <UiFilePicker
          accept="application/json,.json"
          :disabled="Boolean(draft) || transferBusy"
          :busy="transferBusy"
          :show-summary="false"
          :show-reset="false"
          @change="previewImport"
          @reset="closeImport"
        >
          Импортировать
        </UiFilePicker>
        <UiButton :disabled="Boolean(draft) || transferBusy" @click="updateMaps">
          Обновить карты
        </UiButton>
        <UiButton v-if="!draft" :disabled="transferBusy" @click="startCreate">
          Новая запись
        </UiButton>
      </div>
    </header>

    <UiInlineMessage v-if="disabled">Плагин «Знания» выключен.</UiInlineMessage>
    <UiInlineMessage v-else-if="error" tone="danger">{{ error }}</UiInlineMessage>
    <UiInlineMessage v-if="transferError" tone="danger">{{ transferError }}</UiInlineMessage>
    <UiInlineMessage v-if="transferResult">{{ transferResult }}</UiInlineMessage>
    <UiSpinner v-if="loading" />

    <template v-if="!disabled">
      <section v-if="!draft" class="knowledge-view__filters">
        <UiField label="Поиск">
          <div class="knowledge-view__search">
            <UiSearchInput v-model="query" name="query" placeholder="Тема или термин" />
            <UiButton @click="search">Найти</UiButton>
          </div>
        </UiField>
        <UiField label="Проект">
          <UiInput v-model="projectFilter" name="project" placeholder="Все проекты" />
        </UiField>
        <UiField label="Тег">
          <UiInput v-model="tagFilter" name="tag" placeholder="Все теги" />
        </UiField>
        <p class="knowledge-view__facets">
          Проекты: <span v-for="project in facets.projects" :key="project">{{ project }} </span>
          Теги: <span v-for="tag in facets.tags" :key="tag">{{ tag }} </span>
        </p>
      </section>

      <section v-if="importPreview" class="knowledge-view__import" aria-label="Импорт знаний">
        <h2>Предпросмотр импорта</h2>
        <p>
          Создать: {{ importPreview.summary.create }}, обновить: {{ importPreview.summary.update }},
          без изменений: {{ importPreview.summary.unchanged }}, конфликтов:
          {{ importPreview.summary.conflict }}, только в базе: {{ importPreview.summary.targetOnly }}.
        </p>
        <article
          v-for="conflict in importPreview.conflicts"
          :key="conflict.id"
          class="knowledge-view__conflict"
        >
          <h3>{{ conflict.title }}</h3>
          <p>Изменённые поля: {{ conflict.changedFields.join(', ') }}</p>
          <div class="knowledge-view__versions">
            <div>
              <h4>Из экспортированного файла</h4>
              <pre>{{ recordText(conflict.incoming) }}</pre>
            </div>
            <div>
              <h4>Текущая запись в базе</h4>
              <pre>{{ recordText(conflict.current) }}</pre>
            </div>
          </div>
          <UiField label="Решение" required>
            <UiSelect
              :model-value="conflictDecision(conflict.id)"
              @update:model-value="setConflictDecision(conflict.id, $event)"
            >
              <option value="" disabled>Выберите решение</option>
              <option value="keep-current">Оставить в базе</option>
              <option value="use-import">Взять из файла</option>
            </UiSelect>
          </UiField>
        </article>
        <UiFormActions>
          <UiButton :disabled="transferBusy || !allConflictsResolved" @click="applyImport">
            Применить импорт
          </UiButton>
          <UiButton :disabled="transferBusy" @click="closeImport">Закрыть</UiButton>
        </UiFormActions>
      </section>

      <section class="knowledge-view__list" aria-label="Записи знаний">
        <article
          v-for="item in items"
          :key="item.id"
          class="knowledge-view__item"
        >
          <UiButton @click="openRecord(item.id)">{{ item.title }}</UiButton>
          <span v-if="fragmentOf(item)" class="knowledge-view__fragment">
            {{ fragmentOf(item) }}
          </span>
          <span v-if="item.tags.length" class="knowledge-view__tags">
            {{ item.tags.join(', ') }}
          </span>
        </article>
        <p v-if="!loading && !items.length" class="knowledge-view__empty">Записей не найдено.</p>
      </section>

      <section v-if="draft" class="knowledge-view__editor">
        <h2>{{ draft.id ? 'Запись' : 'Новая запись' }}</h2>
        <p v-if="draft.id" class="knowledge-view__record-body">{{ draft.body }}</p>
        <div class="knowledge-view__fields">
          <UiField label="Проект" required>
            <UiInput v-model="draft.project" name="project" />
          </UiField>
          <UiField label="Репозиторий" required>
            <UiInput v-model="draft.repository" name="repository" />
          </UiField>
          <UiField label="Вид" required>
            <UiInput v-model="draft.kind" name="kind" />
          </UiField>
          <UiField label="Заголовок" required>
            <UiInput v-model="draft.title" name="title" />
          </UiField>
          <UiField
            label="Теги"
            hint="Через запятую; первый тег — тема латиницей, например release-notes"
            required
          >
            <UiInput v-model="draft.tagsText" name="tags" required />
          </UiField>
          <UiField class="knowledge-view__body" label="Полный текст" required>
            <UiTextarea v-model="draft.body" name="body" rows="14" />
          </UiField>
        </div>
        <UiFormActions>
          <UiButton @click="save">Сохранить</UiButton>
          <UiButton v-if="draft.id" tone="danger" @click="remove">Удалить</UiButton>
          <UiButton @click="closeEditor">Закрыть</UiButton>
        </UiFormActions>
      </section>
    </template>
  </main>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { knowledgeApi, knowledgeErrorCode, knowledgeErrorMessage } from '../shared/knowledgeApi.ts';
import type {
  KnowledgeFacets,
  KnowledgeImportDecision,
  KnowledgeImportPreview,
  KnowledgeImportResolution,
  KnowledgeRecord,
  KnowledgeRecordInput,
  KnowledgeSearchItem,
} from '../../../shared/knowledgeContracts.ts';
import {
  UiButton,
  UiField,
  UiFilePicker,
  UiFormActions,
  UiInlineMessage,
  UiInput,
  UiSearchInput,
  UiSelect,
  UiSpinner,
  UiTextarea,
  confirmDialog,
} from '../ui.ts';

// Список показывает либо записи базы, либо находки поиска: у находки есть фрагмент
// совпадения и нет полного текста.
type KnowledgeEntry = KnowledgeRecord | KnowledgeSearchItem;

/**
 * Черновик редактора. Теги человек правит одной строкой, а пустой id означает ещё не
 * созданную запись: по нему же решается, куда уйдёт сохранение — в POST или в PUT.
 */
interface KnowledgeDraft {
  id: string;
  revision: number;
  project: string;
  repository: string;
  kind: string;
  title: string;
  body: string;
  tagsText: string;
}

const items = ref<KnowledgeEntry[]>([]);
const facets = ref<KnowledgeFacets>({ projects: [], tags: [] });
const query = ref('');
const projectFilter = ref('');
const tagFilter = ref('');
const draft = ref<KnowledgeDraft | null>(null);
const loading = ref(false);
const error = ref('');
const disabled = ref(false);
const transferBusy = ref(false);
const transferError = ref('');
const transferResult = ref('');
const importPreview = ref<KnowledgeImportPreview | null>(null);
const importDecisions = ref<Record<string, KnowledgeImportDecision | ''>>({});
const importFile = shallowRef<File | null>(null);
const route = useRoute();
const router = useRouter();

function conflictDecision(id: string): KnowledgeImportDecision | '' {
  return importDecisions.value[id] ?? '';
}

const allConflictsResolved = computed(() => (
  (importPreview.value?.conflicts ?? []).every((conflict) => conflictDecision(conflict.id) !== '')
));

/**
 * Общий control отдаёт выбор строкой. Раздел запоминает только известные решения,
 * чтобы посторонняя строка не выглядела как ответ человека по конфликту.
 */
function setConflictDecision(id: string, value: unknown): void {
  importDecisions.value[id] = value === 'keep-current' || value === 'use-import' ? value : '';
}

function fragmentOf(entry: KnowledgeEntry): string {
  return 'fragment' in entry ? entry.fragment : '';
}

function editable(record: KnowledgeRecord): KnowledgeDraft {
  return {
    id: record.id,
    revision: record.revision,
    project: record.project,
    repository: record.repository,
    kind: record.kind,
    title: record.title,
    body: record.body,
    tagsText: record.tags.join(', '),
  };
}

function recordText(record: unknown): string {
  return JSON.stringify(record, null, 2);
}

/**
 * Скачивает резервную копию одним действием человека. Object URL освобождается в любом
 * исходе: ссылка живёт ровно столько, сколько нужно браузеру для сохранения файла.
 */
async function exportKnowledge() {
  transferBusy.value = true;
  transferError.value = '';
  transferResult.value = '';

  try {
    const backup = await knowledgeApi.exportBackup();
    const objectUrl = URL.createObjectURL(backup.blob);

    try {
      const link = document.createElement('a');

      link.href = objectUrl;
      link.download = backup.filename
        || `cockpit-knowledge-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
    } finally {
      URL.revokeObjectURL(objectUrl);
    }

    transferResult.value = 'Резервная копия скачана.';
  } catch (caught) {
    transferError.value = knowledgeErrorMessage(caught);
  } finally {
    transferBusy.value = false;
  }
}

/**
 * Предпросмотр строится по одному выбранному файлу, и сам файл запоминается: применение
 * обязано уйти по тому же содержимому, которое человек только что сверил глазами.
 */
async function previewImport(files: File[]) {
  const [file] = files;

  if (!Array.isArray(files) || files.length !== 1 || !file) {
    transferError.value = 'Выберите ровно один файл резервной копии.';

    return;
  }

  transferBusy.value = true;
  transferError.value = '';
  transferResult.value = '';
  importFile.value = file;

  try {
    importPreview.value = await knowledgeApi.previewImport(file);
    importDecisions.value = {};
  } catch (caught) {
    transferError.value = knowledgeErrorMessage(caught);
  } finally {
    transferBusy.value = false;
  }
}

/**
 * Отправляет ровно один apply по увиденному hash и выбранным решениям. При отказе
 * preview и выборы остаются на экране, чтобы человек осознанно сверил их снова.
 */
async function applyImport() {
  const preview = importPreview.value;
  const file = importFile.value;

  if (!preview || !file || !allConflictsResolved.value) {
    return;
  }

  const resolutions: KnowledgeImportResolution[] = [];

  for (const conflict of preview.conflicts) {
    const decision = conflictDecision(conflict.id);

    if (decision === '') {
      return;
    }

    resolutions.push({
      id: conflict.id,
      decision,
      expectedCurrentRevision: conflict.currentRevision,
    });
  }

  transferBusy.value = true;
  transferError.value = '';
  transferResult.value = '';

  try {
    const result = await knowledgeApi.applyImport(file, preview.snapshotHash, resolutions);

    importPreview.value = null;
    importDecisions.value = {};
    importFile.value = null;
    transferResult.value = `Импорт применён. Записей в базе: ${result.total}.`;
    await loadList();
  } catch (caught) {
    transferError.value = knowledgeErrorMessage(caught);
  } finally {
    transferBusy.value = false;
  }
}

/**
 * Закрывает импорт целиком: и предпросмотр, и выбранные решения, и сам файл. Оставить
 * что-то одно значило бы применить решения к другому содержимому.
 */
function closeImport() {
  importPreview.value = null;
  importDecisions.value = {};
  importFile.value = null;
  transferError.value = '';
}

/**
 * Пересборка карт — отдельное действие человека: она переписывает файлы оглавления в
 * репозиториях и потому не увязана ни с экспортом, ни с импортом.
 */
async function updateMaps() {
  transferBusy.value = true;
  transferError.value = '';
  transferResult.value = '';

  try {
    const result = await knowledgeApi.refreshMaps();

    transferResult.value = `Обновлено карт: ${result.mapCount}; записей: ${result.recordCount}.`;
  } catch (caught) {
    transferError.value = knowledgeErrorMessage(caught);
  } finally {
    transferBusy.value = false;
  }
}

/**
 * Загружает authoritative список. Выключенный плагин — штатное состояние, а не отказ:
 * он превращается в заглушку и не показывает человеку красную ошибку.
 */
async function loadList() {
  loading.value = true;
  error.value = '';

  try {
    const result = await knowledgeApi.list({
      project: projectFilter.value,
      tag: tagFilter.value,
    });

    items.value = result.items;
    facets.value = result.facets;
    disabled.value = false;
  } catch (caught) {
    if (knowledgeErrorCode(caught) === 'plugin_disabled') {
      disabled.value = true;
    } else {
      error.value = knowledgeErrorMessage(caught);
    }
  } finally {
    loading.value = false;
  }
}

/**
 * Поиск заменяет список находками с фрагментами совпадения. Фасеты остаются от списка:
 * их считает вся база, а не выборка запроса.
 */
async function search() {
  loading.value = true;
  error.value = '';

  try {
    items.value = await knowledgeApi.search({
      query: query.value,
      project: projectFilter.value,
      tag: tagFilter.value,
    });
  } catch (caught) {
    error.value = knowledgeErrorMessage(caught);
  } finally {
    loading.value = false;
  }
}

/**
 * Полный текст записи приходит отдельным запросом: ни список, ни находки поиска его не
 * содержат, и открытая запись всегда свежая, а не собранная из строки списка.
 */
async function loadRecord(id: string) {
  error.value = '';

  try {
    draft.value = editable(await knowledgeApi.read(id));
  } catch (caught) {
    error.value = knowledgeErrorMessage(caught);
  }
}

async function openRecord(id: string) {
  if (String(route.params.id || '') === id) {
    await loadRecord(id);

    return;
  }

  await router.push(`/knowledge/${id}`);
}

function startCreate() {
  error.value = '';
  draft.value = {
    id: '',
    revision: 0,
    project: '',
    repository: '',
    kind: 'fact',
    title: '',
    body: '',
    tagsText: '',
  };
}

/**
 * Проверяет владельца темы до удаления пустых тегов, чтобы исправление черновика
 * не отправило запись без доступной карты и резервной копии.
 */
function payload(current: KnowledgeDraft): KnowledgeRecordInput {
  const tags = current.tagsText.split(',').map((tag) => tag.normalize('NFKC').trim());

  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(tags[0] ?? '')) {
    throw new Error(
      'Первый тег обязателен: используйте строчные латинские буквы, цифры и дефис между ними.',
    );
  }

  return {
    project: current.project,
    repository: current.repository,
    kind: current.kind,
    title: current.title,
    body: current.body,
    tags: tags.filter(Boolean),
  };
}

/**
 * Неуспешная мутация не повторяется и не заменяет введённый человеком черновик: правки
 * остаются на экране, и решение отправить их снова принимает человек.
 */
async function save() {
  error.value = '';

  const current = draft.value;

  if (!current) {
    return;
  }

  try {
    const record = current.id
      ? await knowledgeApi.update(current.id, payload(current), current.revision)
      : await knowledgeApi.create(payload(current));

    draft.value = editable(record);
  } catch (caught) {
    error.value = knowledgeErrorMessage(caught);
  }
}

/**
 * Удаление подтверждает человек, а сервер сверяет ревизию: запись, изменённую в другом
 * окне, стереть вслепую нельзя.
 */
async function remove() {
  const current = draft.value;

  if (!current?.id || !await confirmDialog(`Удалить запись «${current.title}»?`)) {
    return;
  }

  error.value = '';

  try {
    await knowledgeApi.remove(current.id, current.revision);
    items.value = items.value.filter((item) => item.id !== current.id);
    draft.value = null;
    await router.push('/knowledge');
  } catch (caught) {
    error.value = knowledgeErrorMessage(caught);
  }
}

async function closeEditor() {
  draft.value = null;
  error.value = '';

  if (route.params.id) {
    await router.push('/knowledge');
  }
}

watch([projectFilter, tagFilter], () => {
  loadList();
});
watch(() => route.params.id, (id) => {
  if (id) {
    loadRecord(String(id));
  } else if (draft.value?.id) {
    draft.value = null;
  }
}, { immediate: true });
onMounted(loadList);
</script>

<style scoped>
.knowledge-view {
  display: grid;
  gap: 18px;
  padding: 24px;
}

.knowledge-view__header,
.knowledge-view__actions,
.knowledge-view__filters,
.knowledge-view__search,
.knowledge-view__fields {
  display: flex;
  gap: 12px;
}

.knowledge-view__header {
  align-items: flex-start;
  justify-content: space-between;
}

.knowledge-view__header h1,
.knowledge-view__header p {
  margin: 0;
}

.knowledge-view__header p,
.knowledge-view__fragment,
.knowledge-view__tags,
.knowledge-view__empty {
  color: var(--text-muted);
}

.knowledge-view__record-body {
  margin: 0;
  white-space: pre-wrap;
}

.knowledge-view__filters {
  align-items: end;
  flex-wrap: wrap;
}

.knowledge-view__list,
.knowledge-view__import,
.knowledge-view__conflict,
.knowledge-view__editor,
.knowledge-view__item {
  display: grid;
  gap: 10px;
}

.knowledge-view__versions {
  display: grid;
  gap: 12px;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.knowledge-view__versions pre {
  margin: 0;
  overflow: auto;
  white-space: pre-wrap;
}

.knowledge-view__fragment,
.knowledge-view__tags {
  display: block;
  text-align: left;
}

.knowledge-view__fields {
  flex-wrap: wrap;
}

.knowledge-view__fields > * {
  flex: 1 1 220px;
}

.knowledge-view__body {
  flex-basis: 100%;
}

@media (max-width: 700px) {
  .knowledge-view {
    padding: 16px;
  }

  .knowledge-view__header,
  .knowledge-view__filters,
  .knowledge-view__actions {
    align-items: stretch;
    flex-direction: column;
  }

  .knowledge-view__versions {
    grid-template-columns: 1fr;
  }
}
</style>
