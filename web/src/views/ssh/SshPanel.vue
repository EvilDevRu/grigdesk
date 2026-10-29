<template>
  <section
    class="ssh-panel ui-workspace"
    data-ui-workspace
    :class="{
      'is-compact': props.compact,
      'is-dock': props.presentation === 'dock',
      'has-session': Boolean(activeSession),
      'show-connections': showConnections,
    }"
    aria-labelledby="ssh-panel-title"
    :aria-busy="refreshLoading || undefined"
  >
    <div class="ssh-panel__surface">
      <div class="ssh-panel__heading">
        <UiPaneHeader class="ssh-panel__header">
          <template #title>
            <div class="ssh-panel__title">
              <h2 id="ssh-panel-title">SSH</h2>
              <span class="ui-maturity-chip" data-product-maturity="beta" aria-label="Бета-версия">
                бета
              </span>
            </div>
          </template>
          <template #meta>
            <span class="ssh-panel__summary" aria-label="Сводка SSH">
              Серверов: {{ store.connections?.length || 0 }} · Сессий: {{ store.sessions?.length || 0 }}
            </span>
            <span v-if="sshApprovals.length" class="ssh-waiting">
              {{ sshApprovals.length }} ждёт решения
            </span>
          </template>
          <template #actions>
            <UiButton tone="accent" data-context="workspace-toolbar"
                      :aria-expanded="showCreate" aria-controls="ssh-create" @click="toggleCreate">
              {{ showCreate ? 'Скрыть форму' : '+ Добавить сервер' }}
            </UiButton>
            <UiIconButton class="ssh-refresh" role="embedded" data-context="workspace-toolbar"
                          label="Обновить SSH" v-tooltip="'Обновить'" :loading="refreshLoading"
                          loading-label="Обновляю" @click="refresh">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
                   stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M20 7v5h-5 M4 17v-5h5" />
                <path d="M6.1 9a7 7 0 0 1 11.6-2.3L20 9 M4 15l2.3 2.3A7 7 0 0 0 17.9 15" />
              </svg>
            </UiIconButton>
          </template>
        </UiPaneHeader>
      </div>

    <div class="ssh-panel__navigation">
      <UiButton data-context="workspace-toolbar" :pressed="showConnections"
                aria-controls="ssh-connections" @click="showConnections = true">
        Серверы
        <span class="ssh-nav-count">{{ store.connections?.length || 0 }}</span>
      </UiButton>
      <UiButton data-context="workspace-toolbar" :pressed="!showConnections"
                aria-controls="ssh-workspace" @click="showConnections = false">
        {{ showCreate ? 'Новый сервер' : 'Терминал' }}
      </UiButton>
    </div>

    <div class="ssh-panel__body">
      <UiInlineMessage v-if="store.error" tone="danger">
        {{ store.error }}
      </UiInlineMessage>

      <div class="ssh-layout">
      <div id="ssh-workspace" class="ssh-workspace">
        <section v-show="showCreate" id="ssh-create" class="ssh-create ui-workspace-section"
                 aria-labelledby="ssh-create-title">
          <UiPaneHeader>
            <template #title><h3 id="ssh-create-title">Новый сервер</h3></template>
            <template #actions>
              <UiButton data-context="workspace-toolbar" @click="toggleCreate">Отмена</UiButton>
            </template>
          </UiPaneHeader>
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
        </section>


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
                  @click="allow(approval)"
                >
                  Разрешить
                </UiButton>
              </div>
            </article>
          </div>
        </section>

        <section
          v-show="!showCreate"
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
                  class="ssh-session-tab"
                  :id="sessionTabId(session.id)"
                  :value="session.id"
                  controls="ssh-terminal-panel"
                  :data-session-id="session.id"
                  :aria-label="sessionTabAriaLabel(session)"
                  v-tooltip="sessionTabTitle(session)"
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
              v-tooltip="`Закрыть ${activeSession.label}`"
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
            <UiSwitch
              :model-value="activeSession.agentAllowed"
              :aria-label="`Доступ агента к ${activeSession.label}`"
              @update:model-value="toggleAgentAccess(activeSession.id, $event)"
            >
              Команды агента
            </UiSwitch>
            <p>Каждая команда — после подтверждения</p>

          </footer>
        </section>

        <details v-if="activeSession" v-show="!showCreate"
                 class="ssh-sftp ui-workspace-disclosure" data-context="workspace-inline">
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
          <div class="ssh-sftp__body ui-workspace-section__body">
            <div class="ssh-files-bar">
              <UiInput v-model="remotePath" aria-label="Путь на сервере" />
              <UiButton @click="openRemotePath">Открыть</UiButton>
              <UiFilePicker label="Загрузить файл" @change="uploadFiles" />
            </div>
            <ul v-if="store.files?.length" class="ssh-files">
              <li v-for="file in store.files" :key="file.name">
                <span>
                  <i aria-hidden="true">{{ file.type === 'directory' ? '▸' : '·' }}</i>
                  {{ file.name }}
                </span>
                <a
                  v-if="file.type !== 'directory'"
                  :href="sshDownloadUrl(file.name)"
                >
                  Скачать
                </a>
              </li>
            </ul>
            <small v-else class="ssh-files__empty">Каталог пока не открыт.</small>
          </div>
        </details>

        <details v-show="!showCreate" class="ssh-audit ui-workspace-disclosure"
                 data-context="workspace-inline">
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
              <pre v-if="entry.output" class="ssh-audit__output">{{ auditOutputText(entry) }}</pre>
            </article>
          </div>
          <p v-else class="ssh-audit__empty">Команд агента ещё не было.</p>
        </details>
      </div>

      <section
        id="ssh-connections"
        ref="connectionsRegion"
        class="ssh-connections"
        aria-label="Серверы"
        tabindex="-1"
      >
        <UiPaneHeader class="ssh-connections__header">
          <template #title><h3>Серверы</h3></template>
          <template #meta>
            <span class="ssh-catalog-count" data-ssh-server-count>
              {{ store.connections?.length || 0 }}
            </span>
          </template>
        </UiPaneHeader>

        <div v-if="store.connections?.length" class="ssh-catalog-search">
          <UiSearchInput
            v-model="search"
            aria-label="Поиск сервера"
            placeholder="Найти сервер…"
          />
        </div>

        <div class="ssh-connections__body">
          <UiLoadingState v-if="refreshLoading && !store.connections?.length && !store.error">
            <UiSkeletonLayout layout="list" :header="false" />
          </UiLoadingState>
          <div v-else-if="store.connections?.length" class="ssh-connection-list">
            <section
              v-for="group in connectionGroups"
              :key="group.projectId"
              class="ssh-connection-group"
            >
              <h4 class="ssh-connection-group__heading">
                <UiDisclosureButton
                  class="ssh-project-toggle"
                  :open="projectIsExpanded(group.projectId)"
                  :controls="projectGroupId(group.projectId)"
                  :data-ssh-project="group.projectId"
                  :aria-label="projectGroupLabel(
                    group.projectId,
                    group.connections.length,
                    group.sessionCount,
                  )"
                  :disabled="Boolean(search.trim() || connectingId)"
                  v-tooltip="search.trim() ? 'Поиск раскрывает подходящие проекты' : undefined"
                  @update:open="expandedProjectId = $event ? group.projectId : null"
                >
                  <span class="ssh-project-heading">
                    <span class="ssh-project-heading__name">
                      <strong>{{ group.projectId }}</strong>
                      <span
                        v-if="group.sessionCount"
                        class="ssh-session-pill"
                        :aria-label="sessionCountLabel(group.sessionCount)"
                        v-tooltip="sessionCountLabel(group.sessionCount)"
                      >
                        <span class="ssh-session-pill__dot" aria-hidden="true"></span>
                        <span aria-hidden="true">{{ group.sessionCount }}</span>
                      </span>
                    </span>
                    <span class="ssh-server-total">
                      {{ serverCountLabel(group.connections.length) }}
                    </span>
                  </span>
                </UiDisclosureButton>
              </h4>
              <div
                v-show="projectIsExpanded(group.projectId)"
                :id="projectGroupId(group.projectId)"
                class="ssh-connection-group__body"
              >
                <UiButton
                  v-for="connection in group.connections"
                  :key="connection.id"
                  class="ssh-connection"
                  variant="ghost"
                  :class="{ 'is-current': connectionIsActive(connection.id) }"
                  data-context="workspace-catalog-row"
                  :data-connection-id="connection.id"
                  :pressed="selectedConnectionId === connection.id"
                  :disabled="Boolean(connectingId)"
                  @click="selectConnection(connection)"
                >
                  <span class="ssh-connection__top">
                    <span class="ssh-connection__label">{{ connection.label }}</span>
                    <span class="ssh-connection__separator" aria-hidden="true">·</span>
                    <span class="ssh-connection__role">{{ connection.role }}</span>
                    <span
                      v-if="connectionSessionCount(connection.id)"
                      class="ssh-session-pill"
                      :aria-label="sessionCountLabel(connectionSessionCount(connection.id))"
                      v-tooltip="sessionCountLabel(connectionSessionCount(connection.id))"
                    >
                      <span class="ssh-session-pill__dot" aria-hidden="true"></span>
                      <span aria-hidden="true">{{ connectionSessionCount(connection.id) }}</span>
                    </span>
                  </span>
                  <code class="ssh-connection__address">
                    {{ connection.user }}@{{ connection.host }}:{{ connection.port }}
                  </code>
                </UiButton>
              </div>
            </section>
            <div v-if="!connectionGroups.length" class="ssh-catalog-empty" role="status">
              <strong>Подходящих серверов нет.</strong>
              <span>Измените запрос или очистите поиск.</span>
              <UiButton variant="text" size="compact" @click="search = ''">
                Сбросить поиск
              </UiButton>
            </div>
          </div>

          <div v-else-if="!store.error" class="ssh-catalog-empty">
            <svg
              class="ssh-catalog-empty__icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <path d="m7 9 3 3-3 3 M13 15h4" />
            </svg>
            <strong>Серверов пока нет</strong>
            <span>Добавьте первое SSH-подключение — оно появится в каталоге проектов.</span>
            <UiButton variant="solid" tone="accent" @click="toggleCreate">
              Добавить сервер
            </UiButton>
          </div>

          <div v-if="selectedConnection" class="ssh-connections__footer">
            <section class="ssh-selected" aria-label="Выбранный сервер">
              <p v-if="!selectedRowIsListed" class="ssh-selected__project">
                {{ selectedConnection.projectId }}
              </p>
              <div class="ssh-selected__heading">
                <strong>{{ selectedConnection.label }}</strong>
                <span class="ssh-selected__separator" aria-hidden="true">·</span>
                <span class="ssh-selected__role">{{ selectedConnection.role }}</span>
              </div>
              <code class="ssh-selected__address">
                {{ selectedConnection.user }}@{{ selectedConnection.host }}:{{ selectedConnection.port }}
              </code>

              <div v-if="connectionSessionCount(selectedConnection.id)" class="ssh-selected__actions">
                <UiButton
                  variant="solid"
                  tone="accent"
                  data-context="workspace-form"
                  :aria-label="`Открыть терминал ${selectedConnection.label}`"
                  @click="openConnectionSession(selectedConnection.id)"
                >
                  {{ connectionIsActive(selectedConnection.id) ? 'К терминалу' : 'Открыть терминал' }}
                </UiButton>
                <UiButton
                  variant="text"
                  data-context="workspace-form"
                  :aria-expanded="showNewLogin"
                  aria-controls="ssh-login"
                  @click="showNewLogin = !showNewLogin"
                >
                  {{ showNewLogin ? 'Скрыть вход' : '+ Новая сессия' }}
                </UiButton>
              </div>

              <form
                v-if="!connectionSessionCount(selectedConnection.id) || showNewLogin"
                id="ssh-login"
                class="ssh-connection__login"
                @submit.prevent="openConnection(selectedConnection)"
              >
                <UiField label="Пароль на один вход">
                  <UiPasswordInput
                    ref="passwordInput"
                    v-model="passwords[selectedConnection.id]"
                    :aria-label="`Пароль для ${selectedConnection.label}`"
                    autocomplete="current-password"
                    :disabled="Boolean(connectingId)"
                  />
                </UiField>
                <UiButton
                  type="submit"
                  variant="solid"
                  tone="accent"
                  data-context="workspace-form"
                  :loading="connectingId === selectedConnection.id"
                  loading-label="Подключаю"
                  :disabled="Boolean(connectingId && connectingId !== selectedConnection.id)"
                >
                  Подключиться
                </UiButton>
              </form>
            </section>

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
          </div>
        </div>
      </section>

      </div>
    </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { toolWindowText } from '../../shared/tools/toolWindowMessages.ts';
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { Terminal } from '@xterm/xterm';
import type { IDisposable } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

import { errorMessage } from '../../../../shared/lib/errors.ts';

import {
  UiButton,
  UiDisclosureButton,
  UiField,
  UiFilePicker,
  UiFormActions,
  UiIconButton,
  UiInlineMessage,
  UiInput,
  UiNumberInput,
  UiPasswordInput,
  UiPaneHeader,
  UiSearchInput,
  UiSelect,
  UiSwitch,
  UiTab,
  UiTabs,
  alertDialog,
  confirmDialog,
  vTooltip,
  UiLoadingState,
  UiSkeletonLayout,
} from '../../ui';
import type {
  SshAuditEntry,
  SshConnection,
  SshSession,
} from '../../../../shared/plugins/ssh/sshContracts.ts';
import {
  activateSshSession,
  bindSshTerminal,
  closeSshSession,
  connectSshSession,
  decideSshHostKey,
  detachSshTerminal,
  listSshFiles,
  loadSsh,
  loadSshProjects,
  probeSshHostKey,
  resizeSshTerminal,
  saveSshConnection,
  sendSshInput,
  setSshAgentAccess,
  sshDownloadUrl,
  uploadSshFile,
  useSshStore,
  watchSsh,
} from '../../actions/ssh';
import { useChatApprovals } from '../../shared/chatApprovals.ts';
import type { ChatApproval } from '../../shared/chatApprovals.ts';

const props = withDefaults(
  defineProps<{
    active?: boolean;
    compact?: boolean;
    presentation?: string;
  }>(),
  {
    active: true,
    compact: false,
    presentation: 'page',
  },
);

const store = useSshStore();
const chat = useChatApprovals();

watchSsh();

const terminalHost = ref<HTMLElement | null>(null);
const sessionTabs = ref<{ $el?: HTMLElement } | HTMLElement | null>(null);
const connectionsRegion = ref<HTMLElement | null>(null);
const passwordInput = ref<{ focus?: (options?: FocusOptions) => void } | null>(null);
const passwords = reactive<Record<string, string>>({});
const comments = reactive<Record<string, string>>({});
const remotePath = ref('.');
const showConnections = ref(!store.sessions?.length);
const showCreate = ref(false);
const showNewLogin = ref(false);
const search = ref('');
const selectedConnectionId = ref('');
const expandedProjectId = ref<string | null>(null);
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

const sshApprovals = computed(() => Object.values(chat.pending || {})
  .filter((item) => item.origin === 'ssh'));
const activeSession = computed(() => (store.sessions || [])
  .find((item) => item.id === store.activeId));
const selectedSessionId = computed({
  get: () => store.activeId || store.sessions?.[0]?.id || '',
  set: (sessionId: string) => {
    if (sessionId && sessionId !== store.activeId) {
      void activateSession(sessionId);
    }
  },
});
// Новый сервер заводят только на активный проект: архивным уже не работают, а
// связи, заведённые до архива, остаются в списке со своим проектом.
const projectOptions = computed(() => (store.projects || []).filter((project) => !project.archivedAt));
const projectPlaceholder = computed(() => {
  if (store.projectsLoading && !projectOptions.value.length) {
    return 'Загрузка проектов…';
  }

  return projectOptions.value.length ? 'Выберите проект' : 'Проектов пока нет';
});
const refreshLoading = computed(() => store.loading || store.projectsLoading);

const sessionsByConnection = computed(() => {
  const groups = new Map<string, SshSession[]>();

  for (const session of store.sessions || []) {
    const sessions = groups.get(session.connectionId) || [];

    sessions.push(session);
    groups.set(session.connectionId, sessions);
  }

  return groups;
});

const selectedConnection = computed(() => (store.connections || [])
  .find((connection) => connection.id === selectedConnectionId.value));
const connectionGroups = computed(() => {
  const query = search.value.trim().toLocaleLowerCase();
  const groups = new Map<string, SshConnection[]>();

  for (const connection of store.connections || []) {
    const text = [connection.projectId, connection.label, connection.role, connection.host,
      connection.user, connection.port].join(' ').toLocaleLowerCase();

    if (query && !text.includes(query)) {
      continue;
    }

    const connections = groups.get(connection.projectId) || [];

    connections.push(connection);
    groups.set(connection.projectId, connections);
  }

  return [...groups].map(([projectId, connections]) => ({
    projectId,
    connections,
    sessionCount: connections.reduce((count, connection) => (
      count + (sessionsByConnection.value.get(connection.id)?.length || 0)
    ), 0),
  }));
});

function projectGroupId(projectId: string): string {
  return `ssh-project-${encodeURIComponent(projectId)}`;
}

function projectIsExpanded(projectId: string): boolean {
  return Boolean(search.value.trim()) || expandedProjectId.value === projectId;
}

// Имя проекта в подвале нужно, только когда строка выбранного сервера скрыта
// свёрнутой группой или поиском: у раскрытого проекта оно дублировало заголовок.
const selectedRowIsListed = computed(() => {
  const selected = selectedConnection.value;

  if (!selected) {
    return false;
  }

  const listed = connectionGroups.value.some((group) => (
    group.projectId === selected.projectId
    && group.connections.some((connection) => connection.id === selected.id)
  ));

  return listed && projectIsExpanded(selected.projectId);
});

/**
 * Каталог сохраняет выбор при обновлении реестра; исчезнувшая запись заменяется
 * сервером активной сессии либо первой доступной записью без нового подключения.
 */
watch(() => store.connections, (connections) => {
  if (expandedProjectId.value && !connections?.some((connection) => (
    connection.projectId === expandedProjectId.value
  ))) {
    expandedProjectId.value = selectedConnection.value?.projectId || connections?.[0]?.projectId || null;
  }

  if (connections?.some((connection) => connection.id === selectedConnectionId.value)) {
    return;
  }

  const active = connections?.find((connection) => connection.id === activeSession.value?.connectionId);

  selectedConnectionId.value = active?.id || connections?.[0]?.id || '';
}, { immediate: true, deep: true });

// Выбор другой связи раскрывает её проект. Замена объектов при обновлении
// не раскрывает проект заново, если человек сам свернул его заголовком.
watch(() => selectedConnection.value?.id, () => {
  expandedProjectId.value = selectedConnection.value?.projectId ?? null;
}, { immediate: true });

watch(selectedConnectionId, (_id, previous) => {
  if (previous && previous !== connectingId.value) {
    delete passwords[previous];
  }

  showNewLogin.value = false;
});

// Раскрытый вход забирает фокус: человек только что нажал «Новая сессия», и поле
// пароля не должно прятаться внизу каталога без приглашения к вводу.
watch(showNewLogin, async (open) => {
  if (!open) {
    return;
  }

  await nextTick();
  passwordInput.value?.focus?.();
});

/**
 * Выбор строки раскрывает один вход, а для уже подключённого сервера возвращает
 * существующую сессию без проверки ключа и повторной передачи пароля.
 */
function selectConnection(connection: SshConnection): void {
  selectedConnectionId.value = connection.id;
  showCreate.value = false;

  if (connectionSessionCount(connection.id)) {
    void openConnectionSession(connection.id);
  }
}

/**
 * Форма создаётся один раз и сохраняет черновик при скрытии. На узкой панели
 * открытие формы переводит человека в рабочую область, закрытие — к серверам.
 */
function toggleCreate(): void {
  showCreate.value = !showCreate.value;
  showConnections.value = !showCreate.value && !activeSession.value;
}

const connectionSessions = (connectionId: string) => (
  sessionsByConnection.value.get(connectionId) || []
);
const connectionSessionCount = (connectionId: string) => connectionSessions(connectionId).length;
const connectionIsActive = (connectionId: string) => (
  activeSession.value?.connectionId === connectionId
);

/**
 * Русская форма счётчика по правилам 11–14 и младших цифр. Одна формула на все
 * подписи каталога: иначе «2 сесс.» и «1 сервер» начинали говорить по-разному.
 */
function pluralize(count: number, one: string, few: string, many: string): string {
  const mod100 = count % 100;
  const mod10 = count % 10;

  if (mod100 >= 11 && mod100 <= 14) {
    return many;
  }
  if (mod10 === 1) {
    return one;
  }

  return mod10 >= 2 && mod10 <= 4 ? few : many;
}

function serverCountLabel(count: number): string {
  return `${count} ${pluralize(count, 'сервер', 'сервера', 'серверов')}`;
}

function sessionCountLabel(count: number): string {
  return `${count} ${pluralize(count, 'живая сессия', 'живые сессии', 'живых сессий')}`;
}

// Заголовок проекта озвучивает имя, серверы и сессии сразу: у свёрнутой группы
// это единственное место, где её состояние ещё видно.
function projectGroupLabel(projectId: string, servers: number, sessions: number): string {
  const live = sessions ? `, ${sessionCountLabel(sessions)}` : '';

  return `Проект ${projectId}, ${serverCountLabel(servers)}${live}`;
}

const auditDecisionLabel = (decision: string | null | undefined) => ({
  allow: 'Разрешено',
  deny: 'Отказано',
}[String(decision)] || decision || 'Без решения');

/**
 * Время записи журнала человеку. Непонятное значение показывается как есть: подменять
 * его «сегодня» нельзя — рядом стоит команда, и время должно быть её.
 */
function formatAuditDate(value: string): string {
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

// Вывод команды агента журнал хранит вместе со счётом байт, а показывает человеку
// сам текст: срез виден отдельной строкой рядом.
function auditOutputText(entry: SshAuditEntry): string {
  return entry.output ? entry.output.text : '';
}

let terminal: Terminal | null = null;
let fit: FitAddon | null = null;
let terminalInput: IDisposable | undefined;
let terminalObserver: ResizeObserver | undefined;
let resizeFrame = 0;
let lastTerminalSize = '';
let disposed = false;

/**
 * Xterm создаётся только перед реальным подключением. Так пустая SSH-панель не
 * показывает чёрный терминал с курсором и не платит за невостребованный renderer.
 */
async function ensureTerminal(): Promise<boolean> {
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
  bindSshTerminal(terminal);
  terminalInput = terminal.onData?.((data: string) => sendSshInput(data));

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
function fitTerminal(): void {
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
  resizeSshTerminal(cols, rows);
}

// Кадр анимации вместо прямого вызова: ResizeObserver срабатывает пачкой, а перетяжка
// границы дока даёт их десятками подряд.
function scheduleTerminalFit(): void {
  if (resizeFrame) {
    cancelAnimationFrame(resizeFrame);
  }

  resizeFrame = requestAnimationFrame(() => {
    resizeFrame = 0;
    fitTerminal();
  });
}

// Раздел и каталог проектов читаются вместе: форма нового сервера бесполезна без
// списка проектов, а список сессий — без самих серверов.
async function refresh(): Promise<void> {
  await Promise.all([loadSsh(), loadSshProjects()]);
}

/**
 * Выбор сеанса возвращает терминал, в том числе при повторном выборе того же сервера.
 * Каталог скрывается после подготовки xterm, а само соединение остаётся в store.
 */
async function activateSession(sessionId: string): Promise<void> {
  const ready = await ensureTerminal();

  if (!ready || disposed) {
    return;
  }

  activateSshSession(sessionId);
  showConnections.value = false;
}

function sessionTabId(sessionId: string): string {
  return `ssh-session-tab-${String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

function sessionProjectLabel(session: SshSession): string {
  const connection = (store.connections || [])
    .find((item) => item.id === session.connectionId);

  return String(session.projectId || connection?.projectId || 'не указан');
}

function sessionTargetBase(session: SshSession): string {
  const values = [session.label, session.role]
    .map((value) => String(value || '').trim())
    .filter((value, index, items) => value && items.indexOf(value) === index);

  return values.join(' · ')
    || [session.host, session.port].filter(Boolean).join(':')
    || 'SSH-сессия';
}

/**
 * Полная видимая метка различает повторные входы в один сервер порядковым номером:
 * две вкладки с одинаковым названием человек путает, а закрывает он их по одной.
 */
function sessionTargetLabel(session: SshSession): string {
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

// Подсказка вкладки называет проект, саму сессию и адрес входа: одной метки мало,
// когда в проекте открыто несколько одинаковых по названию серверов.
function sessionTabTitle(session: SshSession): string {
  const endpoint = [session.host, session.port].filter(Boolean).join(':');
  const identity = [session.user, endpoint].filter(Boolean).join('@');
  const parts = [
    `Проект ${sessionProjectLabel(session)}`,
    sessionTargetLabel(session),
    identity,
  ].filter(Boolean);

  return parts.join(' — ');
}

// То же для чтения с экрана: порядок частей общий, но разделитель — запятая, иначе
// длинное тире читается вслух как часть адреса.
function sessionTabAriaLabel(session: SshSession): string {
  const endpoint = [session.host, session.port].filter(Boolean).join(':');
  const identity = [session.user, endpoint].filter(Boolean).join('@');
  const parts = [
    `Проект ${sessionProjectLabel(session)}`,
    `сессия ${sessionTargetLabel(session)}`,
    identity,
  ].filter(Boolean);

  return parts.join(', ');
}

// Фокус переносится на вкладку по её сессии, а не по позиции: список к этому моменту
// мог уже перестроиться ответом сервера.
async function focusSessionTab(sessionId: string): Promise<void> {
  await nextTick();

  const root = sessionTabs.value;
  const tabsRoot = (root && '$el' in root ? root.$el : root) as HTMLElement | null;
  const tab = [...(tabsRoot?.querySelectorAll?.('[role="tab"]') || [])]
    .find((item) => (item as HTMLElement).dataset.sessionId === sessionId);

  (tab as HTMLElement | undefined)?.focus();
}

/**
 * Карточка сервера возвращает в живую сессию без нового probe и ввода пароля:
 * сессия уже открыта на сервере, и второй вход завёл бы рядом ещё одну.
 */
async function openConnectionSession(connectionId: string): Promise<void> {
  const sessions = connectionSessions(connectionId);
  const session = sessions.find((item) => item.id === store.activeId) || sessions.at(-1);

  if (!session) {
    return;
  }

  if (store.activeId !== session.id) {
    await activateSession(session.id);
  }

  showCreate.value = false;
  showConnections.value = false;

  await nextTick();
  terminal?.focus?.();
}

/**
 * Закрытие активной вкладки выбирает соседа и сохраняет непрерывный roving focus:
 * иначе фокус улетает в начало страницы, и клавиатурная работа обрывается.
 */
async function closeActiveSession(): Promise<void> {
  const sessionId = store.activeId;

  if (!sessionId || closingSessionId.value) {
    return;
  }

  const sessions = store.sessions || [];
  const index = sessions.findIndex((session) => session.id === sessionId);
  const replacementId = sessions[index + 1]?.id || sessions[index - 1]?.id || '';

  closingSessionId.value = sessionId;

  try {
    await closeSshSession(sessionId);

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

    await alertDialog(errorMessage(error, 'Не удалось закрыть SSH-сессию'), { title: 'SSH' });
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

watch(() => activeSession.value?.id, async () => {
  const session = activeSession.value;

  showConnections.value = !session;

  if (session) {
    showCreate.value = false;
    selectedConnectionId.value = session.connectionId;
  }

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

watch([showConnections, showCreate], async ([show, creating]) => {
  if (!show && !creating) {
    await nextTick();
    scheduleTerminalFit();
  }
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
  detachSshTerminal();
  terminal?.dispose?.();
});

/**
 * Вход на сервер. Ключ хоста проверяется до пароля: молчаливое доверие первому
 * ответившему означало бы отдать пароль root тому, кто занял адрес. Пароль стирается
 * в любом исходе — и после успеха, и после отказа.
 */
async function openConnection(connection: SshConnection): Promise<void> {
  if (connectingId.value) {
    return;
  }

  connectingId.value = connection.id;

  try {
    const check = await probeSshHostKey(connection.id);

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

      await decideSshHostKey(String(check.challengeId), changed ? 'replace' : 'trust');
    }

    if (!await ensureTerminal()) {
      return;
    }

    await connectSshSession(connection.id, passwords[connection.id] || '');
    showCreate.value = false;
    showConnections.value = false;
  } catch (error) {
    await alertDialog(errorMessage(error, 'Не удалось подключиться'), { title: 'SSH' });
  } finally {
    passwords[connection.id] = '';

    if (connectingId.value === connection.id) {
      connectingId.value = '';
    }
  }
}

/**
 * Сохранение нового сервера. Проект обязателен: без него соединение не принадлежит
 * ничему, и агент не сможет получить к нему доступ ни при каком решении человека.
 */
async function saveConnection(): Promise<void> {
  if (savingConnection.value || !draft.projectId) {
    return;
  }

  savingConnection.value = true;

  try {
    const saved = await saveSshConnection({
      ...draft,
      port: Number(draft.port) || 22,
    });

    selectedConnectionId.value = saved?.id || selectedConnectionId.value;
    showCreate.value = false;
    showConnections.value = true;
    search.value = '';
    Object.assign(draft, {
      projectId: '',
      label: '',
      role: '',
      host: '',
      port: 22,
      user: '',
    });
  } catch (error) {
    await alertDialog(errorMessage(error, 'Не удалось сохранить соединение'), { title: 'SSH' });
  } finally {
    savingConnection.value = false;
  }
}

// Файл кладётся в открытый каталог под своим именем: путь собирается здесь, а не в
// операции, потому что «куда» видно только на экране.
async function uploadFiles(files: File[]): Promise<void> {
  const file = files?.[0];

  if (file) {
    const destination = `${remotePath.value.replace(/\/$/, '')}/${file.name}`;

    await uploadSshFile(file, destination);
  }
}

function openRemotePath(): void {
  void listSshFiles(remotePath.value);
}

function toggleAgentAccess(sessionId: string, allowed: boolean): void {
  void setSshAgentAccess(sessionId, allowed);
}

function allow(approval: ChatApproval): void {
  chat.answerPerm(approval.pid, true, false, '', '');
}

function deny(approval: ChatApproval): void {
  const comment = String(comments[approval.pid] || '').trim();

  chat.answerPerm(approval.pid, false, false, comment, '');
}
/**
 * Перенос сохраняет серверную сессию, но не её пароль или вывод терминала.
 * Клиентский канал заново присоединяется после загрузки списка сессий.
 */
function exportState() {
  if (connectingId.value || closingSessionId.value || savingConnection.value) {
    throw new Error(toolWindowText('toolSshBusy'));
  }

  return { sessionId: selectedSessionId.value, remotePath: remotePath.value };
}

/**
 * Восстанавливает выбор без повторного подключения к удалённому серверу.
 * Существующая серверная сессия получает только новый клиентский терминал.
 */
async function importState(state: Record<string, unknown>) {
  await refresh();

  if (typeof state.sessionId === 'string'
    && store.sessions.some((session) => session.id === state.sessionId)) {
    await activateSession(state.sessionId);
  }

  if (typeof state.remotePath === 'string') {
    remotePath.value = state.remotePath;
  }
}

defineExpose({ exportState, importState });
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
}

.ssh-panel__surface,
.ssh-panel__body {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  height: 100%;
}

.ssh-panel__heading,
.ssh-panel__navigation {
  flex: none;
}

.ssh-panel.is-dock .ssh-panel__heading {
  padding-right: var(--tool-dock-actions-space, 82px);
}

.ssh-panel__title {
  display: flex;
  align-items: center;
  gap: 8px;
}

.ssh-panel__navigation {
  display: none;
  gap: 6px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--line);
}

.ssh-nav-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 17px;
  height: 16px;
  margin-left: 5px;
  padding-inline: 5px;
  border-radius: 999px;
  background: var(--surface-2);
  color: var(--ink-mid);
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
  line-height: 15px;
}

.ssh-layout {
  display: grid;
  flex: 1;
  grid-template-columns: minmax(240px, 300px) minmax(0, 1fr);
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.ssh-connections {
  display: flex;
  flex-direction: column;
  grid-column: 1;
  grid-row: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  border-right: 1px solid var(--line);
  background: var(--sidebar);
}

.ssh-connections__header {
  flex: none;
}

.ssh-connections__body {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
  padding: 8px 10px 10px;
  overflow: auto;
  overscroll-behavior: contain;
}

.ssh-catalog-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  height: 18px;
  padding-inline: 6px;
  border-radius: 999px;
  background: var(--surface-2);
  color: var(--ink-mid);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

/* Поиск не прокручивается вместе со списком: в длинном каталоге его находят
   там же, где он был, а не после прокрутки наверх. */
.ssh-catalog-search {
  display: grid;
  flex: none;
  gap: 6px;
  padding: 10px 10px 0;
}

.ssh-connection-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
}

.ssh-connection-group {
  min-width: 0;
}

/* Заголовок проекта липнет к верхней кромке списка: в длинной группе видно,
   какому проекту принадлежат серверы под курсором. */
.ssh-connection-group__heading {
  position: sticky;
  top: 0;
  z-index: 2;
  margin: 0 -10px;
  padding: 0 10px;
  background: var(--sidebar);
}

.ssh-project-toggle {
  width: 100%;
  padding-inline: 8px;
}

.ssh-project-heading {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 8px;
  min-width: 0;
  width: 100%;
}

.ssh-project-heading__name {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.ssh-project-heading strong {
  min-width: 0;
  overflow: hidden;
  font-size: 12.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Метка сессий стоит вплотную к имени проекта: auto-отступ нужен только строке
   сервера, где метка прижимается к правому краю. */
.ssh-project-heading .ssh-session-pill {
  margin-left: 0;
}

.ssh-server-total {
  flex: none;
  color: var(--ink-low);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  font-weight: 400;
}

/* Подгруппа получает вертикальную направляющую: строки серверов читаются как дети
   проекта и не превращаются во вторую карточку с собственной рамкой. */
.ssh-connection-group__body {
  display: grid;
  gap: 2px;
  min-width: 0;
  margin: 2px 0 0 9px;
  padding-left: 7px;
  border-left: 1px solid var(--line-2);
}

.ssh-connection,
.ssh-connection :deep(.ui-button__content),
.ssh-connection :deep(.ui-button__label) {
  min-width: 0;
  width: 100%;
}

.ssh-connection :deep(.ui-button__label) {
  display: grid;
  gap: 1px;
  text-align: left;
}

.ssh-connection__top {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.ssh-connection__label {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  font-size: 13px;
  font-weight: 600;
  line-height: 18px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ssh-connection__separator,
.ssh-selected__separator {
  flex: none;
  color: var(--ink-low);
  font-size: 11px;
  line-height: 15px;
}

.ssh-connection__role,
.ssh-selected__role {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 45%;
  overflow: hidden;
  color: var(--ink-mid);
  font-size: 11.5px;
  line-height: 16px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ssh-session-pill {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 4px;
  margin-left: auto;
  padding: 1px 6px 1px 5px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--good) 14%, transparent);
  color: var(--good);
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  line-height: 15px;
}

.ssh-session-pill__dot {
  flex: none;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
}

.ssh-connection__address {
  overflow: hidden;
  color: var(--ink-low);
  font-family: var(--mono);
  font-size: 11px;
  line-height: 15px;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Пустой каталог объясняет следующий шаг: строка «серверов нет» без действия
   оставляла искать добавление в шапке панели. */
.ssh-catalog-empty {
  display: grid;
  justify-items: start;
  gap: 6px;
  padding: 14px 12px;
  border: 1px dashed var(--line-2);
  border-radius: var(--radius-sm);
}

.ssh-catalog-empty__icon {
  width: 22px;
  height: 22px;
  color: var(--ink-low);
}

.ssh-catalog-empty strong {
  color: var(--ink);
  font-size: 13px;
  font-weight: 600;
}

.ssh-catalog-empty span {
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 17px;
  overflow-wrap: anywhere;
}

.ssh-catalog-empty :deep(.ui-button) {
  margin-top: 2px;
}

/* Подвал каталога всегда на виду: действия выбранного сервера не уезжают вниз
   длинного списка. Липкая строка начинается сразу под списком и прижимается к низу,
   только когда каталог прокручивается, — без пустого провала в короткой панели. */
.ssh-connections__footer {
  position: sticky;
  bottom: 0;
  z-index: 3;
  display: grid;
  flex: none;
  gap: 8px;
  margin-inline: -10px;
  padding: 10px;
  border-top: 1px solid var(--line);
  background: var(--sidebar);
}

.ssh-selected {
  display: grid;
  gap: 7px;
  min-width: 0;
  padding: 10px;
  border: 1px solid color-mix(in srgb, var(--accent) 22%, var(--line));
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--accent) 6%, var(--surface));
}

.ssh-selected__project {
  margin: 0;
  overflow: hidden;
  color: var(--ink-low);
  font-size: 11px;
  line-height: 14px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ssh-selected__heading {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.ssh-selected__heading strong {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--ink);
  font-size: 13px;
  line-height: 18px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ssh-selected__address {
  color: var(--ink-mid);
  font-family: var(--mono);
  font-size: 11px;
  line-height: 15px;
  overflow-wrap: anywhere;
}

.ssh-selected__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
}

.ssh-selected__actions :deep(.ui-button:first-child) {
  flex: 1 1 120px;
}

.ssh-connection__login {
  display: grid;
  gap: 8px;
  min-width: 0;
}

.ssh-secret-note {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 0;
  padding-inline: 2px;
  color: var(--ink-low);
  font-size: 10.5px;
  line-height: 14px;
  text-wrap: pretty;
}

.ssh-secret-note svg {
  flex: none;
  width: 13px;
  height: 14px;
}

.ssh-workspace {
  display: flex;
  flex-direction: column;
  grid-column: 2;
  grid-row: 1;
  gap: 12px;
  min-width: 0;
  min-height: 0;
  padding: 12px;
  overflow: auto;
}

.ssh-create {
  flex: none;
  width: 100%;
  max-width: 760px;
}

.ssh-profile-form {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  min-width: 0;
  padding: 16px;
}

.ssh-profile-form__actions,
.ssh-project-message {
  grid-column: 1 / -1;
}

.ssh-console {
  display: flex;
  flex: 1 0 300px;
  flex-direction: column;
  min-width: 0;
  min-height: 300px;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--ground);
}

.ssh-console__header {
  display: flex;
  flex: none;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  min-width: 0;
  min-height: 36px;
  padding: 4px 8px;
  border-bottom: 1px solid var(--line);
  background: var(--topbar);
}

.ssh-session-switcher {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.ssh-session-switcher__label {
  display: none;
}

.ssh-tabs {
  gap: 4px;
  min-width: 0;
  max-width: 100%;
}

.ssh-session-tab {
  flex: none;
}

.ssh-tab__content,
.ssh-tab__project-line,
.ssh-console__context,
.ssh-live-label {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.ssh-tab__copy {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  text-align: left;
}

.ssh-tab__content {
  padding-inline: 6px;
}

.ssh-tab__project-line > small {
  display: none;
}

.ssh-tab__project-line strong,
.ssh-tab__copy > small {
  max-width: 22ch;
  overflow: hidden;
  font-size: 12px;
  line-height: 18px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ssh-tab__copy > small {
  color: var(--ink-mid);
}

.ssh-console__context {
  flex-wrap: wrap;
  width: 100%;
  padding-bottom: 2px;
  color: var(--ink-mid);
  font-size: 12px;
}

.ssh-console__context code {
  overflow-wrap: anywhere;
}

.ssh-role-badge {
  margin-right: auto;
}

.ssh-live-label {
  flex: none;
  color: var(--good);
  font-size: 12px;
  white-space: nowrap;
}

.ssh-live-label i,
.ssh-tab__dot {
  flex: none;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--good);
}

.ssh-console__title {
  color: var(--ink-mid);
  font-size: 12px;
}

.ssh-terminal-stage {
  display: grid;
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
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
  gap: 8px;
  padding: 24px;
  color: var(--ink-mid);
  text-align: center;
}

.ssh-console__empty-icon {
  margin-bottom: 4px;
  color: var(--ink-mid);
  font-family: var(--mono);
  font-size: 24px;
}

.ssh-console__empty strong {
  color: var(--ink);
  font-size: 13px;
  font-weight: 500;
}

.ssh-console__empty > :last-child {
  max-width: 40ch;
  font-size: 12px;
  line-height: 20px;
}

.ssh-session-tools,
.ssh-agent-access {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 16px;
}

.ssh-session-tools {
  padding: 8px 12px;
  border-top: 1px solid var(--line);
  color: var(--ink-mid);
  font-size: 12px;
}

.ssh-session-tools p {
  margin: 0;
}

.ssh-files-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.ssh-files-bar > :first-child {
  flex: 1 1 180px;
  min-width: 0;
}

.ssh-files,
.ssh-audit__list {
  display: grid;
  gap: 8px;
  max-height: 280px;
  margin: 0;
  padding: 0;
  overflow: auto;
  list-style: none;
}

.ssh-files li,
.ssh-audit article header {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 8px;
  overflow-wrap: anywhere;
}

.ssh-files a {
  color: var(--accent);
}

.ssh-sftp__body,
.ssh-audit article {
  display: grid;
  gap: 12px;
  min-width: 0;
  padding-block: 12px;
}

.ssh-sftp > summary svg,
.ssh-audit > summary svg {
  width: 14px;
  height: 14px;
  margin-right: 6px;
  vertical-align: -2px;
  color: var(--ink-mid);
}

.ssh-audit > summary .ssh-count {
  margin-left: 8px;
}

.ssh-files__empty,
.ssh-audit__empty,
.ssh-audit article time,
.ssh-audit__output {
  color: var(--ink-mid);
  font-size: 12px;
}

.ssh-approvals {
  display: grid;
  flex: none;
  gap: 12px;
}

.ssh-approvals__heading,
.ssh-approval__server,
.ssh-approval__identity,
.ssh-approval__actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  min-width: 0;
  overflow-wrap: anywhere;
}

.ssh-approvals__heading h3 {
  margin: 0;
  font-size: 13px;
}

.ssh-approvals__heading small {
  color: var(--ink-mid);
  font-size: 12px;
}

.ssh-approvals__icon,
.ssh-waiting,
.ssh-count.is-waiting {
  color: var(--warn);
}

.ssh-approval-list {
  display: grid;
  gap: 12px;
  max-height: 360px;
  overflow: auto;
}

.ssh-approval {
  display: grid;
  gap: 8px;
  min-width: 0;
  padding: 12px;
  border: 1px solid color-mix(in srgb, var(--warn) 35%, var(--line));
  border-radius: var(--radius-sm);
}

.ssh-approval__identity,
.ssh-count,
.ssh-audit__decision {
  color: var(--ink-mid);
  font-size: 12px;
}

.ssh-badge,
.ssh-audit__decision.deny {
  color: var(--bad);
}

.ssh-audit__decision.allow {
  color: var(--good);
}

.ssh-approval pre,
.ssh-audit pre {
  min-width: 0;
  max-height: 180px;
  margin: 0;
  overflow: auto;
  font-family: var(--mono);
  font-size: 12px;
  line-height: 18px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.ssh-approval__actions {
  justify-content: flex-end;
}

@container (max-width: 880px) {
  .ssh-panel__navigation {
    display: flex;
  }

  .ssh-layout {
    grid-template-columns: minmax(0, 1fr);
  }

  .ssh-connections,
  .ssh-workspace {
    grid-column: 1;
  }

  .ssh-connections {
    border-right: 0;
  }

  /* В узкой панели «Серверы» уже названы переключателем с числом: отдельная
     шапка каталога повторяла подпись и отнимала строку у поиска. */
  .ssh-connections__header {
    display: none;
  }

  .ssh-panel:not(.show-connections) .ssh-connections,
  .ssh-panel.show-connections .ssh-workspace {
    display: none;
  }
}

@container (max-width: 560px) {
  .ssh-profile-form {
    grid-template-columns: minmax(0, 1fr);
  }

  /* В узкой панели сводка шапки ломается на две строки и выдавливает действия.
     Числа серверов и сессий остаются в каталоге и на вкладках. */
  .ssh-panel__summary {
    display: none;
  }
}
</style>
