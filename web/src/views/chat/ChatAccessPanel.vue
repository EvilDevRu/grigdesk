<template>
  <UiDialog :open="true" size="compact" :title="t('core.chatAccessTitle')" @close="emit('close')">
    <UiSpinner v-if="loading" :label="t('core.loading')" />
    <UiInlineMessage v-else-if="error" tone="warning">{{ error }}</UiInlineMessage>
    <template v-else-if="access">
      <dl class="access-list">
        <dt>{{ t('core.chatAccessReadWrite') }}</dt>
        <dd>
          <code>{{ access.writablePath }}</code>
          <UiButton size="compact" @click="emit('navigate', 'workspace')">
            {{ t('core.chatOptionWorkdir') }}
          </UiButton>
        </dd>
        <template v-if="access.readOnlyPaths.length">
          <dt>{{ t('core.chatAccessReadOnly') }}</dt>
          <dd><code v-for="path in access.readOnlyPaths" :key="path">{{ path }}</code></dd>
        </template>
        <dt>{{ t('core.chatAccessImages') }}</dt>
        <dd>
          <span>{{ t(access.imageInput ? 'core.chatAccessReady' : 'core.chatAccessImageModel') }}</span>
          <UiButton v-if="!access.imageInput" size="compact" @click="emit('navigate', 'model')">
            {{ t('core.chatAccessChooseModel') }}
          </UiButton>
        </dd>
        <dt>{{ t('core.chatAccessSearch') }}</dt>
        <dd>{{ t(access.webSearch ? 'core.chatAccessSearchConfigured' : 'core.chatAccessSearchMissing') }}</dd>
        <dt>{{ t('core.chatAccessBrowser') }}</dt>
        <dd>
          {{ access.browser === 'ready' ? t('core.chatAccessBrowserCount', { count: access.browserTabs })
            : t('core.chatAccessBrowserUnavailable') }}
          <span v-for="(title, index) in access.browserTabTitles" :key="index">{{ title }}</span>
          <RouterLink v-if="!access.browserTabs" to="/browser" @click="emit('close')">
            {{ t('core.chatAccessOpenBrowser') }}
          </RouterLink>
        </dd>
        <dt>{{ t('core.chatAccessProjectMcp') }}</dt>
        <dd>
          <span v-if="!access.projectMcpNames.length">{{ t('core.chatAccessMcpNone') }}</span>
          <UiButton v-for="name in access.projectMcpNames" :key="name" size="compact" :disabled="running"
                    @click="emit('prepare', `/mcp ${name}`)">{{ name }}</UiButton>
        </dd>
        <dt>{{ t('core.chatAccessGoals') }}</dt>
        <dd>
          {{ t('core.chatAccessGoalLimit', { total: access.goalRoundLimit }) }}
          <div class="access-actions">
            <UiButton size="compact" :disabled="running" @click="emit('prepare', '/goal')">
              {{ t('core.chatGoalNew') }}
            </UiButton>
            <UiButton size="compact" :disabled="running || hasDraft" @click="emit('prepare', '/goal resume')">
              {{ t('core.chatGoalResume') }}
            </UiButton>
          </div>
        </dd>
      </dl>
      <section v-if="failures.length" aria-labelledby="chat-access-failures">
        <h3 id="chat-access-failures">{{ t('core.chatAccessFailures') }}</h3>
        <ul>
          <li v-for="[tool, count] in failures" :key="tool">{{ tool }} ×{{ count }}</li>
        </ul>
      </section>
    </template>
    <template #footer>
      <UiButton :disabled="loading" @click="refresh">{{ t('core.chatListRetry') }}</UiButton>
      <UiButton variant="solid" @click="emit('close')">{{ t('core.close') }}</UiButton>
    </template>
  </UiDialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { ChatAccess } from '../../../../shared/chat/chatAccess.ts';
import { recordOrEmpty } from '../../../../shared/lib/objects.ts';

import { api, failureText } from '../../shared/apiClient.ts';
import type { ChatMessage } from '../../shared/chatContracts.ts';
import { UiButton, UiDialog, UiInlineMessage, UiSpinner, t } from '../../ui';

const props = defineProps<{
  chatId: string;
  messages: readonly ChatMessage[];
  running?: boolean;
  hasDraft?: boolean;
}>();
const emit = defineEmits<{
  close: [];
  prepare: [command: string];
  navigate: [target: 'workspace' | 'model'];
}>();

const access = ref<ChatAccess | null>(null);
const error = ref('');
const loading = ref(false);
let sequence = 0;

/**
 * Показываем только имя инструмента и счётчик в уже загруженной истории.
 * В сводку не копируются аргументы и результаты, а повторная доставка результата не считается.
 */
const failures = computed(() => {
  const counts = new Map<string, number>();
  const counted = new Set<string>();

  for (const [index, message] of props.messages.entries()) {
    const steps = message.steps ?? [];
    const names = new Map(steps.filter((step) => step.k === 'tool' && step.id && step.name)
      .map((step) => [step.id!, step.name!]));

    for (const step of steps) {
      if (step.k !== 'res' || step.ok !== false || !step.id) {
        continue;
      }

      const name = names.get(step.id);
      const key = JSON.stringify([message.runId ?? message.turnId ?? index, step.id]);

      if (name && !counted.has(key)) {
        counts.set(name, (counts.get(name) ?? 0) + 1);
        counted.add(key);
      }
    }
  }

  return [...counts].sort((left, right) => right[1] - left[1]).slice(0, 10);
});

/**
 * Разговор может смениться, пока сервер запрашивает вкладки браузера.
 * Устаревший ответ не меняет содержимое открытого окна.
 */
async function refresh() {
  const request = ++sequence;
  loading.value = true;
  error.value = '';

  try {
    const json = recordOrEmpty(await api.get(`/api/chat/access/${encodeURIComponent(props.chatId)}`));

    if (typeof json.writablePath !== 'string' || !Array.isArray(json.readOnlyPaths)
      || !Array.isArray(json.projectMcpNames) || !Array.isArray(json.browserTabTitles)) {
      throw new Error(t('core.chatAccessReadFailed'));
    }
    if (request === sequence) {
      access.value = json as unknown as ChatAccess;
    }
  } catch (cause) {
    if (request === sequence) {
      error.value = failureText(cause, t('core.chatAccessReadFailed'));
    }
  } finally {
    if (request === sequence) {
      loading.value = false;
    }
  }
}

watch(() => props.chatId, refresh, { immediate: true });
</script>

<style scoped>
.access-list {
  display: grid;
  grid-template-columns: minmax(0, auto) minmax(0, 1fr);
  gap: 10px 16px;
  margin-block: 0;
}
.access-list dt { color: var(--ink-mid); }
.access-list dd { min-width: 0; margin: 0; overflow-wrap: anywhere; }
.access-list dd > :is(code, span, a) { display: block; }
.access-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
</style>
