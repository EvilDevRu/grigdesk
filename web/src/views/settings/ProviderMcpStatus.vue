<template>
  <div class="pvset pvmcp provider-mcp-slot" :data-provider-id="providerId">
    <div class="pvsetttl">
      {{ t('settings.mcpServers') }}
      <UiButton
        class="mcpbtn"
        data-context="workspace-form-wrap"
        :disabled="status?.loading"
        @click="emit('refresh')"
      >
        {{ status?.loading ? t('settings.refreshing') : t('settings.update') }}
      </UiButton>
    </div>
    <div
      class="mcpbody"
      tabindex="0"
      :aria-label="t('settings.mcpServersFor', { providerName: providerName })"
      aria-live="polite"
    >
      <UiLoadingState v-if="!status || (status.loading && !status.servers)"
        :label="t('settings.gettingTheListFromTheProvider')" />
      <p v-else-if="status.state === 'error'" class="msg err">
        {{ t('settings.couldNotGetTheList') }} {{ status.error }}
      </p>
      <template v-else>
        <p v-if="status.note" class="mcpnote muted small">
          {{ localizeProviderText(providerId, status.note, uiLocale) }}
        </p>
        <div
          v-for="group in groups"
          :key="group.id"
          class="mcpgrp"
        >
          <div class="mcpgrpttl muted">{{ group.label }} ({{ group.servers.length }})</div>
          <div v-if="group.hint" class="mcpgrphint muted">{{ group.hint }}</div>
          <div
            v-for="server in group.servers"
            :key="server.name"
            class="mcprow"
          >
            <div class="mcpline">
              <span class="mcpdot" :class="mcpState(server).cls"></span>
              <span class="mcpname" v-tooltip="server.target || undefined">{{ server.name }}</span>
              <span class="mcpst" :class="mcpState(server).cls">{{ mcpState(server).label }}</span>
            </div>
            <!-- Причина/подсказка принадлежит адаптеру, поэтому Vue не знает CLI. -->
            <div v-if="server.state !== 'ok' && server.detail" class="mcpdetail muted">
              {{ localizeProviderText(providerId, server.detail, uiLocale) }}
            </div>
            <div v-if="server.hint" class="mcpdetail muted">{{ authHint(server) }}</div>
          </div>
        </div>
        <p v-if="!groups.length" class="muted small">
          {{ status.emptyText ? localizeProviderText(providerId, status.emptyText, uiLocale)
            : t('settings.noServersConfigured') }}
        </p>
        <p v-if="status.checkedAt" class="muted small">
          {{ t('settings.updated') }} {{ new Date(status.checkedAt).toLocaleTimeString(intlLocale(uiLocale)) }}
        </p>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { t, uiLocale } from '../../ui.ts';
import { intlLocale } from '../../../../shared/i18n/formats.ts';
import { translator } from '../../../../shared/i18n/catalogs.ts';
import { localizeProviderText } from '../../features/settings/metadataLocale.ts';

import { computed } from 'vue';

import {
  UiButton,
  vTooltip,
  UiLoadingState,
} from '../../ui.ts';

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
    get label() {
    return t('settings.user');
  },
  },
  {
    id: 'project',
    get label() {
    return t('settings.project');
  },
  },
  {
    id: 'account',
    get label() {
    return t('settings.account');
  },
  },
];
const MCP_STATES: Record<string, McpState> & { unknown: McpState } = {
  ok: {
    get label() {
    return t('settings.connected');
  },
    cls: 'ok',
  },
  failed: {
    get label() {
    return t('settings.connectionFailed');
  },
    cls: 'err',
  },
  'needs-auth': {
    get label() {
    return t('settings.authenticationRequired');
  },
    cls: 'warn',
  },
  configured: {
    get label() {
    return t('settings.configured');
  },
    cls: 'idle',
  },
  disabled: {
    get label() {
    return t('settings.disabled');
  },
    cls: 'idle',
  },
  remote: {
    get label() {
    return t('settings.enabledOnClaudeAi');
  },
    cls: 'idle',
  },
  unknown: {
    get label() {
    return t('settings.unknownStatus');
  },
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
    .map((group) => [group.id, {
      ...group,
      hint: group.hint === undefined ? undefined
        : translator.t(uiLocale.value, `settings.mcpGroups.${props.providerId}.${group.id}.hint`,
          {}, group.hint),
    }]));
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

/**
 * Подсказки входа встроенных MCP-адаптеров определяются исполнителем и scope.
 * Имя сервера остаётся параметром команды; внешняя подсказка возвращается исходной.
 */
function authHint(server: McpServer): string | undefined {
  if (!server.hint || !['claude', 'codex'].includes(props.providerId)) {
    return server.hint;
  }

  return props.providerId === 'claude' && server.scope === 'account'
    ? t('settings.mcpAccountLoginHint')
    : t('settings.mcpLoginHint', { command: `${props.providerId} mcp login ${server.name}` });
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
  font-size: 13px;
  color: var(--ink);
  font-weight: 600;
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
  font-size: 12px;
}

.mcpgrphint {
  font-size: 12px;
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
  font-size: 12px;
  line-height: 1.45;
  padding-left: 16px;
  overflow-wrap: anywhere;
}
</style>
