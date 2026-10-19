<template>
  <section
    class="plugin-source"
    data-role="plugin-source"
    :data-managed="!!plugin.install"
  >
    <header class="source-heading">
      <h3>Источник и обновления</h3>
      <span v-if="plugin.install" class="source-version">v{{ plugin.install.version }}</span>
    </header>
    <UiInlineMessage v-if="store.error" tone="danger">{{ store.error }}</UiInlineMessage>
    <UiInlineMessage v-if="store.recoveryError" tone="danger">
      {{ store.recoveryError.message }}
    </UiInlineMessage>
    <div v-if="store.reconciling" class="source-actions">
      <p>Уточняю исход</p>
      <UiButton
        data-role="plugin-source-reconcile"
        :disabled="store.busy"
        @click="store.reconcile()"
      >
        Уточнить результат
      </UiButton>
    </div>
    <template v-if="!plugin.install">
      <p>Плагин установлен вручную и не связан с источником.</p>
      <p class="source-hint">Привяжите репозиторий, чтобы выбирать версии и получать обновления.</p>
      <div class="source-actions">
        <UiButton
          data-role="plugin-source-bind"
          :disabled="locked"
          @click="emit('bind')"
        >
          Привязать к git…
        </UiButton>
      </div>
    </template>
    <template v-else>
      <div class="source-repository">
        <p data-role="plugin-source-url">{{ plugin.install.source.url }}</p>
        <p class="source-revision" data-role="plugin-source-version">
          v{{ plugin.install.version }} · {{ shortSha(plugin.install.sha) }}
        </p>
      </div>
      <UiInlineMessage
        v-if="plugin.install.restartRequired"
        tone="warning"
        data-role="plugin-source-restart"
      >
        Новая версия ждёт перезапуска GrigDesk.
      </UiInlineMessage>
      <UiInlineMessage
        v-if="plugin.install.localChanges"
        tone="warning"
        data-role="plugin-source-local-changes"
      >
        Установленная копия отличается от версии из источника: в ней ручные правки.
      </UiInlineMessage>
      <div class="source-update">
        <p v-if="plugin.install.updateAvailable" class="source-update-title">
          Доступна версия v{{ plugin.install.latest?.version }}
        </p>
        <p class="source-checked" role="status">
          {{ store.checking ? 'Проверяем обновления…' : checkedText }}
        </p>
        <UiInlineMessage
          v-if="plugin.install.checkError"
          tone="danger"
          data-role="plugin-source-check-error"
        >
          {{ plugin.install.checkError.message }}
        </UiInlineMessage>
        <div class="source-actions">
          <UiButton
            data-role="plugin-source-check"
            :loading="store.checking"
            :disabled="store.checking || !!store.recoveryError"
            @click="store.checkUpdates()"
          >
            Проверить обновления
          </UiButton>
          <UiButton
            v-if="plugin.install.localChanges"
            data-role="plugin-source-update"
            :disabled="locked"
            @click="emit('update')"
          >
            Переустановить начисто…
          </UiButton>
          <UiButton
            v-else-if="plugin.install.updateAvailable"
            variant="solid"
            tone="accent"
            data-role="plugin-source-update"
            :disabled="locked"
            @click="emit('update')"
          >
            Обновить до v{{ plugin.install.latest?.version }}
          </UiButton>
        </div>
      </div>
      <div v-if="plugin.install.previous" class="source-previous">
        <div>
          <p>Предыдущая версия</p>
          <p class="source-hint">Можно вернуться, если обновление не подошло.</p>
        </div>
        <UiButton
          data-role="plugin-source-rollback"
          :disabled="locked || !plugin.install.rollbackAvailable"
          @click="rollback"
        >
          Вернуть v{{ plugin.install.previous.version }}
        </UiButton>
      </div>
      <UiInlineMessage
        v-if="plugin.install.rollbackError"
        tone="danger"
        data-role="plugin-source-rollback-error"
      >
        {{ plugin.install.rollbackError.message }}
      </UiInlineMessage>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, onBeforeUnmount } from 'vue';

import { UiButton, UiInlineMessage, confirmDialog } from '../../ui';
import { usePluginInstallStore } from '../../stores/pluginInstall.ts';
import { shortSha } from '../../shared/pluginInstall.ts';
import type { PluginListItem } from '../../../../shared/plugins/pluginsContracts.ts';

const props = defineProps<{ plugin: PluginListItem }>();
const emit = defineEmits<{
  update: [];
  bind: [];
}>();
const store = usePluginInstallStore();
const confirming = ref(false);
let disposed = false;

const locked = computed(() => confirming.value || store.busy || store.reconciling
  || !!store.recoveryError || !!store.pendingAction || store.job?.status === 'recovery_required');

const checkedText = computed(() => props.plugin.install?.checkedAt
  ? `Проверено ${new Date(props.plugin.install.checkedAt).toLocaleString('ru-RU')}`
  : 'Обновления не проверялись');

/**
 * Откат требует отдельного явного подтверждения через общий dialog host.
 * Store получает карточку с revision и digest для серверной проверки baseline.
 */
async function rollback(): Promise<void> {
  const previous = props.plugin.install?.previous;

  if (disposed || locked.value || !previous || !props.plugin.install?.rollbackAvailable) {
    return;
  }

  const plugin = props.plugin;
  const revision = plugin.install?.revision;
  const digest = previous.payloadDigest;

  confirming.value = true;

  let confirmed = false;

  try {
    confirmed = await confirmDialog(
      `Вернуть v${previous.version}? Текущая версия станет прежней; `
        + 'применится после перезапуска GrigDesk.',
      { okText: 'Вернуть' },
    );
  } finally {
    confirming.value = false;
  }

  if (confirmed && !disposed && !locked.value && plugin.id === props.plugin.id
      && revision === props.plugin.install?.revision
      && digest === props.plugin.install?.previous?.payloadDigest) {
    await store.rollback(plugin);
  }
}

onBeforeUnmount(() => {
  disposed = true;
});
</script>

<style scoped>
.plugin-source {
  display: grid;
  gap: 1rem;
  min-width: 0;
  padding: 1rem;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  font-size: 0.875rem;
  line-height: 1.5;
}
.plugin-source p,
.plugin-source h3 {
  margin: 0;
  overflow-wrap: anywhere;
}
.source-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 0.5rem;
}
.source-heading h3 {
  font-size: 0.875rem;
  font-weight: 600;
}
.source-version {
  color: var(--accent);
  font-family: var(--mono);
  font-size: 0.8125rem;
}
.source-repository {
  display: grid;
  gap: 0.35rem;
  min-width: 0;
  padding: 0.75rem;
  border-radius: var(--radius);
  background: var(--ground);
}
.source-revision {
  font-family: var(--mono);
  font-size: 0.75rem;
  color: var(--ink-mid);
}
.source-hint,
.source-checked {
  color: var(--ink-mid);
  font-size: 0.8125rem;
}
.source-checked {
  min-height: 1.25rem;
}
.source-update {
  display: grid;
  gap: 0.75rem;
}
.source-update-title {
  font-weight: 600;
}
.source-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
}
.source-previous {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 0.75rem;
  padding-top: 1rem;
  border-top: 1px solid var(--line);
}
@media (max-width: 420px) {
  .source-actions {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
