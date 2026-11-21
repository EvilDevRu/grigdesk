<template>
  <UiDialog :open="updates.open" :title="t('settings.appUpdateTitle')" @close="updates.open = false">
    <div v-if="snapshot" data-context="application-update-dialog">
      <p>{{ t('settings.appUpdateVersions', {
        current: snapshot.running, next: snapshot.job?.version || snapshot.targetVersion || '—',
      }) }}</p>
      <p>{{ t(snapshot.scope === 'pair' ? 'settings.appUpdatePair' : 'settings.appUpdateDesktop') }}</p>
      <p>{{ t('settings.appUpdateChannel', { channel: snapshot.channel }) }}</p>
      <div v-if="usesChannel" class="application-update-channels">
        <UiButton v-for="channel in channels" :key="channel" :disabled="updates.busy || !!updates.activeJob"
          @click="updates.action('channel', { channel })">
          {{ channel }}
        </UiButton>
      </div>
      <p v-if="usesChannel">{{ t(`settings.appUpdateCheck_${snapshot.checkState}`) }}</p>
      <p v-else-if="snapshot.source === 'local-test'">{{ t('settings.appUpdateLocalTestSource') }}</p>
      <p v-else>{{ t('settings.appUpdateCandidateSource') }}</p>
      <p v-if="snapshot.checkedAt">{{ t('settings.appUpdateCheckedAt', { time: snapshot.checkedAt }) }}</p>
      <p class="application-update-notes">{{ notes || t('settings.appUpdateNoNotes') }}</p>
      <template v-if="snapshot.job">
        <p role="status">{{ t(`settings.appUpdateStage_${snapshot.job.stage}`) }}</p>
        <UiProgress v-if="updates.progress !== null" :value="updates.progress"
          :label="t('settings.appUpdateStage_downloading')" />
        <p v-if="updates.progress !== null">{{ updates.progress }}%</p>
      </template>
      <p v-if="snapshot.error || updates.error" role="alert">
        {{ t('settings.appUpdateFailure', { code: snapshot.error || updates.error || '' }) }}
      </p>
      <p v-if="snapshot.scope === 'desktop'">{{ t('settings.appUpdateRemoteCli') }}</p>
      <p v-if="needsInstaller">{{ t('settings.appUpdateCandidateResume') }}</p>
      <p v-else-if="snapshot.job?.nextAction">{{
        t(snapshot.job.nextAction === 'check-updates'
          ? 'settings.appUpdateNextActionCheck' : 'settings.appUpdateNextAction')
      }}</p>
    </div>
    <template #footer>
      <UiButton v-if="usesChannel" :disabled="updates.busy" @click="updates.action('check')">
        {{ t('settings.appUpdateCheckButton') }}
      </UiButton>
      <UiButton v-if="snapshot?.job?.stage === 'ready'" :disabled="updates.busy"
        @click="updates.action('apply', { confirmed: true })">
        {{ t('settings.appUpdateRestart') }}
      </UiButton>
      <UiButton v-else-if="!needsInstaller && snapshot?.job?.recoverable && resumable.includes(snapshot.job.stage)"
        :disabled="updates.busy" @click="updates.action('resume')">
        {{ t('settings.appUpdateResume') }}
      </UiButton>
      <UiButton v-if="usesChannel && snapshot?.job?.stage !== 'ready' && !updates.activeJob"
        :disabled="updates.busy || !updates.available"
        @click="updates.action('prepare')">
        {{ t('settings.appUpdatePrepare') }}
      </UiButton>
      <UiButton @click="updates.open = false">{{ t('settings.appUpdateLater') }}</UiButton>
    </template>
  </UiDialog>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import { UiButton, UiDialog, UiProgress, uiLocale } from '../ui.ts';
import { localeTranslator } from '../../../shared/i18n/catalogs.ts';
import { useApplicationUpdateStore } from '../stores/applicationUpdate.ts';
import { candidateNeedsInstaller } from '../../../shared/runtime/applicationUpdateContracts.ts';

const t = localeTranslator(uiLocale);
const updates = useApplicationUpdateStore();
const snapshot = computed(() => updates.snapshot);
const usesChannel = computed(() => !snapshot.value?.source || snapshot.value.source === 'channel');
const needsInstaller = computed(() =>
  candidateNeedsInstaller(snapshot.value?.source, snapshot.value?.job?.stage));
const channels = ['release', 'dev'] as const;
const resumable = ['queued', 'verifying', 'downloading', 'preparing', 'failed',
  'manual_recovery_required', 'stopping', 'applying', 'starting'];
const notes = computed(() => snapshot.value?.notes?.[uiLocale.value === 'en' ? 'en' : 'ru']);
</script>

<style scoped>
.application-update-notes {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.application-update-channels {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
</style>
