<template>
  <div class="page projects">
    <header class="page-heading">
      <div>
        <h1>Проекты</h1>
        <p>Рабочие пространства, репозитории и связи с фабрикой.</p>
      </div>
      <UiButton data-role="project-create" tone="accent" variant="solid" @click="createProject">
        <template #leading>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </template>
        Новый проект
      </UiButton>
    </header>

    <div ref="workspace" class="workspace" :class="{ 'single-pane': !splitView }">
      <!--
        На широком экране список и паспорт стоят рядом: так видно, куда вернёшься.
        На узком остаётся одна область, и обратно ведёт кнопка «← К списку».
      -->
      <div v-if="listVisible" class="pane list-pane">
        <ProjectList
          :items="store.items"
          :loading="store.loading"
          :error="store.error"
          :selected-id="creating ? '' : openedId"
          @open="openProject"
          @retry="retry"
        />
      </div>

      <section v-if="formVisible" class="pane form-pane" data-role="project-form">
        <UiButton
          v-if="!splitView"
          variant="text"
          data-role="project-back"
          @click="backToList"
        >
          ← К списку
        </UiButton>

        <header class="project-heading">
          <ProjectAvatar :title="creating ? '' : formTitle" large />
          <div class="project-identity">
            <span class="eyebrow">{{ creating ? 'Рабочее пространство' : 'Настройки проекта' }}</span>
            <h2 class="fhead">{{ formTitle }}</h2>
            <span v-if="!creating" class="project-id">{{ openedId }}</span>
          </div>
          <span v-if="!creating && store.opened" class="project-status">
            <span :class="['status-dot', { archived: store.opened.archivedAt }]" />
            {{ store.opened.archivedAt ? 'В архиве' : 'Активный' }}
          </span>
        </header>

        <div class="form-content">
          <ProjectConflict
            v-if="store.conflict"
            :conflict="store.conflict"
            :busy="saving"
            @reload="reloadFromServer"
            @overwrite="overwriteServer"
          />

          <div v-if="saveFailure === 'exists'" data-role="project-save-failure">
            <UiInlineMessage tone="warning">
              <p class="sub">Проект с таким идентификатором уже есть. Правки не потеряны.</p>
              <UiButton data-role="project-open-found" variant="text" @click="openFound">
                Открыть найденный проект
              </UiButton>
            </UiInlineMessage>
          </div>

          <ProjectForm
            v-if="store.draft"
            v-model="store.draft"
            :detail="creating ? null : store.opened"
            :creating="creating"
            :saving="saving"
            :dirty="dirty"
            :server-errors="fieldErrors"
            :checks="store.checks"
            :busy="lifecycleBusy"
            :lifecycle-failure="lifecycleFailure"
            :dependencies="store.dependencies"
            @save="submit"
            @check="check"
            @select-repo="selectRepo"
            @open-routes="openRoutes"
            @archive="archive"
            @restore="restore"
            @open-rules="openRules"
          />
        </div>
      </section>

      <section v-else-if="splitView" class="welcome">
        <div class="welcome-symbol" aria-hidden="true">
          <svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.4">
            <rect x="8" y="10" width="32" height="28" rx="5" />
            <path d="M8 19h32M19 19v19M24 25h10M24 30h7" />
          </svg>
        </div>
        <h2>Всё начинается с проекта</h2>
        <p>Выберите проект слева, чтобы настроить его репозитории и связи с фабрикой.</p>
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

import { UiButton, UiInlineMessage, confirmDialog } from '../ui';
import { useUiContextSource } from '../composables/useUiContextSource.ts';
import { useDockViewport } from '../shared/tools/viewport.ts';
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
import { createDraft, isDirty } from './projects/projectDraft';
import ProjectConflict from './projects/ProjectConflict.vue';
import ProjectForm from './projects/ProjectForm.vue';
import ProjectList from './projects/ProjectList.vue';
import ProjectAvatar from './projects/ProjectAvatar.vue';

const route = useRoute();
const router = useRouter();
const store = useProjectsStore();
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
const formTitle = computed(() => (
  creating.value ? 'Новый проект' : store.opened?.title || openedId.value
));

const snapshot = computed(() => (
  store.opened ? createDraft(store.opened) : null
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

watch(openedId, (id) => {
  if (id && !creating.value) {
    void loadProject(id);
    void loadDependencies(id);
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

  if (!draft || saving.value) {
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

  if (!draft || saving.value) {
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

function retry(): void {
  void loadProjects();
}
</script>

<style scoped>
.projects {
  display: flex;
  flex-direction: column;
  gap: 24px;
  height: 100%;
  min-height: 0;
  max-width: 1600px;
  margin: 0 auto;
  container: projects-page / inline-size;
}

.page-heading {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
}

.page-heading h1 {
  margin: 0;
  font-size: 28px;
  font-weight: 600;
  letter-spacing: -0.035em;
}

.page-heading p {
  margin: 3px 0 0;
  color: var(--ink-mid);
  font-size: 13px;
}

.workspace {
  display: grid;
  grid-template-columns: 296px minmax(0, 1fr);
  flex: 1;
  gap: 20px;
  min-height: 0;
}

.workspace.single-pane {
  grid-template-columns: minmax(0, 1fr);
}

.pane {
  min-width: 0;
  min-height: 0;
  border: 1px solid var(--line);
  border-radius: 16px;
}

.list-pane {
  background: var(--sidebar);
  overflow: hidden;
}

.form-pane {
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  background: color-mix(in srgb, var(--surface) 48%, var(--ground));
  scrollbar-gutter: stable;
  container: project-detail / inline-size;
}

.project-heading {
  display: flex;
  flex: none;
  align-items: center;
  gap: 16px;
  padding: 26px 28px;
  border-bottom: 1px solid var(--line);
}

.project-identity {
  min-width: 0;
}

.eyebrow {
  color: var(--ink-mid);
  font-size: 11px;
  font-weight: 500;
}

.fhead {
  margin: 0;
  font-size: 25px;
  font-weight: 600;
  letter-spacing: -0.025em;
  overflow-wrap: anywhere;
}

.project-id {
  color: var(--ink-low);
  font-family: var(--mono);
  font-size: 11px;
  overflow-wrap: anywhere;
}

.project-status {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 7px;
  margin-left: auto;
  color: var(--ink-mid);
  font-size: 12px;
}

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--good);
}

.status-dot.archived {
  background: var(--ink-low);
}

.form-content {
  flex: 1;
  padding: 0 28px;
}

.welcome {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  padding: 40px;
  border: 1px dashed var(--line);
  border-radius: 16px;
  text-align: center;
}

.welcome-symbol {
  display: grid;
  place-items: center;
  width: 80px;
  height: 80px;
  border: 1px solid var(--line);
  border-radius: 24px;
  background: var(--sidebar);
  color: var(--accent);
}

.welcome-symbol svg {
  width: 48px;
  height: 48px;
}

.welcome h2 {
  margin: 8px 0 0;
  font-size: 22px;
  font-weight: 500;
  letter-spacing: -0.02em;
}

.welcome p {
  max-width: 340px;
  margin: 0 0 8px;
  color: var(--ink-mid);
  font-size: 13px;
}

@container project-detail (max-width: 580px) {
  .project-heading {
    flex-wrap: wrap;
    padding: 20px;
  }

  .form-content {
    padding: 0 20px;
  }

  .project-status {
    margin-left: 0;
  }
}

@container projects-page (max-width: 600px) {
  .page-heading p {
    display: none;
  }
}

@media (max-width: 899px) {
  .projects {
    gap: 18px;
  }

  .workspace {
    grid-template-columns: minmax(0, 1fr);
  }

  .page-heading h1 {
    font-size: 24px;
  }

  .page-heading p {
    display: none;
  }

  .project-heading {
    padding-top: 12px;
  }
}

@media (min-width: 900px) and (max-width: 1150px) {
  .workspace {
    grid-template-columns: 260px minmax(0, 1fr);
    gap: 14px;
  }
}
</style>
