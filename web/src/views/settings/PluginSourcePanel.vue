<template>
  <section
    class="plugin-source"
    data-role="plugin-source"
    :data-managed="!!plugin.install"
  >
    <header class="source-heading">
      <h3>{{ t('settings.sourceAndUpdates') }}</h3>
      <span v-if="plugin.install" class="source-version">v{{ plugin.install.version }}</span>
    </header>
    <UiInlineMessage v-if="store.error" tone="danger">{{ store.error }}</UiInlineMessage>
    <UiInlineMessage v-if="store.recoveryError" tone="danger">
      {{ store.recoveryError.message }}
    </UiInlineMessage>
    <div v-if="store.reconciling" class="source-actions">
      <p>{{ t('settings.checkingOutcome') }}</p>
      <UiButton
        data-context="workspace-form-wrap"
        data-role="plugin-source-reconcile"
        :disabled="store.busy"
        @click="store.reconcile()"
      >
        {{ t('settings.checkResult') }}
      </UiButton>
    </div>
    <template v-if="!plugin.install">
      <p>{{ driver ? t('settings.manualDbDriver') : t('settings.thePluginWasInstalledManuallyAndHas') }}</p>
      <p class="source-hint">{{ t('settings.attachARepositoryToSelectVersionsAnd') }}</p>
      <div class="source-actions">
        <UiButton
          data-context="workspace-form-wrap"
          data-role="plugin-source-bind"
          :disabled="locked"
          @click="emit('bind')"
        >
          {{ t('settings.attachToGit') }}
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
        {{ t('settings.theNewVersionIsWaitingForA') }}
      </UiInlineMessage>
      <UiInlineMessage
        v-if="plugin.install.localChanges"
        tone="warning"
        data-role="plugin-source-local-changes"
      >
        {{ t('settings.theInstalledCopyDiffersFromTheSource') }}
      </UiInlineMessage>
      <div class="source-update">
        <p v-if="plugin.install.updateAvailable" class="source-update-title">
          {{ t('settings.versionAvailableV') }}{{ plugin.install.latest?.version }}
        </p>
        <p class="source-checked" role="status">
          {{ store.checking ? t('settings.checkingForUpdates') : checkedText }}
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
            data-context="workspace-form-wrap"
            data-role="plugin-source-check"
            :loading="store.checking"
            :disabled="store.checking || !!store.recoveryError"
            @click="store.checkUpdates()"
          >
            {{ t('settings.checkForUpdates') }}
          </UiButton>
          <UiButton
            data-context="workspace-form-wrap"
            v-if="plugin.install.localChanges"
            data-role="plugin-source-update"
            :disabled="locked"
            @click="emit('update')"
          >
            {{ t('settings.reinstallCleanly') }}
          </UiButton>
          <UiButton
            data-context="workspace-form-wrap"
            v-else-if="plugin.install.updateAvailable"
            variant="solid"
            tone="accent"
            data-role="plugin-source-update"
            :disabled="locked"
            @click="emit('update')"
          >
            {{ t('settings.updateToV') }}{{ plugin.install.latest?.version }}
          </UiButton>
        </div>
      </div>
      <div v-if="plugin.install.previous" class="source-previous">
        <div>
          <p>{{ t('settings.previousVersion') }}</p>
          <p class="source-hint">{{ t('settings.youCanRestoreItIfTheUpdate') }}</p>
        </div>
        <UiButton
          data-context="workspace-form-wrap"
          data-role="plugin-source-rollback"
          :disabled="locked || !plugin.install.rollbackAvailable"
          @click="rollback"
        >
          {{ t('settings.restoreV') }}{{ plugin.install.previous.version }}
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
import { intlLocale } from '../../../../shared/i18n/formats.ts';
import { uiLocale } from '../../ui.ts';
import { t, messageRef } from '../../ui.ts';

import { computed, ref, onBeforeUnmount } from 'vue';

import { UiButton, UiInlineMessage, confirmDialog } from '../../ui';
import { useDbEngineInstallStore } from '../../stores/dbEngineInstall.ts';
import { usePluginInstallStore } from '../../stores/pluginInstall.ts';
import { shortSha } from '../../shared/pluginInstall.ts';
import type { InstallSubject } from '../../stores/packageInstall.ts';

const props = defineProps<{ plugin: InstallSubject; packageKind?: 'plugin' | 'db-engine' }>();
const emit = defineEmits<{
  update: [];
  bind: [];
}>();
const driver = props.packageKind === 'db-engine';
const store = driver ? useDbEngineInstallStore() : usePluginInstallStore();
const confirming = ref(false);
let disposed = false;

const locked = computed(() => confirming.value || store.busy || store.reconciling
  || !!store.recoveryError || !!store.pendingAction || store.job?.status === 'recovery_required');

const checkedText = computed(() => props.plugin.install?.checkedAt
  ? t('settings.checked', {
      value1: new Date(props.plugin.install.checkedAt).toLocaleString(intlLocale(uiLocale)),
    })
  : t('settings.updatesHaveNotBeenChecked'));

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
    const confirmation = driver
      ? messageRef('settings.driverRollbackConfirmation', { previousVersion: previous.version })
      : messageRef('settings.pluginRollbackConfirmation', { previousVersion: previous.version });

    confirmed = await confirmDialog(
      confirmation,
      { okText: messageRef('settings.restore') },
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
  gap: 12px;
  min-width: 0;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  font-size: 12px;
  line-height: 1.5;
  margin-bottom: 12px;
  container: plugin-source / inline-size;
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
  font-size: 13px;
  font-weight: 600;
}
.source-version {
  color: var(--accent);
  font-family: var(--mono);
  font-size: 12px;
}
.source-repository {
  display: grid;
  gap: 0.35rem;
  min-width: 0;
  padding: 0.75rem;
  border-radius: var(--radius-sm);
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
  font-size: 12px;
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
@container plugin-source (max-width: 360px) {
  .source-actions {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
