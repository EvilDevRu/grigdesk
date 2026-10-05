<template>
  <div class="pvset pvmcp provider-mcp-slot" :data-provider-id="providerId">
    <div class="pvsetttl">
      MCP-серверы
      <UiButton
        class="mcpbtn"
        data-role="settings-compact-action"
        :disabled="status?.loading"
        @click="emit('refresh')"
      >
        {{ status?.loading ? 'Обновляем…' : 'Обновить' }}
      </UiButton>
    </div>
    <div
      class="mcpbody"
      tabindex="0"
      :aria-label="`MCP-серверы ${providerName}`"
      aria-live="polite"
    >
      <p v-if="!status || (status.loading && !status.servers)" class="muted small">
        Получаем список от исполнителя…
      </p>
      <p v-else-if="status.state === 'error'" class="msg err">
        Не удалось получить список: {{ status.error }}
      </p>
      <template v-else>
        <p v-if="status.note" class="mcpnote muted small">{{ status.note }}</p>
        <div v-for="group in groups" :key="group.id" class="mcpgrp">
          <div class="mcpgrpttl muted">{{ group.label }} ({{ group.servers.length }})</div>
          <div v-if="group.hint" class="mcpgrphint muted">{{ group.hint }}</div>
          <div v-for="server in group.servers" :key="server.name" class="mcprow">
            <div class="mcpline">
              <span class="mcpdot" :class="mcpState(server).cls"></span>
              <span class="mcpname" v-tooltip="server.target || undefined">{{ server.name }}</span>
              <span class="mcpst" :class="mcpState(server).cls">{{ mcpState(server).label }}</span>
            </div>
            <!-- Причина/подсказка принадлежит адаптеру, поэтому Vue не знает CLI. -->
            <div v-if="server.state !== 'ok' && server.detail" class="mcpdetail muted">
              {{ server.detail }}
            </div>
            <div v-if="server.hint" class="mcpdetail muted">{{ server.hint }}</div>
          </div>
        </div>
        <p v-if="!groups.length" class="muted small">
          {{ status.emptyText || 'Серверов не настроено.' }}
        </p>
        <p v-if="status.checkedAt" class="muted small">
          обновлено {{ new Date(status.checkedAt).toLocaleTimeString('ru') }}
        </p>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import { UiButton, vTooltip } from '../../ui.ts';

interface McpServer {
  name: string;
  target?: string;
  scope?: string;
  state?: string;
  detail?: string;
  hint?: string;
}

interface McpGroup {
  id: string;
  label?: string;
  hint?: string;
}

interface McpSnapshot {
  state?: string;
  servers?: readonly McpServer[];
  groups?: readonly McpGroup[];
  loading?: boolean;
  error?: string;
  note?: string;
  emptyText?: string;
  checkedAt?: number;
}

interface McpState {
  label: string;
  cls: string;
}

const props = defineProps<{
  providerId: string;
  providerName: string;
  status: McpSnapshot | null;
}>();
const emit = defineEmits<{ refresh: [] }>();

const MCP_SCOPES: readonly McpGroup[] = [
  {
    id: 'user',
    label: 'Пользователь',
  },
  {
    id: 'project',
    label: 'Проект',
  },
  {
    id: 'account',
    label: 'Аккаунт',
  },
];
const MCP_STATES: Record<string, McpState> & { unknown: McpState } = {
  ok: {
    label: 'Подключён',
    cls: 'ok',
  },
  failed: {
    label: 'Не подключился',
    cls: 'err',
  },
  'needs-auth': {
    label: 'Нужна авторизация',
    cls: 'warn',
  },
  configured: {
    label: 'Настроен',
    cls: 'idle',
  },
  disabled: {
    label: 'Выключен',
    cls: 'idle',
  },
  remote: {
    label: 'Включён на claude.ai',
    cls: 'idle',
  },
  unknown: {
    label: 'Состояние неизвестно',
    cls: 'warn',
  },
};

const groups = computed(() => mcpGroups(props.status));

/**
 * Базовые scope общие, но адаптер может переименовать секцию и дать пояснение.
 * Незнакомые scope сохраняются; проекция групп не меняет снимок ответа.
 */
function mcpGroups(status: McpSnapshot | null) {
  const servers = status?.servers || [];
  const overrides = new Map((Array.isArray(status?.groups) ? status.groups : [])
    .filter((group) => typeof group?.id === 'string' && group.id)
    .map((group) => [group.id, group]));
  const scopes: McpGroup[] = MCP_SCOPES.map((scope) => ({
    ...scope,
    ...(overrides.get(scope.id) || {}),
  }));
  const known = new Set(scopes.map((scope) => scope.id));

  for (const group of overrides.values()) {
    if (!known.has(group.id)) {
      scopes.push(group);
    }
  }

  for (const server of servers) {
    const id = server.scope || 'user';

    if (!scopes.some((scope) => scope.id === id)) {
      scopes.push({
        id,
        label: id,
      });
    }
  }

  return scopes
    .map((scope) => ({
      ...scope,
      servers: servers.filter((server) => (server.scope || 'user') === scope.id),
    }))
    .filter((group) => group.servers.length);
}

function mcpState(server: McpServer): McpState {
  return MCP_STATES[server.state || 'unknown'] || MCP_STATES.unknown;
}
</script>

<style scoped>
.provider-mcp-slot {
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: 12px;
  border-top: 1px solid var(--line);
  padding-top: 12px;
}

.pvsetttl {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
  color: var(--ink-mid);
  text-transform: uppercase;
  letter-spacing: .04em;
}

.small {
  font-size: 12px;
  line-height: 1.5;
}

.msg {
  font-size: 13px;
  margin: 0;
  white-space: pre-line;
}

.msg.err {
  color: var(--bad);
}

/* Все вложенные колонки сжимаются до ширины панели, даже с длинным именем.
   Ограничен только длинный список; короткий не оставляет пустоты. */
.mcpbody {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 10px;
  max-block-size: 360px;
  overflow-y: auto;
  padding-right: 2px;
  scrollbar-gutter: stable;
  overscroll-behavior: contain;
}

.mcpbody:focus-visible {
  outline: 1px solid var(--accent);
  outline-offset: 2px;
}

.mcpnote {
  margin-top: 0;
}

.mcpgrp {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 4px;
}

.mcpgrpttl {
  font-size: 11.5px;
}

.mcpgrphint {
  font-size: 11px;
  line-height: 1.4;
  opacity: .8;
}

.mcprow {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 2px;
  padding: 3px 0;
}

.mcpline {
  display: flex;
  align-items: center;
  gap: 8px;
}

.mcpdot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--ink-mid);
}

.mcpdot.ok {
  background: var(--good);
  box-shadow: 0 0 6px color-mix(in srgb, var(--good) 60%, transparent);
}

.mcpdot.err {
  background: var(--bad);
}

.mcpdot.warn {
  background: var(--warn, #e0a33a);
}

/* Аккаунтный коннектор: локальной проверки нет, поэтому и цвета тревоги нет. */
.mcpdot.idle {
  background: var(--ink-mid);
}

/* Длинное имя сжимается внутри строки, сохраняя место для статуса.
   Без min-width: 0 flex-элемент растягивал бы всю панель. */
.mcpname {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mcpst {
  flex: none;
  font-size: 12px;
}

.mcpst.ok {
  color: var(--good);
}

.mcpst.err {
  color: var(--bad);
}

.mcpst.warn {
  color: var(--warn, #e0a33a);
}

.mcpst.idle {
  color: var(--ink-mid);
}

.mcpdetail {
  font-size: 11.5px;
  line-height: 1.45;
  padding-left: 16px;
  overflow-wrap: anywhere;
}
</style>
