<template>
  <section
    class="settings-system"
    :data-system-page="settings.pageId"
    :data-ready="ready"
  >
    <p v-if="error" role="alert">{{ resolveUiText(error) }}</p>
    <p v-if="message" role="status">{{ resolveUiText(message) }}</p>
    <template v-if="settings.pageId === 'system.startup'">
      <SettingsSection :heading="t('settings.sectionGrigdeskProcess')" :description="t('settings.currentServerStatusOnThisMachine')">
        <dl v-if="server" class="settings-system-facts">
          <div><dt>{{ t('settings.runtimeMode') }}</dt><dd>{{ serverText.pill }}</dd></div>
          <div><dt>{{ t('settings.uptime') }}</dt><dd>{{ uptime }}</dd></div>
          <div><dt>{{ t('settings.process') }}</dt><dd>PID {{ server.pid }}</dd></div>
        </dl>
        <p v-if="serverText.hint">{{ serverText.hint }}</p>
        <UiButton :disabled="busy || !server" @click="restart">{{ t('settings.restartServer') }}</UiButton>
      </SettingsSection>
      <SettingsSection :heading="t('settings.sectionAutomaticStartup')">
        <SettingsScope :scope="t('settings.thisMachine')">
          {{ t('settings.autostartIsSavedWithApplyTheLive') }}
        </SettingsScope>
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
      </SettingsSection>
      <template v-if="launcher">
        <SettingsSection
          :heading="t('settings.sectionApplicationShortcut')"
          :description="t('settings.quickAccessFromTheDesktopAndApplication')"
        >
          <p>{{ t('settings.shortcut') }} {{ shortcutLabel }}</p>
          <UiButton :disabled="busy || (!shortcutPresent && !launcher.shortcut.desktopDir)" @click="shortcut">
            {{ shortcutPresent ? t('settings.removeShortcut') : t('settings.createShortcut') }}
          </UiButton>
        </SettingsSection>
      </template>
    </template>
    <template v-else>
      <SettingsSection
        :heading="t('settings.sectionGrigdeskVersion')"
        :description="t('settings.installedVersionStableChannelAndUpdateCheck')"
      >
        <PackagedServerVersion
          v-if="packageCapability"
          :version="release?.running.version || '—'"
          :client-version="buildVersion"
          :message="packageCapability.message"
        />
        <template v-else-if="release">
          <p>{{ t('settings.running2') }} {{ release.running.version }} · {{ shortSha(release.running.sha) }}</p>
          <p>
            {{ t('settings.checkoutLabel') }} {{ release.checkout.version }} · {{ shortSha(release.checkout.sha) }} ·
            {{ release.checkout.branch || 'detached HEAD' }}
            <span v-if="release.checkout.dirty">{{ t('settings.hasChanges2') }}</span>
          </p>
          <p>{{ t('settings.applicationInterface') }} {{ buildVersion }} · {{ shortSha(buildSha) }}</p>
          <p v-if="release.latest">
            {{ t('settings.stableChannel') }} {{ release.latest.tag }} · {{ shortSha(release.latest.sha) }}
            <UiActionLink
              v-if="release.latest.url"
              :href="release.latest.url"
              target="_blank"
            >
              {{ t('settings.whatSChanged') }}
            </UiActionLink>
          </p>
          <p v-else>{{ t('settings.noReleasesFoundYet') }}</p>
          <p>{{ t('settings.lastCheck') }} {{ release.checkedAt || t('settings.notCheckedYet') }}</p>
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
            <UiButton :disabled="updates.checking || updates.active || busy" @click="updates.check()">
              {{ t('settings.checkForUpdates') }}
            </UiButton>
            <UiButton
              :disabled="!release.canApplyCheckout || updates.actionBusy || busy"
              @click="update('apply')"
            >
              {{ t('settings.applyLocalChanges') }}
            </UiButton>
            <UiButton
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
        <p v-if="updates.error" role="alert">{{ updates.error }}</p>
      </SettingsSection>
      <SettingsSection v-if="!packageCapability" :heading="t('settings.sectionInterfaceBuild')">
        <UiButton :disabled="busy || updates.active" @click="rebuild">{{ t('settings.rebuildWebBundle') }}</UiButton>
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
import { blockReasonLabel, UPDATE_STAGE_LABELS } from '../../../shared/grigdeskUpdate.ts';
import { getSettingsFields } from '../../../features/settings/catalog.ts';
import { createAutostartResource } from '../../../features/settings/resources/startup.ts';
import { sseSubscribe } from '../../../composables/useSse.ts';
import type { LauncherState } from '../../../../../shared/runtime/launcherContracts.ts';
import type { ReleaseStatus } from '../../../../../shared/runtime/grigDeskUpdateContracts.ts';
import SettingsField from '../SettingsField.vue';
import PackagedServerVersion from '../PackagedServerVersion.vue';

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
const server = ref<ServerView | null>(null);
const launcher = ref<LauncherState | null>(null);
const ready = ref(false);
const error = ref<UiText>('');
const message = ref<UiText>('');
const busy = ref(false);
const controller = new AbortController();
const opening = settings.snapshot.sessionId;
const startupFields = computed(() => getSettingsFields(uiLocale.value)
  .filter((field) => field.resourceId === 'autostart'));
const serverText = computed(() => serverModeText(server.value, uiLocale));
const release = computed(() => updates.status as ReleaseStatus | null);
const packageCapability = computed(() => {
  const capability = release.value?.updateCapability;

  return capability?.kind === 'package' ? capability : null;
});
const stageLabel = computed(() =>
  (UPDATE_STAGE_LABELS as Record<string, string>)[release.value?.job?.stage ?? '']
  || release.value?.job?.stage);
const buildVersion = typeof __GRIGDESK_VERSION__ === 'undefined' ? '—' : __GRIGDESK_VERSION__;
const buildSha = typeof __GRIGDESK_SHA__ === 'undefined' ? '' : __GRIGDESK_SHA__;
const autostartValue = computed(() => {
  settings.snapshot;

  return settings.getValue('autostart', 'enabled') === true;
});
const shortcutPresent = computed(() => launcher.value?.shortcut.desktop || launcher.value?.shortcut.menu);
const shortcutLabel = computed(() => launcher.value?.shortcut.desktop && launcher.value.shortcut.menu
  ? t('settings.onDesktopAndInApplicationMenu') : launcher.value?.shortcut.desktop ? t('settings.onDesktop')
    : launcher.value?.shortcut.menu ? t('settings.inApplicationMenu') : t('settings.notCreated'));
const uptime = computed(() => {
  const seconds = server.value?.uptimeSec ?? 0;

  return seconds >= 86400 ? t('settings.d', { value1: Math.floor(seconds / 86400) })
    : seconds >= 3600 ? t('settings.h', { value1: Math.floor(seconds / 3600) })
      : seconds >= 60
      ? t('settings.min2', { value1: Math.floor(seconds / 60) }) : t('settings.s', { seconds });
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
  if (busy.value || !launcher.value) {
    return;
  }

  busy.value = true;

  try {
    const result = await (shortcutPresent.value ? api.del('/api/system/launcher/shortcut')
      : api.post('/api/system/launcher/shortcut')) as { shortcut: LauncherState['shortcut'] };

    if (current()) {
      launcher.value = { ...launcher.value, shortcut: result.shortcut };
      message.value = messageRef('settings.shortcutUpdated');
    }
  } catch (cause) {
    error.value = failureText(cause);
  } finally {
    busy.value = false;
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
            : messageRef('settings.noRebuildIsRunning');

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
  gap: 28px;
  align-content: start;
  min-width: 0;
}
.settings-system p, .settings-system h4 {
  margin: 0;
}
.settings-system-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.settings-system-facts {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
  width: 100%;
  margin: 0 0 4px;
}
.settings-system-facts > div {
  display: grid;
  gap: 7px;
  align-content: start;
}
.settings-system-facts dt {
  color: var(--ink-mid);
  font-size: 11px;
}
.settings-system-facts dd {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
}
.settings-autostart-note {
  display: grid;
  gap: 6px;
  color: var(--ink-mid);
  font-size: 11px;
  line-height: 1.6;
}
@media (max-width: 600px) {
  .settings-system-facts {
    grid-template-columns: minmax(0, 1fr);
    gap: 12px;
  }
  .settings-system-facts > div {
    grid-template-columns: 110px minmax(0, 1fr);
    gap: 12px;
  }
}
</style>
