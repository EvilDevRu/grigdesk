<template>
  <section class="mobile-access" data-ui-touch aria-labelledby="mobile-access-title">
    <h3 id="mobile-access-title" class="sechead">Приложение на телефоне</h3>
    <p v-if="error" role="alert" class="msg err">{{ error }}</p>
    <p v-if="status && !status.server.up" role="status" class="msg warn">
      {{ status.server.error || 'Мобильный доступ ещё не запущен.' }}
    </p>
    <div class="card">
      <h4>Посредники</h4>
      <p class="muted small">Телефон подключается к этому Кокпиту через выбранного посредника.</p>
      <div v-for="relay in status?.relays || []" :key="relay.id" class="mobile-row">
        <div class="mobile-relay-name">
          <b>{{ relay.name }}</b>
          <span class="muted small">{{ relay.host }}:{{ relay.port }}</span>
          <span class="status-pill" :class="relay.link.state === 'online' ? 'ok' : 'neutral'">
            {{ linkLabel(relay.link) }}
          </span>
        </div>
        <div class="mobile-actions">
          <UiButton
            data-role="settings-action"
            data-testid="mobile-phone-qr"
            :disabled="busy"
            @click="showQr(relay.id, true)"
            >QR для телефона</UiButton
          >
          <UiButton data-role="settings-action" :disabled="busy" @click="showQr(relay.id, false)">
            QR посредника
          </UiButton>
          <UiButton data-role="settings-action" :disabled="busy" @click="downloadEnv(relay.id)">
            Скачать relay.env
          </UiButton>
          <UiButton
            data-role="settings-action"
            tone="danger"
            :disabled="busy"
            @click="removeRelay(relay)"
            >Удалить</UiButton
          >
        </div>
      </div>
      <h4>Добавить посредника</h4>
      <div class="mobile-form">
        <label for="mobile-relay-name"
          >Имя
          <UiInput
            id="mobile-relay-name"
            v-model="form.name"
            maxlength="40"
            data-context="settings-field"
            autocomplete="off"
          />
        </label>
        <label for="mobile-relay-host"
          >Адрес
          <UiInput
            id="mobile-relay-host"
            v-model="form.host"
            data-context="settings-field"
            placeholder="IP или имя хоста"
            autocomplete="off"
          />
        </label>
        <label for="mobile-relay-port"
          >Порт
          <UiNumberInput
            id="mobile-relay-port"
            v-model="form.port"
            :min="1"
            :max="65535"
            data-context="settings-field"
          />
        </label>
      </div>
      <UiButton
        data-role="settings-action"
        variant="solid"
        tone="accent"
        data-testid="mobile-add-relay"
        :disabled="busy || !form.name.trim() || !form.host.trim()"
        @click="addRelay"
        >Добавить посредника</UiButton
      >
      <div v-if="created" class="mobile-install" role="status">
        <p>
          Скачайте
          <UiButton data-role="settings-action" @click="downloadEnv(created)"> relay.env</UiButton>
          и сохраните в приватный каталог вне дерева проекта с правами 0600.
        </p>
        <pre>
RELAY_ENV_FILE=/путь/вне-проекта/relay.env docker compose up -d --build
docker compose ps</pre
        >
        <p class="muted small">
          После запуска откройте QR для телефона и отсканируйте его в приложении.
        </p>
      </div>
    </div>
    <div class="card">
      <h4>Телефоны</h4>
      <p v-if="!status?.devices.length" class="muted">Пока нет привязанных телефонов.</p>
      <div v-for="device in status?.devices || []" :key="device.id" class="mobile-row">
        <div>
          <b>{{ device.name }}</b>
          <span class="muted small">{{ device.revokedAt ? 'Отозван' : 'Привязан' }}</span>
        </div>
        <UiButton
          v-if="!device.revokedAt"
          data-role="settings-action"
          tone="danger"
          data-testid="mobile-revoke"
          :disabled="busy"
          @click="revoke(device)"
          >Отозвать</UiButton
        >
      </div>
    </div>
    <UiDialog v-model:open="qrOpen" title="QR для приложения" size="compact" data-ui-touch>
      <div v-if="qr" class="mobile-qr">
        <img :src="qrImage" alt="QR подключения" width="320" height="320" />
        <p v-if="qr.expiresAt" role="status">
          {{ remaining > 0 ? `Код действует ещё ${remaining} с` : 'Код истёк. Создайте новый QR.' }}
        </p>
        <label for="mobile-qr-text">Текст для вставки</label>
        <UiTextarea
          id="mobile-qr-text"
          :model-value="qr.text"
          readonly
          rows="5"
          data-context="settings-field"
        />
        <UiButton data-role="settings-action" @click="copyQr">Скопировать</UiButton>
      </div>
      <template #footer>
        <UiButton data-role="settings-action" @click="qrOpen = false">Закрыть</UiButton>
      </template>
    </UiDialog>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';

import { confirmDialog, UiButton, UiDialog, UiInput, UiNumberInput, UiTextarea } from '../../ui';
import { api } from '../../shared/apiClient.ts';
import { useSse } from '../../composables/useSse.ts';

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

type Qr = {
  svg: string;
  text: string;
  expiresAt: number | null;
};

const status = ref<Status | null>(null);
const form = ref({
  name: '',
  host: '',
  port: 443 as number | '',
});
const error = ref('');
const busy = ref(false);
const created = ref('');
const qr = ref<Qr | null>(null);
const qrOpen = ref(false);
const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | undefined;
let disposed = false;
let loading = false;

const qrImage = computed(() =>
  qr.value ? `data:image/svg+xml,${encodeURIComponent(qr.value.svg)}` : '',
);
const remaining = computed(() =>
  Math.max(0, Math.ceil(((qr.value?.expiresAt ?? 0) - now.value) / 1000)),
);

/**
 * Перечитывает настройки через общий клиент без собственного SSE-соединения.
 * Ответ после unmount не возвращает секретный QR или старый статус на экран.
 */
async function load() {
  if (loading || disposed) {
    return;
  }

  loading = true;

  try {
    const value = (await api.get('/api/mobile/status')) as Status;

    if (!disposed) {
      status.value =
        value && Array.isArray(value.relays) && Array.isArray(value.devices) ? value : null;
    }
  } catch (cause) {
    error.value = message(cause);
  } finally {
    loading = false;
  }
}

/**
 * Обозначает состояние связи обычными словами, сохраняя серверную причину ошибки.
 * Неизвестный статус не выглядит как работающая связь.
 */
function linkLabel(link: Relay['link']) {
  const names: Record<string, string> = {
    online: 'В сети',
    connecting: 'Подключается',
    waiting_vpn: 'Ждёт VPN',
    offline: 'Нет связи',
  };

  return link.state === 'error'
    ? `Ошибка: ${link.lastError || 'Нет связи'}`
    : names[link.state] || 'Нет связи';
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
  await action(async () => {
    const value = (await api.post('/api/mobile/relays', {
      name: form.value.name.trim(),
      host: form.value.host.trim(),
      port: Number(form.value.port),
    })) as { relay: { id: string } };

    created.value = value.relay.id;
    form.value.name = '';
    form.value.host = '';
  });
}

/**
 * Загружает QR только по явному нажатию и показывает его как изображение.
 * SVG не исполняется в DOM, срок одноразового кода виден рядом с ним.
 */
async function showQr(id: string, pair: boolean) {
  await action(async () => {
    const value = (await api.post(`/api/mobile/relays/${id}/qr`, { pair })) as Qr;

    if (!disposed) {
      qr.value = value;
      now.value = Date.now();
      qrOpen.value = true;
    }
  });
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
  if (
    await confirmDialog(`Удалить посредника «${relay.name}»?`, {
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
  if (
    await confirmDialog(`Отозвать телефон «${device.name}»?`, {
      danger: true,
      okText: 'Отозвать',
      touchTargets: true,
    })
  ) {
    await action(async () => {
      await api.post(`/api/mobile/devices/${device.id}/revoke`);
    });
  }
}

/**
 * Копирование вызывается только из открытого QR и по нажатию пользователя.
 * Отсутствие clipboard API показывается как обычная ошибка действия.
 */
async function copyQr() {
  await action(async () => {
    if (qr.value) {
      await navigator.clipboard.writeText(qr.value.text);
    }
  });
}

watch(qrOpen, (open) => {
  clearInterval(timer);

  if (open) {
    timer = setInterval(() => {
      now.value = Date.now();
    }, 1000);
  } else {
    qr.value = null;
  }
});
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
  clearInterval(timer);
  qr.value = null;
});
</script>

<style scoped>
.mobile-access {
  display: grid;
  gap: 1rem;
  min-width: 0;
}
.mobile-row {
  display: flex;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 0.75rem;
  padding-block: 0.75rem;
  border-bottom: 1px solid var(--border);
}
.mobile-relay-name {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.35rem;
  min-width: 0;
  overflow-wrap: anywhere;
}
.mobile-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: center;
}
.mobile-form {
  display: grid;
  grid-template-columns: 1fr 2fr 6rem;
  gap: 0.75rem;
  margin-block: 1rem;
}
.mobile-form label {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  min-width: 0;
}
.mobile-install pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.mobile-qr {
  display: grid;
  gap: 0.75rem;
  min-width: 0;
}
.mobile-qr img {
  width: 100%;
  height: auto;
  max-width: 320px;
  margin-inline: auto;
}
@media (max-width: 650px) {
  .mobile-form {
    grid-template-columns: 1fr;
  }
}
</style>
