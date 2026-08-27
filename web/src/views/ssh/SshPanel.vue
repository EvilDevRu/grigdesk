<template>
  <section class="ssh-panel">
    <header class="ssh-panel__header">
      <div>
        <strong>SSH</strong>
        <small>Соединения живут на сервере кокпита</small>
      </div>
      <UiButton size="sm" @click="store.load()">Обновить</UiButton>
    </header>

    <p v-if="store.error" class="ssh-panel__error">{{ store.error }}</p>

    <div v-if="store.sessions?.length" class="ssh-tabs" role="tablist" aria-label="SSH-сессии">
      <div v-for="session in store.sessions" :key="session.id" class="ssh-tab-wrap">
        <UiButton
          role="tab"
          :aria-selected="store.activeId === session.id"
          :class="{ active: store.activeId === session.id }"
          @click="store.activate(session.id)"
        >{{ session.label }}</UiButton>
        <UiButton
          class="ssh-tab-close"
          size="sm"
          tone="danger"
          :aria-label="`Закрыть ${session.label}`"
          @click="store.closeSession?.(session.id)"
        >×</UiButton>
      </div>
    </div>

    <div ref="terminalHost" class="ssh-terminal" data-ssh-terminal-host></div>

    <div v-if="activeSession" class="ssh-session-tools">
      <label class="ssh-agent-access">
        <UiCheckbox
          :model-value="activeSession.agentAllowed"
          @update:model-value="store.setAgentAccess?.(activeSession.id, $event)"
        />
        Агенту можно выполнять команды с подтверждением
      </label>

      <details>
        <summary>SFTP для человека</summary>
        <div class="ssh-files-bar">
          <UiInput v-model="remotePath" aria-label="Путь на сервере" />
          <UiButton size="sm" @click="store.listFiles?.(remotePath)">Открыть</UiButton>
          <UiFilePicker size="sm" label="Загрузить файл" @change="uploadFiles" />
        </div>
        <ul class="ssh-files">
          <li v-for="file in store.files || []" :key="file.path || file.name">
            <span>{{ file.name }}</span>
            <a v-if="!file.directory" :href="store.downloadUrl?.(file.path || file.name)">Скачать</a>
          </li>
        </ul>
      </details>
    </div>

    <section class="ssh-connections" aria-label="Соединения">
      <h3>Соединения</h3>
      <article v-for="connection in store.connections || []" :key="connection.id" class="ssh-connection">
        <div>
          <strong>{{ connection.label }}</strong>
          <small>{{ connection.role }} · {{ connection.user }}@{{ connection.host }}:{{ connection.port }}</small>
        </div>
        <UiPasswordInput
          v-model="passwords[connection.id]"
          :aria-label="`Пароль для ${connection.label}`"
          autocomplete="current-password"
          placeholder="Пароль на один вход"
        />
        <UiButton size="sm" variant="solid" @click="openConnection(connection)">Подключить</UiButton>
      </article>

      <details>
        <summary>Добавить соединение</summary>
        <form class="ssh-profile-form" @submit.prevent="saveConnection">
          <UiInput v-model="draft.projectId" required placeholder="ID проекта" aria-label="ID проекта" />
          <UiInput v-model="draft.label" required placeholder="Метка сервера" aria-label="Метка сервера" />
          <UiInput v-model="draft.role" required placeholder="Роль" aria-label="Роль сервера" />
          <UiInput v-model="draft.host" required placeholder="Адрес" aria-label="Адрес сервера" />
          <UiInput v-model="draft.port" placeholder="22" aria-label="Порт" />
          <UiInput v-model="draft.user" required placeholder="Пользователь" aria-label="Пользователь" />
          <UiButton type="submit" variant="solid">Сохранить</UiButton>
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
          placeholder="Пояснение обязательно при отказе"
          :aria-label="`Пояснение к команде ${approval.pid}`"
        />
        <div class="ssh-approval__actions">
          <UiButton
            variant="solid"
            tone="accent"
            @click="chat.answerPerm(approval.pid, true, false, '', '')"
          >Разрешить</UiButton>
          <UiButton
            tone="danger"
            :disabled="!String(comments[approval.pid] || '').trim()"
            @click="deny(approval)"
          >Отказать</UiButton>
        </div>
      </article>
    </section>

    <details class="ssh-audit">
      <summary>Журнал команд агента</summary>
      <article v-for="entry in store.audit || []" :key="`${entry.at}-${entry.sessionId}-${entry.command}`">
        <time>{{ entry.at }}</time>
        <strong>{{ entry.label }} · {{ entry.decision }}</strong>
        <pre>{{ entry.command }}</pre>
        <pre v-if="entry.output">{{ entry.output }}</pre>
      </article>
    </details>
  </section>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import {
  UiButton, UiCheckbox, UiFilePicker, UiInput, UiPasswordInput,
  alertDialog, confirmDialog,
} from '../../ui';
import { useSshStore } from '../../stores/ssh.js';
import { useChatStore } from '../../stores/chat.js';

const store = useSshStore();
const chat = useChatStore();
const terminalHost = ref(null);
const passwords = reactive({});
const comments = reactive({});
const remotePath = ref('.');
const draft = reactive({ projectId: '', label: '', role: '', host: '', port: 22, user: '' });
const sshApprovals = computed(() => Object.values(chat.pending || {}).filter((item) => item.origin === 'ssh'));
const activeSession = computed(() => (store.sessions || []).find((item) => item.id === store.activeId));
let terminal;
let fit;

onMounted(async () => {
  terminal = new Terminal({ convertEol: true, cursorBlink: true });
  fit = new FitAddon();
  terminal.loadAddon?.(fit);
  terminal.open(terminalHost.value);
  store.bindTerminal?.(terminal);
  terminal.onData?.((data) => store.sendInput?.(data));
  await store.load();
  if (store.activeId) store.activate(store.activeId);
  else if (store.sessions?.[0]) store.activate(store.sessions[0].id);
  await nextTick();
  fit.fit?.();
});

onBeforeUnmount(() => {
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
      if (!accepted) return;
      await store.decideHostKey(check.challengeId, changed ? 'replace' : 'trust');
    }
    await store.connect(connection.id, passwords[connection.id] || '');
  } catch (error) {
    await alertDialog(error?.message || 'Не удалось подключиться', { title: 'SSH' });
  } finally {
    passwords[connection.id] = '';
  }
}

async function saveConnection() {
  try {
    await store.saveConnection({ ...draft, port: Number(draft.port) || 22 });
    Object.assign(draft, { projectId: '', label: '', role: '', host: '', port: 22, user: '' });
  } catch (error) {
    await alertDialog(error?.message || 'Не удалось сохранить соединение', { title: 'SSH' });
  }
}

async function uploadFiles(files) {
  const file = files?.[0];
  if (file) await store.uploadFile?.(file, `${remotePath.value.replace(/\/$/, '')}/${file.name}`);
}

function deny(approval) {
  const comment = String(comments[approval.pid] || '').trim();
  if (comment) chat.answerPerm(approval.pid, false, false, comment, '');
}
</script>

<style scoped>
.ssh-panel { display: grid; gap: 12px; min-width: 0; padding: 12px; overflow: auto; }
.ssh-panel__header, .ssh-connection, .ssh-files-bar, .ssh-approval__actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.ssh-panel__header { justify-content: space-between; }
.ssh-panel__header small, .ssh-connection small { display: block; color: var(--text-muted); }
.ssh-panel__error { color: var(--danger); }
.ssh-tabs { display: flex; gap: 6px; min-width: 0; overflow-x: auto; }
.ssh-tab-wrap { display: flex; flex: none; }
.ssh-tab-wrap [role='tab'].active { border-color: var(--accent); }
.ssh-tab-close { margin-left: -1px; }
.ssh-terminal { min-height: 280px; min-width: 0; padding: 6px; overflow: hidden; background: #101216; }
.ssh-session-tools, .ssh-connections, .ssh-approvals, .ssh-audit { display: grid; gap: 10px; min-width: 0; }
.ssh-agent-access { display: flex; gap: 8px; align-items: center; }
.ssh-connection { justify-content: space-between; padding: 8px; border: 1px solid var(--border); border-radius: 8px; }
.ssh-profile-form { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; padding-top: 8px; }
.ssh-files { list-style: none; padding: 0; }
.ssh-files li { display: flex; justify-content: space-between; gap: 8px; }
.ssh-approval { display: grid; gap: 8px; min-width: 0; max-width: 100%; padding: 12px; border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
.ssh-approval pre, .ssh-audit pre { min-width: 0; max-width: 100%; margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; }
.ssh-approval__identity { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.ssh-badge { padding: 1px 6px; border-radius: 999px; background: var(--danger-soft); color: var(--danger); font-size: 12px; }
.ssh-approval__actions { justify-content: flex-end; min-width: 0; }
.ssh-audit article { min-width: 0; padding: 8px 0; border-top: 1px solid var(--border); }
</style>
