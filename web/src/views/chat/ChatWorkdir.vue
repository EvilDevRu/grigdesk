<template>
  <UiButton
    v-if="chat.workdirProtocol"
    variant="ghost"
    :aria-label="t('core.workdirTrigger', { name: directoryName })"
    v-tooltip="t('core.workdirWorkingIn', { path: currentDirectory || directory })"
    aria-haspopup="dialog"
    :aria-expanded="pickerOpen"
    :pressed="pickerOpen"
    :disabled="busy"
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
  <UiDialog
    v-model:open="pickerOpen"
    :title="t('core.workdirTitle')"
    size="compact"
    mobile-sheet
    :body-inset="false"
    :busy="busy"
    :dismissible="!busy"
    data-role="workdir-picker"
  >
    <template #title>
      <span class="workdir-heading">
        <span>{{ t('core.workdirTitle') }}</span>
        <UiIconButton :label="t('core.close')" :disabled="busy" @click="closePicker">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
               stroke-linecap="round" aria-hidden="true">
            <path d="m6 6 12 12M6 18 18 6" />
          </svg>
        </UiIconButton>
      </span>
    </template>
    <div class="workdir-content">
      <p class="workdir-location">
        <svg class="workdir-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="3" y="4" width="18" height="13" rx="2" />
          <path d="M8 21h8m-4-4v4" />
        </svg>
        {{ t('core.workdirOnComputer') }}
      </p>
      <div class="workdir-current">
        <span class="workdir-caption">{{ t('core.workdirCurrent') }}</span>
        <code class="workdir-path">{{ directory }}</code>
        <span v-if="sourceLabel" class="workdir-caption">{{ sourceLabel }}</span>
      </div>
      <div v-if="additionalCopies.length" class="workdir-copies">
        <span class="workdir-caption">{{ t('core.workdirExtraRepos') }}</span>
        <div v-for="copy in additionalCopies" :key="copy.key" class="workdir-copy">
          <span>{{ copy.key }}</span>
          <code class="workdir-path">{{ copy.path }}</code>
        </div>
      </div>
      <UiInlineMessage v-for="warning in preview?.target?.warnings || []" :key="warning" tone="warning">
        {{ warning }}
      </UiInlineMessage>
      <UiInlineMessage v-if="error" tone="danger">{{ error }}</UiInlineMessage>
      <template v-if="editable">
        <UiSegmentedControl v-model="mode" :label="t('core.workdirMethod')" :disabled="busy">
          <UiButton variant="ghost" :pressed="mode === 'catalog'" :disabled="busy" @click="mode = 'catalog'">
            {{ t('core.workdirCatalog') }}
          </UiButton>
          <UiButton variant="ghost" :pressed="mode === 'path'" :disabled="busy" @click="mode = 'path'">
            {{ t('core.workdirByPath') }}
          </UiButton>
        </UiSegmentedControl>
        <template v-if="mode === 'catalog'">
          <UiInput v-model="search" type="search" :aria-label="t('core.workdirSearch')"
                   :placeholder="t('core.workdirSearch')" autocomplete="off" :spellcheck="false" />
          <div class="workdir-list-heading">
            <span class="workdir-caption">{{ t('core.workdirAvailable') }}</span>
            <UiSpinner v-if="loadingProjects" :label="t('core.loading')" />
            <span v-else class="workdir-caption">{{ choices.length }}</span>
          </div>
          <div class="workdir-choices" :aria-label="t('core.workdirAvailable')" :aria-busy="loadingProjects">
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
                  <path :d="option.workdir.kind === 'grigdesk' ? NAV_ICONS.board : NAV_ICONS.projects" />
                </svg>
                <span class="workdir-choice-copy">
                  <span class="workdir-choice-title">{{ option.title }}</span>
                  <span class="workdir-choice-detail">{{ option.detail }}</span>
                </span>
                <svg v-if="option.selected" class="workdir-check" viewBox="0 0 24 24" fill="none"
                     stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
                     :aria-label="t('core.workdirCurrent')" role="img">
                  <path d="m5 12 4 4L19 6" />
                </svg>
              </span>
            </UiSelectableRow>
            <p v-if="!choices.length && !loadingProjects" class="workdir-empty" role="status">
              {{ t('core.workdirNoResults') }}
            </p>
          </div>
        </template>
        <form v-else class="workdir-form" @submit.prevent="choosePath">
          <UiField :label="t('core.workdirAbsolutePath')" :hint="t('core.workdirPathHint')">
            <UiInput v-model="pathInput" placeholder="/home/user/project" :disabled="busy"
                     autocomplete="off" autocapitalize="off" :spellcheck="false" />
          </UiField>
          <UiButton type="submit" variant="solid" tone="accent" :disabled="busy || !pathInput.trim()" block>
            {{ t('core.workdirChoose') }}
          </UiButton>
        </form>
      </template>
      <span v-else class="workdir-caption">{{ t('core.workdirManaged') }}</span>
      <UiButton v-if="needsTransfer" :disabled="busy" @click="confirmCurrent">
        {{ t('core.workdirTransfer') }}
      </UiButton>
    </div>
  </UiDialog>
  <UiDialog
    :open="Boolean(proposal)"
    title="Смена рабочей папки"
    :busy="Boolean(session?.workdirChanging)"
    @close="cancel"
  >
    <p>Работаем в: {{ proposal?.preview.target?.cwd }}</p>
    <p v-if="retrying">
      Сервер не подтвердил переход. «Повторить» отправит тот же запрос — второй выжимки и
      второго сброса памяти не будет.
    </p>
    <p v-else>Исполнитель начнёт новую сессию. Можно сохранить выжимку разговора или сбросить память.</p>
    <UiInlineMessage v-if="session?.error" tone="danger">{{ session.error }}</UiInlineMessage>
    <template #footer>
      <UiButton v-if="retrying" :disabled="session?.workdirChanging" @click="retry">Повторить</UiButton>
      <template v-else>
        <UiButton
          :disabled="session?.workdirChanging || !proposal?.preview.summaryAvailable
            || proposal?.preview.transfer === 'unavailable'"
          @click="chat.commitWorkdir(sid, 'summary')"
        >
          Сжать разговор и перейти
        </UiButton>
        <UiButton :disabled="session?.workdirChanging" @click="chat.commitWorkdir(sid, 'reset')">
          Перейти без выжимки
        </UiButton>
      </template>
      <UiButton variant="text" :disabled="session?.workdirChanging" @click="cancel">Отмена</UiButton>
    </template>
  </UiDialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import {
  UiButton,
  UiDialog,
  UiField,
  UiIconButton,
  UiInlineMessage,
  UiInput,
  UiSpinner,
  UiSelectableRow,
  UiSegmentedControl,
  t,
  vTooltip,
} from '../../ui.ts';
import { api } from '../../shared/apiClient.ts';
import { NAV_ICONS } from '../../shared/navIcons.ts';
import { normalizeChatWorkdir } from '../../../../shared/chat/chatWorkdir.ts';
import { useChatStore } from '../../stores/chat.ts';
import {
  chatWorkdirLabel, normalizeRecentWorkdirs, sameChatWorkdir,
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

interface ProjectOption {
  id: string;
  title?: string;
  archivedAt?: string | null;
}

const props = defineProps<{ sid: string; }>();

const chat = useChatStore();
const pickerOpen = ref(false);
const mode = ref<'catalog' | 'path'>('catalog');
const search = ref('');
const pathInput = ref('');
const loadingProjects = ref(false);
const projects = ref<ProjectOption[]>([]);
const error = ref('');

const session = computed<WorkdirSession | undefined>(() => (
  chat.sessions.find((entry: WorkdirSession) => entry.id === props.sid)
  || chat.archived.find((entry: WorkdirSession) => entry.id === props.sid)
));
const preview = computed(() => session.value?.workdirPreview);
const proposal = computed(() => session.value?.workdirProposal || null);
// Стратегия уже отправлена, а ответа нет: окно предлагает повтор того же запроса.
const retrying = computed(() => Boolean(proposal.value?.transfer) && !session.value?.workdirChanging);
const directory = computed(() => session.value?.workdirState?.committed?.cwd
  || preview.value?.target?.cwd || chatWorkdirLabel(session.value?.workdir));
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
const needsTransfer = computed(() => ['reseed', 'unavailable'].includes(preview.value?.transfer || ''));
const sourceLabel = computed(() => ({
  'task-copies': t('core.workdirTaskCopies'),
  'task-project': t('core.workdirTaskProject'),
  project: t('core.workdirProjectRepos'),
  path: t('core.workdirChosenDirectory'),
  grigdesk: t('core.workdirAppRepo'),
} as Record<string, string>)[preview.value?.target?.source || ''] || '');
const additionalCopies = computed(() => (
  (preview.value?.target?.copies || []).filter((copy) => copy.path !== directory.value)
));
// Текущий выбор и недавние идут первыми, остальные проекты дополняют каталог.
// Сравнение по контракту папки исключает повтор проекта из недавних в том же списке.
const choices = computed(() => {
  const current = normalizeChatWorkdir(session.value?.workdir);
  const candidates: WorkdirChoice[] = [
    ...(current ? [current] : []),
    ...normalizeRecentWorkdirs(chat.recentWorkdirs),
    ...projects.value.map((project): WorkdirChoice => ({
      kind: 'project',
      projectId: project.id,
      repoKey: null,
    })),
    { kind: 'grigdesk' },
  ];
  const unique = candidates.filter((workdir, index) => (
    !candidates.slice(0, index).some((previous) => sameChatWorkdir(previous, workdir))
  ));
  const query = search.value.trim().toLocaleLowerCase();

  return unique.map((workdir) => ({
    key: JSON.stringify(workdir),
    workdir,
    title: choiceTitle(workdir),
    detail: choiceDetail(workdir),
    selected: sameChatWorkdir(workdir, session.value?.workdir),
  })).filter((option) => `${option.title} ${option.detail}`.toLocaleLowerCase().includes(query));
});

/**
 * Название каталога остаётся коротким, а полный путь виден второй строкой.
 * У проекта показываем заголовок паспорта; пока каталог грузится, доступен его id.
 */
function choiceTitle(workdir: WorkdirChoice): string {
  if (workdir.kind === 'project') {
    return projects.value.find((project) => project.id === workdir.projectId)?.title || workdir.projectId;
  }
  if (workdir.kind === 'path') {
    return workdir.path.split('/').filter(Boolean).at(-1) || workdir.path;
  }

  return 'GrigDesk';
}

/**
 * Подпись различает проекты и одноимённые каталоги в недавних выборах.
 * Фактические пути проектов не угадываются по их названиям.
 */
function choiceDetail(workdir: WorkdirChoice): string {
  if (workdir.kind === 'path') {
    return workdir.path;
  }
  if (workdir.kind === 'project') {
    return workdir.repoKey
      ? t('core.workdirProjectRepo', { name: workdir.repoKey })
      : t('core.workdirProjectMain');
  }

  return t('core.workdirAppFolder');
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
 * Каталог проектов нужен только открытому окошку выбора,
 * поэтому грузится при открытии, а не после каждого хода.
 */
async function loadProjects(): Promise<void> {
  loadingProjects.value = true;

  try {
    const catalog = await api.get('/api/projects') as { projects?: ProjectOption[]; };

    projects.value = (catalog.projects || []).filter((project) => !project.archivedAt);
  } catch (failure) {
    error.value ||= (failure as Error).message;
  } finally {
    loadingProjects.value = false;
  }
}

/**
 * Каждый вход начинает выбор с общего каталога без прежнего поискового фильтра.
 * Фокус остаётся на кнопке закрытия: телефон не открывает клавиатуру без запроса ввода.
 */
async function openPicker(): Promise<void> {
  mode.value = 'catalog';
  search.value = '';
  pathInput.value = '';
  error.value = '';
  pickerOpen.value = true;

  await Promise.all([refresh(), loadProjects()]);
}

watch(() => props.sid, closePicker);

// Обновление зависит от значений выбора, а не от ссылок объектов ACK:
// так нет цикла preview → save → новый объект workdir → preview.
watch(() => JSON.stringify([
  props.sid, chat.workdirProtocol, session.value?.workdir, session.value?.taskId, session.value?.modelRef,
  busy.value,
]), refresh, { immediate: true });
</script>

<style scoped>
.workdir-content {
  display: flex;
  flex: 1 0 auto;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
  min-height: 0;
  padding: 0 20px 20px;
  overflow-wrap: anywhere;
}

.workdir-heading,
.workdir-list-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.workdir-location {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 1.5;
}

.workdir-current {
  display: grid;
  gap: 4px;
  padding: 12px 14px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface-2);
}

.workdir-copies,
.workdir-form {
  display: grid;
  gap: 12px;
  min-width: 0;
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

.workdir-copy {
  display: grid;
  gap: 2px;
  font-size: 12px;
}

.workdir-list-heading {
  margin-bottom: -8px;
}

.workdir-choices {
  display: grid;
  grid-auto-rows: max-content;
  align-content: start;
  gap: 4px;
  min-height: 72px;
  max-height: 252px;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
}

.workdir-choice {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.workdir-choice-copy {
  display: grid;
  flex: 1;
  gap: 3px;
  min-width: 0;
}

.workdir-choice-title {
  font-size: 13px;
  font-weight: 500;
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
  .workdir-content {
    padding-right: max(16px, env(safe-area-inset-right));
    padding-bottom: max(20px, env(safe-area-inset-bottom));
    padding-left: max(16px, env(safe-area-inset-left));
  }
}
</style>
