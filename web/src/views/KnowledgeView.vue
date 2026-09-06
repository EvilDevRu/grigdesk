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
            <UiSelect v-model="importDecisions[conflict.id]">
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
          <span v-if="item.fragment" class="knowledge-view__fragment">{{ item.fragment }}</span>
          <span v-if="item.tags?.length" class="knowledge-view__tags">
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

<script setup>
import { computed, onMounted, ref, shallowRef, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { api } from '../shared/api-client.js';
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

const items = ref([]);
const facets = ref({ projects: [], tags: [] });
const query = ref('');
const projectFilter = ref('');
const tagFilter = ref('');
const draft = ref(null);
const loading = ref(false);
const error = ref('');
const disabled = ref(false);
const transferBusy = ref(false);
const transferError = ref('');
const transferResult = ref('');
const importPreview = ref(null);
const importDecisions = ref({});
const importFile = shallowRef(null);
const route = useRoute();
const router = useRouter();

const allConflictsResolved = computed(() => (
  (importPreview.value?.conflicts || []).every((conflict) => (
    ['keep-current', 'use-import'].includes(importDecisions.value[conflict.id])
  ))
));

function errorText(caught) {
  return String(caught?.data?.message || caught?.message || 'Не удалось выполнить операцию.');
}

function queryString(values) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value) {
      params.set(key, value);
    }
  }
  const suffix = params.toString();
  return suffix ? `?${suffix}` : '';
}

function editable(record) {
  return {
    ...record,
    tagsText: Array.isArray(record.tags) ? record.tags.join(', ') : '',
  };
}

function recordText(record) {
  return JSON.stringify(record, null, 2);
}

async function exportKnowledge() {
  transferBusy.value = true;
  transferError.value = '';
  transferResult.value = '';
  try {
    const result = await api.download('/api/knowledge/backup/export');
    const objectUrl = URL.createObjectURL(result.blob);
    try {
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = result.filename
        || `cockpit-knowledge-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
    transferResult.value = 'Резервная копия скачана.';
  } catch (caught) {
    transferError.value = errorText(caught);
  } finally {
    transferBusy.value = false;
  }
}

async function previewImport(files) {
  if (!Array.isArray(files) || files.length !== 1) {
    transferError.value = 'Выберите ровно один файл резервной копии.';
    return;
  }
  transferBusy.value = true;
  transferError.value = '';
  transferResult.value = '';
  importFile.value = files[0];
  try {
    const formData = new FormData();
    formData.append('file', importFile.value);
    importPreview.value = await api.upload('/api/knowledge/backup/import/preview', formData);
    importDecisions.value = {};
  } catch (caught) {
    transferError.value = errorText(caught);
  } finally {
    transferBusy.value = false;
  }
}

/**
 * Отправляет ровно один apply по увиденному hash и выбранным решениям. При отказе
 * preview и выборы остаются на экране, чтобы человек осознанно сверил их снова.
 */
async function applyImport() {
  if (!importPreview.value || !importFile.value || !allConflictsResolved.value) {
    return;
  }
  transferBusy.value = true;
  transferError.value = '';
  transferResult.value = '';
  const resolutions = importPreview.value.conflicts.map((conflict) => ({
    id: conflict.id,
    decision: importDecisions.value[conflict.id],
    expectedCurrentRevision: conflict.currentRevision,
  }));
  try {
    const formData = new FormData();
    formData.append('file', importFile.value);
    formData.append('snapshotHash', importPreview.value.snapshotHash);
    formData.append('resolutions', JSON.stringify(resolutions));
    const result = await api.upload('/api/knowledge/backup/import/apply', formData);
    importPreview.value = null;
    importDecisions.value = {};
    importFile.value = null;
    transferResult.value = `Импорт применён. Записей в базе: ${result.total}.`;
    await loadList();
  } catch (caught) {
    transferError.value = errorText(caught);
  } finally {
    transferBusy.value = false;
  }
}

function closeImport() {
  importPreview.value = null;
  importDecisions.value = {};
  importFile.value = null;
  transferError.value = '';
}

async function updateMaps() {
  transferBusy.value = true;
  transferError.value = '';
  transferResult.value = '';
  try {
    const result = await api.post('/api/knowledge/maps/refresh');
    transferResult.value = `Обновлено карт: ${result.mapCount}; записей: ${result.recordCount}.`;
  } catch (caught) {
    transferError.value = errorText(caught);
  } finally {
    transferBusy.value = false;
  }
}

/** Загружает authoritative список; plugin_disabled превращается в штатную заглушку. */
async function loadList() {
  loading.value = true;
  error.value = '';
  try {
    const result = await api.get(`/api/knowledge${queryString({
      project: projectFilter.value,
      tag: tagFilter.value,
    })}`);
    items.value = result.items || [];
    facets.value = result.facets || { projects: [], tags: [] };
    disabled.value = false;
  } catch (caught) {
    if (caught?.data?.error === 'plugin_disabled') {
      disabled.value = true;
    } else {
      error.value = errorText(caught);
    }
  } finally {
    loading.value = false;
  }
}

async function search() {
  loading.value = true;
  error.value = '';
  try {
    const result = await api.get(`/api/knowledge/search${queryString({
      q: query.value,
      project: projectFilter.value,
      tag: tagFilter.value,
    })}`);
    items.value = result.items || [];
  } catch (caught) {
    error.value = errorText(caught);
  } finally {
    loading.value = false;
  }
}

async function loadRecord(id) {
  error.value = '';
  try {
    const result = await api.get(`/api/knowledge/${id}`);
    draft.value = editable(result.record);
  } catch (caught) {
    error.value = errorText(caught);
  }
}

async function openRecord(id) {
  if (String(route.params.id || '') === id) {
    await loadRecord(id);
    return;
  }
  await router.push(`/knowledge/${id}`);
}

function startCreate() {
  error.value = '';
  draft.value = editable({
    project: '',
    repository: '',
    kind: 'fact',
    title: '',
    body: '',
    tags: [],
  });
}

/**
 * Проверяет владельца темы до удаления пустых тегов, чтобы исправление черновика
 * не отправило запись без доступной карты и резервной копии.
 */
function payload() {
  const tags = draft.value.tagsText.split(',').map((tag) => tag.normalize('NFKC').trim());

  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(tags[0])) {
    throw new Error(
      'Первый тег обязателен: используйте строчные латинские буквы, цифры и дефис между ними.',
    );
  }

  return {
    project: draft.value.project,
    repository: draft.value.repository,
    kind: draft.value.kind,
    title: draft.value.title,
    body: draft.value.body,
    tags: tags.filter(Boolean),
  };
}

/** Неуспешная мутация не повторяется и не заменяет введённый человеком черновик. */
async function save() {
  error.value = '';
  const current = draft.value;
  try {
    const result = current.id
      ? await api.put(`/api/knowledge/${current.id}`, {
        ...payload(),
        expectedRevision: current.revision,
      })
      : await api.post('/api/knowledge', payload());
    draft.value = editable(result.record);
  } catch (caught) {
    error.value = errorText(caught);
  }
}

async function remove() {
  const current = draft.value;
  if (!current?.id || !await confirmDialog(`Удалить запись «${current.title}»?`)) {
    return;
  }
  error.value = '';
  try {
    await api.del(`/api/knowledge/${current.id}`, { expectedRevision: current.revision });
    items.value = items.value.filter((item) => item.id !== current.id);
    draft.value = null;
    await router.push('/knowledge');
  } catch (caught) {
    error.value = errorText(caught);
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
