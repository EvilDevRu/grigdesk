<template>
  <SettingsSection
    data-vpn-gate
    :heading="t('settings.vpnGateSection')"
    :description="t('settings.vpnGateSectionDescription')"
  >
    <SettingsScope :scope="t('settings.selectedServerComputer')" />
    <p v-if="error" role="alert" data-vpn-gate-error>{{ resolveUiText(error) }}</p>
    <p v-if="!view && !error" class="settings-vpn-gate-note">{{ t('settings.loading') }}</p>
    <template v-if="view">
      <SettingsField :address="fields[0]!.address" layout="stack">
        <UiSwitch
          v-model="draftRequire"
          data-vpn-gate-require
          :disabled="busy"
          :aria-label="t('settings.vpnGateRequire')"
        />
      </SettingsField>
      <div class="settings-vpn-gate-fields">
        <SettingsField :address="fields[1]!.address" layout="stack">
          <UiInput
            v-model="draftIface"
            data-vpn-gate-iface
            :disabled="busy"
            :placeholder="t('settings.vpnGateIfacePlaceholder')"
            maxlength="15"
          />
        </SettingsField>
        <SettingsField :address="fields[2]!.address" layout="stack">
          <UiInput
            v-model="draftProbe"
            data-vpn-gate-probe
            :disabled="busy"
            :placeholder="view.defaults.probe"
            maxlength="64"
          />
        </SettingsField>
      </div>
      <SettingsFacts :items="activeFacts" />
      <UiInlineMessage v-if="view.restartRequired" tone="warning" data-vpn-gate-restart>
        {{ t('settings.vpnGateRestartPending') }}
      </UiInlineMessage>
      <p class="settings-vpn-gate-note">{{ t('settings.vpnGateRestartNote') }}</p>
    </template>
  </SettingsSection>
</template>

<script setup lang="ts">
import {
  t, uiLocale, resolveUiText, UiInlineMessage, UiInput, UiSwitch,
} from '../../ui.ts';

import { computed, ref } from 'vue';
import { api, failureText } from '../../shared/apiClient.ts';
import { useSettingsStore } from '../../stores/settings.ts';
import { getSettingsFields } from '../../features/settings/catalog.ts';
import { createVpnGateResource } from '../../features/settings/resources/vpnGate.ts';
import SettingsField from './SettingsField.vue';
import type { UiText } from '../../ui.ts';
import SettingsSection from './SettingsSection.vue';
import SettingsScope from './SettingsScope.vue';
import SettingsFacts from './SettingsFacts.vue';

const settings = useSettingsStore();
const resource = settings.sessionService('vpn-gate-resource', () => createVpnGateResource(api));
const fields = computed(() => getSettingsFields(uiLocale.value)
  .filter((field) => field.resourceId === 'vpnGate'));
const error = ref<UiText>('');
const opening = settings.snapshot.sessionId;
const view = computed(() => {
  settings.snapshot;

  return resource.view();
});
const busy = computed(() => settings.snapshot.applying || settings.actionRunning);
const draftRequire = computed({
  get: () => {
    settings.snapshot;

    return settings.getValue('vpnGate', 'requireVpn') === true;
  },
  set: (value: boolean) => settings.setField('vpnGate', 'requireVpn', value),
});
const draftIface = computed({
  get: () => {
    settings.snapshot;

    return String(settings.getValue('vpnGate', 'iface') ?? '');
  },
  set: (value: string) => settings.setField('vpnGate', 'iface', value),
});
const draftProbe = computed({
  get: () => {
    settings.snapshot;

    return String(settings.getValue('vpnGate', 'probe') ?? '');
  },
  set: (value: string) => settings.setField('vpnGate', 'probe', value),
});

// Действующие значения показывают, с чем сервер уже работает, а не что сохранено.
const activeFacts = computed(() => {
  if (!view.value) {
    return [];
  }

  return [
    {
      label: t('settings.vpnGateActiveRequire'),
      value: view.value.active.requireVpn
        ? t('settings.vpnGateOn')
        : t('settings.vpnGateOff'),
    },
    ...(view.value.active.iface
      ? [{ label: t('settings.vpnGateActiveIface'), value: view.value.active.iface }]
      : []),
  ];
});

/**
 * Панель использует ресурс общей сессии: повторный вход сохраняет черновик.
 * Ответ закрытого окна не переносит ошибку в новое открытие настроек.
 */
async function load(): Promise<void> {
  try {
    settings.registerResource(resource.adapter, fields.value);
    await settings.loadResource('vpnGate');
  } catch (cause) {
    if (settings.snapshot.sessionId === opening && settings.snapshot.active) {
      error.value = failureText(cause);
    }
  }
}

void load();
</script>

<style scoped>
.settings-vpn-gate-fields {
  display: grid;
  gap: 12px;
}

.settings-vpn-gate-note {
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 1.6;
}

@media (min-width: 640px) {
  .settings-vpn-gate-fields {
    grid-template-columns: minmax(0, 240px) minmax(0, 240px);
  }
}
</style>
