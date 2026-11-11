<template>
  <SettingsSection
    data-vpn-gate
    :heading="t('settings.vpnGateSection')"
    :description="t('settings.vpnGateSectionDescription')"
  >
    <SettingsScope :scope="t('settings.selectedServerComputer')" />
    <p v-if="error" role="alert" data-vpn-gate-error>{{ resolveUiText(error) }}</p>
    <p v-else-if="message" role="status" data-vpn-gate-message>{{ resolveUiText(message) }}</p>
    <p v-if="!view && !error" class="settings-vpn-gate-note">{{ t('settings.loading') }}</p>
    <template v-if="view">
      <UiField :label="t('settings.vpnGateRequire')" :hint="t('settings.vpnGateRequireHint')">
        <UiSwitch
          v-model="draftRequire"
          data-vpn-gate-require
          :disabled="busy"
          :aria-label="t('settings.vpnGateRequire')"
        />
      </UiField>
      <div class="settings-vpn-gate-fields">
        <UiField :label="t('settings.vpnGateIface')" :hint="t('settings.vpnGateIfaceHint')">
          <UiInput
            v-model="draftIface"
            data-vpn-gate-iface
            :disabled="busy"
            :placeholder="t('settings.vpnGateIfacePlaceholder')"
            maxlength="15"
          />
        </UiField>
        <UiField :label="t('settings.vpnGateProbe')" :hint="t('settings.vpnGateProbeHint')">
          <UiInput
            v-model="draftProbe"
            data-vpn-gate-probe
            :disabled="busy"
            :placeholder="view.defaults.probe"
            maxlength="64"
          />
        </UiField>
      </div>
      <SettingsFacts :items="activeFacts" />
      <UiInlineMessage v-if="view.restartRequired" tone="warning" data-vpn-gate-restart>
        {{ t('settings.vpnGateRestartPending') }}
      </UiInlineMessage>
      <UiButton
        data-context="workspace-form-wrap"
        data-vpn-gate-save
        :disabled="busy || !dirty"
        @click="save"
      >
        {{ t('settings.vpnGateSave') }}
      </UiButton>
      <p class="settings-vpn-gate-note">{{ t('settings.vpnGateRestartNote') }}</p>
    </template>
  </SettingsSection>
</template>

<script setup lang="ts">
import {
  t, messageRef, resolveUiText, UiButton, UiField, UiInlineMessage, UiInput, UiSwitch,
} from '../../ui.ts';

import { computed, onBeforeUnmount, ref } from 'vue';
import { api, failureText } from '../../shared/apiClient.ts';
import { decodeVpnGateView } from '../../../../shared/runtime/vpnGateContracts.ts';
import type { VpnGateView } from '../../../../shared/runtime/vpnGateContracts.ts';
import type { UiText } from '../../ui.ts';
import SettingsSection from './SettingsSection.vue';
import SettingsScope from './SettingsScope.vue';
import SettingsFacts from './SettingsFacts.vue';

const view = ref<VpnGateView | null>(null);
const draftRequire = ref(false);
const draftIface = ref('');
const draftProbe = ref('');
const busy = ref(false);
const error = ref<UiText>('');
const message = ref<UiText>('');
const controller = new AbortController();

// Черновик отличается от подтверждённого снимка — кнопка сохранения активна.
const dirty = computed(() => Boolean(view.value)
  && (draftRequire.value !== view.value.requireVpn
    || draftIface.value !== view.value.iface
    || draftProbe.value !== view.value.probe));

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
 * Подтверждённый снимок становится источником и для черновика: после загрузки и
 * сохранения поля показывают ровно то, что вернул сервер, без расхождения с формой.
 */
function adopt(next: VpnGateView): void {
  view.value = next;
  draftRequire.value = next.requireVpn;
  draftIface.value = next.iface;
  draftProbe.value = next.probe;
}

/**
 * Читает настройки ворот один раз при появлении панели на странице запуска.
 * Отмена при закрытии не показывается как ошибка: страница уже ушла.
 */
async function load(): Promise<void> {
  try {
    adopt(decodeVpnGateView(await api.get('/api/system/vpn-gate', { signal: controller.signal })));
  } catch (cause) {
    if (!controller.signal.aborted) {
      error.value = failureText(cause);
    }
  }
}

/**
 * Сохраняет все три поля одним запросом: они описывают одну проверку запуска и
 * по отдельности не имеют смысла. Ответ заменяет снимок целиком.
 */
async function save(): Promise<void> {
  if (!view.value || busy.value) {
    return;
  }

  busy.value = true;
  error.value = '';
  message.value = '';

  try {
    const next = decodeVpnGateView(await api.put('/api/system/vpn-gate', {
      requireVpn: draftRequire.value,
      iface: draftIface.value.trim(),
      probe: draftProbe.value.trim(),
    }, { signal: controller.signal }));

    adopt(next);
    message.value = messageRef('settings.vpnGateSaved');
  } catch (cause) {
    if (!controller.signal.aborted) {
      error.value = failureText(cause);
    }
  } finally {
    busy.value = false;
  }
}

void load();

onBeforeUnmount(() => controller.abort());
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
