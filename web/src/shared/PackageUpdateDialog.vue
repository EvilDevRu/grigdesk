<template>
  <UiDialog :open="open" :title="t('settings.pkgUpdateTitle')" @close="emit('close')">
    <div data-context="package-update-dialog">
      <p v-if="targetVersion">
        {{ t('settings.pkgUpdateAvailable', { version: targetVersion }) }}
      </p>
      <ul data-context="package-update-stages">
        <li v-for="stage in stages" :key="stage" :data-stage="stage"
          :class="{ done: doneStages.has(stage), active: job?.stage === stage }"
          :aria-current="job?.stage === stage ? 'step' : undefined">
          <strong v-if="job?.stage === stage">{{ stageLabel(stage) }}</strong>
          <template v-else>{{ stageLabel(stage) }}</template>
        </li>
      </ul>
      <UiProgress v-if="percent !== null" :value="percent" :label="t('settings.pkgStageDownloading')" />
      <p v-if="percent !== null" data-context="package-update-progress">{{ percent }}%</p>
      <p v-if="updates.error || job?.error" role="alert" data-context="package-update-error">
        {{ updates.error || job?.error?.message }}
      </p>
      <p v-if="job?.status === 'restarting'">
        {{ t('settings.pkgUpdateRestarting') }}
      </p>
    </div>
    <template #footer>
      <UiButton data-context="package-update-confirm"
        :disabled="updates.active || updates.actionBusy || !release?.updateAvailable"
        @click="updates.installPackage()">
        {{ t('settings.pkgUpdateButton') }}
      </UiButton>
    </template>
  </UiDialog>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import { UiButton, UiDialog, UiProgress } from '../ui.ts';
import { useGrigDeskUpdateStore } from '../stores/grigdeskUpdate.ts';
import { PACKAGE_UPDATE_STAGE_LABELS } from '../shared/grigdeskUpdate.ts';
import { localeTranslator } from '../../../shared/i18n/catalogs.ts';
import { uiLocalePort } from '../shared/uiLocalePort.ts';

defineProps<{ open: boolean }>();

const emit = defineEmits<{ (event: 'close'): void }>();

const updates = useGrigDeskUpdateStore();
const t = localeTranslator(uiLocalePort);

const release = computed(() => {
  return updates.status;
});

const job = computed(() => {
  return updates.status?.job ?? null;
});

const targetVersion = computed(() => {
  return release.value?.packageUpdate?.version ?? job.value?.targetVersion ?? '';
});

const percent = computed(() => {
  return updates.packageProgress;
});

const stages = ['verifying', 'downloading', 'unpacking', 'probing', 'applying',
  'restarting'] as const;

type PackageStage = typeof stages[number];

const doneStages = computed(() => {
  const current = stages.indexOf(String(job.value?.stage ?? '') as PackageStage);

  return new Set(stages.slice(0, Math.max(current, 0)));
});

function stageLabel(stage: PackageStage): string {
  return String(PACKAGE_UPDATE_STAGE_LABELS[stage]);
}
</script>
