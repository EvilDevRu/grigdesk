<template>
  <section
    class="settings-system"
    :data-system-page="settings.pageId"
    :data-ready="ready"
  >
    <p v-if="error" role="alert">{{ resolveUiText(error) }}</p>
    <p v-if="message" role="status">{{ resolveUiText(message) }}</p>
    <template v-if="settings.pageId === 'system.startup'">
      <SettingsSection
        data-startup-scope="application"
        :heading="t('settings.startupApplication')"
        :description="t('settings.startupApplicationDescription')"
      >
        <SettingsScope :scope="t('settings.applicationComputer')" />
        <SettingsField
          v-for="field in applicationFields"
          :key="field.key"
          :address="field.address"
        >
          <UiSwitch
            :model-value="applicationAutostartValue"
            :disabled="!applicationLauncher || busy"
            :aria-label="field.label"
            @update:model-value="settings.setField('applicationAutostart', 'enabled', $event)"
          />
        </SettingsField>
        <template v-if="applicationLauncher">
          <SettingsFacts :items="applicationFacts" />
          <p>{{ t('settings.shortcut') }} {{ shortcutLabel }}</p>
          <UiButton data-context="workspace-form-wrap" :disabled="busy" @click="shortcut">
            {{ shortcutPresent ? t('settings.removeShortcut') : t('settings.createShortcut') }}
          </UiButton>
          <p class="settings-startup-note">{{ t('settings.applicationShortcutDescription') }}</p>
        </template>
        <p v-else-if="!shell.capabilities.includes('applicationLauncher')" class="settings-startup-note">
          {{ t('settings.applicationLauncherUnavailable') }}
        </p>
        <p v-else-if="!applicationError" class="settings-startup-note">{{ t('settings.loading') }}</p>
        <p v-if="applicationError" role="alert">{{ resolveUiText(applicationError) }}</p>
      </SettingsSection>
      <SettingsSection
        data-startup-scope="server"
        :heading="t('settings.startupServer')"
        :description="serverDescription"
      >
        <SettingsScope :scope="t('settings.selectedServerComputer')" />
        <SettingsField
          v-for="field in startupFields"
          :key="field.key"
          :address="field.address"
        >
          <UiSwitch
            :model-value="autostartValue"
            :disabled="!launcher || launcher.autostart.unit === 'missing' || busy"
            :aria-label="field.label"
            @update:model-value="settings.setField('autostart', 'enabled', $event)"
          />
        </SettingsField>
        <template v-if="launcher">
          <div class="settings-autostart-note">
            <p>{{ autostartNote }}</p>
            <p v-if="server?.mode === 'desktop'">
              {{ t('settings.theApplicationManagesTheServerTheSwitch') }}
            </p>
            <p v-else-if="server && !server.systemd">{{ t('settings.theServerWasStartedManuallyTheSwitch') }}</p>
          </div>
        </template>
        <SettingsFacts v-if="server" :items="serverFacts" />
        <p v-if="serverText.hint" class="settings-startup-note">{{ serverText.hint }}</p>
        <UiButton
          data-context="workspace-form-wrap"
          :disabled="busy || !server"
          @click="restart"
        >
          {{ t('settings.restartServer') }}
        </UiButton>
      </SettingsSection>
    </template>
    <template v-else>
      <SettingsSection
        :heading="t('settings.sectionGrigdeskVersion')"
        :description="t('settings.installedVersionStableChannelAndUpdateCheck')"
      >
        <UiButton v-if="applicationUpdate.enabled" @click="applicationUpdate.open = true">
          {{ t('settings.appUpdateTitle') }}
        </UiButton>
        <PackagedServerVersion
          v-if="packageCapability"
          :version="release?.running.version || '—'"
          :client-version="buildVersion"
          :message="packageCapability.message"
        />
        <template v-else-if="release">
          <SettingsFacts :items="versionFacts" />
          <UiActionLink
            v-if="release.latest?.url"
            :href="release.latest.url"
            target="_blank"
          >
            {{ t('settings.whatSChanged') }}
          </UiActionLink>
          <p v-if="release.checkError">
            {{ release.checkError.message }} {{ t('settings.lastSuccessfulResultSaved') }}
          </p>
          <p v-if="release.checkoutChanged">
            {{ t('settings.checkoutChangedAfterStartupApplyLocalChanges') }}
          </p>
          <p>{{ t('settings.theApplicationInterfaceIsUpdatedByInstalling') }}</p>
          <p v-if="release.job">
            {{ stageLabel }} · {{ release.job.kind === 'update' ? t('settings.release2') : t('settings.localCheckout') }} ·
            {{ shortSha(release.job.targetSha) }}
            <span v-if="release.job.error">{{ release.job.error.message }}</span>
          </p>
          <div class="settings-system-actions">
            <UiButton data-context="workspace-form-wrap" :disabled="updates.checking || updates.active || busy" @click="updates.check()">
              {{ t('settings.checkForUpdates') }}
            </UiButton>
            <UiButton data-context="workspace-form-wrap"
              :disabled="!release.canApplyCheckout || updates.actionBusy || busy"
              @click="update('apply')"
            >
              {{ t('settings.applyLocalChanges') }}
            </UiButton>
            <UiButton data-context="workspace-form-wrap"
              v-if="release.latest"
              :disabled="!release.canInstallRelease || updates.actionBusy || busy"
              @click="update('update')"
            >
              {{ t('settings.updateTo') }} {{ release.latest.tag }}
            </UiButton>
          </div>
          <p v-for="reason in release.applyBlockReasons" :key="`apply:${reason}`">
            {{ t('settings.localApplication') }} {{ blockReasonLabel(reason, uiLocale) }}
          </p>
          <p v-for="reason in release.installBlockReasons" :key="`install:${reason}`">
            {{ t('settings.releaseInstallation') }} {{ blockReasonLabel(reason, uiLocale) }}
          </p>
        </template>
        <template v-if="release?.updateCapability?.kind === 'package' && !applicationUpdate.enabled">
          <p data-context="package-update-card">
            {{ t('settings.pkgUpdateTitle') }} · {{ release.running.version }}
            <template v-if="release.updateAvailable && release.packageUpdate">
              → {{ release.packageUpdate.version }}
            </template>
            <UiButton data-context="package-update-check"
              :disabled="updates.checking || updates.active" @click="updates.check()">
              {{ t('settings.pkgUpdateCheck') }}
            </UiButton>
            <UiButton data-context="package-update-open"
              :disabled="!release.updateAvailable && !release.job" @click="packageDialogOpen = true">
              {{ t('settings.pkgUpdateButton') }}
            </UiButton>
          </p>
          <p v-if="release.job" data-context="package-update-job">
            {{ stageLabel }}
          </p>
          <p v-if="release.checkError" role="alert" data-context="package-update-channel-error">
            {{ release.checkError.message }}
          </p>
          <PackageUpdateDialog :open="packageDialogOpen" @close="packageDialogOpen = false" />
        </template>
        <p v-if="updates.error" role="alert">{{ updates.error }}</p>
      </SettingsSection>
      <SettingsSection v-if="!packageCapability" :heading="t('settings.sectionInterfaceBuild')">
        <UiButton data-context="workspace-form-wrap" :disabled="busy || updates.active" @click="rebuild">{{ t('settings.rebuildWebBundle') }}</UiButton>
        <p>
          {{ t('settings.buildingFromTheWorkingTreeIncludesUncommitted') }}
        </p>
      </SettingsSection>
    </template>
  </section>
</template>

<script setup lang="ts">
import { t, uiLocale, messageRef, resolveUiText, type UiText } from '../../../ui.ts';

import { computed, onBeforeUnmount, ref, watch } from 'vue';
import SettingsSection from '../SettingsSection.vue';
import SettingsScope from '../SettingsScope.vue';
import { UiSwitch, UiButton, UiActionLink, confirmDialog } from '../../../ui.ts';
import { api, ApiError, failureText } from '../../../shared/apiClient.ts';
import { useSettingsStore } from '../../../stores/settings.ts';
import { useGrigDeskUpdateStore } from '../../../stores/grigdeskUpdate.ts';
import { serverModeText, serverRestartMessage } from '../serverMode.ts';
import {
  blockReasonLabel, UPDATE_STAGE_LABELS, PACKAGE_UPDATE_STAGE_LABELS,
} from '../../../shared/grigdeskUpdate.ts';
import { getSettingsFields } from '../../../features/settings/catalog.ts';
import { createAutostartResource } from '../../../features/settings/resources/startup.ts';
import { sseSubscribe } from '../../../composables/useSse.ts';
import type { LauncherState } from '../../../../../shared/runtime/launcherContracts.ts';
import type { ReleaseStatus } from '../../../../../shared/runtime/grigDeskUpdateContracts.ts';
import SettingsField from '../SettingsField.vue';
import SettingsFacts from '../SettingsFacts.vue';
import PackagedServerVersion from '../PackagedServerVersion.vue';
import PackageUpdateDialog from '../../../shared/PackageUpdateDialog.vue';
import { useShellStore } from '../../../stores/shell.ts';
import { useApplicationUpdateStore } from '../../../stores/applicationUpdate.ts';
import { shellAction } from '../../../shared/shellClient.ts';
import {
  createApplicationLauncherResource,
  decodeApplicationLauncher,
} from '../../../features/settings/resources/applicationLauncher.ts';
import type { ApplicationLauncherState } from '../../../../../shared/desktop/applicationLauncher.ts';
import { machineProfileName } from '../../../../../shared/client/clientShell.ts';

type ServerView = {
  mode?: string;
  systemd?: boolean;
  pid: number;
  uptimeSec: number;
};
type RebuildView = { status: string; error?: { message?: string } };

declare const __GRIGDESK_VERSION__: string;
declare const __GRIGDESK_SHA__: string;

const props = defineProps<{ active: boolean }>();
const settings = useSettingsStore();
const updates = useGrigDeskUpdateStore();
const packageDialogOpen = ref(false);
const shell = useShellStore();
const applicationUpdate = useApplicationUpdateStore();
const server = ref<ServerView | null>(null);
const launcher = ref<LauncherState | null>(null);
const applicationLauncher = ref<ApplicationLauncherState | null>(null);
const applicationError = ref<UiText>('');
const ready = ref(false);
const error = ref<UiText>('');
const message = ref<UiText>('');
const busy = ref(false);
const controller = new AbortController();
const opening = settings.snapshot.sessionId;
const startupFields = computed(() => getSettingsFields(uiLocale.value)
  .filter((field) => field.resourceId === 'autostart'));
const applicationFields = computed(() => getSettingsFields(uiLocale.value)
  .filter((field) => field.resourceId === 'applicationAutostart'));
const applicationAutostartValue = computed(() => {
  settings.snapshot;

  return settings.getValue('applicationAutostart', 'enabled') === true;
});
const applicationFacts = computed(() => applicationLauncher.value ? [{
  label: t('settings.applicationExecutable'),
  value: applicationLauncher.value.executablePath,
}] : []);
const serverDescription = computed(() => shell.profile
  ? t('settings.startupSelectedServerDescription', {
    machine: machineProfileName(shell.profile, uiLocale.value),
  })
  : t('settings.startupServerDescription'));
const serverText = computed(() => serverModeText(server.value, uiLocale));
const release = computed(() => updates.status as ReleaseStatus | null);
const packageCapability = computed(() => {
  const capability = release.value?.updateCapability;

  return capability?.kind === 'package' ? capability : null;
});
const stageLabel = computed(() => {
  const job = release.value?.job;
  const labels = job?.kind === 'package-update' ? PACKAGE_UPDATE_STAGE_LABELS : UPDATE_STAGE_LABELS;

  return (labels as Record<string, string>)[job?.stage ?? ''] || job?.stage;
});
const buildVersion = typeof __GRIGDESK_VERSION__ === 'undefined' ? '—' : __GRIGDESK_VERSION__;
const buildSha = typeof __GRIGDESK_SHA__ === 'undefined' ? '' : __GRIGDESK_SHA__;
const autostartValue = computed(() => {
  settings.snapshot;

  return settings.getValue('autostart', 'enabled') === true;
});
const shortcutPresent = computed(() =>
  applicationLauncher.value?.shortcut.desktop || applicationLauncher.value?.shortcut.menu);
const shortcutLabel = computed(() => {
  const state = applicationLauncher.value?.shortcut;

  return state?.desktop && state.menu ? t('settings.onDesktopAndInApplicationMenu')
    : state?.desktop ? t('settings.onDesktop')
      : state?.menu ? t('settings.inApplicationMenu') : t('settings.notCreated');
});
const uptime = computed(() => {
  const seconds = server.value?.uptimeSec ?? 0;

  return seconds >= 86400 ? t('settings.d', { value1: Math.floor(seconds / 86400) })
    : seconds >= 3600 ? t('settings.h', { value1: Math.floor(seconds / 3600) })
      : seconds >= 60
      ? t('settings.min2', { value1: Math.floor(seconds / 60) }) : t('settings.s', { seconds });
});
const serverFacts = computed(() => server.value ? [
  { label: t('settings.runtimeMode'), value: serverText.value.pill },
  { label: t('settings.uptime'), value: uptime.value },
  { label: t('settings.process'), value: `PID ${server.value.pid}` },
] : []);
const versionFacts = computed(() => {
  const status = release.value;

  if (!status) {
    return [];
  }

  const checkout = [
    status.checkout.version,
    shortSha(status.checkout.sha),
    status.checkout.branch || 'detached HEAD',
  ];
  const latest = status.latest
    ? `${status.latest.tag} · ${shortSha(status.latest.sha)}` : t('settings.noReleasesFoundYet');

  return [
    {
      label: t('settings.versionRunning'),
      value: `${status.running.version} · ${shortSha(status.running.sha)}`,
    },
    {
      label: t('settings.versionCheckout'),
      value: checkout.join(' · ') + (status.checkout.dirty ? ` ${t('settings.hasChanges2')}` : ''),
    },
    { label: t('settings.versionInterface'), value: `${buildVersion} · ${shortSha(buildSha)}` },
    { label: t('settings.versionStable'), value: latest },
    { label: t('settings.versionLastCheck'), value: status.checkedAt || t('settings.notCheckedYet') },
  ];
});
const autostartNote = computed(() => {
  const state = launcher.value?.autostart;

  if (!state || state.unit === 'missing') {
    return t('settings.theSystemdUnitIsNotInstalledAutostart');
  }
  if (state.unit === 'disabled') {
    return t('settings.autostartIsDisabledAfterRebootOpenThe');
  }

  return state.linger === true ? t('settings.theServerStartsWhenTheMachineTurns')
    : state.linger === false ? t('settings.onlyOnLoginEarlierStartupRequiresLoginctl')
      : t('settings.autostartIsEnabledLogindDidNotReport');
});

function current(): boolean {
  return props.active && settings.isOpen && settings.snapshot.sessionId === opening
    && !controller.signal.aborted;
}

function shortSha(sha: string | null | undefined): string {
  return sha?.slice(0, 7) || '—';
}

/**
 * Таймер принадлежит странице и завершается немедленно при её размонтировании.
 * Ожидание не вызывает reload документа и не удерживает фоновую цепочку чтений.
 */
function pause(ms: number): Promise<boolean> {
  if (!current()) {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    const done = (value: boolean) => {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', abort);
      resolve(value);
    };
    const abort = () => done(false);
    const timer = setTimeout(() => done(current()), ms);

    controller.signal.addEventListener('abort', abort, { once: true });
  });
}

async function readServer(): Promise<void> {
  const view = await api.get('/api/system/server', { signal: controller.signal }) as ServerView;

  if (current()) {
    server.value = view;
  }
}

/**
 * Подтверждение получает актуальное число идущих ходов из общего API.
 * Сбой чтения сохраняет прежнюю совместимость ручной операции сервера.
 */
async function activeTurns(): Promise<number> {
  try {
    const result = await api.get('/api/chat/active', { signal: controller.signal }) as { active?: unknown[] };

    return result.active?.length ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Число активных ходов входит в подтверждение перед немедленной операцией.
 * Отказ или позднее согласие закрытой страницы не начинают запрос перезапуска.
 */
async function restart(): Promise<void> {
  if (!current() || busy.value) {
    return;
  }

  busy.value = true;

  try {
    const active = await activeTurns();
    const warning = active
      ? messageRef('settings.agentTurnsAreRunningUnfinishedWorkMay', { active }) : '';
    const text = messageRef('settings.restartTheGrigDeskServer', {
      serverTextValueRestartConfirm: serverRestartMessage(server.value),
      warning,
    });
    const accepted = await confirmDialog(text, {
      danger: active > 0,
      okText: messageRef('settings.restart'),
    });

    if (!accepted || !current()) {
      return;
    }

    try {
      await api.post('/api/system/restart');
    } catch (cause) {
      if (cause instanceof ApiError && cause.status < 500) {
        error.value = failureText(cause);

        return;
      }

      // После принятого POST сервер может уйти раньше доставки ответа.
      // Исход уточняется чтением доступности, повторного POST нет.
    }

    const deadline = Date.now() + 60000;

    while (current() && Date.now() < deadline && await pause(1000)) {
      try {
        await api.get('/api/auth/state', { signal: controller.signal });
        await readServer();
        message.value = messageRef('settings.theServerIsAvailableAgain');

        return;
      } catch {
        // Новое поколение ещё запускается; следующее чтение ограничено сроком ожидания.
      }
    }

    if (current()) {
      error.value = messageRef('settings.theServerDidNotReturnWithinSeconds');
    }
  } finally {
    busy.value = false;
  }
}

/**
 * Ярлык изменяется сразу и не меняет staged-состояние автозапуска.
 * Ответ обновляет только свой раздел снимка после подтверждённой операции.
 */
async function shortcut(): Promise<void> {
  if (!current() || busy.value || !applicationLauncher.value) {
    return;
  }

  busy.value = true;
  applicationError.value = '';

  try {
    const result = decodeApplicationLauncher(await shellAction('POST', '/launcher', {
      shortcut: !shortcutPresent.value,
    }, controller.signal), uiLocale);

    if (current()) {
      const resource = settings.sessionService('application-launcher-resource',
        () => createApplicationLauncherResource(uiLocale));

      resource.accept(result);
      applicationLauncher.value = result;
      message.value = messageRef('settings.shortcutUpdated');
    }
  } catch (cause) {
    if (current()) {
      applicationError.value = failureText(cause);
    }
  } finally {
    busy.value = false;
  }
}

/**
 * Настройки окна читаются через локальную трубу независимо от доступности серверного юнита.
 * Старый клиент показывает причину отсутствия возможности без обращения к серверным ярлыкам.
 */
async function loadApplicationLauncher(): Promise<void> {
  if (!shell.capabilities.includes('applicationLauncher')) {
    return;
  }

  try {
    const resource = settings.sessionService('application-launcher-resource',
      () => createApplicationLauncherResource(uiLocale));

    settings.registerResource(resource.adapter, applicationFields.value);
    await settings.loadResource('applicationAutostart');

    if (current()) {
      applicationLauncher.value = resource.view();
    }
  } catch (cause) {
    if (current()) {
      applicationError.value = failureText(cause);
    }
  }
}

/**
 * Общий update store сохраняет durable job и допуски checkout/release.
 * Подтверждение содержит точную цель; после ответа UI остаётся в том же документе.
 */
async function update(kind: 'apply' | 'update'): Promise<void> {
  const status = release.value;

  if (!status || packageCapability.value || busy.value || updates.actionBusy || !current()
      || (kind === 'apply' ? !status.canApplyCheckout : !status.canInstallRelease)) {
    return;
  }

  busy.value = true;

  try {
    const active = await activeTurns();
    const target = kind === 'apply'
      ? messageRef('settings.checkoutUpdateTarget', {
        value1: status.checkout.branch || 'detached HEAD',
        sha: shortSha(status.checkout.sha),
      })
      : messageRef('settings.release', {
        statusLatestTag: status.latest?.tag,
        value2: shortSha(status.latest?.sha),
      });
    const warning = active ? messageRef('settings.agentTurnsAreRunningTheirWorkMay', { active }) : '';
    const text = messageRef('settings.serverUpdateConfirmation', { target, warning });
    const accepted = await confirmDialog(text, {
      danger: active > 0,
      okText: kind === 'apply' ? messageRef('settings.applyCheckout') : messageRef('settings.update'),
    });

    if (accepted && current()) {
      await (kind === 'apply' ? updates.applyCheckout() : updates.installRelease());
    }
  } finally {
    busy.value = false;
  }
}

/**
 * Пересборка и её опрос относятся к операции, а не к Apply параметров.
 * При возвращении на страницу running снова читается, server-owned job не отменяется.
 */
async function pollRebuild(): Promise<void> {
  const deadline = Date.now() + 12 * 60000;

  error.value = '';
  message.value = '';

  while (current() && Date.now() < deadline) {
    try {
      const result = await api.get('/api/system/web-rebuild', {
        signal: controller.signal,
        retry: false,
      }) as { rebuild?: RebuildView };

      if (!current()) {
        return;
      }
      if (result.rebuild?.status !== 'running') {
        message.value = result.rebuild?.status === 'done'
          ? messageRef('settings.developmentBuildIsReadyTheApplicationInterface')
          : result.rebuild?.status === 'failed'
            ? result.rebuild.error?.message || messageRef('settings.theRebuildFailed')
            : '';

        return;
      }
    } catch {
      // Краткий отказ чтения не отменяет серверную сборку и следующий опрос.
      // Срок всей операции ограничен независимо от количества неудачных GET.
    }

    if (!await pause(2000)) {
      return;
    }
  }

  if (current()) {
    error.value = messageRef('settings.webRebuildTimeout');
  }
}

/**
 * Пересборка требует отдельного согласия и не выполняется при другом действии сервера.
 * Отказ чтения или POST показывается в этой странице без перезагрузки рабочего документа.
 */
async function rebuild(): Promise<void> {
  if (packageCapability.value || busy.value || updates.active || !current()) {
    return;
  }

  busy.value = true;

  try {
    const accepted = await confirmDialog(messageRef('settings.webRebuildConfirmation'), {
      okText: messageRef('settings.rebuild'),
    });

    if (accepted && current()) {
      await api.post('/api/system/web-rebuild');
      await pollRebuild();
    }
  } catch (cause) {
    error.value = failureText(cause);
  } finally {
    busy.value = false;
  }
}

/**
 * Страница читает только свою область; данные соседних разделов не загружаются заранее.
 * Автозапуск использует прежний адаптер этого открытия и его подтверждённый снимок.
 */
async function load(): Promise<void> {
  if (!current()) {
    return;
  }

  try {
    if (settings.pageId === 'system.startup') {
      await loadApplicationLauncher();
      await readServer();

      const resource = settings.sessionService('autostart-resource',
        () => createAutostartResource(api, uiLocale));

      settings.registerResource(resource.adapter, startupFields.value);
      await settings.loadResource('autostart');
      launcher.value = resource.view();
    } else {
      await updates.load();

      if (!packageCapability.value) {
        await pollRebuild();
      }
    }

    ready.value = true;
  } catch (cause) {
    if (current()) {
      error.value = failureText(cause);
    }
  }
}

const unsubscribe = sseSubscribe((name) => {
  if (current() && name === 'hello') {
    void readServer().catch(() => undefined);
  }
});

watch(() => settings.snapshot.lastResult, () => {
  const resource = settings.sessionService('autostart-resource',
    () => createAutostartResource(api, uiLocale));

  launcher.value = resource.view();

  if (shell.capabilities.includes('applicationLauncher')) {
    const application = settings.sessionService('application-launcher-resource',
      () => createApplicationLauncherResource(uiLocale));

    applicationLauncher.value = application.view();
  }
});
watch(() => release.value?.job?.status, (status) => {
  if (status === 'done' && current()) {
    void readServer().catch(() => undefined);
  }
});
watch(() => props.active, load, { immediate: true });
onBeforeUnmount(() => {
  controller.abort();
  unsubscribe();
});
</script>

<style scoped>
.settings-system {
  display: grid;
  gap: 20px;
  align-content: start;
  min-width: 0;
  container: settings-system / inline-size;
}
.settings-system p, .settings-system h4 {
  margin: 0;
}
/* Сообщение о завершённой операции — тихий статус, а не самая яркая строка страницы. */
.settings-system > p[role='status'] {
  color: var(--ink-mid);
  font-size: 12px;
}
.settings-system-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.settings-autostart-note {
  display: grid;
  gap: 6px;
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 1.6;
}
.settings-startup-note {
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 1.6;
}
</style>
