<template>
  <div v-if="chat.workdirProtocol && editable" class="session-option project-option">
    <span class="option-label">{{ t('core.chatOptionProject') }}</span>
    <UiSelect
      :model-value="projectId"
      :aria-label="t('core.chatOptionProject')"
      :disabled="busy || frozen"
      compact searchable
      data-context="chat-session-toolbar"
      data-role="chat-project"
      v-tooltip="projects.error || projectTitle"
      @update:model-value="chooseProject"
    >
      <option value="">{{ t('core.chatProjectNone') }}</option>
      <option v-if="projectId && !project" :value="projectId" hidden disabled>{{ projectId }}</option>
      <option v-for="item in projects.items" :key="item.id" :value="item.id">{{ item.title }}</option>
      <template #value-leading>
        <ProjectAvatar compact :id="projectId" :title="projectId ? projectTitle : ''" :icon="project?.icon" />
      </template>
      <template #option-leading="{ option }">
        <ProjectAvatar compact :id="option.value" :title="option.value ? option.label : ''"
                       :icon="projectById.get(option.value)?.icon" />
      </template>
    </UiSelect>
  </div>
  <div v-if="chat.workdirProtocol" class="session-option workdir-option">
    <span class="option-label">{{ t('core.chatOptionWorkdir') }}</span>
    <UiButton
      variant="ghost"
      :aria-label="t('core.workdirTrigger', { name: directoryName })"
      v-tooltip="t('core.workdirWorkingIn', { path: currentDirectory || directory })"
      :aria-haspopup="embedded ? undefined : 'dialog'"
      :aria-controls="pickerOpen ? pickerId : undefined"
      :aria-expanded="pickerOpen"
      :pressed="pickerOpen"
      :disabled="busy || frozen"
      data-context="chat-workdir"
      @click="openPicker"
    >
      <template #leading>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
             stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path :d="NAV_ICONS.projects" />
        </svg>
      </template>
      {{ directoryName }}
      <template #trailing>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
             stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path :d="pickerOpen ? 'm7 14 5-5 5 5' : 'm7 10 5 5 5-5'" />
        </svg>
      </template>
    </UiButton>
    <ChatWorkdirPicker v-model:open="pickerOpen" :id="pickerId" :embedded="embedded" :busy="busy">
      <div class="workdir-content" :class="{ 'workdir-content--embedded': embedded }">
        <UiInlineMessage v-for="warning in preview?.target?.warnings || []" :key="warning" tone="warning">
          {{ warning }}
        </UiInlineMessage>
        <UiInlineMessage v-if="error" tone="danger">{{ error }}</UiInlineMessage>
        <UiInlineMessage v-if="editable && projectId && projects.error" tone="danger">
          {{ projects.error }}
        </UiInlineMessage>
        <template v-if="editable">
          <div v-if="mode === 'catalog'" class="workdir-catalog">
            <div class="workdir-toolbar">
              <UiSearchInput v-model="search" :aria-label="t('core.workdirSearch')" :disabled="busy"
                             :placeholder="t('core.search')" autocomplete="off" :spellcheck="false" />
              <UiButton v-if="!projectId" ref="pathModeButton" data-context="workdir-path-mode"
                        :disabled="busy" @click="showPathInput">
                <template #leading>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
                       stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="m8 6-5 6 5 6m8-12 5 6-5 6M14 4l-4 16" />
                  </svg>
                </template>
                {{ t('core.workdirByPath') }}
              </UiButton>
            </div>
            <div class="workdir-list-heading">
              <span class="workdir-caption">
                {{ projectId ? t('core.workdirProjectRepos') : t('core.workdirAvailable') }}
              </span>
              <UiSpinner v-if="projectId && projects.loading" :label="t('core.loading')" />
            </div>
            <div class="workdir-choices" role="group" :aria-label="t('core.workdirAvailable')"
                 :aria-busy="Boolean(projectId && projects.loading)">
              <UiSelectableRow
                v-for="option in choices"
                :key="option.key"
                :selected="option.selected"
                :pressed="option.selected"
                :disabled="busy"
                data-context="workspace-catalog"
                @select="choose(option.workdir)"
              >
                <span class="workdir-choice">
                  <svg class="workdir-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                       stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path :d="option.workdir.kind === 'grigdesk' ? NAV_ICONS.home : NAV_ICONS.projects" />
                  </svg>
                  <span class="workdir-choice-copy">
                    <span class="workdir-choice-heading">
                      <span class="workdir-choice-title">{{ option.title }}</span>
                      <span v-if="option.additional || (showAccess && option.selected)" class="workdir-caption">
                        {{ t(showAccess
                          ? (option.selected ? 'core.chatAccessReadWrite' : 'core.chatAccessReadOnly')
                          : 'core.workdirExtraRepo') }}
                      </span>
                    </span>
                    <span v-if="option.detail" class="workdir-choice-detail">{{ option.detail }}</span>
                  </span>
                  <svg v-if="option.selected" class="workdir-check" viewBox="0 0 24 24" fill="none"
                       stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
                       :aria-label="t('core.workdirCurrent')" role="img">
                    <path d="m5 13 4 4L19 7" />
                  </svg>
                </span>
              </UiSelectableRow>
              <p v-if="!choices.length && !(projectId && projects.loading)" class="workdir-empty"
                 role="status">
                {{ t('core.workdirNoResults') }}
              </p>
            </div>
          </div>
          <div v-else class="workdir-path-editor">
            <UiButton variant="ghost" size="compact" :disabled="busy" @click="showCatalog">
              <template #leading>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
                     stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="m10 6-6 6 6 6M4 12h16" />
                </svg>
              </template>
              {{ t('core.workdirBackToCatalog') }}
            </UiButton>
            <form class="workdir-form" @submit.prevent="choosePath">
              <UiField :label="t('core.workdirAbsolutePath')" :hint="t('core.workdirPathHint')">
                <UiInput ref="pathField" v-model="pathInput" placeholder="/home/user/project" :disabled="busy"
                         autocomplete="off" autocapitalize="off" :spellcheck="false" />
              </UiField>
              <UiButton type="submit" variant="solid" tone="accent" :disabled="busy || !pathInput.trim()">
                {{ t('core.workdirChoose') }}
              </UiButton>
            </form>
          </div>
        </template>
        <div class="workdir-current">
          <svg class="workdir-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path :d="NAV_ICONS.projects" />
          </svg>
          <div class="workdir-current-copy">
            <span class="workdir-caption">
              {{ t('core.workdirCurrent') }}<template v-if="sourceLabel"> · {{ sourceLabel }}</template>
            </span>
            <code class="workdir-path">{{ directory }}</code>
          </div>
        </div>
        <section v-if="unlistedCopies.length" class="workdir-copies" :aria-labelledby="`${pickerId}-copies`">
          <h3 :id="`${pickerId}-copies`" class="workdir-caption">{{ t('core.workdirExtraRepos') }}</h3>
          <ul class="workdir-copy-list">
            <li v-for="copy in unlistedCopies" :key="copy.key" class="workdir-choice">
              <ProjectIcon class="workdir-icon" name="folder" />
              <span class="workdir-choice-copy">
                <span class="workdir-choice-title">{{ copy.key }}</span>
                <span v-if="showAccess" class="workdir-caption">{{ t('core.chatAccessReadOnly') }}</span>
                <code class="workdir-path">{{ copy.path }}</code>
              </span>
            </li>
          </ul>
        </section>
        <span v-if="!editable" class="workdir-caption">{{ t('core.workdirManaged') }}</span>
        <UiButton v-if="needsTransfer" :disabled="busy" @click="confirmCurrent">
          {{ t('core.workdirTransfer') }}
        </UiButton>
      </div>
    </ChatWorkdirPicker>
  </div>
  <UiDialog
    :open="Boolean(proposal)"
    layer="confirm"
    size="compact"
    mobile-sheet
    :title="t('core.chatSmenaRabocheyPapki')"
    :busy="Boolean(session?.workdirChanging)"
    @close="cancel"
  >
    <p>{{ t('core.workdirTransferTarget', { path: proposal?.preview.target?.cwd || '' }) }}</p>
    <p v-if="transferStatus" class="workdir-transfer-status" role="status">
      <UiSpinner decorative />
      {{ transferStatus }}
    </p>
    <p v-else-if="retrying">{{ t('core.chatServerNePodtverdilPerehod') }}</p>
    <p v-else-if="!session?.error">
      {{ summaryAvailable ? t('core.chatIspolnitelNachnetNovuyuSessiyu') : t('core.workdirSummaryUnavailable') }}
    </p>
    <UiInlineMessage v-if="session?.error" tone="danger">{{ session.error }}</UiInlineMessage>
    <template #footer>
      <UiButton :disabled="session?.workdirChanging" @click="cancel">{{ t('core.cancel') }}</UiButton>
      <UiButton v-if="retrying" variant="solid" tone="accent" @click="retry">
        {{ t('core.pluginNotificationsRetry') }}
      </UiButton>
      <template v-else>
        <UiButton :disabled="session?.workdirChanging" @click="chat.commitWorkdir(sid, 'reset')">
          {{ t('core.chatPereytiBezVyzhimki') }}
        </UiButton>
        <UiButton
          v-if="summaryAvailable"
          variant="solid"
          tone="accent"
          :disabled="session?.workdirChanging"
          @click="chat.commitWorkdir(sid, 'summary')"
        >
          {{ t('core.chatSzhatRazgovorIPereyti') }}
        </UiButton>
      </template>
    </template>
  </UiDialog>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue';

import {
  UiButton,
  UiDialog,
  UiField,
  UiInlineMessage,
  UiInput,
  UiSearchInput,
  UiSelect,
  UiSpinner,
  UiSelectableRow,
  showToast,
  t,
  vTooltip,
} from '../../ui.ts';
import ChatWorkdirPicker from './ChatWorkdirPicker.vue';
import ProjectAvatar from '../projects/ProjectAvatar.vue';
import ProjectIcon from '../projects/ProjectIcon.vue';
import { loadProjects, useProjectsStore, watchProjects } from '../../actions/projects/index.ts';
import { NAV_ICONS } from '../../shared/navIcons.ts';
import { useChatStore } from '../../stores/chat.ts';
import {
  chatWorkdirLabel, normalizeChatWorkdir, normalizeRecentWorkdirs, sameChatWorkdir,
} from '../../../../shared/chat/chatWorkdir.ts';
import type { ChatWorkdir as WorkdirChoice } from '../../../../shared/chat/chatWorkdir.ts';

interface WorkdirPreview {
  transfer?: string;
  summaryAvailable?: boolean;
  target?: {
    cwd?: string;
    source?: string;
    copies?: Array<{ key: string; path: string; }>;
    warnings?: string[];
  };
}

interface WorkdirSession {
  id: string;
  taskId?: string | number | null;
  purpose?: string;
  workdir?: unknown;
  modelRef?: unknown;
  error?: string | null;
  sending?: boolean;
  compacting?: boolean;
  sessionResetting?: boolean;
  workdirChanging?: boolean;
  workdirPreview?: WorkdirPreview | null;
  workdirState?: { committed?: { cwd?: string; }; } | null;
  workdirProposal?: {
    transfer?: string | null;
    preview: WorkdirPreview;
  } | null;
}

const props = withDefaults(defineProps<{
  sid: string;
  embedded?: boolean;
  active?: boolean;
  frozen?: boolean;
  showAccess?: boolean;
}>(), {
  embedded: false,
  active: true,
});

const chat = useChatStore();
const projects = useProjectsStore().activeCatalog;
const pickerId = `chat-workdir-picker-${useId()}`;
const pickerOpen = ref(false);
const mode = ref<'catalog' | 'path'>('catalog');
const search = ref('');
const pathInput = ref('');
const pathField = ref<InstanceType<typeof UiInput> | null>(null);
const pathModeButton = ref<InstanceType<typeof UiButton> | null>(null);
const error = ref('');

const session = computed<WorkdirSession | undefined>(() => (
  chat.sessions.find((entry: WorkdirSession) => entry.id === props.sid)
  || chat.archived.find((entry: WorkdirSession) => entry.id === props.sid)
));
const preview = computed(() => session.value?.workdirPreview);
const proposal = computed(() => session.value?.workdirProposal || null);
// Стратегия уже отправлена, а ответа нет: окно предлагает повтор того же запроса.
const retrying = computed(() => Boolean(proposal.value?.transfer) && !session.value?.workdirChanging);
const summaryAvailable = computed(() => Boolean(proposal.value?.preview.summaryAvailable)
  && proposal.value?.preview.transfer !== 'unavailable');
const transferStatus = computed(() => {
  if (!session.value?.workdirChanging || !proposal.value?.transfer) {
    return '';
  }

  return proposal.value.transfer === 'summary'
    ? t('core.chatSzhimayuKontekst')
    : t('core.workdirTransferPending');
});
const directory = computed(() => session.value?.workdirState?.committed?.cwd
  || preview.value?.target?.cwd || chatWorkdirLabel(session.value?.workdir, t('core.workdirHomeFolder')));
// Подпись шапки показывает подтверждённую папку, даже если предпросмотр предлагает другую.
// До первого подтверждения серверный preview разрешает фактический путь сохранённого выбора.
const currentDirectory = computed(() => session.value?.workdirState?.committed?.cwd
  || preview.value?.target?.cwd || '');
const directoryName = computed(() => (
  currentDirectory.value
    ? currentDirectory.value.split('/').filter(Boolean).at(-1) || '/'
    : t('core.workdirFolder')
));
const busy = computed(() => Boolean(session.value?.sending || session.value?.compacting
  || session.value?.sessionResetting || session.value?.workdirChanging));
const editable = computed(() => !session.value?.taskId && session.value?.purpose !== 'companion');
const currentWorkdir = computed(() => normalizeChatWorkdir(session.value?.workdir));
const projectId = computed(() => currentWorkdir.value?.kind === 'project'
  ? currentWorkdir.value.projectId : '');
const projectById = computed(() => new Map(projects.items.map((item) => [item.id, item])));
const project = computed(() => projectById.value.get(projectId.value));
const projectTitle = computed(() => project.value?.title || projectId.value || t('core.chatProjectNone'));
const defaultRepo = computed(() => {
  const items = project.value?.repos ?? [];

  return items.find((repo) => repo.key === project.value?.defaultRepoKey) ?? items[0];
});
const needsTransfer = computed(() => ['reseed', 'unavailable'].includes(preview.value?.transfer || ''));
const sourceLabel = computed(() => ({
  'task-copies': t('core.workdirTaskCopies'),
  'task-project': t('core.workdirTaskProject'),
  project: t('core.workdirProjectRepos'),
  path: t('core.workdirChosenDirectory'),
  grigdesk: t('core.workdirHomeFolder'),
} as Record<string, string>)[preview.value?.target?.source || ''] || '');
const additionalCopies = computed(() => (
  (preview.value?.target?.copies || []).filter((copy) => (
    copy.path !== directory.value && copy.path !== preview.value?.target?.cwd
  ))
));
const additionalPaths = computed(() => new Set(additionalCopies.value.map((copy) => copy.path)));
// Текущий выбор остаётся видимым, даже когда паспорт проекта уже недоступен.
// Остальные варианты относятся к проекту из шапки или к свободным папкам.
const catalogChoices = computed(() => {
  const current = currentWorkdir.value;
  const candidates: WorkdirChoice[] = [
    ...(current ? [current] : []),
    ...(projectId.value ? projectFolders() : [
      ...normalizeRecentWorkdirs(chat.recentWorkdirs).filter((item) => item.kind === 'path'),
      { kind: 'grigdesk' } as const,
    ]),
  ];
  const unique = candidates.filter((workdir, index) => (
    !candidates.slice(0, index).some((previous) => sameChatWorkdir(previous, workdir))
  ));

  return unique.map((workdir) => {
    const detail = choiceDetail(workdir);
    const selected = sameChatWorkdir(workdir, current);

    return {
      key: JSON.stringify(workdir),
      workdir,
      title: choiceTitle(workdir),
      detail,
      selected,
      additional: !selected && workdir.kind === 'project' && additionalPaths.value.has(detail),
    };
  });
});
const choices = computed(() => {
  const query = search.value.trim().toLocaleLowerCase();

  return catalogChoices.value.filter((option) => (
    `${option.title} ${option.detail}`.toLocaleLowerCase().includes(query)
  ));
});
// Поиск скрывает строки каталога, поэтому совпадающие пути не возвращаются под ним при фильтрации.
// В чате с каталогом только для чтения все дополнительные копии показаны отдельными строками.
const unlistedCopies = computed(() => {
  if (!editable.value || mode.value !== 'catalog') {
    return additionalCopies.value;
  }

  const listedPaths = new Set(catalogChoices.value
    .filter((option) => option.additional)
    .map((option) => option.detail));

  return additionalCopies.value.filter((copy) => !listedPaths.has(copy.path));
});

/**
 * Ключ null следует за основным репозиторием паспорта, явный ключ закрепляет папку.
 * Основной репозиторий показываем одним вариантом, сохраняя текущий явный выбор в списке.
 */
function projectFolders(): WorkdirChoice[] {
  const id = projectId.value;
  const main = defaultRepo.value;
  const current = currentWorkdir.value;

  if (!main || !project.value) {
    return [];
  }

  const automatic: WorkdirChoice[] = current?.kind === 'project' && current.repoKey === main.key
    ? []
    : [{
      kind: 'project',
      projectId: id,
      repoKey: null,
    }];

  return [
    ...automatic,
    ...project.value.repos
      .filter((repo) => repo.key !== main.key)
      .map((repo): WorkdirChoice => ({
        kind: 'project',
        projectId: id,
        repoKey: repo.key,
      })),
  ];
}

/**
 * В проекте различаем папки по ключам репозиториев из паспорта.
 * Для произвольной папки достаточно последнего сегмента пути.
 */
function choiceTitle(workdir: WorkdirChoice): string {
  if (workdir.kind === 'project') {
    return workdir.repoKey || t('core.workdirProjectMain');
  }
  if (workdir.kind === 'path') {
    return workdir.path.split('/').filter(Boolean).at(-1) || workdir.path;
  }

  return t('core.workdirHomeFolder');
}

/**
 * Поиск видит пути из паспорта; подтверждённый путь запуска приходит от сервера.
 * У сохранённого выбора без доступного паспорта остаётся только его название.
 */
function choiceDetail(workdir: WorkdirChoice): string {
  if (workdir.kind === 'path') {
    return workdir.path;
  }
  if (workdir.kind === 'project') {
    return workdir.repoKey
      ? project.value?.repos.find((repo) => repo.key === workdir.repoKey)?.dir || ''
      : defaultRepo.value?.dir || '';
  }

  return t('core.workdirHomeFolderDetail');
}

/**
 * Смена проекта использует тот же переход, что выбор папки.
 * Селект читает подтверждённый выбор, пока сервер проверяет новую папку и память.
 */
async function chooseProject(value: string | number | null): Promise<void> {
  const id = String(value ?? '');

  if (!editable.value || busy.value || props.frozen || id === projectId.value
    || (id && !projectById.value.has(id))) {
    return;
  }

  const workdir: WorkdirChoice = id ? {
    kind: 'project',
    projectId: id,
    repoKey: null,
  } : { kind: 'grigdesk' };

  closePicker();
  await choose(workdir);

  if (error.value && !proposal.value) {
    showToast({
      id: `chat-project-change:${props.sid}`,
      title: t('core.chatSmenaRabocheyPapki'),
      body: error.value,
      tone: 'danger',
    });
  }
}

/**
 * Папка и задача проходят общий серверный переход.
 * Предпочтение меняется лишь после успешного явного выбора папки.
 */
async function choose(workdir: WorkdirChoice): Promise<void> {
  error.value = '';

  const accepted = await chat.proposeWorkdir(props.sid, { taskId: null, workdir }, true);

  error.value = session.value?.error || '';

  if (accepted || proposal.value) {
    closePicker();
  }
}

/**
 * Сервер принимает только абсолютный путь. Относительный или «~/…» объясняем на месте,
 * а не отказом сервера про «повреждённый выбор».
 */
function choosePath(): Promise<void> | void {
  const path = pathInput.value.trim();

  if (!path.startsWith('/')) {
    error.value = t('core.workdirInvalidPath');

    return;
  }

  return choose({ kind: 'path', path });
}

function closePicker(): void {
  pickerOpen.value = false;
}

/**
 * Явный переход к ручному вводу сразу переносит фокус в поле.
 * При обычном открытии окна клавиатура по-прежнему не вызывается.
 */
async function showPathInput(): Promise<void> {
  mode.value = 'path';
  await nextTick();
  pathField.value?.focus();
}

/**
 * Возврат восстанавливает фокус у действия, которое открыло ручной ввод.
 * Поиск и черновик пути сохраняются до закрытия окна.
 */
async function showCatalog(): Promise<void> {
  mode.value = 'catalog';
  await nextTick();
  pathModeButton.value?.focus();
}

function retry(): void {
  void chat.commitWorkdir(props.sid, proposal.value?.transfer || '');
}

function cancel(): void {
  if (session.value && !session.value.workdirChanging) {
    session.value.workdirProposal = null;
  }
}

/**
 * Закрываем выбор при переходе к подтверждению переноса, чтобы два слоя не перекрывались.
 * Серверная ошибка остаётся в открытом выборе рядом с текущей папкой.
 */
async function confirmCurrent(): Promise<void> {
  if (!session.value) {
    return;
  }

  const accepted = await chat.proposeWorkdir(props.sid, {
    taskId: session.value.taskId || null,
    workdir: normalizeChatWorkdir(session.value.workdir),
  });

  error.value = session.value?.error || '';

  if (accepted || proposal.value) {
    closePicker();
  }
}

/**
 * Предпросмотр выбора этого чата: путь, копии и нужен ли перенос.
 * Чистый чат при этом на сервер заново не отправляется.
 */
async function refresh(): Promise<void> {
  if (!chat.workdirProtocol || busy.value) {
    return;
  }

  try {
    await chat.previewWorkdir(props.sid);
    error.value = '';
  } catch (failure) {
    error.value = (failure as Error).message;
  }
}

/**
 * Каждый вход начинает поиск заново в пределах текущего проекта.
 * Встроенный выбор сворачивается повторным нажатием; открытие не вызывает клавиатуру.
 */
async function openPicker(): Promise<void> {
  if (props.embedded && pickerOpen.value) {
    closePicker();

    return;
  }

  mode.value = 'catalog';
  search.value = '';
  pathInput.value = '';
  error.value = '';
  pickerOpen.value = true;

  if (editable.value && !projects.loading && (!projects.loaded || projects.error)) {
    void loadProjects('active');
  }

  await refresh();
}

watch(() => Boolean(chat.workdirProtocol && editable.value && session.value), (enabled, _, onCleanup) => {
  if (!enabled) {
    return;
  }

  onCleanup(watchProjects('active'));

  if (!projects.loaded && !projects.loading) {
    void loadProjects('active');
  }
}, { immediate: true });

watch(() => props.sid, closePicker);
watch(projectId, closePicker);
watch(() => props.embedded, closePicker);
watch(() => props.active, (active) => {
  if (!active) {
    closePicker();
  }
});

// Обновление зависит от значений выбора, а не от ссылок объектов ACK:
// так нет цикла preview → save → новый объект workdir → preview.
watch(() => JSON.stringify([
  props.sid, chat.workdirProtocol, session.value?.workdir, session.value?.taskId, session.value?.modelRef,
  busy.value,
]), refresh, { immediate: true });
</script>

<style scoped>
.workdir-transfer-status {
  display: flex;
  align-items: center;
  gap: 8px;
}

.session-option {
  display: contents;
}

.option-label {
  display: none;
}

.project-option > .ui-select-wrap {
  flex: 0 1 auto;
  min-width: 0;
  max-width: min(200px, 33%);
}

.project-option :deep(.ui-select) {
  max-width: 100%;
}

.workdir-content {
  display: flex;
  flex: 1 0 auto;
  flex-direction: column;
  align-items: stretch;
  gap: 12px;
  min-width: 0;
  min-height: 0;
  padding: 16px 20px 20px;
  overflow-wrap: anywhere;
}

.workdir-list-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.workdir-current-copy {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.workdir-content--embedded {
  padding: 12px 0 0;
}

.workdir-catalog,
.workdir-path-editor {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}

.workdir-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.workdir-toolbar > :first-child {
  flex: 1;
  min-width: 0;
}

.workdir-current {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding-top: 14px;
  border-top: 1px solid var(--line);
}

.workdir-current > .workdir-icon {
  margin-top: 2px;
}

.workdir-copies,
.workdir-form {
  display: grid;
  gap: 12px;
  min-width: 0;
}

.workdir-form > :last-child,
.workdir-path-editor > .ui-button,
.workdir-content > .ui-button {
  justify-self: start;
  align-self: flex-start;
}

.workdir-caption,
.workdir-choice-detail {
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 1.5;
}

.workdir-path {
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}

.workdir-copies > h3 {
  margin: 0;
  font-weight: 400;
}

.workdir-copy-list {
  display: grid;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.workdir-list-heading {
  padding: 2px 10px 0;
  margin-bottom: -6px;
}

.workdir-choices {
  display: grid;
  grid-auto-rows: max-content;
  align-content: start;
  gap: 2px;
  min-height: 72px;
  max-height: 340px;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  scrollbar-width: thin;
  scrollbar-color: var(--ink-low) transparent;
}

.workdir-choice {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.workdir-choice-copy {
  display: grid;
  flex: 1;
  gap: 3px;
  min-width: 0;
}

.workdir-choice-heading {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  column-gap: 8px;
}

.workdir-choice-title {
  font-size: 13px;
  font-weight: 400;
  line-height: 1.5;
}

.workdir-choice-title,
.workdir-choice-detail {
  overflow-wrap: anywhere;
}

.workdir-icon,
.workdir-check {
  flex: none;
  width: 18px;
  height: 18px;
}

.workdir-icon {
  color: var(--ink-mid);
}

.workdir-check {
  color: var(--accent);
}

.workdir-empty {
  margin: 0;
  padding: 20px 8px;
  color: var(--ink-mid);
  font-size: 13px;
  line-height: 1.6;
  text-align: center;
}

@media (max-width: 600px) {
  .project-option > .ui-select-wrap {
    max-width: 100%;
  }

  .workdir-content:not(.workdir-content--embedded) {
    padding-right: max(16px, env(safe-area-inset-right));
    padding-bottom: max(20px, env(safe-area-inset-bottom));
    padding-left: max(16px, env(safe-area-inset-left));
  }
}
</style>
