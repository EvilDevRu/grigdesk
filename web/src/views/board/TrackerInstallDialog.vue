<template>
  <UiDialog :open="open" :title="t('core.trackerInstallGit')" @update:open="emit('update:open', $event)">
    <div class="driver-install">
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
      <template v-if="Object.keys(store.installed).length">
        <h3>{{ t('core.trackerInstalled') }}</h3>
        <div v-for="(record, id) in store.installed" :key="id">
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
        </div>
      </template>
      <UiInlineMessage v-if="store.restartRequired">{{ t('core.trackerRestart') }}</UiInlineMessage>
    </div>
  </UiDialog>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue';

import { useDriverInstallStore } from '../../stores/driverInstall.ts';
import { t, UiButton, UiDialog, UiField, UiInlineMessage, UiInput, UiSelect } from '../../ui.ts';

defineProps<{ open: boolean }>();

const emit = defineEmits<{ 'update:open': [open: boolean] }>();
const store = useDriverInstallStore();
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

onMounted(() => {
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
.digest { word-break: break-all; }
</style>
