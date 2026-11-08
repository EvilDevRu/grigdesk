<template>
  <main class="connections" aria-labelledby="connections-title">
    <header class="connections-navigation">
      <UiButton variant="text" @click="back">
        <template #leading><MachineGlyph name="back" /></template>
        {{ recovery ? t('core.machines') : t('core.returnToWork') }}
      </UiButton>
    </header>
    <div class="connections-scroll">
      <header class="connections-heading">
        <h1 id="connections-title">{{ recovery ? t('core.machineConnectionTitle') : t('core.machines') }}</h1>
        <p>{{ recovery ? t('core.machineConnectionIntro') : t('core.machineChooseIntro') }}</p>
      </header>
      <UiInlineMessage v-if="error" tone="danger">{{ resolveUiText(error) }}</UiInlineMessage>
      <MachineConnection v-if="shell.profile" :recovery="recovery" :busy="busy"
                         @menu="menuProfile = shell.profile"
                         @open="shell.showConnections = false" @connect="connect"
                         @add="adding = true" @unlock="run(() => shell.unlock())"
                         @list="listRequested = true" @address="changeAddress(shell.profile)" />
      <section v-if="shell.status === 'incompatible'" class="connection-versions">
        <p>{{ versionHint }}</p>
        <p>{{ t('core.application2') }} {{ shell.appApi.major }}.{{ shell.appApi.minor }}</p>
        <p v-if="shell.serverApi">{{ t('core.server2') }} {{ shell.serverApi.major }}.{{ shell.serverApi.minor }}</p>
        <UiActionLink v-if="RELEASES_URL" :href="RELEASES_URL" target="_blank">
          {{ t('core.downloadFromGitHub') }}
        </UiActionLink>
      </section>
      <p v-if="!shell.profile && detailText" class="connections-detail" role="status">{{ detailText }}</p>
      <template v-if="!recovery">
        <section v-if="!shell.profiles.length" class="connections-empty">
          <span class="connections-empty-icon"><MachineGlyph name="machine" /></span>
          <h2>{{ t('core.yourComputersWillAppearHere') }}</h2>
          <p>{{ t('core.addAMachineUsingAPairingString') }}</p>
        </section>
        <section v-if="otherProfiles.length" aria-labelledby="other-machines-title">
          <div class="machines-heading">
            <h2 id="other-machines-title">{{ t('core.machineOtherMachines') }}</h2>
            <span>{{ otherProfiles.length }}</span>
          </div>
          <div class="machines-list">
            <article v-for="profile in otherProfiles" :key="profile.id" class="machine-row">
              <UiPressable data-context="machine-choice" :disabled="busy"
                           :aria-label="t('core.machineSelectMachine', {
                             name: machineProfileName(profile, uiLocale),
                           })" @click="select(profile.id)">
                <span class="machine-list-icon"><MachineGlyph name="machine" /></span>
                <span class="machine-list-copy">
                  <strong>{{ machineProfileName(profile, uiLocale) }}</strong>
                  <span>{{ t('core.machineNotSelected') }}</span>
                </span>
              </UiPressable>
              <UiIconButton :label="t('core.machineMachineSettings', {
                              name: machineProfileName(profile, uiLocale),
                            })" :disabled="busy" @click="menuProfile = profile">
                <MachineGlyph name="more" />
              </UiIconButton>
            </article>
          </div>
          <p class="machines-hint">{{ t('core.machineSwitchHint') }}</p>
        </section>
        <div v-if="canAddLocal" class="connections-local">
          <p>{{ t('core.grigdeskIsRunningOnThisDevice') }}</p>
          <UiButton :disabled="busy" @click="run(() => shell.addLocal())">
            {{ t('core.localComputer') }}
          </UiButton>
        </div>
      </template>
    </div>
    <footer class="connections-footer">
      <p v-if="recovery && autoRetry" class="connections-footer-hint">
        {{ t('core.machineAutoReconnect') }}
      </p>
      <UiButton v-else-if="!recovery" block wrap :disabled="busy" @click="adding = true">
        <template #leading><MachineGlyph name="plus" /></template>
        {{ t('core.addMachine') }}
      </UiButton>
    </footer>
    <MachineActionsDialog :open="menuProfile !== null" :profile="menuProfile" :busy="busy"
                          :current="menuProfile?.id === shell.profile?.id"
                          :disconnected="disconnected" @update:open="closeMenu" @action="menuAction" />
    <AddMachineDialog v-model:open="adding" />
    <UpdateRoutesDialog v-if="routeProfile" :open="true" :profile="routeProfile"
                        @update:open="routeProfile = $event ? routeProfile : null" />
  </main>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  UiButton, UiIconButton, UiPressable, UiInlineMessage, UiActionLink,
  confirmDialog, promptDialog, t, uiLocale, messageRef, resolveUiText, type UiText,
} from '../ui.ts';
import {
  RELEASES_URL, connectionDetailText, machineProfileName, type MachineProfile,
} from '../../../shared/client/clientShell.ts';
import { useShellStore } from '../stores/shell.ts';
import { failureText } from '../shared/apiClient.ts';
import UpdateRoutesDialog from '../shared/layout/UpdateRoutesDialog.vue';
import AddMachineDialog from '../shared/layout/AddMachineDialog.vue';
import MachineActionsDialog from '../shared/layout/MachineActionsDialog.vue';
import MachineConnection from '../shared/layout/MachineConnection.vue';
import MachineGlyph from '../shared/layout/MachineGlyph.vue';

const shell = useShellStore();
const adding = ref(false);
const busy = ref(false);
const listRequested = ref(false);
const menuProfile = ref<MachineProfile | null>(null);
const routeProfile = ref<MachineProfile | null>(null);
const error = ref<UiText>('');
let actionProfile: MachineProfile | null = null;

const disconnected = computed(() => typeof shell.detail !== 'string'
  && shell.detail?.code === 'disconnected');
const recovery = computed(() => Boolean(shell.profile) && shell.status !== 'online' && !listRequested.value);
const otherProfiles = computed(() => shell.profiles.filter((profile) => profile.id !== shell.profile?.id));
const canAddLocal = computed(() => shell.localAvailable
  && !shell.profiles.some((profile) => profile.kind === 'local'));
const autoRetry = computed(() => !disconnected.value && ['offline', 'connecting'].includes(shell.status));
const detailText = computed(() => disconnected.value
  ? '' : connectionDetailText(shell.detail, uiLocale.value));
const versionHint = computed(() => {
  const upgradeServer = typeof shell.detail !== 'string'
    && shell.detail?.code === 'server_upgrade_required';
  const version = upgradeServer ? shell.appApi : shell.serverApi || shell.appApi;

  return t('core.requiredVersionAtLeast', {
    value1: upgradeServer ? t('core.server') : t('core.application'),
  }) + `${version.major}.${version.minor}.`;
});

watch(() => shell.profile?.id, () => {
  listRequested.value = false;
  menuProfile.value = null;
  routeProfile.value = null;
});

function back(): void {
  if (recovery.value) {
    listRequested.value = true;

    return;
  }

  shell.showConnections = false;
}

/**
 * Экран подключения остаётся доступным при любом отказе удалённой машины.
 * Ошибка действия показывается рядом со списком без перезагрузки документа.
 */
async function run(work: () => Promise<unknown>): Promise<void> {
  if (busy.value) {
    return;
  }

  busy.value = true;
  error.value = '';

  try {
    await work();
  } catch (failure) {
    error.value = failureText(failure, '') || messageRef('core.couldNotChangeTheConnection');
  } finally {
    busy.value = false;
  }
}

async function connect(): Promise<void> {
  listRequested.value = false;
  await run(() => shell.connect());
}

async function select(id: string): Promise<void> {
  listRequested.value = false;
  await run(() => shell.selectProfile(id));
}

/**
 * Запоминаем профиль до закрытия меню: событие действия приходит следующим.
 * Снимок оболочки может обновиться, но действие остаётся привязано к выбранной машине.
 */
function closeMenu(open: boolean): void {
  if (!open) {
    actionProfile = menuProfile.value;
    menuProfile.value = null;
  }
}

/**
 * Меню делегирует действия владельцу списка и использует общие подтверждения.
 * Идентификатор машины берётся из закрытого меню, а не из текущего профиля после переключения.
 */
async function menuAction(action: string): Promise<void> {
  const profile = actionProfile;

  actionProfile = null;

  if (!profile) {
    return;
  }
  if (action === 'select') {
    await select(profile.id);
  } else if (action === 'disconnect') {
    await run(() => shell.disconnect());
  } else if (action === 'address') {
    await changeAddress(profile);
  } else if (action === 'rename') {
    const name = await promptDialog({
      title: messageRef('core.machineRename'),
      value: profile.name,
    });

    if (name !== null && name.trim()) {
      await run(() => shell.editProfile(profile.id, { name: name.trim() }));
    }
  } else if (action === 'remove') {
    if (await confirmDialog(messageRef('core.deleteMachine', { profileName: profile.name }), {
      danger: true,
      touchTargets: true,
    })) {
      await run(() => shell.removeProfile(profile.id));
    }
  }
}

/**
 * Адрес меняется только у существующего профиля, его pin хранится в оболочке.
 * Оболочка проверяет hello новым адресом до сохранения, отмена не отправляет запрос.
 */
async function changeAddress(profile: MachineProfile | null): Promise<void> {
  if (!profile) {
    return;
  }

  if (shell.capabilities.includes('routeUpdate')) {
    routeProfile.value = profile;

    return;
  }

  const address = await promptDialog({
    title: messageRef('core.changeAddress'),
    value: profile.address,
  });

  if (address !== null) {
    await run(() => shell.editProfile(profile.id, { address }));
  }
}
</script>

<style scoped>
.connections {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 600px;
  height: 100%;
  min-height: 0;
  margin: 0 auto;
  padding: 20px 24px 0;
}

.connections-navigation {
  flex: none;
  margin: 0 0 18px;
}

.connections-scroll {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 26px;
  min-height: 0;
  overflow-y: auto;
  padding: 0 2px 20px;
  scrollbar-width: thin;
}

.connections-heading h1 {
  margin: 0 0 8px;
  font-size: 28px;
  font-weight: 600;
  letter-spacing: -0.5px;
  overflow-wrap: anywhere;
}

.connections-heading p {
  margin: 0;
  color: var(--ink-mid);
  font-size: 13px;
  line-height: 1.7;
}

.machines-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
  color: var(--ink-mid);
}

.machines-heading h2 {
  margin: 0;
  font-size: 11px;
  letter-spacing: 1px;
  font-weight: 600;
  text-transform: uppercase;
}

.machines-heading > span {
  font-size: 12px;
}

.machines-list {
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: var(--sidebar);
}

.machine-row {
  display: flex;
  align-items: center;
  padding-right: 6px;
}

.machine-row + .machine-row {
  border-top: 1px solid var(--line);
}

.machine-list-icon, .connections-empty-icon {
  display: grid;
  place-items: center;
  flex: none;
  width: 44px;
  height: 44px;
  border-radius: 12px;
  background: var(--surface-2);
  color: var(--ink-mid);
}

.machine-list-copy {
  display: grid;
  gap: 5px;
  min-width: 0;
  overflow-wrap: anywhere;
}

.machine-list-copy strong {
  font-size: 14px;
  font-weight: 600;
}

.machine-list-copy > span, .machines-hint {
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 1.7;
}

.machines-hint {
  margin: 12px 3px 0;
}

.connections-empty {
  display: grid;
  justify-items: center;
  gap: 16px;
  padding: 32px 12px;
  text-align: center;
}

.connections-empty-icon {
  width: 64px;
  height: 64px;
  border-radius: 18px;
}

.connections-empty-icon svg {
  width: 32px;
  height: 32px;
}

.connections-empty h2 {
  margin: 0;
  font-size: 17px;
  font-weight: 600;
}

.connections-empty p, .connections-detail, .connections-local p, .connection-versions p {
  margin: 0;
  font-size: 13px;
  line-height: 1.8;
  color: var(--ink-mid);
  overflow-wrap: anywhere;
}

.connection-versions {
  display: grid;
  gap: 8px;
}

.connections-local {
  display: grid;
  gap: 12px;
}

.connections-footer {
  flex: none;
  padding: 16px 0 max(20px, env(safe-area-inset-bottom));
}

.connections-footer-hint {
  margin: 0;
  text-align: center;
  color: var(--ink-mid);
  font-size: 11px;
  line-height: 1.7;
}

@media (max-width: 600px) {
  .connections {
    padding: max(12px, env(safe-area-inset-top)) max(18px, env(safe-area-inset-right)) 0
      max(18px, env(safe-area-inset-left));
  }
}
</style>
