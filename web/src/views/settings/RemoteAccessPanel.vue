<template>
  <SettingsSection :heading="t('settings.remoteAccess')">
    <div class="remote-access" :aria-busy="jobs.loading || undefined">
      <p>{{ t('settings.remotePlatform') }}</p>
      <p>{{ t('settings.remoteHome') }}: {{ shell.profile?.name ?? t('settings.remoteThisServer') }}</p>
      <UiInlineMessage v-if="jobs.error" tone="danger">
        {{ jobs.error }}
        <UiButton @click="jobs.load">{{ t('settings.retryLoading') }}</UiButton>
      </UiInlineMessage>
      <UiInlineMessage v-if="error && !opened" tone="danger">
        {{ error }}
        <UiButton @click="load">{{ t('settings.retryLoading') }}</UiButton>
      </UiInlineMessage>
      <UiButton :disabled="!serverFp || jobs.loading" @click="begin()">
        {{ t('settings.remoteSetup') }}
      </UiButton>
      <UiButton v-if="jobs.jobs.length" @click="resume">
        {{ t('settings.remoteResume') }}
      </UiButton>
      <article v-for="relay in relays" :key="relay.id" class="remote-access__relay">
        <strong>{{ relay.name }}</strong>
        <span>{{ relayOnline(relay) }}</span>
        <div class="remote-access__actions">
          <UiButton @click="begin(relay)">{{ t('settings.remoteRestore') }}</UiButton>
          <UiButton :disabled="deleting" @click="remove(relay.id)">
            {{ t('settings.remoteDelete') }}
          </UiButton>
        </div>
      </article>
      <p v-if="jobs.jobs.some((job) => job.routeUpdateRequired)">{{ t('settings.remoteRouteUpdate') }}</p>
    </div>
    <UiDialog :open="opened" :title="t('settings.remoteAccess')" size="compact" mobile-sheet
              data-ui-workspace data-role="remote-access-wizard" :busy="busy" @update:open="close">
      <div class="remote-access">
        <p>{{ t('settings.remoteHome') }}: {{ shell.profile?.name ?? t('settings.remoteThisServer') }}</p>
        <p v-if="restoreRelay">{{ restoreRelay.name }}</p>
        <template v-if="!current">
          <UiField v-if="!restoreRelay" :label="t('settings.remoteName')">
            <UiInput v-model="name" :disabled="busy" />
          </UiField>
          <UiField :label="t('settings.remoteSshHost')"><UiInput v-model="host" :disabled="busy" /></UiField>
          <UiField :label="t('settings.remoteSshUser')"><UiInput v-model="user" :disabled="busy" /></UiField>
          <UiDisclosureButton v-model:open="advanced" :controls="advancedId">
            {{ t('settings.remoteAdvanced') }}
          </UiDisclosureButton>
          <div v-if="advanced" :id="advancedId">
            <UiField :label="t('settings.remoteSshPort')"><UiInput v-model="sshPort" /></UiField>
            <UiField :label="t('settings.remotePublicHost')"><UiInput v-model="publicHost" /></UiField>
            <UiField :label="t('settings.remotePublicPort')"><UiInput v-model="publicPort" /></UiField>
            <UiField :label="t('settings.remoteCandidateHost')"><UiInput v-model="candidateHost" /></UiField>
          </div>
          <UiButton :disabled="busy || !serverFp" @click="create">{{ t('settings.remoteCheck') }}</UiButton>
        </template>
        <template v-else>
          <template v-if="current.state === 'draft'">
            <p>{{ t('settings.remoteWorking') }}</p>
            <UiButton :disabled="busy" @click="act('probe')">{{ t('settings.remoteCheck') }}</UiButton>
          </template>
          <p v-if="current.state === 'awaiting_host_key'">{{ current.hostKey?.fingerprint }}</p>
          <p v-if="current.hostKey?.decision === 'replace_required'">{{ t('settings.remoteChangedKey') }}</p>
          <UiButton v-if="current.state === 'awaiting_host_key'" :disabled="busy" @click="trust">
            {{ t('settings.remoteTrust') }}
          </UiButton>
          <template v-if="current.state === 'awaiting_credentials'">
            <UiCheckbox v-model="useKey">{{ t('settings.remoteUseKey') }}</UiCheckbox>
            <template v-if="useKey">
              <UiFilePicker :label="t('settings.remoteKeyFile')" @change="readKey" />
              <UiField :label="t('settings.remotePassphrase')">
                <UiPasswordInput v-model="passphrase" autocomplete="off" />
              </UiField>
            </template>
            <UiField v-else :label="t('settings.remotePassword')">
              <UiPasswordInput v-model="password" autocomplete="off" />
            </UiField>
            <UiButton :disabled="busy" @click="credentials">{{ t('settings.remoteCheck') }}</UiButton>
          </template>
          <template v-if="current.state === 'awaiting_confirmation'">
            <p>{{ t('settings.remotePreview') }}</p>
            <p v-for="change in current.preview?.changes" :key="change">{{ previewChange(change) }}</p>
            <p>{{ current.preview?.artifact.version }} · {{ current.preview?.artifact.digest }}</p>
            <UiButton :disabled="busy" @click="start">{{ t('settings.remoteInstall') }}</UiButton>
          </template>
          <p v-if="current.service">
            {{ t('settings.remoteServiceResult') }}:
            {{ current.service.state === 'running' ? t('settings.remoteServiceRunning')
              : t('settings.remoteServiceUnverified') }}
          </p>
          <template v-if="current.state === 'ready'">
            <p>{{ t('settings.remoteReady') }}</p>
            <p>{{ t('settings.remotePhonePending') }}</p>
            <p v-if="current.routeUpdateRequired">{{ t('settings.remoteRouteUpdate') }}</p>
            <UiButton @click="showQr">{{ t('settings.remoteQr') }}</UiButton>
          </template>
          <template v-if="['awaiting_dns', 'waiting_vpn'].includes(current.state)">
            <p>{{ current.state === 'awaiting_dns' ? t('settings.remoteDns') : t('settings.remoteVpn') }}</p>
            <UiButton :disabled="busy" @click="act('check')">{{ t('settings.remoteCheck') }}</UiButton>
          </template>
          <template v-if="['failed', 'interrupted', 'recovery_required'].includes(current.state)">
            <UiInlineMessage tone="danger">{{ failureMessage }}</UiInlineMessage>
            <UiButton :disabled="busy" @click="act('retry')">{{ t('settings.remoteRetry') }}</UiButton>
          </template>
          <p v-for="step in current.steps" :key="step.name">
            {{ stepLabel(step.name) }}: {{ stepState(step.state) }}
          </p>
          <p v-if="['installing', 'preflight', 'verifying'].includes(current.state)" role="status">
            {{ t('settings.remoteWorking') }}
          </p>
        </template>
        <UiInlineMessage v-if="error" tone="danger">{{ error }}</UiInlineMessage>
      </div>
      <template #footer><UiButton @click="close(false)">{{ t('settings.close') }}</UiButton></template>
    </UiDialog>
  </SettingsSection>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, useId, watch } from 'vue';

import { UiButton, UiCheckbox, UiDialog, UiDisclosureButton, UiField, UiFilePicker, UiInlineMessage,
  UiInput, UiPasswordInput, confirmDialog, messageRef, t } from '../../ui.ts';
import { api } from '../../shared/apiClient.ts';
import { useShellStore } from '../../stores/shell.ts';
import { useAuthStore } from '../../stores/auth.ts';
import { usePhoneAccessStore } from '../../stores/phoneAccess.ts';
import { deploymentJob, useRelayDeploymentStore } from '../../stores/relayDeployment.ts';
import { useSse } from '../../composables/useSse.ts';
import type { DeploymentSnapshot as DeploymentJob }
  from '../../../../shared/mobile/relayDeploymentContracts.ts';
import SettingsSection from './SettingsSection.vue';

interface RelaySummary {
  id: string;
  name: string;
  host: string;
  port: number;
  link: { state: string };
}

const shell = useShellStore();
const auth = useAuthStore();
const phone = usePhoneAccessStore();
const jobs = useRelayDeploymentStore();
const owner = computed(() => `${shell.profile?.id ?? 'origin'}:${auth.clientScope}:${auth.authenticated}`);
const relays = ref<RelaySummary[]>([]);
const current = ref<DeploymentJob | null>(null);
const restoreRelay = ref<RelaySummary | null>(null);
const opened = ref(false);
const busy = ref(false);
const error = ref('');
const name = ref('');
const host = ref('');
const user = ref('root');
const sshPort = ref('22');
const publicHost = ref('');
const publicPort = ref('443');
const candidateHost = ref('');
const advanced = ref(false);
const advancedId = useId();
const useKey = ref(false);
const password = ref('');
const privateKey = ref('');
const passphrase = ref('');
const serverFp = ref('');
const deleting = ref(false);
let generation = 0;
let ownerGeneration = 0;
let loadGeneration = 0;

const failureMessage = computed(() => {
  const code = current.value?.error?.code;

  if (code === 'port_busy' || code === 'relay_port_busy') {
    return t('settings.remotePortBusy');
  }

  return code === 'ssh_auth_failed' ? t('settings.remoteAuthFailed')
    : code === 'unsupported_platform' ? t('settings.remotePlatformFailed')
      : code === 'preflight_failed' ? t('settings.remotePreflightFailed') : t('settings.remoteFailure');
});

/**
 * Статус relay переводится отдельно: исторический ready не объявляет связь маршрута.
 */
function relayOnline(relay: RelaySummary): string {
  return relay.link.state === 'online' ? t('settings.remoteOnline') : t('settings.remoteOffline');
}

function previewChange(change: string): string {
  const labels: Record<string, string> = {
    install_relay_binary: t('settings.remoteChangeBinary'),
    create_service_user: t('settings.remoteChangeUser'),
    write_private_config: t('settings.remoteChangeConfig'),
    enable_systemd: t('settings.remoteChangeService'),
  };

  return labels[change] ?? change;
}

/**
 * Этапы имеют фиксированные собственные подписи, данные не становятся ключами перевода.
 * Неизвестный сетевой этап показывается в общей группе проверки канала.
 */
function stepLabel(name: string): string {
  return name === 'preflight' ? t('settings.remoteStepPreflight')
    : name === 'install' ? t('settings.remoteStepInstall') : t('settings.remoteStepChannel');
}

/**
 * Состояния этапов переводятся отдельно от данных сервера.
 * Незавершённый шаг не выдаётся за успешную установку.
 */
function stepState(state: string): string {
  return state === 'completed' ? t('settings.remoteStepCompleted')
    : state === 'failed' ? t('settings.remoteStepFailed') : t('settings.remoteStepRunning');
}

function clearSecrets(): void {
  password.value = '';
  privateKey.value = '';
  passphrase.value = '';
}

/**
 * Закрытие уничтожает только локальную форму, серверное задание не отменяется.
 * Поколение отсекает также завершение чтения выбранного файла и поздние HTTP-ответы.
 */
function close(value: boolean): void {
  opened.value = value;
  generation += 1;
  busy.value = false;
  error.value = '';
  clearSecrets();
}

/**
 * Список и личность читаются с явно выбранного сервера до ввода учётных данных.
 * Ошибка или смена владельца не оставляют адреса и отпечаток прежней машины.
 */
async function load(): Promise<void> {
  const epoch = ownerGeneration;
  const read = ++loadGeneration;

  await jobs.load();

  try {
    const value = await api.get('/api/mobile/status') as {
      server: { fp: string };
      relays: RelaySummary[];
    };

    if (ownerGeneration === epoch && loadGeneration === read) {
      serverFp.value = value.server.fp;
      relays.value = value.relays;
      current.value = jobs.jobs.find((job) => job.id === current.value?.id) ?? current.value;
      error.value = '';
    }
  } catch {
    if (ownerGeneration === epoch && loadGeneration === read) {
      error.value = t('settings.remoteLoadFailed');
    }
  }
}

/**
 * Новая форма и восстановление начинаются с чистых полей: параметры прежней машины
 * не должны тихо уйти в заявку для другой. Маршруты relay остаются значениями по умолчанию.
 */
function begin(relay?: RelaySummary): void {
  close(false);
  current.value = null;
  restoreRelay.value = relay ?? null;
  publicHost.value = relay?.host ?? '';
  publicPort.value = String(relay?.port ?? 443);
  host.value = '';
  name.value = '';
  user.value = 'root';
  sshPort.value = '22';
  candidateHost.value = '';
  advanced.value = false;
  useKey.value = false;
  error.value = '';
  opened.value = true;
}

function resume(): void {
  current.value = jobs.jobs.at(-1) ?? null;
  opened.value = true;
}

/**
 * Один обработчик защищает от двойного запуска и поздней публикации чужого результата.
 * Секретное тело передаётся отдельным binary transport без автоматического повтора.
 */
async function submit(work: () => Promise<unknown>): Promise<void> {
  if (busy.value || !auth.authenticated) {
    return;
  }

  const epoch = generation;

  busy.value = true;
  error.value = '';

  try {
    const job = deploymentJob(await work());

    // Поздний ответ действия не откатывает более свежий снимок, пришедший через SSE.
    if (generation === epoch && (job.revision >= (current.value?.revision ?? 0))) {
      current.value = job;
      jobs.accept(job);
    }
  } catch {
    if (generation === epoch) {
      error.value = t('settings.remoteFailure');
    }
  } finally {
    if (generation === epoch) {
      busy.value = false;
    }
  }
}

/**
 * Порты читаются только как целые числа: молчаливая замена NaN на 22/443 недопустима.
 * Ошибка показывается в мастере до отправки заявки на сервер.
 */
function portValue(value: string, fallback: number): number {
  const parsed = Number(value);

  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : fallback;
}

/**
 * Создание закрепляет личность домашнего сервера и раздельные адреса установки и телефона.
 * До probe ни пароль, ни приватный ключ не запрашиваются.
 */
async function create(): Promise<void> {
  const epoch = generation;

  if (Number(sshPort.value) !== portValue(sshPort.value, 22)
    || Number(publicPort.value) !== portValue(publicPort.value, 443)) {
    error.value = t('settings.remoteInvalidPort');

    return;
  }

  await submit(async () => {
    const created = deploymentJob(await api.post('/api/mobile/deployments', {
      requestId: crypto.randomUUID(),
      expectedServerFp: serverFp.value,
      mode: restoreRelay.value ? 'restore' : 'setup',
      ...(restoreRelay.value ? { relayId: restoreRelay.value.id } : { name: name.value }),
      ssh: {
        host: host.value,
        user: user.value,
        port: portValue(sshPort.value, 22),
      },
      public: { host: publicHost.value || host.value, port: portValue(publicPort.value, 443) },
      candidateHost: candidateHost.value || host.value,
    }, { retry: false }));

    if (generation !== epoch) {
      return created;
    }

    return api.post(`/api/mobile/deployments/${created.id}/probe`, { revision: created.revision },
      { retry: false });
  });
}

async function trust(): Promise<void> {
  await act('host-key', {
    challengeId: current.value?.hostKey?.challengeId,
    decision: current.value?.hostKey?.decision === 'replace_required' ? 'replace' : 'trust',
  });
}

/**
 * Действие использует текущую revision и отдельный идентификатор мутации.
 * Повторное чтение через SSE восстанавливает состояние без повторения эффекта.
 */
async function act(action: string, extra: Record<string, unknown> = {}): Promise<void> {
  const job = current.value;

  if (!job) {
    return;
  }

  await submit(() => api.post(`/api/mobile/deployments/${job.id}/${action}`, {
    revision: job.revision,
    ...(['start', 'retry', 'check'].includes(action) ? { requestId: crypto.randomUUID() } : {}),
    ...extra,
  }, { retry: false }));

  if (action === 'retry' && current.value?.state === 'draft') {
    await act('probe');
  }
}

async function start(): Promise<void> {
  await act('start', { previewDigest: current.value?.preview?.digest });
}

/**
 * Секреты очищаются сразу после передачи, независимо от сетевого результата.
 * Они не попадают в Pinia, persisted state, SSE или сериализуемые ошибки.
 */
async function credentials(): Promise<void> {
  const secretReady = useKey.value ? privateKey.value : password.value;

  // Пустой ввод не уходит на сервер: там он стал бы пустым паролем вместо внятного отказа.
  if (!secretReady.trim()) {
    error.value = t('settings.remoteSecretRequired');

    return;
  }

  const body = JSON.stringify({
    revision: current.value?.revision,
    attemptId: crypto.randomUUID(),
    ...(useKey.value ? { privateKey: privateKey.value, passphrase: passphrase.value }
      : { password: password.value }),
  });

  clearSecrets();
  await submit(() => api.postBytes(`/api/mobile/deployments/${current.value?.id}/credentials`, body));
}

/**
 * Читается только выбранный человеком файл, с ограничением размера binary-контракта.
 * Закрытая или сменившая владельца форма не получает результат File.text.
 */
async function readKey(files: File[]): Promise<void> {
  const epoch = generation;
  const file = files[0];

  privateKey.value = '';

  if (!file || file.size === 0 || file.size > 60000) {
    error.value = t('settings.remoteFailure');

    return;
  }

  const text = await file.text();

  if (generation === epoch && opened.value) {
    privateKey.value = text;
  }
}

/**
 * Удаление личности является отдельным подтверждённым действием.
 * Устройства не отзываются, а закрытие мастера никогда не вызывает этот маршрут.
 */
async function remove(id: string): Promise<void> {
  const epoch = generation;

  if (deleting.value || !await confirmDialog(messageRef('settings.remoteDeleteHint'), { danger: true })) {
    return;
  }

  if (generation !== epoch) {
    return;
  }

  deleting.value = true;

  try {
    await api.del(`/api/mobile/relays/${id}`, undefined, { retry: false });
    await load();
  } catch {
    if (generation === epoch) {
      error.value = t('settings.remoteFailure');
    }
  } finally {
    if (generation === epoch) {
      deleting.value = false;
    }
  }
}

/**
 * QR использует общий телефонный диалог с явно выбранным relay.
 * Готовность канала не меняет отдельное подтверждение устройства.
 */
async function showQr(): Promise<void> {
  const relayId = current.value?.relayId;

  close(false);
  await phone.start({ relayId });
}

watch(owner, () => {
  ownerGeneration += 1;
  close(false);
  jobs.reset();
  relays.value = [];
  current.value = null;
  serverFp.value = '';
  void load();
}, { immediate: true, flush: 'sync' });
useSse((event) => {
  if (['mobile-changed', 'hello', 'reconnect'].includes(event)) {
    void load();
  }
});
onBeforeUnmount(() => {
  ownerGeneration += 1;
  close(false);
  jobs.reset();
});
</script>

<style scoped>
.remote-access {
  display: grid;
  gap: 12px;
  min-width: 0;
  overflow-wrap: anywhere;
}
.remote-access p {
  margin: 0;
}
.remote-access__relay {
  display: grid;
  gap: 8px;
  min-width: 0;
}
.remote-access__actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
</style>
