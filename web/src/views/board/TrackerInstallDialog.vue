<template>
  <UiDialog :open="open" :title="t('core.trackerInstallTitle')"
            :description="t('core.trackerInstallIntro')" data-role="tracker-install" data-ui-workspace
            initial-focus=".driver-source:not([disabled]), .driver-custom-source:not([disabled])"
            @update:open="emit('update:open', $event)">
    <template #title>
      <div class="driver-install__heading">
        <span class="driver-install__title">{{ t('core.trackerInstallTitle') }}</span>
        <UiIconButton :label="t('core.close')" @click="emit('update:open', false)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
               stroke-linecap="round" aria-hidden="true">
            <path d="m6 6 12 12M18 6 6 18" />
          </svg>
        </UiIconButton>
      </div>
    </template>

    <div class="driver-install" :aria-busy="store.busy || removing">
      <section class="driver-sources" :aria-label="t('core.trackerSource')">
        <h3>{{ t('core.trackerSource') }}</h3>
        <p v-if="store.sourcesLoading" class="driver-install__note" role="status">
          {{ t('core.trackerSourcesLoading') }}
        </p>
        <UiInlineMessage v-else-if="store.sourcesError" tone="danger">
          {{ store.sourcesError }}
        </UiInlineMessage>
        <p v-else-if="!store.sources.length" class="driver-install__note">
          {{ t('core.trackerSourcesEmpty') }}
        </p>
        <div class="driver-source-list">
          <UiButton v-for="source in store.sources" :key="source.url" class="driver-source"
                    :disabled="store.busy || active" :pressed="selectedSource === source.url" wrap
                    @click="chooseSource(source.url)">
            <span class="driver-source__copy">
              <span class="driver-source__title">{{ source.title }}</span>
              <small class="driver-source__domain">{{ sourceDomain(source.url) }}</small>
            </span>
          </UiButton>
          <UiButton class="driver-custom-source" data-role="driver-custom-source"
                    :disabled="store.busy || active" :pressed="isCustomSource" wrap @click="chooseSource(null)">
            <span class="driver-source__copy">
              <span class="driver-source__title">{{ t('core.trackerCustomSource') }}</span>
              <small class="driver-source__domain">{{ t('core.trackerCustomSourceHint') }}</small>
            </span>
          </UiButton>
        </div>
      </section>

      <div class="driver-install__fields">
        <UiField v-if="isCustomSource" id="driver-install-url" :label="t('core.trackerRepository')">
          <UiInput v-model="store.url" name="url" type="url" :disabled="store.busy || active"
                   placeholder="https://github.com/owner/tracker" autocomplete="off" :spellcheck="false" />
        </UiField>
        <UiField :label="t('core.trackerTag')" :hint="t('core.trackerTagHint')">
          <div class="driver-install__version-row">
            <UiInput v-model="store.tag" name="tag" :disabled="store.busy || active"
                     :placeholder="t('core.trackerTagPlaceholder')" autocomplete="off" :spellcheck="false" />
            <UiButton :disabled="store.busy || active || !store.url.trim()" @click="store.versionsForSource()">
              {{ t('core.trackerVersions') }}
            </UiButton>
          </div>
        </UiField>
        <UiField v-if="store.versions.length" :label="t('core.trackerAvailableVersions')">
          <UiSelect v-model="store.tag" :disabled="store.busy || active">
            <option value="">{{ t('core.trackerChooseVersion') }}</option>
            <option v-for="version in store.versions" :key="version.tag" :value="version.tag">
              {{ version.tag }}
            </option>
          </UiSelect>
        </UiField>
      </div>

      <UiInlineMessage v-if="store.error" tone="danger">{{ store.error }}</UiInlineMessage>
      <UiInlineMessage v-if="store.versionsEmpty" tone="danger">
        {{ t('core.trackerNoVersions') }}
      </UiInlineMessage>
      <UiInlineMessage v-if="store.previousUnavailable" tone="danger">
        {{ t('core.trackerPreviousUnavailable') }}
      </UiInlineMessage>
      <UiInlineMessage v-if="store.recoveryError" tone="danger">{{ store.recoveryError }}</UiInlineMessage>

      <section v-if="store.job" class="driver-job" :aria-label="statusLabel">
        <p class="driver-job__status" :data-status="store.job.status" role="status">
          {{ statusLabel }} <span>{{ store.job.target?.version }}</span>
        </p>
        <p v-if="stageLabel" class="driver-install__note">
          {{ stageLabel }} {{ store.job.percent === null ? '' : `${store.job.percent}%` }}
        </p>
        <template v-if="store.job.preview">
          <div class="driver-job__identity">
            <h3>{{ store.job.preview.name }}</h3>
            <span>{{ store.job.preview.version }}</span>
          </div>
          <p class="driver-install__note">{{ store.job.preview.source.url }}</p>
          <dl class="driver-job__details">
            <dt>{{ t('settings.commit') }}</dt>
            <dd><code>{{ store.job.preview.target.sha }}</code></dd>
            <template v-if="store.job.payloadDigest">
              <dt>{{ t('core.trackerDigest') }}</dt>
              <dd><code>{{ store.job.payloadDigest }}</code></dd>
            </template>
          </dl>
          <div v-if="store.job.preview.changes" class="driver-job__changes">
            <UiDisclosureButton v-model:open="changesOpen" :controls="changesId" size="compact">
              {{ t('core.trackerChanges') }}
            </UiDisclosureButton>
            <div v-if="changesOpen" :id="changesId" class="driver-job__diff">
              <p v-for="commit in store.job.preview.changes.commits" :key="commit.sha">{{ commit.subject }}</p>
              <p v-for="file in store.job.preview.changes.files" :key="file.path">
                <code>{{ file.status }} {{ file.path }}</code>
              </p>
            </div>
          </div>
          <p v-else class="driver-install__note">{{ t('core.trackerNoChanges') }}</p>
        </template>
        <UiInlineMessage v-if="store.job.status === 'ready'" tone="warning">
          {{ t('core.trackerServerCode') }}
        </UiInlineMessage>
        <UiInlineMessage v-for="warning in store.job.preview?.warnings" :key="warning" tone="warning">
          {{ warning }}
        </UiInlineMessage>
        <UiInlineMessage v-if="store.job.error" tone="danger">{{ store.job.error.message }}</UiInlineMessage>
      </section>

      <section v-if="Object.keys(installedDrivers).length || otherDrivers.length" class="driver-installed"
               :aria-label="t('core.trackerInstalled')">
        <h3>{{ t('core.trackerInstalled') }}</h3>
        <div v-for="(record, id) in installedDrivers" :key="id" class="driver-package">
          <p class="driver-package__identity">{{ id }} <span>{{ record.version }}</span></p>
          <UiInlineMessage v-if="record.checkError" tone="danger">{{ record.checkError.message }}</UiInlineMessage>
          <UiInlineMessage v-if="record.rollbackError" tone="danger">
            {{ record.rollbackError.message }}
          </UiInlineMessage>
          <UiFormActions align="start">
            <UiButton :disabled="store.busy || active || !!store.pendingRollback" @click="store.update(String(id))">
              {{ t('core.trackerUpdate') }}
            </UiButton>
            <UiButton :disabled="store.busy || active || !record.rollbackAvailable"
                      @click="store.rollback(String(id))">
              {{ t('core.trackerRollback') }}
            </UiButton>
            <UiButton variant="ghost" tone="danger"
                      :disabled="store.busy || active || removing || !!store.pendingRollback"
                      @click="removeDriver(String(id), String(id))">
              {{ t('core.trackerRemove') }}
            </UiButton>
          </UiFormActions>
        </div>
        <div v-for="driver in otherDrivers" :key="driver.id" class="driver-package">
          <p class="driver-package__identity">{{ driver.name }} <span>{{ driver.version }}</span></p>
          <UiInlineMessage v-if="driver.deleted">{{ t('core.trackerDeleted') }}</UiInlineMessage>
          <UiFormActions v-else align="start">
            <UiButton variant="ghost" tone="danger"
                      :disabled="store.busy || active || removing || !!store.pendingRollback"
                      @click="removeDriver(driver.id, driver.name)">
              {{ t('core.trackerRemove') }}
            </UiButton>
          </UiFormActions>
        </div>
      </section>
      <UiInlineMessage v-if="store.restartRequired">{{ t('core.trackerRestart') }}</UiInlineMessage>
    </div>

    <template #footer>
      <div class="driver-install__footer">
        <UiButton variant="link" :disabled="store.busy" @click="store.check()">
          {{ t('core.trackerCheckUpdates') }}
        </UiButton>
        <UiFormActions>
          <UiButton variant="ghost" @click="emit('update:open', false)">{{ t('core.close') }}</UiButton>
          <UiButton v-if="store.job && ['running', 'ready'].includes(store.job.status)"
                    :disabled="store.busy" @click="store.cancel()">
            {{ t('core.trackerCancel') }}
          </UiButton>
          <UiButton v-if="store.job?.status === 'ready'" variant="solid" tone="accent"
                    :disabled="store.busy || !!store.recoveryError" :loading="store.busy" @click="store.apply()">
            {{ t('core.trackerApply') }}
          </UiButton>
          <UiButton v-else-if="store.pendingRollback" variant="solid" tone="accent"
                    :disabled="store.busy" :loading="store.busy" @click="store.current()">
            {{ t('core.trackerResumeRollback') }}
          </UiButton>
          <UiButton v-else variant="solid" tone="accent" :loading="store.busy || active"
                    :disabled="store.busy || active || !store.url.trim() || !store.tag.trim()"
                    @click="store.prepare()">
            {{ active ? statusLabel : t('core.trackerPrepare') }}
          </UiButton>
        </UiFormActions>
      </div>
    </template>
  </UiDialog>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, useId, watch } from 'vue';

import { useDriverInstallStore } from '../../stores/driverInstall.ts';
import { useTrackersStore } from '../../stores/trackers.ts';
import {
  confirmDialog, messageRef, t, UiButton, UiDialog, UiDisclosureButton, UiField, UiFormActions,
  UiIconButton, UiInlineMessage, UiInput, UiSelect,
} from '../../ui.ts';

defineProps<{ open: boolean }>();

const emit = defineEmits<{ 'update:open': [open: boolean] }>();
const store = useDriverInstallStore();
const trackers = useTrackersStore();
const removing = ref(false);
const changesOpen = ref(false);
const changesId = `driver-install-changes-${useId().replaceAll(':', '')}`;
const selectedSource = ref<string | null>();
const customUrl = ref('');

// SSE может подтвердить удаление раньше ответа check или при его сетевом отказе.
// Такая карточка сразу получает tombstone, а не прежние кнопки управляемой установки.
const installedDrivers = computed(() => Object.fromEntries(Object.entries(store.installed)
  .filter(([id]) => !trackers.catalog?.drivers.some((driver) => driver.id === id && driver.deleted))));
const otherDrivers = computed(() => trackers.catalog?.drivers.filter((driver) =>
  driver.id !== 'own' && !installedDrivers.value[driver.id]) ?? []);
const active = computed(() => !!store.job && ['running', 'ready', 'applying'].includes(store.job.status));
const isCustomSource = computed(() => selectedSource.value === null);
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
 * Официальный источник передаёт URL скрыто, а собственный сохраняет отдельный черновик.
 * Переключение не запускает Git, поиск версий или подготовку установки.
 */
function chooseSource(url: string | null) {
  if (store.busy || active.value) {
    return;
  }

  if (isCustomSource.value) {
    customUrl.value = store.url;
  }

  selectedSource.value = url;
  store.url = url ?? customUrl.value;
}

/**
 * После чтения каталога выбирается сохранённый адрес либо первый официальный источник.
 * Восстановленное активное задание имеет приоритет и показывает свой фактический источник.
 */
function syncSource() {
  if (selectedSource.value !== undefined) {
    return;
  }

  const jobUrl = active.value ? store.job?.source.url : undefined;
  const url = jobUrl ?? store.url;
  const official = store.sources.find((source) => source.url === url);
  const fallback = url ? null : store.sources[0]?.url ?? null;

  selectedSource.value = official?.url ?? fallback;
  store.url = selectedSource.value ?? url;

  if (isCustomSource.value) {
    customUrl.value = store.url;
  }
}

watch([() => store.sourcesLoading, () => store.busy], ([loading, busy]) => {
  if (!loading && !busy) {
    syncSource();
  }
});

watch(() => store.url, () => {
  store.versions = [];
  store.versionsEmpty = false;
});

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
.driver-install {
  display: grid;
  gap: 20px;
  min-width: 0;
  overflow-wrap: anywhere;
}

.driver-install__heading,
.driver-job__identity,
.driver-package__identity {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.driver-install__heading {
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
  font-size: 13px;
  font-weight: 500;
  line-height: 1.5;
}

.driver-sources,
.driver-installed,
.driver-package,
.driver-job {
  display: grid;
  gap: 12px;
  min-width: 0;
}

.driver-source-list {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}

.driver-source__copy {
  display: grid;
  gap: 2px;
  min-width: 0;
  padding: 4px 0;
  text-align: left;
}

.driver-source__title {
  font-size: 13px;
  font-weight: 500;
}

.driver-source__domain,
.driver-install__note,
.driver-job__details dt,
.driver-package__identity span {
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 1.5;
}

.driver-install__fields {
  display: grid;
  gap: 16px;
}

.driver-install__version-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: start;
  gap: 8px;
}

.driver-package,
.driver-job {
  padding: 14px;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--surface-2);
}

.driver-job__identity,
.driver-package__identity {
  flex-wrap: wrap;
  font-size: 13px;
}

.driver-job__identity span,
.driver-job__status {
  color: var(--accent);
  font-size: 12px;
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
  gap: 5px;
  min-width: 0;
  margin: 0;
}

.driver-job__details dd {
  margin: 0 0 5px;
  color: var(--ink-mid);
  font-size: 11px;
}

.driver-job__details code,
.driver-job__diff code {
  font-family: var(--mono);
  overflow-wrap: anywhere;
}

.driver-job__diff {
  display: grid;
  gap: 8px;
  max-height: 180px;
  margin-top: 8px;
  overflow-y: auto;
  font-size: 12px;
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
  .driver-source-list {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .driver-install__footer {
    flex-direction: column;
    align-items: stretch;
  }
}

@media (max-width: 360px) {
  .driver-source-list {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
