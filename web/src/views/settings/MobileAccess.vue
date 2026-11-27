<template>
  <section
    class="mobile-access"
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
      <div class="ui-visually-hidden">
        <h3 id="mobile-access-title">{{ t('settings.phoneApplication') }}</h3>
        <p>{{ t('settings.connectYourPhoneWithAQRCode') }}</p>
      </div>
      <span class="mobile-loading-indicator">
        <UiSpinner v-if="loading" :label="t('settings.loadingConnections')" />
      </span>
    </header>
    <UiInlineMessage v-if="error || loadError" tone="danger">
      {{ resolveUiText(error || loadError) }}
      <UiButton data-context="workspace-form-wrap"
        v-if="loadError"
        variant="text"
        :disabled="loading"
        @click="load"
      >
        {{ t('settings.retryLoading') }}
      </UiButton>
    </UiInlineMessage>
    <UiInlineMessage v-if="status && status.server.error" tone="danger">
      {{ resolveUiText(status.server.error) }}
    </UiInlineMessage>
    <section class="mobile-card" aria-labelledby="mobile-relays-title">
      <header class="mobile-card-head">
        <div>
          <h4 id="mobile-relays-title">{{ t('settings.connectionThroughARelay') }}</h4>
          <p>{{ t('settings.chooseTheAddressYourPhoneWillUse') }}</p>
        </div>
        <UiButton data-context="workspace-form-wrap"
          data-role="settings-action"
          data-testid="mobile-open-add"
          :disabled="busy || !status"
          @click="openAdd"
        >
          {{ t('settings.addRelay') }}
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
            <span class="mobile-skeleton-button mobile-skeleton-icon mobile-relay-settings" />
          </div>
        </div>
      </div>
      <SettingsEmpty
        v-else-if="!status.relays.length"
        class="mobile-empty"
        :heading="t('settings.addARelayFirst')"
        :text="t('settings.enterItsAddressDownloadTheSettingsAnd')"
      />
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
            <UiIconButton
              v-tooltip="t('settings.relaySettings')"
              class="mobile-relay-settings"
              :label="t('settings.settingsForRelay', { relayName: relay.name })"
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
            {{ relay.link.lastError || t('settings.theRelayMustBeOnlineToPair') }}
          </p>
          <div
            v-if="expandedRelay === relay.id"
            :id="`mobile-relay-${relay.id}`"
            class="mobile-relay-setup"
          >
            <div class="mobile-row">
              <div class="mobile-identity">
                <b>{{ t('settings.relayInstallation') }}</b>
                <p>{{ t('settings.downloadTheSettingsFileToStartOn') }}</p>
              </div>
              <UiButton data-context="workspace-form-wrap"
                data-role="settings-action"
                :disabled="busy"
                @click="downloadEnv(relay.id)"
              >
                {{ t('settings.downloadRelayEnv') }}
              </UiButton>
            </div>
            <div
              v-if="created === relay.id"
              class="mobile-install"
              role="status"
            >
              <p>{{ t('settings.saveRelayEnvInAPrivateDirectory') }}</p>
              <pre>{{ t('settings.runNativeRelay') }}</pre>
              <p>{{ t('settings.whenTheStatusBecomesOnlineClickConnect') }}</p>
            </div>
            <div class="mobile-relay-remove">
              <UiButton data-context="workspace-form-wrap"
                data-role="settings-action"
                variant="ghost"
                tone="danger"
                :disabled="busy"
                @click="removeRelay(relay)"
              >
                {{ t('settings.deleteRelay') }}
              </UiButton>
            </div>
          </div>
        </article>
      </div>
    </section>
    <UiDialog
      v-model:open="addOpen"
      :title="t('settings.addRelay')"
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
        <p class="mobile-form-hint">{{ t('settings.enterAServerAddressAccessibleFromYour') }}</p>
        <UiInlineMessage v-if="error" tone="danger">{{ resolveUiText(error) }}</UiInlineMessage>
        <UiField
          id="mobile-relay-name"
          :label="t('settings.name')"
          :hint="t('settings.connectionNameHint')"
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
            :label="t('settings.address')"
            :hint="t('settings.hostHint')"
          >
            <UiInput
              v-model="form.host"
              placeholder="relay.example.com"
              autocomplete="off"
              :disabled="busy"
              required
            />
          </UiField>
          <UiField id="mobile-relay-port" :label="t('settings.port')">
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
        <UiButton data-context="workspace-form-wrap"
          data-role="settings-action"
          :disabled="busy"
          @click="addOpen = false"
        >
          {{ t('settings.cancel') }}
        </UiButton>
        <UiButton data-context="workspace-form-wrap"
          type="submit"
          form="mobile-relay-form"
          data-role="settings-action"
          variant="solid"
          tone="accent"
          data-testid="mobile-add-relay"
          :disabled="!canAdd"
          :loading="busy"
        >
          {{ t('settings.addRelay') }}
        </UiButton>
      </template>
    </UiDialog>
  </section>
</template>

<script setup lang="ts">
import { t, messageRef, resolveUiText, type UiText } from '../../ui.ts';

import { saveFile } from '../../shared/saveFile.ts';
import { computed, onMounted, onUnmounted, ref } from 'vue';

import {
  confirmDialog,
  UiButton,
  UiDialog,
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
import SettingsEmpty from './SettingsEmpty.vue';

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

type Status = {
  server: {
    fp: string | null;
    error: string | null;
  };
  relays: Relay[];
};

const status = ref<Status | null>(null);
const form = ref({
  name: '',
  host: '',
  port: 443 as number | '',
});
const error = ref<UiText>('');
const loadError = ref<UiText>('');
const busy = ref(false);

const created = ref('');
const addOpen = ref(false);
const expandedRelay = ref('');
const loading = ref(false);
let disposed = false;

const canAdd = computed(() => Boolean(
  form.value.name.trim() && form.value.host.trim()
  && Number.isInteger(form.value.port) && Number(form.value.port) >= 1 && Number(form.value.port) <= 65535,
));

/**
 * Перечитывает настройки через общий клиент без собственного SSE-соединения.
 * Ответ после unmount не обновляет уже закрытую страницу настроек.
 */
async function load() {
  if (loading.value || disposed) {
    return;
  }

  loading.value = true;
  loadError.value = '';

  try {
    const value = (await api.get('/api/mobile/status')) as Status;

    if (!value?.server || !Array.isArray(value.relays)) {
      if (!disposed) {
        loadError.value = messageRef('settings.couldNotLoadConnectionsTryAgain');
      }

      return;
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
    online: t('settings.online'),
    connecting: t('settings.connecting'),
    waiting_vpn: t('settings.waitingForVPN'),
    offline: t('settings.offline'),
  };

  return link.state === 'error' ? t('settings.connectionError') : names[link.state] || t('settings.offline');
}

function message(cause: unknown): UiText {
  return cause instanceof Error ? cause.message : messageRef('settings.couldNotPerformTheAction');
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

/**
 * Скачивает env по защищённому GET, затем удаляет временный браузерный URL.
 * Содержимое файла не попадает в локальные настройки или журнал.
 */
async function downloadEnv(id: string) {
  await action(async () => {
    const value = await api.downloadGet(`/api/mobile/relays/${id}/env`);

    await saveFile(value.blob, 'relay.env');
  });
}

/**
 * Удаление посредника подтверждается общим диалогом проекта.
 * После отказа диалога сетевой мутации не возникает.
 */
async function removeRelay(relay: Relay) {
  const text = messageRef('settings.deleteRelayPhonesWillNoLongerBe', { relayName: relay.name });

  if (
    await confirmDialog(text, {
      danger: true,
      okText: messageRef('settings.delete'),
      touchTargets: true,
    })
  ) {
    await action(async () => {
      await api.del(`/api/mobile/relays/${relay.id}`);
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
  gap: 16px;
  min-width: 0;
}
/* Заголовок раздела дублирует заголовок страницы и скрыт визуально. В шапке остаётся
   заранее отведённое место индикатора загрузки справа: обновление не сдвигает страницу. */
.mobile-heading {
  display: flex;
  align-items: center;
  justify-content: flex-end;
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
  font-size: 14px;
}
.mobile-heading p,
.mobile-card p {
  margin: 0.35rem 0 0;
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 1.55;
}
.mobile-icon {
  display: none;
}
.mobile-icon svg {
  width: 1.5rem;
  height: 1.5rem;
}
.mobile-card {
  min-width: 0;
  border-top: 1px solid var(--line);
}
.mobile-card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 1rem;
  padding: 12px 0;
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
  font-size: 13px;
}
.mobile-relays {
  display: grid;
  gap: 0.75rem;
  padding: 0 0 12px;
}
.mobile-relay {
  min-width: 0;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--ground);
}
.mobile-relay-summary {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.75rem;
}
.mobile-relay-summary > .mobile-identity {
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
  font-size: 12px;
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
  font-size: 12px;
}
.mobile-relay-remove {
  border-top: 1px solid var(--line);
  padding-top: 0.5rem;
}
.mobile-install {
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--surface);
}
.mobile-install pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 0.75rem;
  line-height: 1.6;
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
.mobile-form {
  display: grid;
  gap: 16px;
}
.mobile-form-hint {
  margin: 0;
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 1.5;
}
.mobile-form-address {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 6rem;
  gap: 0.75rem;
}
@container (max-width: 480px) {
  .mobile-relay {
    padding: 12px;
  }
  .mobile-relays {
    padding: 0 0 12px;
  }
  .mobile-identity {
    flex-basis: auto;
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
  .mobile-card-head { padding: 12px 0; }
  .mobile-relays { padding: 0 0 12px; }
}
</style>
