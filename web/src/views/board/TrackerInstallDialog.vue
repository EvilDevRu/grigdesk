<template>
  <UiDialog :open="open" :title="title" :description="description" data-role="tracker-install"
            data-ui-workspace initial-focus="[data-primary], .driver-source, .driver-custom-source"
            @update:open="emit('update:open', $event)">
    <template #title>
      <div class="driver-install__heading">
        <span class="driver-install__title">{{ title }}</span>
        <UiIconButton :label="t('core.close')" @click="emit('update:open', false)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
               stroke-linecap="round" aria-hidden="true">
            <path d="m6 6 12 12M18 6 6 18" />
          </svg>
        </UiIconButton>
      </div>
    </template>

    <div class="driver-install" :aria-busy="store.busy || store.loading || store.removing">
      <ol v-if="steps.length" class="driver-steps" :class="{ 'driver-steps--three': steps.length === 3 }"
          :aria-label="t('core.trackerWizardSteps')">
        <li v-for="(step, index) in steps" :key="step" :aria-current="index === stepIndex ? 'step' : undefined"
            :class="{ 'is-current': index === stepIndex, 'is-complete': index < stepIndex }">
          <span class="driver-steps__number" aria-hidden="true">{{ index < stepIndex ? '✓' : index + 1 }}</span>
          <span>{{ step }}</span>
        </li>
      </ol>
      <p v-if="steps.length" class="driver-steps__mobile">
        <span>{{ t('core.trackerWizardStep', { current: stepIndex + 1, total: steps.length }) }}</span>
        <strong>{{ steps[stepIndex] }}</strong>
      </p>

      <UiLoadingState v-if="store.loading" :label="t('core.loading')">
        <div v-if="displayScreen === 'source'" class="driver-source-list"
             aria-hidden="true" data-loading-region="tracker-sources">
          <div v-for="index in 3" :key="index" class="driver-source__copy driver-install__loading-source">
            <UiSkeleton width="65%" height="21px" />
            <UiSkeleton width="90%" height="18px" />
          </div>
        </div>
        <div v-else class="driver-job" aria-hidden="true" data-loading-region="tracker-operation">
          <UiSkeleton width="45%" height="21px" />
          <UiSkeleton width="65%" height="18px" />
          <UiSkeleton width="85%" height="18px" />
        </div>
      </UiLoadingState>
      <template v-else>
        <UiInlineMessage v-if="store.recoveryError || store.job?.status === 'recovery_required'" tone="danger">
          {{ store.recoveryError || t('core.trackerRecovery') }}
        </UiInlineMessage>
        <UiInlineMessage v-if="store.error" tone="danger">{{ store.error }}</UiInlineMessage>
        <UiInlineMessage v-if="store.previousUnavailable" tone="warning">
          {{ t('core.trackerPreviousUnavailable') }}
        </UiInlineMessage>
        <UiInlineMessage v-if="store.refreshError" tone="warning">
          {{ t('core.trackerRefreshFailed') }} {{ store.refreshError }}
          <UiButton variant="link" :disabled="store.busy" @click="store.refreshAfterMutation()">
            {{ t('core.trackerRefresh') }}
          </UiButton>
        </UiInlineMessage>

        <section v-if="store.screen === 'source'" class="driver-sources"
                 :aria-label="t('core.trackerSource')">
          <UiInlineMessage v-if="store.sourcesError" tone="warning">
            {{ store.sourcesError }}
            <UiButton variant="link" @click="store.loadSources()">{{ t('core.trackerRefresh') }}</UiButton>
          </UiInlineMessage>
          <p v-else-if="!store.sources.length" class="driver-install__note">{{ t('core.trackerSourcesEmpty') }}</p>
          <div class="driver-source-list">
            <UiButton v-for="source in store.sources" :key="source.url" class="driver-source" wrap
                      :disabled="store.busy" :pressed="store.selectedSource === source.url"
                      @click="chooseSource(source.url)">
              <span class="driver-source__copy">
                <span class="driver-source__title">{{ source.title }}</span>
                <small>{{ source.url.replace(/^https?:\/\//u, '') }}</small>
              </span>
            </UiButton>
            <UiButton class="driver-custom-source" data-role="driver-custom-source" wrap
                      :disabled="store.busy" :pressed="store.selectedSource === null" @click="chooseSource(null)">
              <span class="driver-source__copy">
                <span class="driver-source__title">{{ t('core.trackerCustomSource') }}</span>
                <small>{{ t('core.trackerCustomSourceHint') }}</small>
              </span>
            </UiButton>
          </div>
          <UiField v-if="store.selectedSource === null" id="driver-install-url"
                   :label="t('core.trackerRepository')" :hint="t('core.trackerRepositoryHint')">
            <UiInput v-model="store.url" name="url" :disabled="store.busy"
                     :placeholder="'https://github.com/owner/tracker'" autocomplete="off" :spellcheck="false" />
          </UiField>
        </section>

        <section v-else-if="store.screen === 'version'" class="driver-install__fields">
          <p class="driver-install__note">{{ store.url }}</p>
          <UiInlineMessage v-if="store.replaceModified" tone="warning">
            {{ t('core.trackerRestoreHint') }}
          </UiInlineMessage>
          <UiLoadingState v-if="store.busy && !store.manualVersion" :label="t('core.trackerVersionsLoading')">
            <div class="driver-install__loading-field" aria-hidden="true" data-loading-region="tracker-version">
              <UiSkeleton width="min(100%, 180px)" height="18px" />
              <UiSkeleton shape="block" height="var(--control-height)" />
              <UiSkeleton width="min(100%, 220px)" height="17px" />
            </div>
          </UiLoadingState>
          <UiLoadingState v-else-if="store.busy" variant="inline" :label="t('core.trackerVersionsLoading')" />
          <UiInlineMessage v-if="store.versionsEmpty" tone="warning">{{ t('core.trackerNoVersions') }}</UiInlineMessage>
          <UiField v-if="store.versions.length && !store.manualVersion" :label="t('core.trackerAvailableVersions')"
                   :hint="t('core.trackerStableVersions')">
            <UiSelect v-model="store.tag" :disabled="store.busy">
              <option v-for="(version, index) in store.versions" :key="version.tag" :value="version.tag">
                {{ version.tag }}{{ index === 0 ? t('core.taskTrackerlatestversion', { trackerLatestVersion: t('core.trackerLatestVersion') }) : '' }}
              </option>
            </UiSelect>
          </UiField>
          <UiDisclosureButton v-model:open="store.manualVersion" :controls="`${baseId}-manual`">
            {{ t('core.trackerManualVersion') }}
          </UiDisclosureButton>
          <UiField v-if="store.manualVersion" :id="`${baseId}-manual`" :label="t('core.trackerTag')"
                   :hint="t('core.trackerStableVersions')">
            <UiInput v-model="store.tag" name="tag" :disabled="store.busy"
                     :placeholder="t('core.trackerTagPlaceholder')" autocomplete="off" :spellcheck="false" />
          </UiField>
          <UiButton variant="link" :disabled="store.busy" @click="store.versionsForSource()">
            {{ t('core.trackerReloadVersions') }}
          </UiButton>
        </section>

        <section v-else-if="store.screen === 'rollback' && store.rollbackPreview" class="driver-job">
          <h3>{{ driverName(store.rollbackPreview.id) }}</h3>
          <p class="driver-job__version">
            {{ store.rollbackPreview.record.version }} → {{ store.rollbackPreview.record.previous?.version }}
          </p>
          <p class="driver-install__note">{{ store.rollbackPreview.record.previous?.source.url }}</p>
          <UiInlineMessage>{{ t('core.trackerRollbackHint') }}</UiInlineMessage>
          <UiInlineMessage v-if="store.rollbackPreview.record.source.url
            !== store.rollbackPreview.record.previous?.source.url" tone="warning">
            {{ t('core.trackerRollbackSourceChanges') }}
          </UiInlineMessage>
        </section>

        <section v-else-if="store.job || working" class="driver-job"
                 :class="{ 'driver-job--working': working }" :aria-label="statusLabel">
          <div class="driver-job__activity" role="status" aria-live="polite">
            <UiSpinner v-if="working" decorative />
            <div class="driver-job__activity-copy">
              <p class="driver-job__status" :data-status="store.job?.status">
                {{ store.unknownOutcome ? t('core.trackerCheckingOutcome') : statusLabel }}
              </p>
              <p v-if="working" class="driver-job__stage">{{ stageLabel || t('core.trackerOperationRunning') }}</p>
            </div>
          </div>
          <template v-if="working">
            <div class="driver-job__progress">
              <UiProgress :label="stageLabel || statusLabel" :value="store.job?.percent ?? 0"
                          :indeterminate="store.job?.stage !== 'fetching' || store.job.percent === null" />
              <span v-if="store.job?.stage === 'fetching' && store.job.percent !== null">
                {{ store.job.percent }}%
              </span>
            </div>
            <p class="driver-install__note">{{ t('core.trackerCloseKeepsOperation') }}</p>
          </template>
          <template v-if="store.job?.preview && !store.unknownOutcome">
            <div class="driver-job__identity">
              <h3>{{ store.job.preview.name }}</h3>
              <span class="driver-job__version">
                <template v-if="store.job.preview.replaces.kind === 'managed'">
                  {{ store.job.preview.replaces.version }} →
                </template>
                {{ store.job.preview.version }}
              </span>
            </div>
            <p class="driver-install__note">{{ store.job.preview.source.url }}</p>
            <p v-if="store.job.status === 'done'" class="driver-install__note">
              {{ t(store.flow === 'rollback' ? 'core.trackerRollbackDone'
                : store.flow === 'update' ? 'core.trackerUpdateDoneHint' : 'core.trackerInstalledHint') }}
            </p>
            <UiInlineMessage v-if="resultRestartRequired">{{ t('core.trackerRestart') }}</UiInlineMessage>
            <template v-if="store.job.status === 'ready'">
              <UiInlineMessage v-if="!officialSource" tone="warning">{{ t('core.trackerServerCode') }}</UiInlineMessage>
              <UiInlineMessage v-for="warning in warnings" :key="warning" tone="warning">
                {{ warning }}
              </UiInlineMessage>
              <div v-if="store.job.preview.changes" class="driver-job__changes">
                <UiDisclosureButton v-model:open="changesOpen" :controls="`${baseId}-changes`">
                  {{ t('core.trackerChanges') }}
                </UiDisclosureButton>
                <div v-if="changesOpen" :id="`${baseId}-changes`" class="driver-job__diff">
                  <p v-for="commit in store.job.preview.changes.commits" :key="commit.sha">{{ commit.subject }}</p>
                  <p v-for="file in store.job.preview.changes.files" :key="file.path">
                    <code>{{ file.status }} {{ file.path }}</code>
                  </p>
                  <p v-if="store.job.preview.changes.truncated">{{ t('core.trackerChangesTruncated') }}</p>
                </div>
              </div>
              <p v-else-if="store.job.preview.replaces.kind !== 'none'" class="driver-install__note">
                {{ t('core.trackerNoChanges') }}
              </p>
            </template>
            <UiDisclosureButton v-model:open="detailsOpen" :controls="`${baseId}-details`">
              {{ t('core.trackerTechnicalDetails') }}
            </UiDisclosureButton>
            <dl v-if="detailsOpen" :id="`${baseId}-details`" class="driver-job__details">
              <dt>{{ t('core.trackerPackageId') }}</dt>
              <dd>{{ store.job.driverId }}</dd>
              <dt>{{ t('settings.commit') }}</dt>
              <dd><code>{{ store.job.preview.target.sha }}</code></dd>
              <template v-if="store.job.payloadDigest">
                <dt>{{ t('core.trackerDigest') }}</dt>
                <dd><code>{{ store.job.payloadDigest }}</code></dd>
              </template>
            </dl>
          </template>
          <UiInlineMessage v-if="store.job?.error" tone="danger">{{ store.job.error.message }}</UiInlineMessage>
        </section>
      </template>
    </div>

    <template #footer>
      <div class="driver-install__footer">
        <UiLoadingState v-if="store.loading && displayScreen !== 'source'" variant="inline" />
        <template v-else-if="store.recoveryError || store.job?.status === 'recovery_required' || store.unknownOutcome">
          <UiButton :loading="store.busy" :disabled="store.busy" @click="store.current()">
            {{ t('core.trackerCheckingOutcome') }}
          </UiButton>
        </template>
        <template v-else-if="initializationError">
          <UiButton :disabled="store.busy" @click="configure()">{{ t('core.trackerBackToSettings') }}</UiButton>
          <UiButton :disabled="store.busy" @click="initialize()">{{ t('core.trackerRefresh') }}</UiButton>
        </template>
        <template v-else-if="displayScreen === 'source'">
          <UiButton :disabled="store.loading || store.busy" @click="configure()">
            {{ t('core.trackerBackToSettings') }}
          </UiButton>
          <UiButton variant="solid" tone="accent" data-primary
                    :disabled="store.loading || store.busy || !store.url.trim()"
                    @click="nextVersion()">{{ t('core.trackerNext') }}</UiButton>
        </template>
        <template v-else-if="store.screen === 'version'">
          <UiButton :disabled="store.busy" @click="backFromVersion()">{{ t('core.trackerBack') }}</UiButton>
          <UiButton variant="solid" tone="accent" data-primary :loading="store.busy"
                    :disabled="store.busy || !validVersion" @click="store.prepare()">
            {{ t('core.trackerPrepare') }}
          </UiButton>
        </template>
        <template v-else-if="store.screen === 'rollback'">
          <UiButton :disabled="store.busy" @click="configure()">{{ t('core.trackerBack') }}</UiButton>
          <UiButton v-if="store.errorCode" :disabled="store.busy"
                    @click="store.openRollback(store.rollbackPreview!.id)">
            {{ t('core.trackerRefresh') }}
          </UiButton>
          <UiButton v-else variant="solid" tone="accent" data-primary :disabled="store.busy"
                    @click="store.rollback()">{{ t('core.trackerRollback') }}</UiButton>
        </template>
        <template v-else-if="store.screen === 'review' && store.job?.status === 'ready'">
          <UiButton :disabled="store.busy" @click="editVersion()">{{ t('core.trackerBack') }}</UiButton>
          <UiButton v-if="store.errorCode === 'preview_stale'" variant="solid" tone="accent"
                    :disabled="store.busy" @click="editVersion()">{{ t('core.trackerPrepareAgain') }}</UiButton>
          <UiButton v-else variant="solid" tone="accent" data-primary :disabled="store.busy"
                    @click="store.apply()">{{ t(store.flow === 'update' ? 'core.trackerUpdate' : 'core.trackerInstall') }}</UiButton>
        </template>
        <template v-else-if="working">
          <UiButton v-if="store.job && ['running', 'ready'].includes(store.job.status)" :disabled="store.busy"
                    @click="editVersion()">{{ t('core.trackerCancelReview') }}</UiButton>
          <p v-else class="driver-install__note">{{ t('core.trackerCloseKeepsOperation') }}</p>
        </template>
        <template v-else>
          <UiButton :disabled="store.busy" @click="configure()">{{ t('core.trackerBackToSettings') }}</UiButton>
          <UiButton v-if="store.job?.status === 'done' && canConfigure(store.job.driverId)"
                    variant="solid" tone="accent" data-primary @click="configure(store.job.driverId!)">
            {{ t('core.trackerConfigureConnection') }}
          </UiButton>
          <UiButton v-else-if="store.job?.status === 'done'" variant="solid" tone="accent" @click="configure(store.job?.driverId ?? undefined)">
            {{ t('core.trackerFinish') }}
          </UiButton>
          <UiButton v-else-if="store.flow !== 'rollback'" variant="solid" tone="accent" @click="editVersion()">
            {{ t('core.trackerOtherVersion') }}
          </UiButton>
        </template>
      </div>
    </template>
  </UiDialog>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, useId, watch } from 'vue';

import { useDriverInstallStore } from '../../stores/driverInstall.ts';
import type { DriverInstallRequest } from '../../stores/driverInstall.ts';
import { useTrackersStore } from '../../stores/trackers.ts';
import { BUILTIN_DRIVER_SOURCES } from '../../../../shared/trackers/driverSources.ts';
import { sameCatalogSource } from '../../../../shared/plugins/pluginCatalogPolicy.ts';
import { isPackageCodeWarning } from '../../shared/installWarnings.ts';
import {
  t, UiButton, UiDialog, UiDisclosureButton, UiField,
  UiIconButton, UiInlineMessage, UiInput, UiLoadingState, UiProgress, UiSelect, UiSkeleton, UiSpinner,
} from '../../ui.ts';

const props = defineProps<{
  open: boolean;
  request: DriverInstallRequest;
}>();
const emit = defineEmits<{ 'update:open': [open: boolean]; configure: [id?: string] }>();
const store = useDriverInstallStore();
const trackers = useTrackersStore();
const initializationError = ref(false);
const changesOpen = ref(false);
const detailsOpen = ref(false);
const baseId = `driver-wizard-${useId().replaceAll(':', '')}`;
let timer: ReturnType<typeof setInterval> | null = null;

const displayScreen = computed(() => store.loading && store.screen === 'idle'
  ? props.request.kind === 'install' ? 'source'
    : props.request.kind === 'version' || props.request.kind === 'restore' ? 'version' : 'review'
  : store.screen);
const displayFlow = computed(() => store.loading && store.screen === 'idle'
  ? props.request.kind === 'install' ? 'install' : props.request.kind === 'rollback' ? 'rollback' : 'update'
  : store.flow);
const validVersion = computed(() => /^v?\d+\.\d+\.\d+$/u.test(store.tag.trim()));
const working = computed(() => store.busy || store.unknownOutcome
  || !!store.job && ['running', 'applying'].includes(store.job.status));
const completed = computed(() => store.screen === 'result' && store.job?.status === 'done'
  && !store.unknownOutcome);
const title = computed(() => t(completed.value ? store.flow === 'rollback' ? 'core.trackerRollbackDoneTitle'
    : store.flow === 'update' ? 'core.trackerUpdateDoneTitle' : 'core.trackerInstallDoneTitle'
  : displayFlow.value === 'rollback' ? 'core.trackerRollbackTitle'
  : displayFlow.value === 'update' ? 'core.trackerUpdateTitle' : 'core.trackerInstallTitle'));
const description = computed(() =>
  working.value && !['source', 'version'].includes(displayScreen.value) ? '' : completed.value
  ? t('core.trackerVersionInstalled', {
    version: store.job?.preview?.version ?? store.job?.target?.version ?? '',
  })
  : t(displayScreen.value === 'source' ? 'core.trackerChooseSourceHint'
  : displayScreen.value === 'version' ? 'core.trackerChooseVersionHint'
  : displayScreen.value === 'rollback' ? 'core.trackerRollbackHint'
  : 'core.trackerReviewHint'));
const steps = computed(() => ['idle', 'result'].includes(displayScreen.value) ? []
  : displayFlow.value === 'rollback' ? [
    t('core.trackerConfirmStep'), t('core.trackerRollback'), t('core.trackerResultStep'),
  ]
  : displayFlow.value === 'update' ? [
    t('core.trackerPrepareStep'), t('core.trackerConfirmStep'), t('core.trackerInstall'),
  ]
  : [
    t('core.trackerExternal'), t('core.trackerVersionStep'), t('core.trackerConfirmStep'),
    t('core.trackerInstall'),
  ]);
const stepIndex = computed(() => {
  if (displayFlow.value === 'rollback') {
    return displayScreen.value === 'rollback' ? 0 : displayScreen.value === 'progress' ? 1 : 2;
  }

  if (displayFlow.value === 'update') {
    return displayScreen.value === 'version' || store.job?.status === 'running' ? 0
      : displayScreen.value === 'review' ? 1 : 2;
  }

  return displayScreen.value === 'source' ? 0 : displayScreen.value === 'version' ? 1
    : displayScreen.value === 'review' ? 2 : 3;
});
const statusLabel = computed(() => store.job ? t(({
  running: 'core.trackerJobRunning',
  ready: 'core.trackerJobReady',
  awaiting_restart: 'settings.waitingForRestart',
  applying: 'core.trackerJobApplying',
  done: 'core.trackerJobDone',
  failed: 'core.trackerJobFailed',
  cancelled: 'core.trackerJobCancelled',
  interrupted: 'core.trackerJobInterrupted',
  recovery_required: 'core.trackerRecovery',
} as const)[store.job.status]) : t('core.trackerJobRunning'));
const stageLabel = computed(() => store.job?.stage ? t(({
  fetching: 'core.trackerStageFetching',
  validating: 'core.trackerStageValidating',
  dependencies: 'core.trackerStageDependencies',
} as const)[store.job.stage]) : '');
const officialSource = computed(() => !!store.job?.preview && BUILTIN_DRIVER_SOURCES.some((source) =>
  sameCatalogSource({ kind: 'git', url: source.url }, store.job!.preview!.source)));
const warnings = computed(() => [...new Set(store.job?.preview?.warnings ?? [])]
  .filter((warning) => !/правами GrigDesk|GrigDesk permissions/iu.test(warning)
    && (!officialSource.value || !isPackageCodeWarning(warning))));
const resultRestartRequired = computed(() => store.jobRestartRequired
  || !!store.job?.driverId && !!store.installed[store.job.driverId]?.restartRequired);
const driverName = (id: string) => trackers.catalog?.drivers.find((entry) => entry.id === id)?.name ?? id;
const canConfigure = (id: string | null) => !!id
  && !(store.job?.driverId === id && store.jobRestartRequired)
  && !store.installed[id]?.restartRequired
  && trackers.catalog?.drivers.some((entry) => entry.id === id
    && !entry.deleted && ['active', 'available'].includes(entry.status));

/**
 * Черновик своего источника переживает переключение карточек и закрытие мастера.
 * Любая смена адреса сбрасывает версии и тег прежнего репозитория.
 */
function chooseSource(url: string | null) {
  if (store.blocked) {
    return;
  }

  if (store.selectedSource === null) {
    store.customUrl = store.url;
  }

  store.selectedSource = url;
  store.url = url ?? store.customUrl;
  store.error = '';
}

watch(() => store.manualVersion, (manual) => {
  if (!manual && !store.versions.some((version) => version.tag === store.tag)) {
    store.tag = store.versions[0]?.tag ?? '';
  }
});

watch(() => store.url, () => {
  if (store.screen === 'source') {
    store.versions = [];
    store.versionsEmpty = false;
    store.tag = '';
  }
});

/**
 * Новый маршрут не может вытеснить активное серверное задание.
 * Подтверждённый результат снимается отдельно, черновик источника сохраняется.
 */
function beginInstall() {
  if (store.blocked) {
    return;
  }

  store.acknowledge();
  store.flow = 'install';
  store.replaceModified = false;
  store.updateDriverId = null;
  store.screen = 'source';
}

/**
 * Шаг версий выполняет единственный явный запрос списка, без подготовки пакета.
 * Повторное открытие того же шага сохраняет выбранный тег.
 */
async function nextVersion() {
  store.screen = 'version';
  await store.versionsForSource();
}

/**
 * Управляемый пакет обновляется из сохранённого источника с ожидаемым id.
 * Выбор старой версии проходит обычное подтверждение понижения на сервере.
 */
async function chooseVersion(id: string, replaceModified = false) {
  const record = store.installed[id];

  if (!record || store.blocked) {
    return;
  }

  store.acknowledge();
  store.flow = 'update';
  store.replaceModified = replaceModified;
  store.updateDriverId = id;
  store.url = record.source.url;
  store.tag = '';
  await nextVersion();
}

/**
 * Возврат к выбору сначала отменяет running/ready, освобождая серверный слот.
 * При отказе отмены исходный кандидат и его подтверждение остаются видимыми.
 */
async function editVersion() {
  if (store.busy || store.unknownOutcome || store.recoveryError) {
    return;
  }

  if (store.active && !await store.cancel()) {
    return;
  }

  store.acknowledge();
  store.screen = 'version';

  if (!store.versions.length) {
    await store.versionsForSource();
  }
}

function backFromVersion() {
  store.error = '';

  if (store.flow === 'update') {
    configure(store.updateDriverId ?? undefined);
  } else {
    store.screen = 'source';
  }
}

/**
 * Выход из мастера возвращает выбранный драйвер в единственный каталог настроек.
 * Завершённый результат отмечается просмотренным, активный серверный job не сбрасывается.
 */
function configure(id?: string) {
  if (store.blocked) {
    return;
  }

  const driverId = id ?? store.job?.driverId ?? store.updateDriverId ?? undefined;

  store.acknowledge();
  store.screen = 'idle';
  emit('configure', driverId);
}

/**
 * Прямой вход выполняет запрошенное действие после восстановления серверной операции.
 * Прежние завершённые попытки не подменяют новый выбор; активный и неизвестный исход сохраняются.
 */
async function initialize() {
  const recoveringOperation = store.blocked;

  initializationError.value = false;
  store.loading = true;

  if (props.request.kind === 'install') {
    await store.loadSources();
  }

  const restored = await store.current();
  const restoreError = store.error;
  const installed = await store.run(() => store.readInstalled());

  store.error ||= restoreError;
  store.loading = false;

  if (!restored || !installed) {
    initializationError.value = true;

    return;
  }

  if (store.blocked || store.job?.status === 'recovery_required'
    || store.job?.status === 'awaiting_restart') {
    return;
  }

  if (recoveringOperation || props.request.kind === 'resume') {
    if (!store.job) {
      configure();
    }

    return;
  }

  store.acknowledge();
  store.screen = 'idle';

  if (props.request.kind === 'update') {
    await store.update(props.request.id);
  } else if (props.request.kind === 'version' || props.request.kind === 'restore') {
    await chooseVersion(props.request.id, props.request.kind === 'restore');
  } else if (props.request.kind === 'rollback') {
    await store.openRollback(props.request.id);
  } else {
    if (store.selectedSource === undefined) {
      store.url ||= store.sources[0]?.url ?? '';
      store.selectedSource = store.sources.some((source) => source.url === store.url) ? store.url : null;
    }

    beginInstall();
  }
}

watch(() => store.screen, async () => {
  changesOpen.value = false;
  detailsOpen.value = false;
  await nextTick();

  const dialog = document.querySelector<HTMLElement>('[data-role="tracker-install"]');

  dialog?.querySelector<HTMLElement>('.ui-dialog__body')?.scrollTo?.(0, 0);
  dialog?.focus({ preventScroll: true });
});

onMounted(() => {
  void initialize();
  timer = setInterval(() => {
    if (!store.loading && !store.busy && (store.unknownOutcome || store.pendingRollback
      || store.job && ['running', 'applying'].includes(store.job.status))) {
      void store.current();
    }
  }, 1500);
});
onUnmounted(() => {
  if (timer) {
    clearInterval(timer);
  }
});
</script>

<style scoped>
.driver-install,
.driver-sources,
.driver-install__fields,
.driver-job {
  display: grid;
  gap: 16px;
  min-width: 0;
  overflow-wrap: anywhere;
}

.driver-install {
  align-content: start;
}

.driver-job__activity {
  display: flex;
  align-items: center;
  gap: 12px;
}

.driver-job__activity-copy {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.driver-job__stage {
  font-size: 14px;
}

.driver-job__progress {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.driver-job__progress > :first-child {
  flex: 1;
}

.driver-install__heading,
.driver-job__identity {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  min-width: 0;
}

.driver-install__heading {
  flex-wrap: nowrap;
  width: 100%;
}

.driver-install__title {
  flex: 1;
  min-width: 0;
}

.driver-install h3,
.driver-install p {
  margin: 0;
}

.driver-install h3 {
  font-size: 14px;
  font-weight: 500;
}

.driver-install__note,
.driver-source__copy small {
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 1.5;
}

.driver-source-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.driver-source__copy {
  display: grid;
  gap: 6px;
  padding: 8px 0;
  text-align: left;
}

.driver-install__loading-source {
  padding: 17px 11px;
}

.driver-install__loading-field {
  display: grid;
  gap: 5px;
  min-width: 0;
}

.driver-source__title {
  font-size: 14px;
  font-weight: 500;
}

.driver-job {
  align-content: start;
  padding: 18px;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--surface-2);
}

.driver-job__version,
.driver-job__status {
  color: var(--accent);
  font-size: 13px;
}

.driver-job__status[data-status='done'] {
  color: var(--good);
}

.driver-job__status[data-status='failed'],
.driver-job__status[data-status='recovery_required'] {
  color: var(--bad);
}

.driver-job__details {
  display: grid;
  gap: 6px;
  margin: 0;
  color: var(--ink-mid);
  font-size: 12px;
}

.driver-job__details dd {
  margin: 0 0 8px;
}

.driver-job code {
  font-family: var(--mono);
  overflow-wrap: anywhere;
}

.driver-job__diff {
  display: grid;
  gap: 8px;
  margin-top: 12px;
  font-size: 12px;
}

.driver-steps {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
  margin: 0 0 8px;
  padding: 0;
  list-style: none;
}

.driver-steps--three {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.driver-steps li {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--ink-mid);
  font-size: 12px;
}

.driver-steps li.is-current {
  color: var(--accent);
}

.driver-steps li.is-complete {
  color: var(--good);
}

.driver-steps__number {
  display: grid;
  flex: 0 0 24px;
  height: 24px;
  place-items: center;
  border: 1px solid currentColor;
  border-radius: 50%;
}

.driver-steps__mobile {
  display: none;
}

.driver-install__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
  width: 100%;
}

@media (max-width: 600px) {
  .driver-steps {
    display: none;
  }

  .driver-steps__mobile {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    color: var(--ink-mid);
    font-size: 12px;
  }

  .driver-steps__mobile strong {
    color: var(--ink);
    font-weight: 500;
  }

  .driver-job {
    gap: 12px;
    padding: 16px;
  }

  .driver-install__footer {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    align-items: stretch;
    gap: 8px;
  }

  .driver-install__footer > :only-child {
    grid-column: 1 / -1;
  }

  .driver-source-list {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
