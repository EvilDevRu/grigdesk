<template>
  <section
    class="mobile-access"
    data-ui-touch
    aria-labelledby="mobile-access-title"
    :aria-busy="loading"
  >
    <header class="mobile-heading">
      <span class="mobile-icon" aria-hidden="true">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
        >
          <rect
            x="6"
            y="2"
            width="12"
            height="20"
            rx="3"
          />
          <path d="M10 5h4M10 19h4" />
        </svg>
      </span>
      <div>
        <h3 id="mobile-access-title">Приложение на телефоне</h3>
        <p>Подключите телефон по QR-коду, чтобы пользоваться GrigDesk в приложении.</p>
      </div>
      <span class="mobile-loading-indicator">
        <UiSpinner v-if="loading" label="Загружаем подключения" />
      </span>
    </header>
    <UiInlineMessage v-if="error || loadError" tone="danger">
      {{ error || loadError }}
      <UiButton
        v-if="loadError"
        variant="text"
        :disabled="loading"
        @click="load"
      >
        Повторить загрузку
      </UiButton>
    </UiInlineMessage>
    <UiInlineMessage v-if="status && !status.server.up" tone="warning">
      {{ status.server.error || 'Мобильный доступ ещё не запущен.' }}
    </UiInlineMessage>
    <section class="mobile-card" aria-labelledby="mobile-relays-title">
      <header class="mobile-card-head">
        <div>
          <h4 id="mobile-relays-title">Подключение через посредника</h4>
          <p>Выберите, через какой адрес телефон будет подключаться к этому GrigDesk.</p>
        </div>
        <UiButton
          data-role="settings-action"
          data-testid="mobile-open-add"
          :disabled="busy || !status"
          @click="openAdd"
        >
          Добавить посредника
        </UiButton>
      </header>
      <div
        v-if="!status"
        class="mobile-relays mobile-skeleton"
        :class="{ 'is-loading': loading }"
        aria-hidden="true"
      >
        <div class="mobile-relay">
          <div class="mobile-relay-summary">
            <div class="mobile-identity">
              <span class="mobile-skeleton-line mobile-skeleton-name" />
              <span class="mobile-skeleton-line mobile-skeleton-address" />
            </div>
            <span class="mobile-skeleton-button mobile-connect" />
            <span class="mobile-skeleton-button mobile-skeleton-icon mobile-relay-settings" />
          </div>
        </div>
      </div>
      <div v-else-if="!status.relays.length" class="mobile-empty">
        <b>Сначала добавьте посредника</b>
        <p>Укажите его адрес, скачайте настройки и запустите. Затем здесь появится QR для телефона.</p>
      </div>
      <div v-else class="mobile-relays">
        <article
          v-for="relay in status.relays"
          :key="relay.id"
          class="mobile-relay"
        >
          <div class="mobile-relay-summary">
            <div class="mobile-identity">
              <div class="mobile-name-line">
                <b>{{ relay.name }}</b>
                <span class="mobile-badge" :data-state="relay.link.state">
                  <span class="mobile-status-dot" aria-hidden="true" />
                  {{ linkLabel(relay.link) }}
                </span>
              </div>
              <span class="mobile-address">{{ relay.host }}:{{ relay.port }}</span>
            </div>
            <UiButton
              class="mobile-connect"
              data-role="settings-action"
              data-testid="mobile-phone-qr"
              variant="solid"
              tone="accent"
              :disabled="busy || !status.server.up"
              @click="showQr(relay, true)"
            >
              Подключить телефон
            </UiButton>
            <UiIconButton
              v-tooltip="'Настройки посредника'"
              class="mobile-relay-settings"
              :label="`Настройки посредника «${relay.name}»`"
              :tone="expandedRelay === relay.id ? 'accent' : 'neutral'"
              :aria-expanded="expandedRelay === relay.id"
              :aria-controls="`mobile-relay-${relay.id}`"
              @click="expandedRelay = expandedRelay === relay.id ? '' : relay.id"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.6"
                aria-hidden="true"
              >
                <path
                  d="m10 3-.6 2.2-2 .9-2.1-.6-2 3.5 1.6 1.6v2.8L3.3 15l2 3.5 2.1-.6 2 .9L10 21h4
                     l.6-2.2 2-.9 2.1.6 2-3.5-1.6-1.6v-2.8L20.7 9l-2-3.5-2.1.6-2-.9L14 3Z"
                />
                <circle
                  cx="12"
                  cy="12"
                  r="3"
                />
              </svg>
            </UiIconButton>
          </div>
          <p v-if="relay.link.state !== 'online'" class="mobile-connection-note">
            {{ relay.link.lastError || 'Для привязки телефона посредник должен быть в сети.' }}
          </p>
          <div
            v-if="expandedRelay === relay.id"
            :id="`mobile-relay-${relay.id}`"
            class="mobile-relay-setup"
          >
            <div class="mobile-row">
              <div class="mobile-identity">
                <b>Уже привязали телефон?</b>
                <p>Добавьте этот адрес в приложении как ещё один способ подключения.</p>
              </div>
              <UiButton
                data-role="settings-action"
                :disabled="busy"
                @click="showQr(relay, false)"
              >
                QR посредника
              </UiButton>
            </div>
            <div class="mobile-row">
              <div class="mobile-identity">
                <b>Установка посредника</b>
                <p>Скачайте файл настроек для запуска на выбранном сервере.</p>
              </div>
              <UiButton
                data-role="settings-action"
                :disabled="busy"
                @click="downloadEnv(relay.id)"
              >
                Скачать relay.env
              </UiButton>
            </div>
            <div
              v-if="created === relay.id"
              class="mobile-install"
              role="status"
            >
              <p>Сохраните relay.env в приватный каталог вне проекта с правами 0600 и запустите:</p>
              <pre>RELAY_ENV_FILE=/путь/вне-проекта/relay.env docker compose up -d --build
docker compose ps</pre>
              <p>Когда появится статус «В сети», нажмите «Подключить телефон».</p>
            </div>
            <div class="mobile-relay-remove">
              <UiButton
                data-role="settings-action"
                variant="ghost"
                tone="danger"
                :disabled="busy"
                @click="removeRelay(relay)"
              >
                Удалить посредника
              </UiButton>
            </div>
          </div>
        </article>
      </div>
    </section>
    <section class="mobile-card" aria-labelledby="mobile-devices-title">
      <header class="mobile-card-head">
        <div>
          <h4 id="mobile-devices-title">
            Привязанные телефоны
            <span class="mobile-count">{{ status ? activeDevices.length : '—' }}</span>
          </h4>
          <p>Устройства, которым разрешён доступ к этому GrigDesk.</p>
        </div>
      </header>
      <div class="mobile-device-list">
        <div
          v-if="!status"
          class="mobile-devices mobile-skeleton"
          :class="{ 'is-loading': loading }"
          aria-hidden="true"
        >
          <div
            v-for="row in 2"
            :key="row"
            class="mobile-device mobile-row"
          >
            <div class="mobile-identity">
              <span class="mobile-skeleton-line mobile-skeleton-name" />
              <span class="mobile-skeleton-line mobile-skeleton-address" />
            </div>
            <span class="mobile-skeleton-button" />
          </div>
        </div>
        <div v-else-if="!activeDevices.length" class="mobile-empty">
          <b>Пока нет привязанных телефонов</b>
          <p>Нажмите «Подключить телефон» у посредника и отсканируйте QR в приложении.</p>
        </div>
        <div v-else class="mobile-devices">
          <div
            v-for="device in activeDevices"
            :key="device.id"
            class="mobile-device mobile-row"
          >
            <div class="mobile-identity">
              <b>{{ device.name }}</b>
              <span class="mobile-device-status">Доступ разрешён</span>
            </div>
            <UiButton
              data-role="settings-action"
              variant="ghost"
              tone="danger"
              data-testid="mobile-revoke"
              :aria-label="`Отозвать доступ: ${device.name}`"
              :disabled="busy"
              @click="revoke(device)"
            >
              Отозвать доступ
            </UiButton>
          </div>
        </div>
      </div>
      <div class="mobile-history">
        <div
          v-if="!status"
          class="mobile-skeleton mobile-history-placeholder"
          aria-hidden="true"
        >
          <span class="mobile-skeleton-line mobile-skeleton-address" />
        </div>
        <UiDisclosureButton
          v-else-if="revokedDevices.length"
          v-model:open="historyOpen"
          controls="mobile-revoked-devices"
        >
          Отозванные телефоны · {{ revokedDevices.length }}
        </UiDisclosureButton>
        <p v-else class="mobile-history-empty">Отозванных телефонов нет</p>
        <div
          v-if="historyOpen && revokedDevices.length"
          id="mobile-revoked-devices"
          class="mobile-devices"
        >
          <div
            v-for="device in revokedDevices"
            :key="device.id"
            class="mobile-device mobile-row"
          >
            <b>{{ device.name }}</b>
            <span class="mobile-badge">Доступ отозван</span>
          </div>
        </div>
      </div>
    </section>
    <UiDialog
      v-model:open="addOpen"
      title="Добавить посредника"
      size="compact"
      initial-focus="#mobile-relay-name"
      :persistent="busy"
      :busy="busy"
      data-ui-touch
    >
      <form
        id="mobile-relay-form"
        class="mobile-form"
        @submit.prevent="addRelay"
      >
        <p class="mobile-form-hint">Укажите адрес сервера, доступный вашему телефону.</p>
        <UiInlineMessage v-if="error" tone="danger">{{ error }}</UiInlineMessage>
        <UiField
          id="mobile-relay-name"
          label="Название"
          hint="Чтобы отличать подключения, например «Дом»."
        >
          <UiInput
            v-model="form.name"
            maxlength="40"
            autocomplete="off"
            :disabled="busy"
            required
          />
        </UiField>
        <div class="mobile-form-address">
          <UiField
            id="mobile-relay-host"
            label="Адрес"
            hint="IP или имя хоста, без https:// и порта."
          >
            <UiInput
              v-model="form.host"
              placeholder="relay.example.com"
              autocomplete="off"
              :disabled="busy"
              required
            />
          </UiField>
          <UiField id="mobile-relay-port" label="Порт">
            <UiNumberInput
              v-model="form.port"
              :min="1"
              :max="65535"
              :disabled="busy"
              required
            />
          </UiField>
        </div>
      </form>
      <template #footer>
        <UiButton
          data-role="settings-action"
          :disabled="busy"
          @click="addOpen = false"
        >
          Отмена
        </UiButton>
        <UiButton
          type="submit"
          form="mobile-relay-form"
          data-role="settings-action"
          variant="solid"
          tone="accent"
          data-testid="mobile-add-relay"
          :disabled="!canAdd"
          :loading="busy"
        >
          Добавить посредника
        </UiButton>
      </template>
    </UiDialog>
    <MobilePairingDialog
      v-if="qrTarget"
      :relay="qrTarget.relay"
      :pair="qrTarget.pair"
      @close="qrTarget = null"
    />
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';

import {
  confirmDialog,
  UiButton,
  UiDialog,
  UiDisclosureButton,
  UiField,
  UiIconButton,
  UiInlineMessage,
  UiInput,
  UiNumberInput,
  UiSpinner,
  vTooltip,
} from '../../ui';
import { api } from '../../shared/apiClient.ts';
import { useSse } from '../../composables/useSse.ts';
import MobilePairingDialog from './MobilePairingDialog.vue';

type Relay = {
  id: string;
  name: string;
  host: string;
  port: number;
  link: {
    state: string;
    lastError: string | null;
  };
};

type Device = {
  id: string;
  name: string;
  revokedAt: number | null;
};

type Status = {
  server: {
    up: boolean;
    error: string | null;
  };
  relays: Relay[];
  devices: Device[];
};

const status = ref<Status | null>(null);
const form = ref({
  name: '',
  host: '',
  port: 443 as number | '',
});
const error = ref('');
const loadError = ref('');
const busy = ref(false);
const created = ref('');
const addOpen = ref(false);
const expandedRelay = ref('');
const historyOpen = ref(false);
const qrTarget = ref<{ relay: Relay; pair: boolean } | null>(null);
const loading = ref(false);
let disposed = false;

const activeDevices = computed(() => status.value?.devices.filter((device) => !device.revokedAt) || []);
const revokedDevices = computed(() => status.value?.devices.filter((device) => device.revokedAt) || []);
const canAdd = computed(() => Boolean(
  form.value.name.trim() && form.value.host.trim()
  && Number.isInteger(form.value.port) && Number(form.value.port) >= 1 && Number(form.value.port) <= 65535,
));

/**
 * Перечитывает настройки через общий клиент без собственного SSE-соединения.
 * Ответ после unmount не возвращает секретный QR или старый статус на экран.
 */
async function load() {
  if (loading.value || disposed) {
    return;
  }

  loading.value = true;
  loadError.value = '';

  try {
    const value = (await api.get('/api/mobile/status')) as Status;

    if (!value?.server || !Array.isArray(value.relays) || !Array.isArray(value.devices)) {
      throw new Error('Не удалось загрузить подключения. Повторите попытку.');
    }

    if (!disposed) {
      status.value = value;
    }
  } catch (cause) {
    if (!disposed) {
      loadError.value = message(cause);
    }
  } finally {
    loading.value = false;
  }
}

/**
 * Обозначает состояние связи коротким текстом для метки рядом с названием.
 * Причина ошибки выводится отдельно, неизвестное состояние не считается рабочим.
 */
function linkLabel(link: Relay['link']) {
  const names: Record<string, string> = {
    online: 'В сети',
    connecting: 'Подключается',
    waiting_vpn: 'Ждёт VPN',
    offline: 'Нет связи',
  };

  return link.state === 'error' ? 'Ошибка подключения' : names[link.state] || 'Нет связи';
}

function message(cause: unknown) {
  return cause instanceof Error ? cause.message : 'Не удалось выполнить действие.';
}

/**
 * Блокирует повторное нажатие до завершения мутации и обновляет общий снимок.
 * Ошибка остаётся видимой рядом с настройками.
 */
async function action(work: () => Promise<void>) {
  if (busy.value) {
    return;
  }

  busy.value = true;
  error.value = '';

  try {
    await work();
    await load();
  } catch (cause) {
    error.value = message(cause);
  } finally {
    busy.value = false;
  }
}

/**
 * Создаёт посредника с портом 443 по умолчанию и показывает следующий шаг установки.
 * Ключи остаются на сервере до защищённого скачивания env.
 */
async function addRelay() {
  if (!canAdd.value) {
    return;
  }

  await action(async () => {
    const value = (await api.post('/api/mobile/relays', {
      name: form.value.name.trim(),
      host: form.value.host.trim(),
      port: Number(form.value.port),
    })) as { relay: { id: string } };

    created.value = value.relay.id;
    expandedRelay.value = value.relay.id;
    addOpen.value = false;
  });
}

/**
 * Новая форма начинается с понятного порта и не сохраняет старые ошибки.
 * Черновик закрытого диалога не становится настройками посредника.
 */
function openAdd() {
  error.value = '';
  form.value = {
    name: '',
    host: '',
    port: 443,
  };
  addOpen.value = true;
}

function showQr(relay: Relay, pair: boolean) {
  qrTarget.value = { relay, pair };
}

/**
 * Скачивает env по защищённому GET, затем удаляет временный браузерный URL.
 * Содержимое файла не попадает в локальные настройки или журнал.
 */
async function downloadEnv(id: string) {
  await action(async () => {
    const value = await api.downloadGet(`/api/mobile/relays/${id}/env`);
    const url = URL.createObjectURL(value.blob);
    const anchor = document.createElement('a');

    anchor.href = url;
    anchor.download = 'relay.env';
    anchor.click();
    URL.revokeObjectURL(url);
  });
}

/**
 * Удаление посредника подтверждается общим диалогом проекта.
 * После отказа диалога сетевой мутации не возникает.
 */
async function removeRelay(relay: Relay) {
  const text = `Удалить посредника «${relay.name}»? Телефоны больше не смогут подключаться через него.`;

  if (
    await confirmDialog(text, {
      danger: true,
      okText: 'Удалить',
      touchTargets: true,
    })
  ) {
    await action(async () => {
      await api.del(`/api/mobile/relays/${relay.id}`);
    });
  }
}

/**
 * Отзыв телефона подтверждается общим danger-dialog, затем перечитывает список.
 * Сервер завершает живые соединения только после durable записи отзыва.
 */
async function revoke(device: Device) {
  const text = `Отозвать доступ у «${device.name}»? Для повторного подключения понадобится новый QR.`;

  if (
    await confirmDialog(text, {
      danger: true,
      okText: 'Отозвать доступ',
      touchTargets: true,
    })
  ) {
    await action(async () => {
      await api.post(`/api/mobile/devices/${device.id}/revoke`);
    });
  }
}

useSse((name) => {
  if (name === 'mobile-changed') {
    void load();
  }
});
onMounted(() => {
  void load();
});
onUnmounted(() => {
  disposed = true;
});
</script>

<style scoped>
.mobile-access {
  container-type: inline-size;
  display: grid;
  gap: 1.25rem;
  min-width: 0;
}
.mobile-heading {
  display: flex;
  align-items: center;
  gap: 1rem;
}
.mobile-heading > div {
  flex: 1;
  min-width: 0;
}
.mobile-loading-indicator {
  display: grid;
  place-items: center;
  flex: 0 0 1.25rem;
  height: 1.25rem;
}
.mobile-heading h3 {
  margin: 0;
  font-size: 1.125rem;
}
.mobile-heading p,
.mobile-card p {
  margin: 0.35rem 0 0;
  color: var(--ink-mid);
  font-size: 0.875rem;
  line-height: 1.55;
}
.mobile-icon {
  display: grid;
  place-items: center;
  flex: 0 0 3rem;
  height: 3rem;
  border: 1px solid color-mix(in srgb, var(--accent) 25%, var(--line));
  border-radius: var(--radius);
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 8%, var(--surface));
}
.mobile-icon svg {
  width: 1.5rem;
  height: 1.5rem;
}
.mobile-card {
  min-width: 0;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
  overflow: hidden;
}
.mobile-card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 1rem;
  padding: 1.25rem;
}
.mobile-card-head > div {
  flex: 1 1 17rem;
  min-width: 0;
}
.mobile-card h4 {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin: 0;
  font-size: 0.9375rem;
}
.mobile-count {
  padding: 0.125rem 0.45rem;
  border-radius: 6px;
  background: var(--surface-2);
  color: var(--ink-mid);
  font-size: 0.75rem;
  font-weight: 500;
}
.mobile-relays {
  display: grid;
  gap: 0.75rem;
  padding: 0 1.25rem 1.25rem;
}
.mobile-relay {
  min-width: 0;
  padding: 1rem;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--ground);
}
.mobile-relay-summary {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 0.75rem;
}
.mobile-relay-summary > .mobile-identity,
.mobile-device > .mobile-identity {
  min-height: 3.25rem;
  align-content: center;
}
.mobile-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 0.75rem 1rem;
}
.mobile-identity {
  display: grid;
  gap: 0.35rem;
  flex: 1 1 12rem;
  min-width: 0;
  overflow-wrap: anywhere;
}
.mobile-name-line {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.5rem 0.75rem;
}
.mobile-badge {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.2rem 0.5rem;
  border: 1px solid var(--line-2);
  border-radius: 6px;
  color: var(--ink-mid);
  font-size: 0.75rem;
  line-height: 1.4;
}
.mobile-badge[data-state='online'] {
  color: var(--good);
  border-color: color-mix(in srgb, var(--good) 30%, var(--line));
  background: color-mix(in srgb, var(--good) 7%, transparent);
}
.mobile-badge[data-state='connecting'],
.mobile-badge[data-state='waiting_vpn'] {
  color: var(--warn);
}
.mobile-badge[data-state='error'] {
  color: var(--bad);
}
.mobile-status-dot {
  width: 0.375rem;
  height: 0.375rem;
  flex: none;
  border-radius: 50%;
  background: currentColor;
}
.mobile-address {
  color: var(--ink-mid);
  font-family: var(--mono);
  font-size: 0.8125rem;
}
.mobile-card .mobile-connection-note {
  margin: 0.75rem 0 0;
  color: var(--warn);
  overflow-wrap: anywhere;
}
.mobile-relay-setup {
  display: grid;
  gap: 1rem;
  margin-top: 0.75rem;
  padding-top: 1rem;
  border-top: 1px solid var(--line);
  font-size: 0.875rem;
}
.mobile-relay-remove {
  border-top: 1px solid var(--line);
  padding-top: 0.5rem;
}
.mobile-install {
  padding: 1rem;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
}
.mobile-install pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 0.75rem;
  line-height: 1.6;
}
.mobile-devices {
  padding: 0 1.25rem;
}
.mobile-device-list {
  min-height: 10rem;
}
.mobile-device {
  min-width: 0;
  padding: 1rem 0;
  border-top: 1px solid var(--line);
  overflow-wrap: anywhere;
}
.mobile-device-status {
  color: var(--ink-mid);
  font-size: 0.8125rem;
}
.mobile-history {
  padding: 0.5rem 1.25rem;
  border-top: 1px solid var(--line);
}
.mobile-history .mobile-devices {
  padding: 0;
  color: var(--ink-mid);
  font-size: 0.875rem;
}
.mobile-history-empty,
.mobile-history-placeholder {
  display: flex;
  align-items: center;
  min-height: var(--control-height);
}
.mobile-card .mobile-history-empty {
  margin: 0;
}
.mobile-skeleton-line,
.mobile-skeleton-button {
  display: block;
  border-radius: 6px;
  background: var(--surface-2);
}
.mobile-skeleton-line {
  height: 1.25rem;
  max-width: 100%;
}
.mobile-skeleton-name {
  width: 8rem;
}
.mobile-skeleton-address {
  width: 12rem;
}
.mobile-skeleton-button {
  width: 11.75rem;
  height: var(--control-height);
}
.mobile-skeleton-icon {
  width: var(--control-height);
}
.mobile-skeleton.is-loading {
  animation: mobile-loading-pulse 1.5s ease-in-out infinite alternate;
}
@keyframes mobile-loading-pulse {
  from {
    opacity: 0.45;
  }
  to {
    opacity: 1;
  }
}
@media (prefers-reduced-motion: reduce) {
  .mobile-skeleton.is-loading {
    animation: none;
  }
}
.mobile-empty {
  display: grid;
  justify-items: start;
  gap: 0.5rem;
  padding: 1.25rem;
  color: var(--ink-mid);
  font-size: 0.875rem;
}
.mobile-card > .mobile-empty,
.mobile-device-list > .mobile-empty {
  margin: 0 1.25rem 1.25rem;
  border: 1px dashed var(--line-2);
  border-radius: var(--radius);
}
.mobile-empty b {
  color: var(--ink);
}
.mobile-form {
  display: grid;
  gap: 1.25rem;
}
.mobile-form-hint {
  margin: 0;
  color: var(--ink-mid);
  font-size: 0.875rem;
  line-height: 1.5;
}
.mobile-form-address {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 6rem;
  gap: 0.75rem;
}
@container (max-width: 480px) {
  .mobile-card-head,
  .mobile-relay {
    padding: 1rem;
  }
  .mobile-relays {
    padding: 0 1rem 1rem;
  }
  .mobile-relay-summary {
    grid-template-columns: minmax(0, 1fr) auto;
  }
  .mobile-connect {
    grid-column: 1 / -1;
  }
  .mobile-skeleton-button.mobile-connect {
    width: 100%;
  }
  .mobile-relay-settings {
    grid-column: 2;
    grid-row: 1;
  }
  .mobile-identity {
    flex-basis: auto;
  }
  .mobile-device {
    align-items: flex-start;
    flex-direction: column;
  }
  .mobile-heading {
    align-items: flex-start;
  }
}
@media (max-width: 380px) {
  .mobile-form-address {
    grid-template-columns: minmax(0, 1fr);
  }
}
@media (max-width: 900px), (max-height: 500px) {
  .mobile-access { gap: 12px; }
  .mobile-heading { gap: 8px; }
  .mobile-icon { display: none; }
  .mobile-heading p { margin-bottom: 0; }
  .mobile-card-head { padding: 12px; }
  .mobile-relays { padding: 0 12px 12px; }
  .mobile-empty { padding: 12px; }
}
</style>
