<template>
  <UiDialog :open="open" :title="t('core.trackerInstallGit')" @update:open="emit('update:open', $event)">
    <div class="driver-install">
      <section class="driver-sources" :aria-label="t('core.trackerOfficialSources')">
        <h3>{{ t('core.trackerOfficialSources') }}</h3>
        <p v-if="store.sourcesLoading" role="status">{{ t('core.trackerSourcesLoading') }}</p>
        <UiInlineMessage v-else-if="store.sourcesError" tone="danger">
          {{ store.sourcesError }}
        </UiInlineMessage>
        <p v-else-if="!store.sources.length">{{ t('core.trackerSourcesEmpty') }}</p>
        <div class="driver-source-list">
          <UiButton v-for="source in store.sources" :key="source.url" class="driver-source"
                    :disabled="store.busy" @click="store.url = source.url">
            <span>{{ source.title }}</span>
            <small>{{ sourceDomain(source.url) }}</small>
          </UiButton>
        </div>
      </section>
      <UiField :label="t('core.trackerRepository')">
        <UiInput v-model="store.url" name="url" type="url" :disabled="store.busy" />
      </UiField>
      <UiField :label="t('core.trackerTag')">
        <UiInput v-model="store.tag" name="tag" :disabled="store.busy" />
      </UiField>
      <UiButton :disabled="store.busy || active" @click="store.prepare()">
        {{ t('core.trackerPrepare') }}
      </UiButton>
      <UiButton :disabled="store.busy || !store.url" @click="store.versionsForSource()">
        {{ t('core.trackerVersions') }}
      </UiButton>
      <UiSelect v-if="store.versions.length" v-model="store.tag" :disabled="store.busy"
                :aria-label="t('core.trackerTag')">
        <option v-for="version in store.versions" :key="version.tag" :value="version.tag">
          {{ version.tag }}
        </option>
      </UiSelect>
      <UiInlineMessage v-if="store.error" tone="danger">{{ store.error }}</UiInlineMessage>
      <UiInlineMessage v-if="store.versionsEmpty" tone="danger">
        {{ t('core.trackerNoVersions') }}
      </UiInlineMessage>
      <UiInlineMessage v-if="store.previousUnavailable" tone="danger">
        {{ t('core.trackerPreviousUnavailable') }}
      </UiInlineMessage>
      <UiInlineMessage v-if="store.recoveryError" tone="danger">{{ store.recoveryError }}</UiInlineMessage>
      <UiButton v-if="store.pendingRollback" :disabled="store.busy" @click="store.current()">
        {{ t('core.trackerResumeRollback') }}
      </UiButton>
      <template v-if="store.job">
        <p role="status">{{ statusLabel }} {{ store.job.target?.version }}</p>
        <p v-if="stageLabel">{{ stageLabel }} {{ store.job.percent === null ? '' : `${store.job.percent}%` }}</p>
        <p v-if="store.job.payloadDigest" class="digest">
          {{ t('core.trackerDigest') }}: {{ store.job.payloadDigest }}
        </p>
        <UiInlineMessage v-if="store.job.status === 'ready'">{{ t('core.trackerServerCode') }}</UiInlineMessage>
        <template v-if="store.job.preview">
          <p>{{ store.job.preview.name }} {{ store.job.preview.version }}</p>
          <p>{{ store.job.preview.source.url }}</p>
          <details v-if="store.job.preview.changes">
            <summary>{{ t('core.trackerChanges') }}</summary>
            <p v-for="commit in store.job.preview.changes.commits" :key="commit.sha">{{ commit.subject }}</p>
            <p v-for="file in store.job.preview.changes.files" :key="file.path">{{ file.status }} {{ file.path }}</p>
          </details>
          <p v-else>{{ t('core.trackerNoChanges') }}</p>
        </template>
        <p v-for="warning in store.job.preview?.warnings" :key="warning">{{ warning }}</p>
        <p v-if="store.job.error" role="alert">{{ store.job.error.message }}</p>
        <UiButton v-if="store.job.status === 'ready'" :disabled="store.busy || !!store.recoveryError"
                  @click="store.apply()">
          {{ t('core.trackerApply') }}
        </UiButton>
        <UiButton v-if="['running', 'ready'].includes(store.job.status)"
                  :disabled="store.busy" @click="store.cancel()">{{ t('core.trackerCancel') }}</UiButton>
      </template>
      <UiButton :disabled="store.busy" @click="store.check()">{{ t('core.trackerCheckUpdates') }}</UiButton>
      <template v-if="Object.keys(installedDrivers).length || otherDrivers.length">
        <h3>{{ t('core.trackerInstalled') }}</h3>
        <div v-for="(record, id) in installedDrivers" :key="id" class="driver-package">
          <p>{{ id }} {{ record.version }}</p>
          <p v-if="record.checkError" role="alert">{{ record.checkError.message }}</p>
          <p v-if="record.rollbackError" role="alert">{{ record.rollbackError.message }}</p>
          <UiButton :disabled="store.busy || active || !!store.pendingRollback" @click="store.update(String(id))">
            {{ t('core.trackerUpdate') }}
          </UiButton>
          <UiButton :disabled="store.busy || active || !record.rollbackAvailable"
                    @click="store.rollback(String(id))">
            {{ t('core.trackerRollback') }}
          </UiButton>
          <UiButton tone="danger" :disabled="store.busy || active || removing || !!store.pendingRollback"
                    @click="removeDriver(String(id), String(id))">
            {{ t('core.trackerRemove') }}
          </UiButton>
        </div>
        <div v-for="driver in otherDrivers" :key="driver.id" class="driver-package">
          <p>{{ driver.name }} {{ driver.version }}</p>
          <UiInlineMessage v-if="driver.deleted">{{ t('core.trackerDeleted') }}</UiInlineMessage>
          <UiButton v-else tone="danger"
                    :disabled="store.busy || active || removing || !!store.pendingRollback"
                    @click="removeDriver(driver.id, driver.name)">
            {{ t('core.trackerRemove') }}
          </UiButton>
        </div>
      </template>
      <UiInlineMessage v-if="store.restartRequired">{{ t('core.trackerRestart') }}</UiInlineMessage>
    </div>
  </UiDialog>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';

import { useDriverInstallStore } from '../../stores/driverInstall.ts';
import { useTrackersStore } from '../../stores/trackers.ts';
import {
  confirmDialog, messageRef, t, UiButton, UiDialog, UiField, UiInlineMessage, UiInput, UiSelect,
} from '../../ui.ts';

defineProps<{ open: boolean }>();

const emit = defineEmits<{ 'update:open': [open: boolean] }>();
const store = useDriverInstallStore();
const trackers = useTrackersStore();
const removing = ref(false);
// SSE может подтвердить удаление раньше ответа check или при его сетевом отказе.
// Такая карточка сразу получает tombstone, а не прежние кнопки управляемой установки.
const installedDrivers = computed(() => Object.fromEntries(Object.entries(store.installed)
  .filter(([id]) => !trackers.catalog?.drivers.some((driver) => driver.id === id && driver.deleted))));
const otherDrivers = computed(() => trackers.catalog?.drivers.filter((driver) =>
  driver.id !== 'own' && !installedDrivers.value[driver.id]) ?? []);
const active = computed(() => !!store.job && ['running', 'ready', 'applying'].includes(store.job.status));
const statusLabel = computed(() => store.job ? t(({
  running: 'core.trackerJobRunning',
  ready: 'core.trackerJobReady',
  applying: 'core.trackerJobApplying',
  done: 'core.trackerJobDone',
  failed: 'core.trackerJobFailed',
  cancelled: 'core.trackerJobCancelled',
  interrupted: 'core.trackerJobInterrupted',
  recovery_required: 'core.trackerRecovery',
} as const)[store.job.status]) : '');
const stageLabel = computed(() => store.job?.stage ? t(({
  fetching: 'core.trackerStageFetching',
  validating: 'core.trackerStageValidating',
  dependencies: 'core.trackerStageDependencies',
} as const)[store.job.stage]) : '');
let timer: ReturnType<typeof setInterval> | null = null;

const sourceDomain = (url: string) => new URL(url).hostname;

/**
 * Общий диалог подтверждает удаление выбранного пакета и сохраняет реквизиты владельца.
 * Повторный клик не создаёт второе подтверждение или параллельный запрос удаления.
 */
async function removeDriver(id: string, name: string) {
  if (removing.value || store.busy) {
    return;
  }

  removing.value = true;

  try {
    const accepted = await confirmDialog(messageRef('core.trackerRemoveConfirmation', { name }), {
      title: messageRef('core.trackerRemoveTitle'),
      okText: messageRef('core.trackerRemove'),
      danger: true,
    });

    if (accepted) {
      await store.remove(id);
    }
  } finally {
    removing.value = false;
  }
}

onMounted(() => {
  void store.loadSources();
  void store.current();
  timer = setInterval(() => {
    if (store.job && ['running', 'applying'].includes(store.job.status)) {
      void store.current();
    }
  }, 1000);
});
onUnmounted(() => {
  if (timer) {
    clearInterval(timer);
  }
});
</script>

<style scoped>
.driver-install { display: grid; gap: 12px; min-width: 0; overflow-wrap: anywhere; }
.driver-source-list { display: flex; flex-wrap: wrap; gap: 8px; }
.driver-source small { display: block; color: var(--ink-mid); }
.digest { word-break: break-all; }
</style>
