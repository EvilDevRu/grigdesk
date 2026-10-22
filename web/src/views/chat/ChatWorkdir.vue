<template>
  <UiPopover
    v-if="chat.workdirProtocol"
    placement="bottom-end"
    aria-label="Рабочая папка"
    :style="{ width: '420px', maxWidth: 'calc(100vw - 20px)' }"
    @update:open="onOpen"
  >
    <template #trigger="{ open }">
      <UiButton
        variant="ghost"
        :aria-label="`Рабочая папка: ${directoryName}`"
        v-tooltip="`Работаем в: ${currentDirectory || directory}`"
        :pressed="open"
        :disabled="busy"
        data-context="chat-workdir"
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
            <path :d="open ? 'm7 14 5-5 5 5' : 'm7 10 5 5 5-5'" />
          </svg>
        </template>
      </UiButton>
    </template>
    <template #default="{ close }">
      <div class="workdir-content">
        <div class="workdir-current">
          <div class="workdir-heading">
            <strong>Рабочая папка</strong>
            <span class="workdir-caption">Сейчас</span>
          </div>
          <code class="workdir-path">{{ directory }}</code>
          <span v-if="sourceLabel" class="workdir-caption">{{ sourceLabel }}</span>
        </div>
        <div v-if="additionalCopies.length" class="workdir-copies">
          <span class="workdir-caption">Дополнительные репозитории</span>
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
          <section class="workdir-section" aria-label="Быстрый выбор">
            <span class="workdir-caption">Быстрый выбор</span>
            <div class="workdir-choices">
              <UiSelectableRow
                v-for="option in quickChoices"
                :key="option.key"
                :selected="option.selected"
                :pressed="option.selected"
                :disabled="busy"
                @select="choose(option.workdir, close)"
              >
                <span class="workdir-choice">
                  <svg class="workdir-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                       stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path :d="option.workdir.kind === 'grigdesk' ? NAV_ICONS.board : NAV_ICONS.projects" />
                  </svg>
                  <span class="workdir-choice-copy">
                    <span class="workdir-choice-title" v-tooltip="option.title">{{ option.title }}</span>
                    <span class="workdir-choice-detail" v-tooltip="option.detail">{{ option.detail }}</span>
                  </span>
                  <svg v-if="option.selected" class="workdir-check" viewBox="0 0 24 24" fill="none"
                       stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
                       aria-label="Текущая папка" role="img">
                    <path d="m5 12 4 4L19 6" />
                  </svg>
                </span>
              </UiSelectableRow>
            </div>
          </section>
          <div class="workdir-section">
            <UiField label="Проект">
              <UiSelect :model-value="''" :disabled="busy" @change="onProjectChange($event, close)">
                <option value="">Выбрать проект…</option>
                <option v-for="project in projects" :key="project.id" :value="project.id">
                  {{ project.title || project.id }}
                </option>
              </UiSelect>
            </UiField>
            <form class="workdir-form" @submit.prevent="choosePath(close)">
              <UiField label="Другая папка" hint="Путь на машине, где работает GrigDesk">
                <UiInput v-model="pathInput" placeholder="Абсолютный путь" :disabled="busy"
                         autocomplete="off" :spellcheck="false" />
              </UiField>
              <UiButton type="submit" tone="accent" :disabled="busy || !pathInput.trim()" block>
                Выбрать папку
              </UiButton>
            </form>
          </div>
        </template>
        <span v-else class="workdir-caption">Папка определяется задачей или назначением этого чата.</span>
        <UiButton v-if="needsTransfer" :disabled="busy" @click="confirmCurrent(close)">
          Перенести разговор
        </UiButton>
      </div>
    </template>
  </UiPopover>
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
  UiInlineMessage,
  UiInput,
  UiPopover,
  UiSelect,
  UiSelectableRow,
  vTooltip,
} from '../../ui.ts';
import type { UiOverlayContentSlotProps } from '../../ui.ts';
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

type ClosePopover = UiOverlayContentSlotProps['close'];

const props = defineProps<{ sid: string; }>();

const chat = useChatStore();
const pathInput = ref('');
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
const directory = computed(() => preview.value?.target?.cwd
  || session.value?.workdirState?.committed?.cwd || chatWorkdirLabel(session.value?.workdir));
// Подпись шапки показывает подтверждённую папку, даже если предпросмотр предлагает другую.
// До первого подтверждения серверный preview разрешает фактический путь сохранённого выбора.
const currentDirectory = computed(() => session.value?.workdirState?.committed?.cwd
  || preview.value?.target?.cwd || '');
const directoryName = computed(() => (
  currentDirectory.value ? currentDirectory.value.split('/').filter(Boolean).at(-1) || '/' : 'Папка'
));
const busy = computed(() => Boolean(session.value?.sending || session.value?.compacting
  || session.value?.sessionResetting || session.value?.workdirChanging));
const editable = computed(() => !session.value?.taskId && session.value?.purpose !== 'companion');
const needsTransfer = computed(() => ['reseed', 'unavailable'].includes(preview.value?.transfer || ''));
const sourceLabel = computed(() => ({
  'task-copies': 'Рабочие копии задачи',
  'task-project': 'Репозитории проекта задачи',
  project: 'Репозитории проекта',
  path: 'Выбранный каталог',
  grigdesk: 'Репозиторий GrigDesk',
} as Record<string, string>)[preview.value?.target?.source || ''] || '');
const additionalCopies = computed(() => (
  (preview.value?.target?.copies || []).filter((copy) => copy.path !== directory.value)
));
const quickChoices = computed(() => (
  [
    { kind: 'grigdesk' } as WorkdirChoice,
    ...normalizeRecentWorkdirs(chat.recentWorkdirs).filter((workdir) => workdir.kind !== 'grigdesk'),
  ].map((workdir) => ({
    key: JSON.stringify(workdir),
    workdir,
    title: choiceTitle(workdir),
    detail: choiceDetail(workdir),
    selected: sameChatWorkdir(workdir, session.value?.workdir),
  }))
));

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
    return workdir.repoKey ? `Проект · ${workdir.repoKey}` : 'Проект · основной репозиторий';
  }

  return 'Папка GrigDesk';
}

/**
 * Папка и задача проходят общий серверный переход.
 * Предпочтение меняется лишь после успешного явного выбора папки.
 */
async function choose(workdir: WorkdirChoice, close: ClosePopover): Promise<void> {
  error.value = '';

  const accepted = await chat.proposeWorkdir(props.sid, { taskId: null, workdir }, true);

  error.value = session.value?.error || '';

  if (accepted || proposal.value) {
    close('action');
  }
}

/**
 * Сервер принимает только абсолютный путь. Относительный или «~/…» объясняем на месте,
 * а не отказом сервера про «повреждённый выбор».
 */
function choosePath(close: ClosePopover): Promise<void> | void {
  const path = pathInput.value.trim();

  if (!path.startsWith('/')) {
    error.value = 'Нужен абсолютный путь: он начинается с «/».';

    return;
  }

  return choose({ kind: 'path', path }, close);
}

function onProjectChange(event: Event, close: ClosePopover): Promise<void> | void {
  const projectId = (event.target as HTMLSelectElement).value;

  if (projectId) {
    return choose({
      kind: 'project',
      projectId,
      repoKey: null
    }, close);
  }
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
async function confirmCurrent(close: ClosePopover): Promise<void> {
  if (!session.value) {
    return;
  }

  const accepted = await chat.proposeWorkdir(props.sid, {
    taskId: session.value.taskId || null,
    workdir: normalizeChatWorkdir(session.value.workdir),
  });

  error.value = session.value?.error || '';

  if (accepted || proposal.value) {
    close('action');
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
  try {
    const catalog = await api.get('/api/projects') as { projects?: ProjectOption[]; };

    projects.value = (catalog.projects || []).filter((project) => !project.archivedAt);
  } catch (failure) {
    error.value ||= (failure as Error).message;
  }
}

async function onOpen(opened: boolean): Promise<void> {
  if (opened) {
    await Promise.all([refresh(), loadProjects()]);
  }
}

// Обновление зависит от значений выбора, а не от ссылок объектов ACK:
// так нет цикла preview → save → новый объект workdir → preview.
watch(() => JSON.stringify([
  props.sid, chat.workdirProtocol, session.value?.workdir, session.value?.taskId, session.value?.modelRef,
  busy.value,
]), refresh, { immediate: true });
</script>

<style scoped>
.workdir-content {
  display: grid;
  gap: 12px;
  min-width: 0;
  padding: 4px;
  overflow-wrap: anywhere;
}

.workdir-current,
.workdir-copies,
.workdir-section,
.workdir-form {
  display: grid;
  gap: 10px;
  min-width: 0;
}

.workdir-current {
  gap: 6px;
}

.workdir-heading {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.workdir-heading strong {
  font-size: 14px;
  font-weight: 600;
}

.workdir-caption,
.workdir-choice-detail {
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 1.4;
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

.workdir-section {
  padding-top: 12px;
  border-top: 1px solid var(--line);
}

.workdir-choices {
  display: grid;
  grid-auto-rows: max-content;
  align-content: start;
  gap: 5px;
  max-height: 184px;
  overflow-y: auto;
  overscroll-behavior: contain;
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

.workdir-choice-title,
.workdir-choice-detail {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workdir-choice-title {
  font-size: 13px;
  font-weight: 500;
  line-height: 1.4;
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
</style>
