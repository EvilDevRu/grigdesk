<template>
  <section
    class="ssh-panel"
    :class="{
      'is-compact': props.compact,
      'is-dock': props.presentation === 'dock',
    }"
    aria-labelledby="ssh-panel-title"
    :aria-busy="refreshLoading || undefined"
  >
    <div class="ssh-panel__surface">
    <header class="ssh-panel__header">
      <div class="ssh-panel__brand">
        <span class="ssh-panel__mark" aria-hidden="true">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <rect x="3" y="4" width="18" height="16" rx="3" />
            <path d="m7 9 3 3-3 3 M13 15h4" />
          </svg>
        </span>
        <div>
          <div class="ssh-panel__title">
            <h2 id="ssh-panel-title">SSH</h2>
            <span
              class="ui-maturity-chip"
              data-product-maturity="beta"
              aria-label="Бета-версия"
            >
              бета
            </span>
          </div>
          <small>Терминал, файлы и команды агента</small>
        </div>
      </div>

      <div class="ssh-panel__summary" aria-label="Сводка SSH">
        <span class="ssh-summary-item" :class="{ active: store.sessions?.length }">
          <i aria-hidden="true"></i>
          {{ store.sessions?.length || 0 }} сесс.
        </span>
        <span class="ssh-summary-item">
          {{ store.connections?.length || 0 }} серв.
        </span>
        <span v-if="sshApprovals.length" class="ssh-summary-item is-waiting">
          {{ sshApprovals.length }} ждёт решения
        </span>
      </div>

      <UiIconButton
        class="ssh-refresh"
        role="embedded"
        label="Обновить SSH"
        title="Обновить"
        :loading="refreshLoading"
        loading-label="Обновляю"
        @click="refresh"
      >
        <svg
          viewBox="0 0 24 24"
          width="16"
          height="16"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M20 7v5h-5 M4 17v-5h5" />
          <path d="M6.1 9a7 7 0 0 1 11.6-2.3L20 9 M4 15l2.3 2.3A7 7 0 0 0 17.9 15" />
        </svg>
      </UiIconButton>
    </header>

    <div class="ssh-panel__body">
      <UiInlineMessage v-if="store.error" tone="danger">
        {{ store.error }}
      </UiInlineMessage>

      <div class="ssh-layout">
      <div class="ssh-workspace">
        <section
          v-if="sshApprovals.length"
          class="ssh-approvals"
          aria-label="Подтверждения команд"
        >
          <header class="ssh-approvals__heading">
            <span class="ssh-approvals__icon" aria-hidden="true">!</span>
            <div>
              <h3>Агент ждёт решения</h3>
              <small>Команда не выполнится без вашего разрешения.</small>
            </div>
            <span class="ssh-count is-waiting">{{ sshApprovals.length }}</span>
          </header>

          <div class="ssh-approval-list">
            <article
              v-for="approval in sshApprovals"
              :key="approval.pid"
              class="ssh-approval"
              data-ssh-approval
            >
              <div class="ssh-approval__server" data-ssh-server>
                <strong>{{ approval.server?.label }}</strong>
                <span aria-hidden="true"> — </span>
                <code>{{ approval.server?.host }}:{{ approval.server?.port }}</code>
              </div>
              <div class="ssh-approval__identity">
                Пользователь: <strong>{{ approval.user }}</strong>
                <span v-if="approval.isRoot" class="ssh-badge">root</span>
                <span v-if="approval.usesSudo" class="ssh-badge">sudo</span>
              </div>
              <pre data-ssh-command>{{ approval.command }}</pre>
              <UiInput
                v-model="comments[approval.pid]"
                placeholder="Пояснение к отказу (необязательно)"
                :aria-label="`Пояснение к команде ${approval.pid}`"
              />
              <div class="ssh-approval__actions">
                <UiButton tone="danger" @click="deny(approval)">Отказать</UiButton>
                <UiButton
                  variant="solid"
                  tone="accent"
                  @click="chat.answerPerm(approval.pid, true, false, '', '')"
                >
                  Разрешить
                </UiButton>
              </div>
            </article>
          </div>
        </section>

        <section
          class="ssh-console"
          :class="{ 'has-session': activeSession }"
          aria-label="SSH-терминал"
        >
          <header class="ssh-console__header">
            <div v-if="store.sessions?.length" class="ssh-session-switcher">
              <span class="ssh-session-switcher__label">Сессии</span>
              <UiTabs
                ref="sessionTabs"
                v-model="selectedSessionId"
                class="ssh-tabs"
                label="SSH-сессии"
              >
                <UiTab
                  v-for="session in store.sessions"
                  :key="session.id"
                  :id="sessionTabId(session.id)"
                  :value="session.id"
                  controls="ssh-terminal-panel"
                  :data-session-id="session.id"
                  :aria-label="sessionTabAriaLabel(session)"
                  :title="sessionTabTitle(session)"
                >
                  <span class="ssh-tab__content" aria-hidden="true">
                    <span class="ssh-tab__dot"></span>
                    <span class="ssh-tab__copy">
                      <span class="ssh-tab__project-line">
                        <small>Проект</small>
                        <strong data-ssh-session-project>
                          {{ sessionProjectLabel(session) }}
                        </strong>
                      </span>
                      <small data-ssh-session-target>
                        {{ sessionTargetLabel(session) }}
                      </small>
                    </span>
                  </span>
                </UiTab>
              </UiTabs>
            </div>

            <UiIconButton
              v-if="activeSession"
              class="ssh-session-close"
              role="embedded"
              tone="danger"
              :label="`Закрыть активную сессию ${activeSession.label}`"
              :title="`Закрыть ${activeSession.label}`"
              :loading="closingSessionId === activeSession.id"
              loading-label="Закрываю сессию"
              @click="closeActiveSession"
            >
              ×
            </UiIconButton>

            <div v-else class="ssh-console__title">
              <span aria-hidden="true">›_</span>
              Терминал
            </div>

            <div v-if="activeSession" class="ssh-console__context">
              <span class="ssh-role-badge">{{ activeSession.role }}</span>
              <span class="ssh-live-label">
                <i aria-hidden="true"></i>
                Подключено
              </span>
              <code>
                {{ activeSession.user }}@{{ activeSession.host }}:{{ activeSession.port }}
              </code>
            </div>
          </header>

          <div
            id="ssh-terminal-panel"
            class="ssh-terminal-stage"
            role="tabpanel"
            :aria-labelledby="activeSession ? sessionTabId(activeSession.id) : undefined"
            :aria-label="activeSession ? `Терминал ${activeSession.label}` : 'SSH-терминал'"
          >
            <div
              v-show="activeSession"
              ref="terminalHost"
              class="ssh-terminal"
              data-ssh-terminal-host
              data-escape-owner="terminal"
            ></div>

            <div v-if="!activeSession" class="ssh-console__empty" role="status">
              <span class="ssh-console__empty-icon" aria-hidden="true">›_</span>
              <strong>Нет активной SSH-сессии</strong>
              <span>Выберите сохранённый сервер — терминал появится после входа.</span>
            </div>
          </div>

          <footer v-if="activeSession" class="ssh-session-tools">
            <div class="ssh-session-endpoint">
              <span class="ssh-server-icon is-small" aria-hidden="true">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.7"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <rect x="4" y="4" width="16" height="6" rx="2" />
                  <rect x="4" y="14" width="16" height="6" rx="2" />
                  <path d="M8 7h.01 M8 17h.01 M12 7h4 M12 17h4" />
                </svg>
              </span>
              <span>
                <strong>{{ activeSession.label }}</strong>
                <small>Сессия хранится на сервере кокпита</small>
              </span>
            </div>

            <div class="ssh-agent-access">
              <span>
                <strong>Команды агента</strong>
                <small>Каждая — только после подтверждения</small>
              </span>
              <UiSwitch
                :model-value="activeSession.agentAllowed"
                :aria-label="`Доступ агента к ${activeSession.label}`"
                @update:model-value="store.setAgentAccess?.(activeSession.id, $event)"
              />
            </div>

          </footer>
        </section>

        <details v-if="activeSession" class="ssh-sftp">
          <summary>
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M3 7h7l2 2h9v10H3z" />
              <path d="M3 7V5h6l2 2" />
            </svg>
            Файлы сессии
          </summary>
          <div class="ssh-sftp__body">
            <div class="ssh-files-bar">
              <UiInput v-model="remotePath" aria-label="Путь на сервере" />
              <UiButton @click="store.listFiles?.(remotePath)">Открыть</UiButton>
              <UiFilePicker label="Загрузить файл" @change="uploadFiles" />
            </div>
            <ul v-if="store.files?.length" class="ssh-files">
              <li v-for="file in store.files" :key="file.path || file.name">
                <span>
                  <i aria-hidden="true">{{ file.directory ? '▸' : '·' }}</i>
                  {{ file.name }}
                </span>
                <a
                  v-if="!file.directory"
                  :href="store.downloadUrl?.(file.path || file.name)"
                >
                  Скачать
                </a>
              </li>
            </ul>
            <small v-else class="ssh-files__empty">Каталог пока не открыт.</small>
          </div>
        </details>

        <details class="ssh-audit">
          <summary>
            <span>
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path d="M5 4h14v16H5z M8 8h8 M8 12h8 M8 16h5" />
              </svg>
              Журнал команд агента
            </span>
            <span class="ssh-count">{{ store.audit?.length || 0 }}</span>
          </summary>
          <div v-if="store.audit?.length" class="ssh-audit__list">
            <article
              v-for="entry in store.audit"
              :key="`${entry.at}-${entry.sessionId}-${entry.command}`"
            >
              <header>
                <strong>{{ entry.label }}</strong>
                <span class="ssh-audit__decision" :class="entry.decision">
                  {{ auditDecisionLabel(entry.decision) }}
                </span>
                <time>{{ formatAuditDate(entry.at) }}</time>
              </header>
              <pre>{{ entry.command }}</pre>
              <pre v-if="entry.output" class="ssh-audit__output">{{ entry.output }}</pre>
            </article>
          </div>
          <p v-else class="ssh-audit__empty">Команд агента ещё не было.</p>
        </details>
      </div>

      <section
        ref="connectionsRegion"
        class="ssh-connections"
        aria-label="Серверы"
        tabindex="-1"
      >
        <header class="ssh-section-heading">
          <div>
            <h3>Серверы</h3>
            <small>Пароль только для одного входа</small>
          </div>
          <span class="ssh-count">{{ store.connections?.length || 0 }}</span>
        </header>

        <div v-if="store.connections?.length" class="ssh-connection-list">
          <article
            v-for="connection in store.connections"
            :key="connection.id"
            class="ssh-connection"
            :class="{
              'is-connected': connectionSessionCount(connection.id),
              'is-current': connectionIsActive(connection.id),
            }"
          >
            <div class="ssh-connection__topline">
              <span class="ssh-server-icon" aria-hidden="true">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.7"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <rect x="4" y="3" width="16" height="7" rx="2" />
                  <rect x="4" y="14" width="16" height="7" rx="2" />
                  <path d="M8 6.5h.01 M8 17.5h.01 M12 6.5h4 M12 17.5h4" />
                </svg>
              </span>
              <div class="ssh-connection__identity">
                <div class="ssh-connection__title">
                  <strong>{{ connection.label }}</strong>
                  <span
                    v-if="connectionSessionCount(connection.id)"
                    class="ssh-live-badge"
                  >
                    <i aria-hidden="true"></i>
                    {{ connectionSessionCount(connection.id) }} сесс.
                  </span>
                </div>
                <code>{{ connection.user }}@{{ connection.host }}:{{ connection.port }}</code>
              </div>
            </div>

            <div class="ssh-connection__meta">
              <span>{{ connection.role }}</span>
              <span class="ssh-project-badge">{{ connection.projectId }}</span>
            </div>

            <UiButton
              v-if="connectionSessionCount(connection.id)"
              block
              :variant="connectionIsActive(connection.id) ? 'solid' : 'outline'"
              :tone="connectionIsActive(connection.id) ? 'accent' : 'neutral'"
              :aria-label="`Открыть терминал ${connection.label}`"
              @click="openConnectionSession(connection.id)"
            >
              {{ connectionIsActive(connection.id) ? 'К терминалу' : 'Открыть терминал' }}
            </UiButton>

            <details
              class="ssh-connection__login-panel"
              :class="{ 'has-sessions': connectionSessionCount(connection.id) }"
              :open="!connectionSessionCount(connection.id)"
            >
              <summary v-if="connectionSessionCount(connection.id)">
                <span aria-hidden="true">＋</span>
                Новая сессия
              </summary>
              <form
                class="ssh-connection__login"
                @submit.prevent="openConnection(connection)"
              >
                <UiPasswordInput
                  v-model="passwords[connection.id]"
                  :aria-label="`Пароль для ${connection.label}`"
                  autocomplete="current-password"
                  placeholder="Пароль на один вход"
                  :disabled="Boolean(connectingId && connectingId !== connection.id)"
                />
                <UiButton
                  type="submit"
                  variant="solid"
                  tone="accent"
                  :loading="connectingId === connection.id"
                  loading-label="Подключаю"
                  :disabled="Boolean(connectingId && connectingId !== connection.id)"
                >
                  Войти
                </UiButton>
              </form>
            </details>
          </article>
        </div>

        <div v-else class="ssh-connections__empty" role="status">
          <span aria-hidden="true">＋</span>
          <strong>Серверов пока нет</strong>
          <small>Добавьте первое SSH-соединение ниже.</small>
        </div>

        <details class="ssh-add-connection" :open="!store.connections?.length">
          <summary>
            <span class="ssh-disclosure-icon" aria-hidden="true">＋</span>
            <span>Добавить сервер</span>
          </summary>
          <form class="ssh-profile-form" @submit.prevent="saveConnection">
            <UiField label="Проект" required>
              <UiSelect
                v-model="draft.projectId"
                required
                :disabled="!projectOptions.length"
                aria-label="Проект"
                data-ssh-project-select
              >
                <option value="" disabled>{{ projectPlaceholder }}</option>
                <option
                  v-for="project in projectOptions"
                  :key="project.id"
                  :value="project.id"
                >
                  {{ project.id }}
                </option>
              </UiSelect>
            </UiField>

            <UiField label="Метка сервера" required>
              <UiInput
                v-model="draft.label"
                required
                placeholder="Например, production"
                aria-label="Метка сервера"
              />
            </UiField>

            <UiField label="Роль" required>
              <UiInput
                v-model="draft.role"
                required
                placeholder="Например, приложение"
                aria-label="Роль сервера"
              />
            </UiField>

            <UiField label="Адрес" required>
              <UiInput
                v-model="draft.host"
                required
                placeholder="server.example.org"
                aria-label="Адрес сервера"
              />
            </UiField>

            <UiField label="Порт">
              <UiNumberInput
                v-model="draft.port"
                :min="1"
                :max="65535"
                placeholder="22"
                aria-label="Порт"
              />
            </UiField>

            <UiField label="Пользователь" required>
              <UiInput
                v-model="draft.user"
                required
                autocomplete="username"
                placeholder="deploy"
                aria-label="Пользователь"
              />
            </UiField>

            <UiInlineMessage
              v-if="store.projectsError"
              class="ssh-project-message"
              tone="danger"
            >
              Список проектов не обновлён: {{ store.projectsError }}
            </UiInlineMessage>
            <UiInlineMessage
              v-else-if="!store.projectsLoading && !projectOptions.length"
              class="ssh-project-message"
            >
              Сначала создайте проект в разделе «Проекты».
            </UiInlineMessage>

            <UiFormActions class="ssh-profile-form__actions">
              <UiButton
                type="submit"
                variant="solid"
                tone="accent"
                :loading="savingConnection"
                loading-label="Сохраняю"
                :disabled="!draft.projectId"
              >
                Сохранить
              </UiButton>
            </UiFormActions>
          </form>
        </details>

        <p class="ssh-secret-note">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M7 11V8a5 5 0 0 1 10 0v3" />
            <rect x="4" y="11" width="16" height="10" rx="2" />
          </svg>
          Пароли не сохраняются и не попадают в журнал.
        </p>
      </section>

      </div>
    </div>
    </div>
  </section>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import {
  UiButton,
  UiField,
  UiFilePicker,
  UiFormActions,
  UiIconButton,
  UiInlineMessage,
  UiInput,
  UiNumberInput,
  UiPasswordInput,
  UiSelect,
  UiSwitch,
  UiTab,
  UiTabs,
  alertDialog,
  confirmDialog,
} from '../../ui';
import { useSshStore } from '../../stores/ssh.js';
import { useChatStore } from '../../stores/chat.js';

const props = defineProps({
  active: { type: Boolean, default: true },
  compact: { type: Boolean, default: false },
  presentation: { type: String, default: 'page' },
});

const store = useSshStore();
const chat = useChatStore();
const terminalHost = ref(null);
const sessionTabs = ref(null);
const connectionsRegion = ref(null);
const passwords = reactive({});
const comments = reactive({});
const remotePath = ref('.');
const savingConnection = ref(false);
const connectingId = ref('');
const closingSessionId = ref('');
const draft = reactive({
  projectId: '',
  label: '',
  role: '',
  host: '',
  port: 22,
  user: '',
});

const sshApprovals = computed(() => Object.values(chat.pending || [])
  .filter((item) => item.origin === 'ssh'));
const activeSession = computed(() => (store.sessions || [])
  .find((item) => item.id === store.activeId));
const selectedSessionId = computed({
  get: () => store.activeId || store.sessions?.[0]?.id || '',
  set: (sessionId) => {
    if (sessionId && sessionId !== store.activeId) {
      activateSession(sessionId);
    }
  },
});
const projectOptions = computed(() => store.projects || []);
const projectPlaceholder = computed(() => {
  if (store.projectsLoading && !projectOptions.value.length) {
    return 'Загрузка проектов…';
  }

  return projectOptions.value.length ? 'Выберите проект' : 'Проектов пока нет';
});
const refreshLoading = computed(() => store.loading || store.projectsLoading);

const sessionsByConnection = computed(() => {
  const groups = new Map();
  for (const session of store.sessions || []) {
    const sessions = groups.get(session.connectionId) || [];
    sessions.push(session);
    groups.set(session.connectionId, sessions);
  }

  return groups;
});

const connectionSessions = (connectionId) => sessionsByConnection.value.get(connectionId) || [];
const connectionSessionCount = (connectionId) => connectionSessions(connectionId).length;
const connectionIsActive = (connectionId) => activeSession.value?.connectionId === connectionId;

const auditDecisionLabel = (decision) => ({
  allow: 'Разрешено',
  deny: 'Отказано',
}[decision] || decision || 'Без решения');

function formatAuditDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

let terminal;
let fit;
let terminalInput;
let terminalObserver;
let resizeFrame = 0;
let lastTerminalSize = '';
let disposed = false;

/**
 * Xterm создаётся только перед реальным подключением. Так пустая SSH-панель не
 * показывает чёрный терминал с курсором и не платит за невостребованный renderer.
 */
async function ensureTerminal() {
  if (disposed) {
    return false;
  }
  if (terminal) {
    return true;
  }

  await nextTick();
  if (disposed || !terminalHost.value) {
    return false;
  }
  if (terminal) {
    return true;
  }

  terminal = new Terminal({
    convertEol: true,
    cursorBlink: true,
    fontFamily: 'ui-monospace, "SF Mono", "Cascadia Mono", Consolas, monospace',
    fontSize: 13,
    lineHeight: 1.2,
    theme: {
      background: '#0a0c10',
      foreground: '#e7eaf0',
      cursor: '#5aa2ff',
      selectionBackground: '#2e3742',
      black: '#0a0c10',
      brightBlack: '#39424f',
      red: '#f0564c',
      green: '#3fb950',
      yellow: '#e0a33a',
      blue: '#5aa2ff',
      magenta: '#b47cff',
      cyan: '#37b7c3',
      white: '#e7eaf0',
      brightWhite: '#ffffff',
    },
  });
  fit = new FitAddon();
  terminal.loadAddon?.(fit);
  terminal.open(terminalHost.value);
  store.bindTerminal?.(terminal);
  terminalInput = terminal.onData?.((data) => store.sendInput?.(data));

  if (typeof ResizeObserver !== 'undefined') {
    terminalObserver = new ResizeObserver(scheduleTerminalFit);
    terminalObserver.observe(terminalHost.value);
  }

  return true;
}

/**
 * Видимая геометрия xterm и удалённого PTY меняется одним шагом. Последний
 * размер запоминается, чтобы ResizeObserver не засыпал SSH одинаковыми пакетами.
 */
function fitTerminal() {
  if (!props.active || !activeSession.value || !terminal || !fit) {
    return;
  }

  try {
    fit.fit?.();
  } catch {
    return;
  }

  const cols = Number(terminal.cols);
  const rows = Number(terminal.rows);
  if (!Number.isSafeInteger(cols) || !Number.isSafeInteger(rows) || cols < 1 || rows < 1) {
    return;
  }

  const size = `${cols}:${rows}`;
  if (size === lastTerminalSize) {
    return;
  }

  lastTerminalSize = size;
  store.resize?.(cols, rows);
}

function scheduleTerminalFit() {
  if (resizeFrame) {
    cancelAnimationFrame(resizeFrame);
  }

  resizeFrame = requestAnimationFrame(() => {
    resizeFrame = 0;
    fitTerminal();
  });
}

async function refresh() {
  await Promise.all([
    store.load(),
    Promise.resolve(store.loadProjects?.()),
  ]);
}

async function activateSession(sessionId) {
  const ready = await ensureTerminal();
  if (!ready || disposed) {
    return;
  }

  store.activate(sessionId);
}

function sessionTabId(sessionId) {
  return `ssh-session-tab-${String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

function sessionProjectLabel(session) {
  const connection = (store.connections || [])
    .find((item) => item.id === session.connectionId);

  return String(session.projectId || connection?.projectId || 'не указан');
}

function sessionTargetBase(session) {
  const values = [session.label, session.role]
    .map((value) => String(value || '').trim())
    .filter((value, index, items) => value && items.indexOf(value) === index);

  return values.join(' · ')
    || [session.host, session.port].filter(Boolean).join(':')
    || 'SSH-сессия';
}

/** Полная видимая метка различает повторные входы в один сервер порядковым номером. */
function sessionTargetLabel(session) {
  const project = sessionProjectLabel(session);
  const target = sessionTargetBase(session);
  const sameTarget = (store.sessions || []).filter((item) => (
    sessionProjectLabel(item) === project && sessionTargetBase(item) === target
  ));
  if (sameTarget.length < 2) {
    return target;
  }

  const position = sameTarget.findIndex((item) => item.id === session.id) + 1;

  return `${target} · ${Math.max(position, 1)}`;
}

function sessionTabTitle(session) {
  const endpoint = [session.host, session.port].filter(Boolean).join(':');
  const identity = [session.user, endpoint].filter(Boolean).join('@');
  const parts = [
    `Проект ${sessionProjectLabel(session)}`,
    sessionTargetLabel(session),
    identity,
  ].filter(Boolean);

  return parts.join(' — ');
}

function sessionTabAriaLabel(session) {
  const endpoint = [session.host, session.port].filter(Boolean).join(':');
  const identity = [session.user, endpoint].filter(Boolean).join('@');
  const parts = [
    `Проект ${sessionProjectLabel(session)}`,
    `сессия ${sessionTargetLabel(session)}`,
    identity,
  ].filter(Boolean);

  return parts.join(', ');
}

async function focusSessionTab(sessionId) {
  await nextTick();
  const tabsRoot = sessionTabs.value?.$el || sessionTabs.value;
  const tab = [...(tabsRoot?.querySelectorAll?.('[role="tab"]') || [])]
    .find((item) => item.dataset.sessionId === sessionId);
  tab?.focus();
}

/** Карточка сервера возвращает в живую сессию без нового probe и ввода пароля. */
async function openConnectionSession(connectionId) {
  const sessions = connectionSessions(connectionId);
  const session = sessions.find((item) => item.id === store.activeId) || sessions.at(-1);
  if (!session) {
    return;
  }

  if (store.activeId !== session.id) {
    await activateSession(session.id);
  }
  await nextTick();
  terminal?.focus?.();
}

/** Закрытие активной вкладки выбирает соседа и сохраняет непрерывный roving focus. */
async function closeActiveSession() {
  const sessionId = store.activeId;
  if (!sessionId || closingSessionId.value) {
    return;
  }

  const sessions = store.sessions || [];
  const index = sessions.findIndex((session) => session.id === sessionId);
  const replacementId = sessions[index + 1]?.id || sessions[index - 1]?.id || '';
  closingSessionId.value = sessionId;

  try {
    await store.closeSession?.(sessionId);
    if (disposed) {
      return;
    }
    if (!replacementId) {
      await nextTick();
      connectionsRegion.value?.focus();
      return;
    }
    if (!(store.sessions || []).some((session) => session.id === replacementId)) {
      return;
    }

    await activateSession(replacementId);
    await focusSessionTab(replacementId);
  } catch (error) {
    if (!disposed && (store.sessions || []).some((session) => session.id === sessionId)) {
      await activateSession(sessionId);
      await focusSessionTab(sessionId);
    }
    await alertDialog(error?.message || 'Не удалось закрыть SSH-сессию', { title: 'SSH' });
  } finally {
    if (closingSessionId.value === sessionId) {
      closingSessionId.value = '';
    }
  }
}

onMounted(async () => {
  await refresh();
  if (disposed) {
    return;
  }

  const sessionId = store.activeId || store.sessions?.[0]?.id;
  if (sessionId) {
    await activateSession(sessionId);
    scheduleTerminalFit();
  }
});

watch(activeSession, async (session) => {
  if (!session) {
    lastTerminalSize = '';
    return;
  }

  await ensureTerminal();
  await nextTick();
  scheduleTerminalFit();
});

watch(() => props.active, async (active) => {
  if (!active || !activeSession.value) {
    return;
  }

  await nextTick();
  scheduleTerminalFit();
});

watch(projectOptions, (projects) => {
  if (draft.projectId && !projects.some((project) => project.id === draft.projectId)) {
    draft.projectId = '';
  }
});

onBeforeUnmount(() => {
  disposed = true;

  if (resizeFrame) {
    cancelAnimationFrame(resizeFrame);
  }

  terminalObserver?.disconnect?.();
  terminalInput?.dispose?.();
  store.detach?.();
  terminal?.dispose?.();
});

async function openConnection(connection) {
  if (connectingId.value) {
    return;
  }

  connectingId.value = connection.id;
  try {
    const check = await store.probeHostKey(connection.id);
    if (check.status !== 'trusted') {
      const changed = check.status === 'changed';
      const accepted = await confirmDialog(
        `${changed ? 'Ключ сервера изменился.' : 'Первое подключение к серверу.'}\n\n`
          + `Отпечаток: ${check.current?.fingerprint || 'неизвестен'}`,
        {
          title: changed ? 'Проверить новый host key' : 'Доверять host key?',
          okText: changed ? 'Заменить ключ' : 'Доверять',
          danger: changed,
        },
      );
      if (!accepted) {
        return;
      }

      await store.decideHostKey(check.challengeId, changed ? 'replace' : 'trust');
    }

    if (!await ensureTerminal()) {
      return;
    }

    await store.connect(connection.id, passwords[connection.id] || '');
  } catch (error) {
    await alertDialog(error?.message || 'Не удалось подключиться', { title: 'SSH' });
  } finally {
    passwords[connection.id] = '';
    if (connectingId.value === connection.id) {
      connectingId.value = '';
    }
  }
}

async function saveConnection() {
  if (savingConnection.value || !draft.projectId) {
    return;
  }

  savingConnection.value = true;
  try {
    await store.saveConnection({
      ...draft,
      port: Number(draft.port) || 22,
    });
    Object.assign(draft, {
      projectId: '',
      label: '',
      role: '',
      host: '',
      port: 22,
      user: '',
    });
  } catch (error) {
    await alertDialog(error?.message || 'Не удалось сохранить соединение', { title: 'SSH' });
  } finally {
    savingConnection.value = false;
  }
}

async function uploadFiles(files) {
  const file = files?.[0];
  if (file) {
    const destination = `${remotePath.value.replace(/\/$/, '')}/${file.name}`;
    await store.uploadFile?.(file, destination);
  }
}

function deny(approval) {
  const comment = String(comments[approval.pid] || '').trim();
  chat.answerPerm(approval.pid, false, false, comment, '');
}
</script>

<style scoped>
.ssh-panel {
  box-sizing: border-box;
  container-type: inline-size;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  color: var(--ink);
}

.ssh-panel__surface {
  box-sizing: border-box;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  gap: 10px;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  padding: 9px 12px 12px;
  overflow: hidden;
}

.ssh-panel__body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  min-height: 0;
}

.ssh-panel__header {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 14px;
  min-width: 0;
  min-height: 38px;
}

.ssh-panel.is-compact.is-dock .ssh-panel__header {
  padding-right: var(--tool-dock-actions-space, 82px);
}

.ssh-panel__brand,
.ssh-panel__title,
.ssh-panel__summary,
.ssh-summary-item,
.ssh-section-heading,
.ssh-connection__topline,
.ssh-connection__title,
.ssh-connection__meta,
.ssh-live-badge,
.ssh-console__header,
.ssh-console__context,
.ssh-live-label,
.ssh-session-endpoint,
.ssh-agent-access,
.ssh-files-bar,
.ssh-approval__actions,
.ssh-approvals__heading,
.ssh-approval__server,
.ssh-approval__identity,
.ssh-audit summary,
.ssh-audit summary > span,
.ssh-audit article header {
  display: flex;
  align-items: center;
}

.ssh-panel__brand {
  gap: 10px;
  min-width: 0;
}

.ssh-panel__title {
  gap: 6px;
  min-width: 0;
}

.ssh-panel__brand h2,
.ssh-section-heading h3,
.ssh-approvals h3 {
  margin: 0;
}

.ssh-panel__brand h2 {
  font-size: 15px;
  line-height: 1.15;
  letter-spacing: 0.015em;
}

.ssh-panel__brand small,
.ssh-section-heading small,
.ssh-session-endpoint small,
.ssh-agent-access small {
  display: block;
  margin-top: 2px;
  color: var(--ink-mid);
  font-size: 11px;
}

.ssh-panel__mark,
.ssh-server-icon {
  display: grid;
  flex: none;
  place-items: center;
  color: var(--accent);
}

.ssh-panel__mark {
  width: 32px;
  height: 32px;
  border: 1px solid color-mix(in srgb, var(--accent) 28%, var(--line));
  border-radius: 9px;
  background: color-mix(in srgb, var(--accent) 9%, var(--ground));
}

.ssh-panel__mark svg {
  width: 17px;
  height: 17px;
}

.ssh-panel__summary {
  justify-content: flex-end;
  gap: 6px;
  min-width: 0;
  overflow: hidden;
}

.ssh-summary-item {
  flex: none;
  gap: 6px;
  min-height: 25px;
  padding: 0 8px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: color-mix(in srgb, var(--surface) 62%, transparent);
  color: var(--ink-mid);
  font-size: 11px;
  white-space: nowrap;
}

.ssh-summary-item i,
.ssh-live-badge i,
.ssh-live-label i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--idle);
}

.ssh-summary-item.active i,
.ssh-live-badge i,
.ssh-live-label i {
  background: var(--good);
  box-shadow: 0 0 7px color-mix(in srgb, var(--good) 62%, transparent);
}

.ssh-summary-item.is-waiting {
  border-color: color-mix(in srgb, var(--warn) 40%, var(--line));
  background: color-mix(in srgb, var(--warn) 8%, var(--surface));
  color: var(--warn);
}

.ssh-layout {
  display: grid;
  flex: 1;
  grid-template-columns: minmax(270px, 326px) minmax(0, 1fr);
  gap: 10px;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.ssh-connections {
  display: flex;
  flex-direction: column;
  grid-column: 1;
  grid-row: 1;
  gap: 9px;
  min-width: 0;
  min-height: 0;
  padding: 0 9px 10px;
  overflow: auto;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--sidebar) 88%, var(--ground));
  scrollbar-color: var(--line-2) transparent;
  scrollbar-width: thin;
}

.ssh-section-heading {
  position: sticky;
  z-index: 2;
  top: 0;
  justify-content: space-between;
  gap: 10px;
  min-height: 48px;
  margin: 0 -1px;
  padding: 8px 1px 7px;
  border-bottom: 1px solid var(--line);
  background: color-mix(in srgb, var(--sidebar) 96%, var(--ground));
}

.ssh-section-heading h3,
.ssh-approvals h3 {
  font-size: 13px;
}

.ssh-count {
  display: grid;
  flex: none;
  place-items: center;
  min-width: 23px;
  height: 23px;
  padding: 0 7px;
  border-radius: 999px;
  background: var(--surface-2);
  color: var(--ink-mid);
  font-size: 10.5px;
}

.ssh-count.is-waiting {
  background: color-mix(in srgb, var(--warn) 16%, var(--surface));
  color: var(--warn);
}

.ssh-connection-list {
  display: grid;
  gap: 8px;
  min-width: 0;
}

.ssh-connection {
  display: grid;
  gap: 9px;
  min-width: 0;
  padding: 10px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--ground);
  transition:
    border-color var(--control-motion-duration) var(--control-motion-easing),
    background var(--control-motion-duration) var(--control-motion-easing);
}

.ssh-connection:hover {
  border-color: var(--line-2);
}

.ssh-connection.is-connected {
  border-color: color-mix(in srgb, var(--good) 35%, var(--line));
  background: color-mix(in srgb, var(--good) 3%, var(--ground));
}

.ssh-connection.is-current {
  border-color: color-mix(in srgb, var(--accent) 58%, var(--line));
  background: color-mix(in srgb, var(--accent) 5%, var(--ground));
  box-shadow: inset 3px 0 0 color-mix(in srgb, var(--accent) 76%, transparent);
}

.ssh-connection__topline {
  gap: 9px;
  min-width: 0;
}

.ssh-server-icon {
  width: 34px;
  height: 34px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--surface);
  color: var(--ink-mid);
}

.ssh-connection.is-connected .ssh-server-icon {
  border-color: color-mix(in srgb, var(--good) 30%, var(--line));
  color: var(--good);
}

.ssh-connection.is-current .ssh-server-icon {
  border-color: color-mix(in srgb, var(--accent) 40%, var(--line));
  color: var(--accent);
}

.ssh-server-icon svg {
  width: 17px;
  height: 17px;
}

.ssh-server-icon.is-small {
  width: 27px;
  height: 27px;
  border-radius: 7px;
}

.ssh-server-icon.is-small svg {
  width: 14px;
  height: 14px;
}

.ssh-connection__identity {
  min-width: 0;
}

.ssh-connection__title {
  gap: 7px;
  min-width: 0;
}

.ssh-connection__title strong {
  min-width: 0;
  overflow: hidden;
  font-size: 12.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ssh-connection code {
  display: block;
  max-width: 100%;
  margin-top: 4px;
  overflow: hidden;
  color: var(--ink-mid);
  font-family: var(--mono);
  font-size: 10.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ssh-live-badge {
  flex: none;
  gap: 5px;
  color: var(--good);
  font-size: 10px;
}

.ssh-connection__meta {
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
  color: var(--ink-mid);
  font-size: 10.5px;
}

.ssh-connection__meta > :first-child {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ssh-project-badge,
.ssh-role-badge,
.ssh-badge,
.ssh-audit__decision {
  flex: none;
  border-radius: 999px;
  font-size: 10px;
  line-height: 1;
}

.ssh-project-badge,
.ssh-role-badge {
  padding: 4px 7px;
  background: color-mix(in srgb, var(--accent) 11%, var(--surface));
  color: var(--accent);
}

.ssh-connection__login {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 7px;
  min-width: 0;
}

.ssh-connection__login > :first-child {
  min-width: 0;
}

.ssh-connection__login-panel {
  min-width: 0;
}

.ssh-connection__login-panel > summary {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 27px;
  color: var(--ink-mid);
  cursor: pointer;
  font-size: 10.5px;
  font-weight: 600;
  list-style: none;
}

.ssh-connection__login-panel > summary::-webkit-details-marker {
  display: none;
}

.ssh-connection__login-panel > summary:hover {
  color: var(--ink);
}

.ssh-connection__login-panel > summary > span {
  color: var(--accent);
  font-size: 13px;
}

.ssh-connection__login-panel.has-sessions {
  border-top: 1px solid var(--line);
}

.ssh-connection__login-panel[open] > summary {
  margin-bottom: 7px;
}

.ssh-connections__empty {
  display: grid;
  justify-items: center;
  gap: 4px;
  padding: 22px 14px;
  border: 1px dashed var(--line-2);
  border-radius: 10px;
  color: var(--ink-mid);
  text-align: center;
}

.ssh-connections__empty > span {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  margin-bottom: 3px;
  border-radius: 50%;
  background: var(--surface-2);
  color: var(--accent);
  font-size: 18px;
}

.ssh-connections__empty strong {
  color: var(--ink);
  font-size: 12.5px;
}

.ssh-connections__empty small {
  font-size: 11px;
  line-height: 1.45;
}

.ssh-add-connection,
.ssh-sftp,
.ssh-audit {
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: color-mix(in srgb, var(--surface) 48%, transparent);
}

.ssh-add-connection > summary,
.ssh-sftp > summary,
.ssh-audit > summary {
  cursor: pointer;
  list-style: none;
}

.ssh-add-connection > summary::-webkit-details-marker,
.ssh-sftp > summary::-webkit-details-marker,
.ssh-audit > summary::-webkit-details-marker {
  display: none;
}

.ssh-add-connection > summary {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 38px;
  padding: 7px 10px;
  color: var(--ink);
  font-size: 11.5px;
  font-weight: 600;
}

.ssh-add-connection > summary:hover,
.ssh-audit > summary:hover {
  background: color-mix(in srgb, var(--surface-2) 54%, transparent);
}

.ssh-disclosure-icon {
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border-radius: 6px;
  background: var(--surface-2);
  color: var(--accent);
  font-size: 14px;
  font-weight: 400;
  transition: transform var(--control-motion-duration) var(--control-motion-easing);
}

.ssh-add-connection[open] .ssh-disclosure-icon {
  transform: rotate(45deg);
}

.ssh-add-connection[open] > summary {
  border-bottom: 1px solid var(--line);
}

.ssh-profile-form {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 10px;
  padding: 11px 10px 10px;
}

.ssh-project-message,
.ssh-profile-form__actions {
  grid-column: 1 / -1;
}

.ssh-profile-form__actions {
  justify-content: stretch;
}

.ssh-profile-form__actions > :deep(.ui-button) {
  flex: 1;
}

.ssh-secret-note {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  margin: auto 2px 0;
  padding-top: 2px;
  color: var(--ink-mid);
  font-size: 10.5px;
  line-height: 1.45;
}

.ssh-secret-note svg {
  flex: none;
  width: 13px;
  height: 13px;
  margin-top: 1px;
  color: var(--good);
}

.ssh-workspace {
  display: flex;
  flex-direction: column;
  grid-column: 2;
  grid-row: 1;
  gap: 8px;
  min-width: 0;
  min-height: 0;
  overflow: auto;
  scrollbar-color: var(--line-2) transparent;
  scrollbar-width: thin;
}

.ssh-approvals {
  display: grid;
  gap: 8px;
  min-width: 0;
  padding: 10px;
  border: 1px solid color-mix(in srgb, var(--warn) 38%, var(--line));
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--warn) 6%, var(--surface));
}

.ssh-approvals__heading {
  gap: 9px;
  min-width: 0;
}

.ssh-approvals__heading > div {
  flex: 1;
  min-width: 0;
}

.ssh-approvals__heading small {
  display: block;
  margin-top: 2px;
  color: var(--ink-mid);
  font-size: 10.5px;
}

.ssh-approvals__icon {
  display: grid;
  flex: none;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--warn) 16%, var(--surface));
  color: var(--warn);
  font-weight: 750;
}

.ssh-approval-list {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 310px), 1fr));
  gap: 8px;
  max-height: 330px;
  overflow: auto;
}

.ssh-approval {
  display: grid;
  align-content: start;
  gap: 8px;
  min-width: 0;
  max-width: 100%;
  padding: 10px;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--warn) 24%, var(--line));
  border-radius: 9px;
  background: var(--surface);
}

.ssh-approval__server {
  flex-wrap: wrap;
  gap: 4px;
  min-width: 0;
  font-size: 12px;
}

.ssh-approval__server code {
  min-width: 0;
  max-width: 100%;
  color: var(--ink-mid);
  font-family: var(--mono);
  font-size: 10.5px;
  white-space: normal;
  overflow-wrap: anywhere;
  word-break: break-word;
}

.ssh-approval__identity {
  gap: 5px;
  flex-wrap: wrap;
  color: var(--ink-mid);
  font-size: 10.5px;
}

.ssh-badge {
  padding: 3px 6px;
  background: color-mix(in srgb, var(--bad) 13%, transparent);
  color: var(--bad);
}

.ssh-approval pre,
.ssh-audit pre {
  min-width: 0;
  max-width: 100%;
  margin: 0;
  font-family: var(--mono);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
}

.ssh-approval pre {
  max-height: 150px;
  padding: 9px 10px;
  overflow: auto;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--ground);
  color: var(--ink);
  font-size: 11.5px;
  line-height: 1.45;
}

.ssh-approval__actions {
  justify-content: flex-end;
  gap: 7px;
  flex-wrap: wrap;
  min-width: 0;
}

.ssh-console {
  display: flex;
  flex: 1 1 440px;
  flex-direction: column;
  min-width: 0;
  min-height: 430px;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--ground);
  box-shadow: var(--shadow);
}

.ssh-console__header {
  flex: none;
  gap: 9px;
  min-width: 0;
  min-height: 44px;
  padding: 5px 7px;
  border-bottom: 1px solid var(--line);
  background: var(--topbar);
}

.ssh-session-switcher {
  display: flex;
  flex: 0 1 auto;
  align-items: center;
  gap: 6px;
  width: max-content;
  max-width: min(66%, 720px);
  min-width: 0;
}

.ssh-session-switcher__label {
  flex: none;
  color: var(--ink-mid);
  font-size: 9px;
  font-weight: 650;
  letter-spacing: 0.07em;
  text-transform: uppercase;
}

.ssh-tabs {
  flex: 0 1 auto;
  gap: 5px;
  width: max-content;
  max-width: 100%;
  min-width: 0;
}

.ssh-session-close {
  flex: none;
}

.ssh-tab__dot {
  display: block;
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--good);
  box-shadow: 0 0 6px color-mix(in srgb, var(--good) 55%, transparent);
}

.ssh-tab__content {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 1px 7px;
}

.ssh-tab__copy {
  display: grid;
  gap: 1px;
  min-width: 0;
  text-align: left;
}

.ssh-tab__project-line {
  display: flex;
  align-items: baseline;
  gap: 4px;
  min-width: 0;
  line-height: 1;
}

.ssh-tab__project-line > small {
  flex: none;
  color: var(--ink-mid);
  font-size: 8px;
  font-weight: 600;
  letter-spacing: 0.055em;
  text-transform: uppercase;
}

.ssh-tab__project-line strong,
.ssh-tab__copy > small {
  min-width: 0;
  max-width: 22ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ssh-tab__project-line strong {
  font-size: 11px;
  font-weight: 600;
  line-height: 1.1;
}

.ssh-tab__copy > small {
  color: var(--ink-mid);
  font-size: 9px;
  line-height: 1.05;
}

.ssh-console__title {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--ink-mid);
  font-size: 11.5px;
  font-weight: 600;
}

.ssh-console__title > span {
  color: var(--accent);
  font-family: var(--mono);
  font-size: 13px;
}

.ssh-console__context {
  flex: none;
  justify-content: flex-end;
  gap: 7px;
  min-width: 0;
  margin-left: auto;
}

.ssh-console__context code {
  max-width: min(27vw, 300px);
  overflow: hidden;
  color: var(--ink-mid);
  font-family: var(--mono);
  font-size: 10.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ssh-live-label {
  gap: 5px;
  color: var(--good);
  font-size: 10.5px;
  white-space: nowrap;
}

.ssh-terminal-stage {
  display: grid;
  flex: 1;
  min-width: 0;
  min-height: 300px;
  overflow: hidden;
  background: var(--ground);
}

.ssh-terminal,
.ssh-console__empty {
  grid-area: 1 / 1;
  min-width: 0;
  min-height: 0;
}

.ssh-terminal {
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: var(--ground);
}

.ssh-terminal :deep(.xterm) {
  box-sizing: border-box;
  height: 100%;
  padding: 9px 10px;
}

.ssh-terminal :deep(.xterm-viewport) {
  background: transparent !important;
}

.ssh-console__empty {
  display: grid;
  place-content: center;
  justify-items: center;
  gap: 7px;
  padding: 28px;
  color: var(--ink-mid);
  text-align: center;
  background:
    linear-gradient(color-mix(in srgb, var(--line) 24%, transparent) 1px, transparent 1px),
    linear-gradient(90deg, color-mix(in srgb, var(--line) 20%, transparent) 1px, transparent 1px),
    radial-gradient(
      circle at 50% 100%,
      color-mix(in srgb, var(--accent) 9%, transparent),
      transparent 52%
    ),
    var(--ground);
  background-size: 28px 28px, 28px 28px, auto, auto;
}

.ssh-console__empty-icon {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  margin-bottom: 3px;
  border: 1px solid color-mix(in srgb, var(--accent) 27%, var(--line));
  border-radius: 13px;
  background: color-mix(in srgb, var(--accent) 8%, var(--surface));
  color: var(--accent);
  font-family: var(--mono);
  font-size: 16px;
}

.ssh-console__empty strong {
  color: var(--ink);
  font-size: 13px;
}

.ssh-console__empty > :last-child {
  max-width: 46ch;
  font-size: 11.5px;
  line-height: 1.5;
}

.ssh-session-tools {
  display: grid;
  flex: none;
  grid-template-columns: minmax(170px, 1fr) minmax(225px, auto);
  align-items: center;
  gap: 9px;
  padding: 8px 9px;
  border-top: 1px solid var(--line);
  background: var(--topbar);
}

.ssh-session-endpoint {
  gap: 8px;
  min-width: 0;
}

.ssh-session-endpoint > span:last-child,
.ssh-agent-access > span {
  min-width: 0;
}

.ssh-session-endpoint strong,
.ssh-agent-access strong {
  display: block;
  overflow: hidden;
  font-size: 11.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ssh-agent-access {
  justify-content: space-between;
  gap: 10px;
  min-width: 0;
  padding: 5px 8px;
  border-right: 1px solid var(--line);
  border-left: 1px solid var(--line);
}

.ssh-sftp > summary {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 39px;
  padding: 7px 10px;
  color: var(--ink-mid);
  font-size: 11px;
  font-weight: 600;
}

.ssh-sftp > summary:hover {
  background: var(--surface-2);
  color: var(--ink);
}

.ssh-sftp > summary svg {
  width: 14px;
  height: 14px;
}

.ssh-sftp[open] {
  width: 100%;
}

.ssh-sftp[open] > summary {
  border-bottom: 1px solid var(--line);
}

.ssh-sftp__body {
  display: grid;
  gap: 8px;
  padding: 10px;
}

.ssh-files-bar {
  gap: 7px;
  flex-wrap: wrap;
}

.ssh-files-bar > :first-child {
  flex: 1 1 220px;
}

.ssh-files {
  display: grid;
  gap: 2px;
  max-height: 180px;
  margin: 0;
  padding: 4px;
  overflow: auto;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--ground);
  list-style: none;
}

.ssh-files li {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
  padding: 5px 7px;
  border-radius: 6px;
  font-size: 11px;
}

.ssh-files li:hover {
  background: var(--surface-2);
}

.ssh-files li > span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ssh-files li i {
  color: var(--accent);
  font-style: normal;
}

.ssh-files a {
  flex: none;
  color: var(--accent);
}

.ssh-files__empty {
  color: var(--ink-mid);
  font-size: 10.5px;
}

.ssh-audit {
  flex: none;
  background: color-mix(in srgb, var(--surface) 36%, transparent);
}

.ssh-audit > summary {
  justify-content: space-between;
  gap: 9px;
  min-height: 39px;
  padding: 7px 10px;
  font-size: 11.5px;
  font-weight: 600;
}

.ssh-audit > summary > span {
  gap: 7px;
}

.ssh-audit > summary svg {
  width: 14px;
  height: 14px;
  color: var(--ink-mid);
}

.ssh-audit[open] > summary {
  border-bottom: 1px solid var(--line);
}

.ssh-audit__list {
  display: grid;
  gap: 0;
  max-height: 330px;
  overflow: auto;
}

.ssh-audit article {
  display: grid;
  gap: 7px;
  min-width: 0;
  padding: 10px;
  border-top: 1px solid var(--line);
}

.ssh-audit article:first-child {
  border-top: 0;
}

.ssh-audit article header {
  gap: 7px;
  min-width: 0;
}

.ssh-audit article header strong {
  min-width: 0;
  overflow: hidden;
  font-size: 11.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ssh-audit article time {
  margin-left: auto;
  color: var(--ink-mid);
  font-size: 10px;
  white-space: nowrap;
}

.ssh-audit__decision {
  padding: 4px 7px;
  background: var(--surface-2);
  color: var(--ink-mid);
}

.ssh-audit__decision.allow {
  background: color-mix(in srgb, var(--good) 12%, transparent);
  color: var(--good);
}

.ssh-audit__decision.deny {
  background: color-mix(in srgb, var(--bad) 12%, transparent);
  color: var(--bad);
}

.ssh-audit pre {
  font-size: 11px;
  line-height: 1.45;
}

.ssh-audit__output {
  max-height: 180px;
  padding: 8px 9px;
  overflow: auto;
  border-radius: 7px;
  background: var(--ground);
  color: var(--ink-mid);
}

.ssh-audit__empty {
  margin: 0;
  padding: 14px 10px;
  color: var(--ink-mid);
  font-size: 11px;
}

@container (max-width: 880px) {
  .ssh-panel__surface {
    grid-template-rows: auto auto;
    overflow: auto;
  }

  .ssh-panel__body {
    min-height: max-content;
  }

  .ssh-layout {
    display: flex;
    flex: none;
    flex-direction: column;
    min-height: max-content;
    overflow: visible;
  }

  .ssh-workspace {
    flex: none;
    min-height: 0;
    overflow: visible;
  }

  .ssh-console {
    flex: none;
    height: 500px;
    min-height: 500px;
  }

  .ssh-console:not(.has-session) {
    height: 240px;
    min-height: 240px;
  }

  .ssh-console:not(.has-session) .ssh-terminal-stage {
    min-height: 180px;
  }

  .ssh-connections {
    flex: none;
    min-height: 0;
    overflow: visible;
  }

  .ssh-profile-form {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@container (max-width: 600px) {
  .ssh-panel__surface {
    gap: 8px;
    padding: 7px 8px 10px;
  }

  .ssh-panel__header {
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 7px;
  }

  .ssh-panel__brand {
    grid-column: 1;
  }

  .ssh-panel__summary {
    grid-column: 1 / -1;
    grid-row: 2;
    justify-content: flex-start;
    overflow-x: auto;
  }

  .ssh-refresh {
    grid-column: 2;
    grid-row: 1;
  }

  .ssh-layout {
    gap: 8px;
  }

  .ssh-console {
    height: 560px;
    min-height: 560px;
  }

  .ssh-console__header {
    flex-wrap: wrap;
  }

  .ssh-session-switcher {
    flex: 1 1 0;
    max-width: calc(100% - 40px);
  }

  .ssh-session-switcher__label {
    display: none;
  }

  .ssh-tabs {
    flex: 1 1 auto;
    width: auto;
  }

  .ssh-console__context {
    width: 100%;
    justify-content: flex-start;
    margin-left: 0;
  }

  .ssh-console__context code {
    max-width: none;
  }

  .ssh-terminal-stage {
    min-height: 280px;
  }

  .ssh-session-tools {
    grid-template-columns: 1fr;
  }

  .ssh-agent-access {
    border: 0;
    border-top: 1px solid var(--line);
    border-bottom: 1px solid var(--line);
  }

  .ssh-profile-form {
    grid-template-columns: minmax(0, 1fr);
  }

  .ssh-approval-list {
    grid-template-columns: minmax(0, 1fr);
  }

  .ssh-approval__actions > :deep(.ui-button) {
    flex: 1 1 130px;
  }
}

@container (max-width: 390px) {
  .ssh-panel__brand small,
  .ssh-summary-item:nth-child(2),
  .ssh-console__context code,
  .ssh-session-endpoint small {
    display: none;
  }

  .ssh-panel__mark {
    width: 29px;
    height: 29px;
  }

  .ssh-connection__login {
    grid-template-columns: minmax(0, 1fr);
  }

  .ssh-console {
    height: 540px;
    min-height: 540px;
  }

  .ssh-tab__project-line strong,
  .ssh-tab__copy > small {
    max-width: 14ch;
  }
}

@media (prefers-reduced-motion: reduce) {
  .ssh-connection,
  .ssh-disclosure-icon {
    transition: none;
  }
}
</style>
