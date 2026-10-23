<template>
  <!-- Монтирование при открытии добавляет Teleport после настроек в body.
       Так общий слой dialog рисуется поверх уже открытого окна. -->
  <UiDialog v-if="phone.open" :open="phone.open" :title="t('settings.connectPhone')"
    @update:open="phone.close()">
    <div data-ui-touch class="phone-connect">
      <strong>{{ phone.status?.name || shell.profile?.name }}</strong>
      <p>{{ t('settings.phoneInstructions') }}</p>
      <p v-if="phone.busy" role="status">{{ t('settings.loadingConnections') }}</p>
      <UiInlineMessage v-if="phone.error || phone.progressError" tone="danger">
        {{ phone.error || phone.progressError }}
      </UiInlineMessage>
      <UiInlineMessage v-if="phone.progress === 'connected'" tone="success">
        {{ t('settings.phoneConnected') }}
      </UiInlineMessage>
      <template v-if="phone.code && phone.seconds > 0">
        <img :src="qrUrl" :alt="t('settings.pairingQRCode')" class="phone-qr" />
        <UiField :label="t('settings.pairingString')">
          <UiTextarea :model-value="phone.code.text" readonly />
        </UiField>
        <p role="status">{{ t('settings.sLeftSingleUse', { seconds: phone.seconds }) }}</p>
        <UiButton @click="phone.copy()">{{ t('settings.phoneCopy') }}</UiButton>
        <p v-if="phone.copied" role="status">{{ t('settings.phoneCopied') }}</p>
      </template>
      <template v-if="phone.progress === 'connected'">
        <UiField :label="t('settings.deviceName')">
          <UiInput v-model="deviceName" maxlength="40" />
        </UiField>
        <UiButton :disabled="!deviceName.trim() || phone.busy" @click="phone.rename(deviceName)">
          {{ t('settings.phoneSave') }}
        </UiButton>
      </template>
      <template v-else-if="phone.status && !phone.busy">
        <p>{{ t('settings.phoneDirect') }}: {{ phone.status.direct.error
          || (phone.status.direct.state === 'online'
            ? t('settings.phoneDirectEnabled') : t('settings.phoneDirectDisabled')) }}</p>
        <UiDisclosureButton v-if="!directAttention" v-model:open="directOpen" :controls="directControls">
          {{ t('settings.phoneDirectSettings') }}
        </UiDisclosureButton>
        <section v-if="directAttention || directOpen" :id="directControls" class="phone-direct">
          <p v-if="loopbackOnly">{{ t('settings.phoneLoopbackOnly') }}</p>
          <p v-if="phone.errorCode === 'choose_address'">{{ t('settings.phoneChooseNetworkHint') }}</p>
          <UiInlineMessage v-if="!phone.status.networks.length" tone="warning">
            {{ t('settings.phoneNoNetworks') }}
            <UiButton variant="text" @click="phone.reload()">
              {{ t('settings.phoneReloadNetworks') }}
            </UiButton>
          </UiInlineMessage>
          <UiField :label="t('settings.phoneNetwork')">
            <UiSelect v-model="network">
              <option value="">{{ t('settings.phoneChooseNetwork') }}</option>
              <option v-for="item in phone.status.networks" :key="item.host || item.address"
                :value="item.host || item.address">
                {{ item.name }} · {{ item.host || item.address }}
              </option>
            </UiSelect>
          </UiField>
          <UiField :label="t('settings.phonePort')">
            <UiNumberInput v-model="port" min="1" max="65535" />
          </UiField>
          <p v-if="narrowsWildcard">{{ t('settings.phoneDirectNarrowWarning') }}</p>
          <div class="phone-direct__actions">
            <UiButton :disabled="!network" @click="phone.enable(network, Number(port))">
              {{ phone.status.direct.state === 'online'
                ? t('settings.phoneApplyDirect') : t('settings.phoneEnable') }}
            </UiButton>
            <UiButton v-if="directConfigured" tone="danger" variant="text" @click="phone.disable()">
              {{ t('settings.phoneDisable') }}
            </UiButton>
          </div>
        </section>
        <template v-if="!phone.code || relayOmitted">
          <p v-if="phone.progress === 'expired'">{{ t('settings.codeExpired') }}</p>
          <UiField :label="t('settings.machineAddressOptional')">
            <UiInput v-model="manual" :placeholder="t('settings.forExampleDeskExample')" />
          </UiField>
          <UiField v-if="phone.status.relays.length > 1" :label="t('settings.phoneRelay')">
            <UiSelect v-model="relayId">
              <option value="">{{ t('settings.phoneChooseRelay') }}</option>
              <option v-for="relay in phone.status.relays" :key="relay.id" :value="relay.id">
                {{ relay.name }}
              </option>
            </UiSelect>
          </UiField>
          <UiButton @click="refreshCode">{{ t('settings.phoneRefresh') }}</UiButton>
        </template>
      </template>
      <UiInlineMessage v-if="relayOmitted && phone.progress !== 'connected'" tone="warning">
        {{ t('settings.phoneRelayOmitted') }}
      </UiInlineMessage>
      <p v-for="relay in phone.status?.relays ?? []" :key="relay.id">
        {{ relay.name }}: {{ relayText(relay) }}
        <span v-if="relayErrorText(relay)"> · {{ relayErrorText(relay) }}</span>
      </p>
      <p v-if="phone.status?.source === 'saved'">{{ t('settings.phoneSavedConfig') }}</p>
      <p>{{ t('settings.phoneReachability') }}</p>
      <UiButton variant="text" @click="configureRelay">{{ t('settings.phoneConfigureRelay') }}</UiButton>
    </div>
    <template #footer>
      <UiButton variant="text" @click="phone.close()">{{ t('settings.close') }}</UiButton>
    </template>
  </UiDialog>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, useId, watch } from 'vue';

import { UiButton, UiDialog, UiDisclosureButton, UiField, UiInput, UiNumberInput, UiSelect,
  UiTextarea, UiInlineMessage, t } from '../../ui.ts';
import { phoneRelayReady, usePhoneAccessStore } from '../../stores/phoneAccess.ts';
import type { PhoneAccessStatus } from '../../stores/phoneAccess.ts';
import { useShellStore } from '../../stores/shell.ts';
import { useSettingsStore } from '../../stores/settings.ts';

const phone = usePhoneAccessStore();
const shell = useShellStore();
const settings = useSettingsStore();
const network = ref('');
const port = ref<number | null>(8145);
const manual = ref('');
const relayId = ref('');
const deviceName = ref('');
const directOpen = ref(false);
const directControls = useId();
const loopbackOnly = computed(() => phone.status?.direct.state === 'online'
  && phone.status.direct.addresses.every((address) => {
    const host = typeof address === 'string' ? address.split(':')[0] : address.host;

    return host === 'localhost' || host?.startsWith('127.') || host === '::1';
  }));
const relayOmitted = computed(() => !!phone.code && (phone.status?.relays.length ?? 0) > 0
  && (phone.code.includedRelayId === null || (phone.code.includedRelayId === undefined
    && !phone.status?.relays.some(phoneRelayReady))));
const boundAddresses = computed(() => (phone.status?.direct.addresses ?? []).map((address) =>
  typeof address === 'string'
    ? { host: address.split(':')[0] ?? '', port: Number(address.split(':').at(-1)) } : address));
const directConfigured = computed(() => phone.status?.direct.enabled === true
  || phone.status?.direct.state === 'online');
const narrowsWildcard = computed(() => phone.status?.direct.state === 'online'
  && boundAddresses.value.some((address) => address.host === '0.0.0.0'));
// Настройка раскрывается сама, когда без неё QR не выдать или вход сломан.
const directAttention = computed(() => phone.status?.direct.state !== 'online' || loopbackOnly.value
  || !phone.status?.networks.length || phone.errorCode === 'choose_address');
const qrUrl = computed(() => `data:image/svg+xml,${encodeURIComponent(phone.code?.svg ?? '')}`);

watch(() => phone.connectedDevice, (device) => deviceName.value = device?.name ?? '');
watch(() => phone.status, (status) => {
  const address = status?.direct.addresses[0];
  const currentPort = typeof address === 'string' ? Number(address.split(':').at(-1)) : address?.port;

  if (currentPort) {
    port.value = currentPort;
  }

  if (status?.networks.length === 1) {
    network.value = status.networks[0]?.host ?? status.networks[0]?.address ?? '';
  }
});
watch(() => phone.open, () => {
  network.value = '';
  manual.value = '';
  relayId.value = '';
  port.value = 8145;
  deviceName.value = '';
  directOpen.value = false;
});

/**
 * Выбор адреса уточняет только маршруты текущего сервера в открытом сценарии.
 * Значения не сохраняются в storage и очищаются при каждом закрытии.
 */
function refreshCode(): void {
  const match = /^([a-z0-9.-]+):(\d+)$/i.exec(manual.value.trim());

  if (manual.value.trim() && !match) {
    phone.error = t('settings.phoneBadAddress');

    return;
  }

  const direct = match ? [{ host: match[1]!.toLowerCase(), port: Number(match[2]) }]
    : servedNetwork(network.value);

  void phone.renew({ ...(direct ? { direct } : {}),
    ...(relayId.value ? { relayId: relayId.value } : {}) });
}

/**
 * Сеть попадает в QR, только если сервер уже слушает её: точным адресом или «на всех сетях».
 * Порт берётся у действующего входа, а не из поля ещё не применённой настройки.
 */
function servedNetwork(host: string): { host: string; port: number }[] | undefined {
  const bound = boundAddresses.value.find((address) => address.host === host || address.host === '0.0.0.0');

  return host && phone.status?.direct.state === 'online' && bound
    ? [{ host, port: bound.port }] : undefined;
}

/**
 * Последняя ошибка связи сервера с ретранслятором — код relayLink, а не текст.
 * Известные коды переводятся, неизвестный показывается как есть без интерпретации.
 */
function relayErrorText(relay: PhoneAccessStatus['relays'][number]): string {
  const lastError = relay.link.lastError;

  if (lastError === 'relay_pin_mismatch') {
    return t('settings.phoneRelayPinMismatch');
  }

  if (lastError === 'relay_disconnected') {
    return t('settings.phoneRelayDisconnected');
  }

  return lastError ?? '';
}

/**
 * Проверка серверного маршрута отделена от действий на телефоне.
 * Причина несовместимости остаётся видимой также при работающем прямом пути.
 */
function relayText(relay: PhoneAccessStatus['relays'][number]): string {
  if (relay.link.state === 'waiting_vpn') {
    return t('settings.phoneServerRelayRoute');
  }

  if (relay.phoneError === 'unsupported_address') {
    return t('settings.phoneRelayAddressUnsupported');
  }

  if (relay.enabled === false || relay.phoneError === 'disabled') {
    return t('settings.phoneRelayDisabled');
  }

  if (relay.link.state === 'connecting') {
    return t('settings.phoneRelayConnecting');
  }

  const compatibility = relay.link.compatibility ?? relay.compatibility;

  if (compatibility === 'unsupported' || relay.phoneError === 'incompatible') {
    return t('settings.phoneRelayUpgrade');
  }

  if (relay.link.state === 'online') {
    return compatibility === 'supported' ? t('settings.phoneRelayReady') : t('settings.phoneRelayChecking');
  }

  return t('settings.phoneRelayOffline');
}

function configureRelay(): void {
  phone.close();
  settings.selectPage('connections.devices');
  settings.requestOpen({ pageId: 'connections.devices', entityId: 'relay' });
}

onBeforeUnmount(phone.close);
</script>

<style scoped>
.phone-connect {
  display: grid;
  gap: 12px;
  min-width: 0;
  overflow-wrap: anywhere;
}
.phone-connect p {
  margin: 0;
}
.phone-direct {
  display: grid;
  gap: 8px;
}
.phone-direct__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.phone-qr {
  display: block;
  width: min(100%, 320px);
  margin: auto;
}
</style>
