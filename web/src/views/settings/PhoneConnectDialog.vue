<template>
  <!-- Монтирование при открытии добавляет Teleport после настроек в body.
       Так общий слой dialog рисуется поверх уже открытого окна. -->
  <UiDialog v-if="phone.open" :open="phone.open" :title="t('settings.connectPhone')"
    data-role="phone-connect" data-ui-touch class="phone-connect" @update:open="phone.close()">
    <div class="phone-connect__content">
      <div class="phone-connect__intro">
        <div class="phone-connect__server">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
            aria-hidden="true">
            <rect x="3" y="4" width="18" height="12" rx="2" />
            <path d="M8 20h8m-4-4v4" />
          </svg>
          <strong>{{ phone.status?.name || shell.profile?.name }}</strong>
        </div>
        <p>{{ t('settings.phoneInstructions') }}</p>
      </div>
      <UiInlineMessage v-if="phone.error || phone.progressError" tone="danger">
        {{ phone.error || phone.progressError }}
      </UiInlineMessage>
      <div class="phone-connect__workspace">
        <section class="phone-code" :aria-label="t('settings.phoneCodeTitle')"
          :aria-busy="phone.busy || undefined">
          <h3>{{ t('settings.phoneCodeTitle') }}</h3>
          <template v-if="phone.progress === 'connected'">
            <div class="phone-code__stage phone-code__success">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
                aria-hidden="true">
                <circle cx="12" cy="12" r="9" />
                <path d="m8 12 3 3 5-6" />
              </svg>
              <p role="status">{{ t('settings.phoneConnected') }}</p>
            </div>
            <UiField :label="t('settings.deviceName')">
              <UiInput v-model="deviceName" maxlength="40" :disabled="phone.busy" />
            </UiField>
            <UiButton :disabled="!deviceName.trim()" :loading="phone.busy" @click="phone.rename(deviceName)">
              {{ t('settings.phoneSave') }}
            </UiButton>
          </template>
          <template v-else>
            <div class="phone-code__stage">
              <div v-if="phone.busy" class="phone-code__placeholder" role="status">
                <UiSpinner role="large" decorative />
                <p>{{ t('settings.loadingConnections') }}</p>
              </div>
              <img v-else-if="phone.code && phone.seconds > 0" :src="qrUrl"
                :alt="t('settings.pairingQRCode')" class="phone-qr" />
              <div v-else class="phone-code__placeholder">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"
                  aria-hidden="true">
                  <path d="M9 3H3v6m12-6h6v6M3 15v6h6m12-6v6h-6" />
                  <path d="M7 7h3v3H7zm7 0h3v3h-3zM7 14h3v3H7zm7 0h3v3h-3z" />
                </svg>
                <p>{{ phone.progress === 'expired'
                  ? t('settings.codeExpired') : t('settings.phoneCodeNeedsAccess') }}</p>
              </div>
            </div>
            <template v-if="phone.code && phone.seconds > 0 && !phone.busy">
              <p class="phone-code__expiry">
                {{ t('settings.sLeftSingleUse', { seconds: phone.seconds }) }}
              </p>
              <UiField :label="t('settings.pairingString')">
                <UiTextarea :model-value="phone.code.text" readonly rows="3" spellcheck="false" />
              </UiField>
              <UiButton @click="phone.copy()">
                {{ phone.copied ? t('settings.phoneCopied') : t('settings.phoneCopy') }}
              </UiButton>
              <span class="ui-visually-hidden" role="status">
                {{ phone.copied ? t('settings.phoneCopied') : '' }}
              </span>
            </template>
            <UiButton v-if="!phone.status && !phone.busy" @click="phone.start()">
              {{ t('settings.phoneReloadNetworks') }}
            </UiButton>
          </template>
        </section>

        <div class="phone-connect__access">
          <section v-if="!phone.status && phone.busy" class="phone-connect__section phone-connect__loading"
            role="status" aria-busy="true">
            <UiSpinner decorative />
            <p>{{ t('settings.loadingConnections') }}</p>
          </section>
          <template v-if="phone.status && phone.progress !== 'connected'">
            <section class="phone-connect__section">
              <h3>{{ t('settings.phoneDirect') }}</h3>
              <p>{{ phone.status.direct.error || (phone.status.direct.state === 'online'
                ? t('settings.phoneDirectEnabled') : t('settings.phoneDirectDisabled')) }}</p>
              <UiDisclosureButton v-if="!directAttention" v-model:open="directOpen" :controls="directControls">
                {{ t('settings.phoneDirectSettings') }}
              </UiDisclosureButton>
              <div v-if="directAttention || directOpen" :id="directControls" class="phone-direct">
                <p v-if="loopbackOnly">{{ t('settings.phoneLoopbackOnly') }}</p>
                <p v-if="phone.errorCode === 'choose_address'">{{ t('settings.phoneChooseNetworkHint') }}</p>
                <UiInlineMessage v-if="!phone.status.networks.length" tone="warning">
                  {{ t('settings.phoneNoNetworks') }}
                  <UiButton variant="text" :disabled="phone.busy" @click="phone.reload()">
                    {{ t('settings.phoneReloadNetworks') }}
                  </UiButton>
                </UiInlineMessage>
                <div class="phone-direct__fields">
                  <UiField :label="t('settings.phoneNetwork')">
                    <UiSelect v-model="network" :disabled="phone.busy">
                      <option value="">{{ t('settings.phoneChooseNetwork') }}</option>
                      <option v-for="item in phone.status.networks" :key="item.host || item.address"
                        :value="item.host || item.address">
                        {{ item.name }} · {{ item.host || item.address }}
                      </option>
                    </UiSelect>
                  </UiField>
                  <UiField :label="t('settings.phonePort')">
                    <UiNumberInput v-model="port" min="1" max="65535" :disabled="phone.busy" />
                  </UiField>
                </div>
                <p v-if="narrowsWildcard">{{ t('settings.phoneDirectNarrowWarning') }}</p>
                <div class="phone-direct__actions">
                  <UiButton tone="accent" :disabled="!network || phone.busy"
                    @click="phone.enable(network, Number(port))">
                    {{ phone.status.direct.state === 'online'
                      ? t('settings.phoneApplyDirect') : t('settings.phoneEnable') }}
                  </UiButton>
                  <UiButton v-if="directConfigured" tone="danger" variant="text" :disabled="phone.busy"
                    @click="phone.disable()">
                    {{ t('settings.phoneDisable') }}
                  </UiButton>
                </div>
              </div>
            </section>
          </template>
          <section v-if="phone.status?.relays.length" class="phone-connect__section">
            <h3>{{ t('settings.phoneRelay') }}</h3>
            <UiInlineMessage v-if="relayOmitted && phone.progress !== 'connected'" tone="warning">
              {{ t('settings.phoneRelayOmitted') }}
            </UiInlineMessage>
            <div v-for="relay in phone.status.relays" :key="relay.id" class="phone-relay">
              <strong>{{ relay.name }}</strong>
              <div class="phone-relay__status" :aria-busy="relayPending(relay) || undefined">
                <UiSpinner v-if="relayPending(relay)" decorative />
                <p>
                  {{ relayText(relay) }}
                  <span v-if="relayErrorText(relay)"> · {{ relayErrorText(relay) }}</span>
                </p>
              </div>
            </div>
          </section>
          <section v-if="phone.status && phone.progress !== 'connected' && (!phone.code || relayOmitted)"
            class="phone-connect__section">
            <h3>{{ t('settings.phoneCodeAddress') }}</h3>
            <UiField :label="t('settings.machineAddressOptional')">
              <UiInput v-model="manual" :placeholder="t('settings.forExampleDeskExample')"
                :disabled="phone.busy" />
            </UiField>
            <UiField v-if="phone.status.relays.length > 1" :label="t('settings.phoneRelay')">
              <UiSelect v-model="relayId" :disabled="phone.busy">
                <option value="">{{ t('settings.phoneChooseRelay') }}</option>
                <option v-for="relay in phone.status.relays" :key="relay.id" :value="relay.id">
                  {{ relay.name }}
                </option>
              </UiSelect>
            </UiField>
            <UiButton :disabled="phone.busy" @click="refreshCode">{{ t('settings.phoneRefresh') }}</UiButton>
          </section>
          <div class="phone-connect__notes">
            <p v-if="phone.status?.source === 'saved'">{{ t('settings.phoneSavedConfig') }}</p>
            <p>{{ t('settings.phoneReachability') }}</p>
          </div>
        </div>
      </div>
    </div>
    <template #footer>
      <div class="phone-connect__footer">
        <UiButton variant="link" @click="configureRelay">{{ t('settings.phoneConfigureRelay') }}</UiButton>
        <UiButton variant="text" @click="phone.close()">{{ t('settings.close') }}</UiButton>
      </div>
    </template>
  </UiDialog>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, useId, watch } from 'vue';

import { UiButton, UiDialog, UiDisclosureButton, UiField, UiInput, UiNumberInput, UiSelect,
  UiTextarea, UiInlineMessage, UiSpinner, t } from '../../ui.ts';
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
 * Индикатор нужен только во время подключения или проверки совместимости.
 * Выключенный, несовместимый или недоступный маршрут не изображает вечную загрузку.
 */
function relayPending(relay: PhoneAccessStatus['relays'][number]): boolean {
  const compatibility = relay.link.compatibility ?? relay.compatibility;
  const unavailable = relay.enabled === false || relay.phoneError === 'disabled'
    || relay.phoneError === 'unsupported_address' || relay.phoneError === 'incompatible'
    || compatibility === 'unsupported';

  return !unavailable && (relay.link.state === 'connecting'
    || (relay.link.state === 'online' && compatibility !== 'supported'));
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

/**
 * Переход закрывает секретный код и открывает настройки того же выбранного сервера.
 * Повторное открытие снова адресует раздел ретрансляторов.
 */
function configureRelay(): void {
  phone.close();
  settings.selectPage('connections.devices');
  settings.requestOpen({ pageId: 'connections.devices', entityId: 'relay' });
}

onBeforeUnmount(phone.close);
</script>

<style scoped>
.phone-connect__content {
  display: grid;
  gap: 20px;
  min-width: 0;
  overflow-wrap: anywhere;
  font-size: 13px;
  line-height: 1.5;
}
.phone-connect p,
.phone-connect h3 {
  margin: 0;
}
.phone-connect h3 {
  color: var(--ink);
  font-size: 13px;
  font-weight: 600;
}
.phone-connect__intro {
  display: grid;
  gap: 10px;
  color: var(--ink-mid);
}
.phone-connect__server {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--ink);
}
.phone-connect__server svg {
  flex: none;
  width: 22px;
  height: 22px;
  color: var(--accent);
}
.phone-connect__workspace {
  display: grid;
  grid-template-columns: 248px minmax(0, 1fr);
  align-items: start;
  gap: 24px;
}
.phone-code,
.phone-connect__access,
.phone-connect__section,
.phone-direct,
.phone-connect__notes {
  display: grid;
  gap: 12px;
  min-width: 0;
}
.phone-code {
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--ground);
}
.phone-code__stage {
  display: grid;
  place-items: center;
  width: 100%;
  aspect-ratio: 1;
  overflow: hidden;
  border-radius: var(--radius);
}
.phone-code__placeholder,
.phone-code__success {
  display: grid;
  align-content: center;
  justify-items: center;
  gap: 16px;
  color: var(--ink-mid);
  text-align: center;
}
.phone-code__placeholder svg,
.phone-code__success svg {
  width: 40px;
  height: 40px;
}
.phone-code__success {
  color: var(--good);
}
.phone-code__expiry {
  min-height: 18px;
  color: var(--ink-mid);
  font-size: 12px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}
.phone-connect__access {
  gap: 20px;
}
.phone-connect__section + .phone-connect__section {
  padding-top: 16px;
  border-top: 1px solid var(--line);
}
.phone-connect__section > p,
.phone-direct > p,
.phone-relay__status {
  color: var(--ink-mid);
}
.phone-connect__loading,
.phone-relay__status {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.phone-relay {
  display: grid;
  gap: 4px;
}
.phone-direct__fields {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 100px;
  align-items: end;
  gap: 10px;
}
.phone-direct__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.phone-connect__notes {
  color: var(--ink-dim);
  font-size: 12px;
}
.phone-connect__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
  width: 100%;
}
.phone-qr {
  display: block;
  width: 100%;
  height: 100%;
  padding: 10px;
  background: #fff;
  object-fit: contain;
}
@media (max-width: 720px) {
  .phone-connect__workspace {
    grid-template-columns: minmax(0, 1fr);
    gap: 20px;
  }
  .phone-code {
    width: min(100%, 320px);
    justify-self: center;
  }
}
</style>
