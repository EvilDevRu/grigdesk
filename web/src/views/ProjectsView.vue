<template>
  <div class="page projects ui-page ui-workspace" data-ui-workspace>
    <UiInlineMessage v-if="registrationDeleted" tone="warning">
      Регистрация проекта удалена.
    </UiInlineMessage>
    <div ref="workspace" class="workspace" :class="{ 'single-pane': !splitView }">
      <!--
        На широком экране список и паспорт стоят рядом: так видно, куда вернёшься.
        На узком остаётся одна область, и обратно ведёт кнопка «Проекты».
      -->
      <div v-show="listVisible" class="pane list-pane">
        <ProjectList
          :items="store.items"
          :loading="store.loading"
          :error="store.error"
          :selected-id="creating ? '' : openedId"
          @open="openProject"
          @retry="retry"
        >
          <template #actions>
            <UiButton
              v-if="!creating"
              data-role="project-create"
              data-context="workspace-toolbar"
              variant="ghost"
              aria-label="Новый проект"
              v-tooltip="'Новый проект'"
              @click="createProject"
            >
              <template #leading><ProjectIcon name="plus" /></template>Новый
            </UiButton>
          </template>
        </ProjectList>
      </div>

      <section v-if="formVisible" class="pane form-pane" data-role="project-form">
        <UiPaneHeader inset="content">
          <template v-if="!splitView" #navigation>
            <UiButton variant="ghost" data-context="workspace-toolbar"
              data-role="project-back" @click="backToList">
              <template #leading><ProjectIcon name="back" /></template>Проекты
            </UiButton>
          </template>
          <template #title><h2>{{ formTitle }}</h2></template>
          <template v-if="!creating && currentDetail" #meta>
            <span class="project-status">
              <span :class="['status-dot', { archived: currentDetail.archivedAt }]" />
              {{ currentDetail.archivedAt ? 'В архиве' : 'Активный' }}
            </span>
          </template>
          <template v-if="!creating && currentDetail && !currentDetail.archivedAt && !registrationDeleted" #actions>
            <UiButton variant="ghost" tone="accent" data-context="workspace-toolbar"
              aria-label="Чат с проектом" @click="openChat">
              <template #leading><ProjectIcon name="chat" /></template>
              <span class="chat-full">Чат с проектом</span><span class="chat-short">Чат</span>
            </UiButton>
          </template>
        </UiPaneHeader>

        <div class="form-content">
          <ProjectForm
            v-if="currentDraft && store.draft"
            v-model="store.draft"
            :detail="creating ? null : currentDetail"
            :creating="creating"
            :saving="saving"
            :dirty="dirty"
            :server-errors="fieldErrors"
            :checks="store.checks"
            :busy="lifecycleBusy"
            :readonly="registrationDeleted"
            :lifecycle-failure="lifecycleFailure"
            :dependencies="store.dependencies"
            @save="submit"
            @cancel="cancelChanges"
            @check="check"
            @select-repo="selectRepo"
            @open-routes="openRoutes"
            @archive="archive"
            @restore="restore"
            @remove="remove"
            @retry-dependencies="retryDependencies"
            @open-rules="openRules"
          >
            <template #notices>
              <div
                v-if="store.error && !store.conflict && saveFailure !== 'exists'"
                class="form-notice"
                role="alert"
              >
                <UiInlineMessage tone="danger">{{ store.error }}</UiInlineMessage>
                <UiButton
                  v-if="!creating && !currentDetail"
                  data-role="project-detail-retry"
                  @click="retryProject"
                >
                  Повторить
                </UiButton>
              </div>
              <ProjectConflict
                v-if="currentDraft && store.conflict"
                class="form-notice"
                :conflict="store.conflict"
                :busy="saving"
                @reload="reloadFromServer"
                @overwrite="overwriteServer"
              />

              <div v-if="saveFailure === 'exists'" class="form-notice" data-role="project-save-failure">
                <UiInlineMessage tone="warning">
                  <p class="sub">Проект с таким идентификатором уже есть. Правки не потеряны.</p>
                  <UiButton data-role="project-open-found" variant="text" @click="openFound">
                    Открыть найденный проект
                  </UiButton>
                </UiInlineMessage>
              </div>

            </template>
          </ProjectForm>
          <div v-else class="form-notice">
            <template v-if="store.error">
              <UiInlineMessage tone="danger">{{ store.error }}</UiInlineMessage>
              <UiButton v-if="!creating" data-role="project-detail-retry" @click="retryProject">
                Повторить
              </UiButton>
            </template>
            <p v-else role="status">Загрузка проекта…</p>
          </div>
        </div>
      </section>

      <section
        v-else-if="splitView && (store.items.length || (!store.loading && !store.error))"
        class="welcome"
      >
        <div class="welcome-symbol" aria-hidden="true">
          <svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.4">
            <rect x="8" y="10" width="32" height="28" rx="5" />
            <path d="M8 19h32M19 19v19M24 25h10M24 30h7" />
          </svg>
        </div>
        <h2>{{ store.items.length ? 'Выберите проект' : 'Создайте первый проект' }}</h2>
        <p>{{ store.items.length
          ? 'Здесь будут его настройки, репозитории и связи с фабрикой.'
          : 'Объедините рабочие копии кода под одним названием.' }}</p>
        <UiButton variant="outline" @click="createProject">Создать проект</UiButton>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
// Раздел «Проекты»: список паспортов слева, паспорт открытого проекта справа.
//
// Страница — только каркас: она читает адрес (`/projects/:id?`, `?create=1`),
// зовёт операции раздела и раскладывает две области по ширине окна. Ни сети,
// ни правил формы здесь нет.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute, useRouter } from 'vue-router';

import { UiButton, UiInlineMessage, UiPaneHeader, confirmDialog, vTooltip } from '../ui';
import { useUiContextSource } from '../composables/useUiContextSource.ts';
import { useDockViewport } from '../shared/tools/viewport.ts';
import { useChatStore } from '../stores/chat.ts';
import {
  archiveProject,
  checkRepositories,
  loadDependencies,
  loadProject,
  loadProjects,
  restoreProject,
  saveProject,
  useProjectsStore,
  watchProjects,
} from '../actions/projects';
import * as projectActions from '../actions/projects';
import type { ProjectDetail } from '../../../shared/runtime/projectsContracts';
import { createDraft, isDirty } from './projects/projectDraft';
import ProjectConflict from './projects/ProjectConflict.vue';
import ProjectForm from './projects/ProjectForm.vue';
import ProjectList from './projects/ProjectList.vue';
import ProjectIcon from './projects/ProjectIcon.vue';

const route = useRoute();
const router = useRouter();
const store = useProjectsStore();
const chat = useChatStore();
const { dockCapable } = useDockViewport();
const projectsContext = useUiContextSource('projects', { layer: 'page', active: false });

const fieldErrors = ref<Array<{ path: string; message: string }>>([]);
// Код отказа сохранения: по нему показывается «проект уже есть» и расхождение ревизий.
const saveFailure = ref('');
const saving = ref(false);
// Операция жизненного цикла: кнопки архива и возврата выключены на её время,
// а отказ сервера показывается рядом с ними текстом.
const lifecycleBusy = ref(false);
const lifecycleFailure = ref('');
const registrationDeleted = ref(false);
const removedDetail = ref<ProjectDetail | null>(null);
// Выбранный человеком репозиторий: живёт до конца открытого паспорта.
const selectedRepo = ref('');
const workspace = ref<HTMLElement | null>(null);
const workspaceWidth = ref(Number.POSITIVE_INFINITY);
let workspaceObserver: ResizeObserver | null = null;

// Адрес — единственный источник того, что открыто: прямая ссылка на паспорт
// и возврат «назад» в браузере обязаны работать одинаково.
const openedId = computed(() => (typeof route.params.id === 'string' ? route.params.id : ''));
const creating = computed(() => route.query.create === '1');
const formVisible = computed(() => creating.value || openedId.value !== '');
const splitView = computed(() => dockCapable.value && workspaceWidth.value >= 760);
const listVisible = computed(() => splitView.value || !formVisible.value);
const currentDetail = computed(() => {
  const detail = store.opened ?? removedDetail.value;

  return detail?.id === openedId.value ? detail : null;
});
const currentDraft = computed(() => creating.value || store.draft?.id === openedId.value);
const formTitle = computed(() => (
  creating.value ? 'Новый проект' : currentDetail.value?.title || openedId.value
));

/**
 * Чат запоминает явный проект и выбранный репозиторий паспорта.
 * Рабочую папку перед первым сохранением проверяет общий серверный resolver.
 */
async function openChat() {
  await chat._load();
  chat.newSession({
    workdir: {
      kind: 'project',
      projectId: openedId.value,
      repoKey: selectedRepo.value || null
    },
    title: `Проект · ${formTitle.value}`,
  });
  await router.push('/chats');
}

const snapshot = computed(() => (
  store.opened ? createDraft(store.opened)
    : removedDetail.value ? createDraft(removedDetail.value) : null
));

// Правки относительно снимка: один ответ и для кнопки сохранения, и для защиты ухода.
// У нового проекта снимка нет — правкой считается всё, что человек уже назвал.
const dirty = computed(() => {
  if (!store.draft) {
    return false;
  }
  if (!snapshot.value) {
    return Boolean(store.draft.id.trim() || store.draft.title.trim());
  }

  return isDirty(store.draft, snapshot.value);
});

let pageGeneration = 0;

watch(openedId, (id) => {
  pageGeneration += 1;

  if (id) {
    registrationDeleted.value = false;
    removedDetail.value = null;
  }

  if (id && !creating.value) {
    void loadProject(id);
    void loadDependencies(id);
  }
}, { immediate: true, flush: 'sync' });

// Удаление приходит и до первого паспорта: адрес сверяется с реактивным запретом.
// Загруженный снимок нужен только для сохранения локальных правок в режиме чтения.
watch([
  () => store.opened,
  openedId,
  () => store.deletedIds?.has(openedId.value) === true,
], ([detail, id, deleted], [previous]) => {
  if (!id || creating.value) {
    return;
  }

  if (detail?.id === id && !deleted) {
    registrationDeleted.value = false;
    removedDetail.value = null;

    return;
  }

  const retained = previous?.id === id ? previous
    : removedDetail.value?.id === id ? removedDetail.value : null;

  if (!deleted && !retained) {
    return;
  }

  registrationDeleted.value = true;

  if (retained && store.draft?.id === id && isDirty(store.draft, createDraft(retained))) {
    removedDetail.value = retained;
  } else {
    if (store.draft?.id === id) {
      store.setDraft(null);
    }

    void router.replace('/projects');
  }
}, { immediate: true });

// Форма создания начинается с пустого черновика: его же правит человек.
watch(creating, (value) => {
  if (value) {
    store.setOpened(null);
    store.setDraft(createDraft(null));
    store.setConflict(null);
    saveFailure.value = '';
  }
}, { immediate: true });

/**
 * Уход со страницы с несохранёнными правками: спрашиваем один раз и одинаково —
 * и при переходе по ссылке, и при смене открытого проекта в адресе.
 */
async function canLeave(): Promise<boolean> {
  if (!dirty.value) {
    return true;
  }

  return confirmDialog('Есть несохранённые изменения — бросить?', { okText: 'Бросить' });
}

onBeforeRouteLeave(() => canLeave());
onBeforeRouteUpdate(() => canLeave());

// Закрытие вкладки браузер подтверждает своим диалогом: текст ему не передать,
// поэтому важно само наличие обработчика — и важно снять его, когда правок нет.
function beforeUnload(event: BeforeUnloadEvent): void {
  event.preventDefault();
  event.returnValue = '';
}

watch(dirty, (value) => {
  if (typeof window === 'undefined') {
    return;
  }
  if (value) {
    window.addEventListener('beforeunload', beforeUnload);
  } else {
    window.removeEventListener('beforeunload', beforeUnload);
  }
});

onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', beforeUnload);
  workspaceObserver?.disconnect();
});

// В UI-контекст уходит только выбор человека: id открытого проекта и — если он
// выбирал репозиторий по умолчанию — ключ этого репозитория. Путей здесь нет:
// `dir` — машинная конкретика, и в чат она не попадает. Форма создания ничего
// не публикует: открытого паспорта у неё ещё нет.
watch([() => store.opened?.id ?? '', selectedRepo], ([id, repo]) => {
  if (!id || creating.value) {
    projectsContext.blur();

    return;
  }

  projectsContext.focus({ details: { project: id, repo: repo || undefined } });
}, { immediate: true });

onMounted(() => {
  // Док может сузить страницу при широком окне: две колонки зависят и от её реальной ширины.
  if (workspace.value && typeof ResizeObserver === 'function') {
    workspaceObserver = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width > 0) {
        workspaceWidth.value = entry.contentRect.width;
      }
    });
    workspaceObserver.observe(workspace.value);
  }

  watchProjects();
  void loadProjects();
});

/**
 * Сохранение паспорта. Подсказки сервера по полям остаются здесь и уходят в форму:
 * она показывает их там же, где свои, — у того поля, о котором говорит сервер.
 */
async function submit(): Promise<void> {
  const draft = store.draft;

  if (!draft || saving.value || lifecycleBusy.value || registrationDeleted.value) {
    return;
  }

  saving.value = true;
  fieldErrors.value = [];
  saveFailure.value = '';

  try {
    const result = await saveProject(creating.value ? null : openedId.value, draft);

    fieldErrors.value = result.fieldErrors;
    saveFailure.value = result.ok ? '' : result.error;

    if (result.ok && creating.value && store.opened) {
      await router.push(`/projects/${store.opened.id}`);
    }
  } finally {
    saving.value = false;
  }
}

/**
 * «Перечитать серверную версию»: черновик уступает серверному снимку, поэтому
 * спрашиваем подтверждение — правки после этого не вернуть.
 */
async function reloadFromServer(): Promise<void> {
  const confirmed = await confirmDialog(
    'Перечитать серверную версию? Несохранённые правки будут потеряны.',
    { okText: 'Перечитать' },
  );

  if (!confirmed) {
    return;
  }

  const id = openedId.value;

  store.setConflict(null);
  saveFailure.value = '';
  fieldErrors.value = [];

  if (id) {
    await loadProject(id);
  }
}

/**
 * «Сохранить мой черновик поверх свежей ревизии»: пишем ровно с той ревизией,
 * которую сервер назвал в отказе. Если и она устарела, конфликт покажется снова.
 */
async function overwriteServer(): Promise<void> {
  const draft = store.draft;

  if (!draft || saving.value || lifecycleBusy.value || registrationDeleted.value) {
    return;
  }

  saving.value = true;
  fieldErrors.value = [];

  try {
    const result = await saveProject(openedId.value, draft, {
      expectedRevision: store.conflict?.currentRevision ?? store.opened?.revision ?? 0,
    });

    fieldErrors.value = result.fieldErrors;
    saveFailure.value = result.ok ? '' : result.error;
  } finally {
    saving.value = false;
  }
}

/**
 * Архив и возврат из архива. Ревизия — та, что у открытого паспорта; отказ (например,
 * живые правила Telegram) показывается текстом, а сводка связей перечитывается, чтобы
 * человек увидел, что именно помешало.
 */
async function changeLifecycle(action: 'archive' | 'restore'): Promise<void> {
  const id = openedId.value;
  const revision = store.opened?.revision;

  if (!id || revision === undefined || lifecycleBusy.value) {
    return;
  }

  lifecycleBusy.value = true;
  lifecycleFailure.value = '';

  try {
    const result = action === 'archive'
      ? await archiveProject(id, { expectedRevision: revision })
      : await restoreProject(id, { expectedRevision: revision });

    lifecycleFailure.value = result.ok ? '' : result.message;
  } finally {
    lifecycleBusy.value = false;
  }
}

/**
 * Общее подтверждение относится только к регистрации: файлы остаются на диске.
 * Busy выставляется до диалога, поэтому повторное нажатие не запускает второй DELETE.
 */
async function remove(): Promise<void> {
  const detail = store.opened;
  const generation = pageGeneration;

  if (!detail?.archivedAt || dirty.value || lifecycleBusy.value || saving.value) {
    return;
  }

  lifecycleBusy.value = true;
  lifecycleFailure.value = '';

  try {
    const confirmed = await confirmDialog(
      `Удалить регистрацию «${detail.title}»? Файлы проекта останутся на диске.`,
      { okText: 'Удалить регистрацию' },
    );

    if (!confirmed) {
      return;
    }

    const result = await projectActions.removeProject(detail.id, { expectedRevision: detail.revision });

    if (generation !== pageGeneration || openedId.value !== detail.id) {
      return;
    }

    lifecycleFailure.value = result.ok ? '' : result.message;

    if (result.ok) {
      if (store.draft?.id === detail.id && isDirty(store.draft, createDraft(detail))) {
        removedDetail.value = detail;
        registrationDeleted.value = true;

        return;
      }

      store.setDraft(null);
      await router.replace('/projects');
    }
  } finally {
    lifecycleBusy.value = false;
  }
}

function retryDependencies(): void {
  void loadDependencies(openedId.value);
}

function archive(): void {
  void changeLifecycle('archive');
}

function restore(): void {
  void changeLifecycle('restore');
}

function openRules(path: string): void {
  if (path) {
    void router.push(path);
  }
}

function openFound(): void {
  const id = store.draft?.id ?? '';

  if (id) {
    openProject(id);
  }
}

function check(dirs: string[]): void {
  void checkRepositories(dirs);
}

function openRoutes(): void {
  void router.push('/routes');
}

function selectRepo(key: string): void {
  selectedRepo.value = key;
}

function openProject(id: string): void {
  fieldErrors.value = [];
  selectedRepo.value = '';
  void router.push(`/projects/${id}`);
}

function backToList(): void {
  void router.push('/projects');
}

function createProject(): void {
  void router.push({ path: '/projects', query: { create: '1' } });
}

/**
 * Явная отмена возвращает паспорт к загруженному снимку без запроса к серверу.
 * Общий черновик и выбранный для чата репозиторий сбрасываются вместе.
 */
function cancelChanges(): void {
  if (saving.value) {
    return;
  }

  store.setDraft(createDraft(creating.value ? null : currentDetail.value));
  fieldErrors.value = [];
  saveFailure.value = '';
  selectedRepo.value = '';
}

function retry(): void {
  void loadProjects();
}

function retryProject(): void {
  void loadProject(openedId.value);
  void loadDependencies(openedId.value);
}
</script>

<style scoped>
.projects {
  height: 100%;
  min-height: 0;
  container: projects-page / inline-size;
}

.workspace {
  display: grid;
  grid-template-columns: 240px minmax(0, 1fr);
  height: 100%;
  overflow: hidden;
}

.workspace.single-pane {
  grid-template-columns: minmax(0, 1fr);
}

.pane {
  min-width: 0;
  min-height: 0;
}

.list-pane {
  background: var(--sidebar);
  border-right: 1px solid var(--line);
  overflow: auto;
}

.single-pane .list-pane {
  border-right: 0;
}

.form-pane {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--surface);
  container: project-detail / inline-size;
}

.project-status {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.status-dot {
  width: 5px;
  height: 5px;
  border-radius: var(--radius-round);
  background: var(--good);
}

.status-dot.archived {
  background: var(--ink-low);
}

.form-content {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  min-width: 0;
}

.form-notice {
  margin-bottom: 16px;
  overflow-wrap: anywhere;
}

.form-content > .form-notice {
  padding: 20px;
  overflow: auto;
}

.welcome {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 24px;
  text-align: center;
  background: var(--surface);
}

.welcome-symbol {
  color: var(--accent);
}

.welcome-symbol svg {
  width: 40px;
  height: 40px;
}

.welcome h2 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}

.welcome p {
  max-width: 340px;
  margin: 0;
  color: var(--ink-mid);
  font-size: 13px;
}

.chat-short {
  display: none;
}

@container project-detail (max-width: 320px) {
  .chat-full {
    display: none;
  }

  .chat-short {
    display: inline;
  }

}
</style>
