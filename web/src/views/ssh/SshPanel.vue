<template>
  <section
    class="ssh-panel"
    :class="{
      'is-compact': props.compact,
      'is-dock': props.presentation === 'dock',
    }"
  >
    <header class="ssh-panel__header">
      <div>
        <h2>SSH</h2>
        <small>Соединения и сессии живут на сервере кокпита</small>
      </div>
      <UiButton
        size="sm"
        :loading="refreshLoading"
        loading-label="Обновляю"
        @click="refresh"
      >
        Обновить
      </UiButton>
    </header>

    <UiInlineMessage v-if="store.error" tone="danger">
      {{ store.error }}
    </UiInlineMessage>

    <section class="ssh-console" aria-label="SSH-терминал">
      <div
        v-if="store.sessions?.length"
        class="ssh-tabs"
        role="tablist"
        aria-label="SSH-сессии"
      >
        <div v-for="session in store.sessions" :key="session.id" class="ssh-tab-wrap">
          <UiButton
            role="tab"
            :aria-selected="store.activeId === session.id"
            :class="{ active: store.activeId === session.id }"
            @click="activateSession(session.id)"
          >
            {{ session.label }}
          </UiButton>
          <UiButton
            class="ssh-tab-close"
            size="sm"
            tone="danger"
            :aria-label="`Закрыть ${session.label}`"
            @click="store.closeSession?.(session.id)"
          >
            ×
          </UiButton>
        </div>
      </div>

      <div
        v-show="activeSession"
        ref="terminalHost"
        class="ssh-terminal"
        data-ssh-terminal-host
        data-escape-owner="terminal"
      ></div>

      <div v-if="!activeSession" class="ssh-console__empty" role="status">
        <strong>Нет активной SSH-сессии</strong>
        <span>Выберите сохранённое соединение ниже — терминал появится после входа.</span>
      </div>

      <div v-if="activeSession" class="ssh-session-tools">
        <label class="ssh-agent-access">
          <UiCheckbox
            :model-value="activeSession.agentAllowed"
            @update:model-value="store.setAgentAccess?.(activeSession.id, $event)"
          />
          Агенту можно выполнять команды с подтверждением
        </label>

        <details class="ssh-sftp">
          <summary>SFTP для человека</summary>
          <div class="ssh-files-bar">
            <UiInput v-model="remotePath" aria-label="Путь на сервере" />
            <UiButton size="sm" @click="store.listFiles?.(remotePath)">Открыть</UiButton>
            <UiFilePicker size="sm" label="Загрузить файл" @change="uploadFiles" />
          </div>
          <ul class="ssh-files">
            <li v-for="file in store.files || []" :key="file.path || file.name">
              <span>{{ file.name }}</span>
              <a
                v-if="!file.directory"
                :href="store.downloadUrl?.(file.path || file.name)"
              >
                Скачать
              </a>
            </li>
          </ul>
        </details>
      </div>
    </section>

    <section class="ssh-connections" aria-label="Соединения">
      <header class="ssh-section-heading">
        <div>
          <h3>Соединения</h3>
          <small>Пароль запрашивается заново при каждом входе и не сохраняется.</small>
        </div>
        <span v-if="store.connections?.length" class="ssh-count">
          {{ store.connections.length }}
        </span>
      </header>

      <div v-if="store.connections?.length" class="ssh-connection-list">
        <article
          v-for="connection in store.connections"
          :key="connection.id"
          class="ssh-connection"
        >
          <div class="ssh-connection__identity">
            <div class="ssh-connection__title">
              <strong>{{ connection.label }}</strong>
              <span class="ssh-project-badge">{{ connection.projectId }}</span>
            </div>
            <small>{{ connection.role }}</small>
            <code>{{ connection.user }}@{{ connection.host }}:{{ connection.port }}</code>
          </div>
          <div class="ssh-connection__actions">
            <UiPasswordInput
              v-model="passwords[connection.id]"
              :aria-label="`Пароль для ${connection.label}`"
              autocomplete="current-password"
              placeholder="Пароль на один вход"
            />
            <UiButton
              size="sm"
              variant="solid"
              @click="openConnection(connection)"
            >
              Подключить
            </UiButton>
          </div>
        </article>
      </div>

      <UiInlineMessage v-else>Сохранённых соединений пока нет.</UiInlineMessage>

      <details class="ssh-add-connection" :open="!store.connections?.length">
        <summary>Добавить соединение</summary>
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
              <option v-for="project in projectOptions" :key="project.id" :value="project.id">
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
              :loading="savingConnection"
              loading-label="Сохраняю"
              :disabled="!draft.projectId"
            >
              Сохранить соединение
            </UiButton>
          </UiFormActions>
        </form>
      </details>
    </section>

    <section v-if="sshApprovals.length" class="ssh-approvals" aria-label="Подтверждения команд">
      <h3>Агент ждёт решения</h3>
      <article
        v-for="approval in sshApprovals"
        :key="approval.pid"
        class="ssh-approval"
        data-ssh-approval
      >
        <div data-ssh-server>
          {{ approval.server?.label }} — {{ approval.server?.host }}:{{ approval.server?.port }}
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
          <UiButton
            variant="solid"
            tone="accent"
            @click="chat.answerPerm(approval.pid, true, false, '', '')"
          >
            Разрешить
          </UiButton>
          <UiButton tone="danger" @click="deny(approval)">Отказать</UiButton>
        </div>
      </article>
    </section>

    <details class="ssh-audit">
      <summary>Журнал команд агента</summary>
      <article
        v-for="entry in store.audit || []"
        :key="`${entry.at}-${entry.sessionId}-${entry.command}`"
      >
        <time>{{ entry.at }}</time>
        <strong>{{ entry.label }} · {{ entry.decision }}</strong>
        <pre>{{ entry.command }}</pre>
        <pre v-if="entry.output">{{ entry.output }}</pre>
      </article>
    </details>
  </section>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import {
  UiButton,
  UiCheckbox,
  UiField,
  UiFilePicker,
  UiFormActions,
  UiInlineMessage,
  UiInput,
  UiNumberInput,
  UiPasswordInput,
  UiSelect,
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
const passwords = reactive({});
const comments = reactive({});
const remotePath = ref('.');
const savingConnection = ref(false);
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
const projectOptions = computed(() => store.projects || []);
const projectPlaceholder = computed(() => {
  if (store.projectsLoading && !projectOptions.value.length) {
    return 'Загрузка проектов…';
  }

  return projectOptions.value.length ? 'Выберите проект' : 'Проектов пока нет';
});
const refreshLoading = computed(() => store.loading || store.projectsLoading);

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
  display: grid;
  align-content: start;
  gap: 14px;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  padding: 12px;
  overflow: auto;
}

.ssh-panel__header,
.ssh-section-heading,
.ssh-connection__title,
.ssh-files-bar,
.ssh-approval__actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.ssh-panel__header,
.ssh-section-heading {
  justify-content: space-between;
}

.ssh-panel__header h2,
.ssh-section-heading h3,
.ssh-approvals h3 {
  margin: 0;
}

.ssh-panel__header h2 {
  font-size: 16px;
}

.ssh-panel__header small,
.ssh-section-heading small,
.ssh-connection small {
  display: block;
  margin-top: 3px;
  color: var(--ink-mid);
}

.ssh-panel.is-compact.is-dock .ssh-panel__header {
  padding-right: var(--tool-dock-actions-space, 82px);
}

.ssh-console {
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--ground);
  box-shadow: var(--shadow);
}

.ssh-tabs {
  display: flex;
  gap: 6px;
  min-width: 0;
  padding: 8px;
  overflow-x: auto;
  border-bottom: 1px solid var(--line);
  background: var(--topbar);
}

.ssh-tab-wrap {
  display: flex;
  flex: none;
}

.ssh-tab-wrap [role='tab'].active {
  border-color: var(--accent);
  background: var(--surface-2);
}

.ssh-tab-close {
  margin-left: -1px;
}

.ssh-terminal {
  width: 100%;
  height: clamp(280px, 44vh, 560px);
  min-width: 0;
  min-height: 280px;
  padding: 8px 10px;
  overflow: hidden;
  background: var(--ground);
}

.ssh-terminal :deep(.xterm) {
  height: 100%;
}

.ssh-terminal :deep(.xterm-viewport) {
  background: transparent !important;
}

.ssh-console__empty {
  display: grid;
  place-content: center;
  gap: 6px;
  min-height: 156px;
  padding: 24px;
  color: var(--ink-mid);
  text-align: center;
  background:
    radial-gradient(circle at 50% 100%, color-mix(in srgb, var(--accent) 8%, transparent), transparent 56%),
    var(--ground);
}

.ssh-console__empty strong {
  color: var(--ink);
  font-size: 14px;
}

.ssh-session-tools {
  display: grid;
  gap: 10px;
  padding: 10px 12px;
  border-top: 1px solid var(--line);
  background: var(--topbar);
}

.ssh-agent-access {
  display: flex;
  align-items: center;
  gap: 8px;
}

.ssh-sftp summary,
.ssh-add-connection summary,
.ssh-audit summary {
  cursor: pointer;
}

.ssh-files-bar {
  flex-wrap: wrap;
  padding-top: 10px;
}

.ssh-files-bar > :first-child {
  flex: 1 1 220px;
}

.ssh-files {
  display: grid;
  gap: 5px;
  margin: 10px 0 0;
  padding: 0;
  list-style: none;
}

.ssh-files li {
  display: flex;
  justify-content: space-between;
  gap: 8px;
}

.ssh-connections,
.ssh-approvals,
.ssh-audit {
  display: grid;
  gap: 10px;
  min-width: 0;
}

.ssh-section-heading h3,
.ssh-approvals h3 {
  font-size: 14px;
}

.ssh-count,
.ssh-project-badge,
.ssh-badge {
  flex: none;
  border-radius: 999px;
  font-size: 11px;
}

.ssh-count {
  display: grid;
  place-items: center;
  min-width: 24px;
  height: 24px;
  padding: 0 7px;
  background: var(--surface-2);
  color: var(--ink-mid);
}

.ssh-connection-list {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 430px), 1fr));
  gap: 10px;
}

.ssh-connection {
  display: grid;
  gap: 12px;
  min-width: 0;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
}

.ssh-connection__identity {
  min-width: 0;
}

.ssh-connection__title {
  flex-wrap: wrap;
}

.ssh-project-badge {
  padding: 2px 7px;
  background: color-mix(in srgb, var(--accent) 13%, transparent);
  color: var(--accent);
}

.ssh-connection code {
  display: block;
  margin-top: 7px;
  overflow: hidden;
  color: var(--ink);
  font-family: var(--mono);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ssh-connection__actions {
  display: grid;
  grid-template-columns: minmax(180px, 1fr) auto;
  gap: 8px;
}

.ssh-add-connection {
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--surface) 46%, transparent);
}

.ssh-add-connection > summary {
  padding: 11px 12px;
  font-weight: 600;
}

.ssh-add-connection[open] > summary {
  border-bottom: 1px solid var(--line);
}

.ssh-profile-form {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 180px), 1fr));
  gap: 12px;
  padding: 14px 12px 12px;
}

.ssh-project-message,
.ssh-profile-form__actions {
  grid-column: 1 / -1;
}

.ssh-approval {
  display: grid;
  gap: 8px;
  min-width: 0;
  max-width: 100%;
  padding: 12px;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
}

.ssh-approval pre,
.ssh-audit pre {
  min-width: 0;
  max-width: 100%;
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
}

.ssh-approval__identity {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.ssh-badge {
  padding: 1px 6px;
  background: color-mix(in srgb, var(--bad) 12%, transparent);
  color: var(--bad);
}

.ssh-approval__actions {
  justify-content: flex-end;
  flex-wrap: wrap;
  min-width: 0;
}

.ssh-audit {
  padding: 11px 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
}

.ssh-audit article {
  min-width: 0;
  padding: 8px 0;
  border-top: 1px solid var(--line);
}

@container (max-width: 520px) {
  .ssh-panel__header {
    display: grid;
    justify-items: start;
  }

  .ssh-section-heading {
    align-items: flex-start;
  }

  .ssh-connection__actions {
    grid-template-columns: 1fr;
  }

  .ssh-terminal {
    height: 320px;
  }
}
</style>
