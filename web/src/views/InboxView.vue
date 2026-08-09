<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { api } from '../shared/api-client.js';
import { confirmDialog } from '../shared/ui/confirm.js';
import { useSse } from '../composables/useSse.js';

// Inbox показывает только public projection общего API. Provider identity,
// accountRef и native payload в браузере не нужны и здесь не ожидаются.
const loading = ref(true);
const unavailable = ref(false);
const error = ref('');
const notice = ref('');
const busy = ref('');
const activeSection = ref('review');
const payload = ref({ items: [], channels: [], errors: [], truncated: false, worker: null });
const selection = reactive({});
const itemAlerts = reactive({});
const nowMs = ref(Date.now());
let loadVersion = 0;
let clockTimer = null;

const channelsById = computed(() => new Map(
  payload.value.channels.map((channel) => [channel.id, channel]),
));

const reviewItems = computed(() => payload.value.items.filter((item) => (
  item.status === 'new' || item.status === 'mixed'
)));
const historyItems = computed(() => payload.value.items.filter((item) => (
  item.status === 'skipped' || item.status === 'task'
)));
const visibleItems = computed(() => (
  activeSection.value === 'history' ? historyItems.value : reviewItems.value
));
const analysisBlocksByRef = computed(() => new Map(
  (Array.isArray(payload.value.worker?.analysisRequired)
    ? payload.value.worker.analysisRequired
    : [])
    .filter((entry) => typeof entry?.ref === 'string')
    .map((entry) => [entry.ref, entry]),
));

const automationNotice = computed(() => {
  const worker = payload.value.worker;
  if (!worker) return null;
  if (worker.readiness === 'no_model') return {
    kind: 'warn',
    text: 'Автозадачи приостановлены: в плагине «Входящие» не выбрана модель разбора.',
    settings: true,
  };
  if (worker.readiness === 'no_b24') return {
    kind: 'warn',
    text: 'Автозадачи приостановлены: Битрикс24 не подключён.',
    settings: false,
  };
  const incompatibleModel = [
    'executor_unavailable',
    'invalid_model_ref',
    'model_unavailable',
    'model_not_found',
    'registry_failed',
    'unknown_model',
    'unknown_provider',
    'unsafe_model_provider',
    'unsupported_media',
    'unsupported_model',
  ];
  if (incompatibleModel.includes(worker.readiness)
      || incompatibleModel.includes(worker.lastReason)) return {
    kind: 'warn',
    text: 'Автозадачи приостановлены: выбранная модель не поддерживает безопасный разбор входящих.',
    settings: true,
  };
  if (worker.readiness === 'stopped') return {
    kind: 'bad', text: 'Автообработчик входящих остановлен.', settings: false,
  };
  if (worker.readiness === 'unavailable') return {
    kind: 'bad', text: 'Состояние автообработчика временно недоступно.', settings: false,
  };
  if (['snapshot_failed', 'tick_failed'].includes(worker.lastReason)) return {
    kind: 'bad', text: 'Последний автоматический разбор завершился технической ошибкой.', settings: false,
  };
  return null;
});

function isPluginDisabled(err) {
  return err?.status === 404 && err?.data?.error === 'plugin_disabled';
}

function selectable(message) {
  return Boolean(message) && (!message.decision || message.decision.status === 'skipped');
}

function selectionKey(message) {
  if (!message?.decision) return 'new';
  if (message.decision.status !== 'skipped') return '';
  return `skipped:${message.decision.decisionId}:${message.decision.version}`;
}

function normalizeSelection(item, refs) {
  const messagesByRef = new Map(item.messages.map((message) => [message.messageRef, message]));
  const allowed = refs.map((ref) => messagesByRef.get(ref)).filter(selectable);
  const key = selectionKey(allowed[0]);
  if (!key) return [];
  const accepted = new Set(allowed.filter((message) => selectionKey(message) === key)
    .map((message) => message.messageRef));
  return item.messages.map((message) => message.messageRef).filter((ref) => accepted.has(ref));
}

function sameRefs(left, right) {
  return left.length === right.length && left.every((ref, index) => ref === right[index]);
}

function syncSelection(items) {
  const live = new Set(items.map((item) => item.ref));
  for (const ref of Object.keys(selection)) {
    if (!live.has(ref)) delete selection[ref];
  }
  for (const ref of Object.keys(itemAlerts)) {
    if (!live.has(ref)) delete itemAlerts[ref];
  }
  for (const item of items) {
    if (Object.hasOwn(selection, item.ref)) {
      selection[item.ref] = normalizeSelection(item, selection[item.ref]);
    } else {
      const fresh = item.messages.filter((message) => !message.decision)
        .map((message) => message.messageRef);
      const initial = fresh.length
        ? fresh
        : item.messages.filter((message) => message.decision?.status === 'skipped')
          .map((message) => message.messageRef);
      selection[item.ref] = normalizeSelection(item, initial);
    }
    const retry = itemAlerts[item.ref]?.retry;
    if (retry && (retry.revision !== item.revision
        || !sameRefs(retry.messageRefs, selection[item.ref]))) delete itemAlerts[item.ref];
  }
}

async function load() {
  const own = ++loadVersion;
  if (!payload.value.items.length && !payload.value.channels.length) loading.value = true;
  try {
    const data = await api.get('/api/inbox');
    if (own !== loadVersion) return;
    const next = {
      items: Array.isArray(data?.items) ? data.items : [],
      channels: Array.isArray(data?.channels) ? data.channels : [],
      errors: Array.isArray(data?.errors) ? data.errors : [],
      truncated: data?.truncated === true,
      worker: data?.worker && typeof data.worker === 'object' ? data.worker : null,
    };
    payload.value = next;
    syncSelection(next.items);
    unavailable.value = false;
    error.value = '';
  } catch (err) {
    if (own !== loadVersion) return;
    if (isPluginDisabled(err)) {
      unavailable.value = true;
      error.value = '';
      payload.value = {
        items: [], channels: [], errors: [], truncated: false, worker: null,
      };
    } else {
      error.value = err?.message || 'Не удалось загрузить входящие.';
    }
  } finally {
    if (own === loadVersion) loading.value = false;
  }
}

function selectedRefs(item) {
  return selection[item.ref] || [];
}

function toggleMessage(item, messageRef, checked) {
  const target = item.messages.find((message) => message.messageRef === messageRef);
  if (!target || !selectable(target)) return;
  const refs = new Set(selectedRefs(item));
  if (checked) {
    const key = selectionKey(target);
    for (const message of selectedMessages(item)) {
      if (selectionKey(message) !== key) refs.delete(message.messageRef);
    }
    refs.add(messageRef);
  }
  else refs.delete(messageRef);
  selection[item.ref] = normalizeSelection(item, [...refs]);
  delete itemAlerts[item.ref];
}

function selectedMessages(item) {
  const refs = new Set(selectedRefs(item));
  return item.messages.filter((message) => refs.has(message.messageRef));
}

function canDecide(item) {
  const messages = selectedMessages(item);
  return messages.length > 0 && messages.every((message) => !message.decision);
}

function resetDecision(item) {
  const messages = selectedMessages(item);
  if (!messages.length || messages.some((message) => message.decision?.status !== 'skipped')) return null;
  const first = messages[0].decision;
  return messages.every((message) => message.decision.decisionId === first.decisionId
      && message.decision.version === first.version)
    ? first
    : null;
}

function selectionMode(item) {
  if (canDecide(item)) return 'new';
  if (resetDecision(item)) return 'skipped';
  return 'none';
}

function taskLinks(item) {
  const decisions = [item.decision, ...item.messages.map((message) => message.decision)];
  const seen = new Set();
  return decisions.filter((decision) => {
    if (!decision?.taskUrl || seen.has(decision.taskUrl)) return false;
    seen.add(decision.taskUrl);
    return true;
  }).map((decision, index, links) => ({
    url: decision.taskUrl,
    label: links.length === 1
      ? 'Открыть задачу'
      : `Открыть задачу ${decision.taskId || index + 1}`,
  }));
}

function itemReadOnly(item) {
  return channelsById.value.get(item.channel?.id)?.readOnly !== false;
}

async function mutateItem(item, action, { allowUnanalyzedAttachments = false } = {}) {
  if (busy.value || itemReadOnly(item)) return;
  const messageRefs = [...selectedRefs(item)];
  const body = { revision: item.revision, messageRefs };
  if (action === 'reset') {
    const decision = resetDecision(item);
    if (!decision) return;
    body.decisionId = decision.decisionId;
    body.decisionVersion = decision.version;
  } else if (!canDecide(item)) return;
  if (action === 'task' && allowUnanalyzedAttachments) {
    body.allowUnanalyzedAttachments = true;
  }
  busy.value = `${item.ref}:${action}`;
  error.value = '';
  notice.value = '';
  delete itemAlerts[item.ref];
  try {
    await api.post(`/api/inbox/items/${encodeURIComponent(item.ref)}/${action}`, body);
    notice.value = action === 'task' ? 'Задача создана'
      : action === 'dismiss' ? 'Обращение пропущено и перенесено в историю'
        : 'Обращение возвращено к разбору';
    delete selection[item.ref];
    await load();
  } catch (err) {
    const code = err?.data?.error;
    if (['stale_item', 'stale_decision', 'account_changed'].includes(code)) {
      const text = 'Обращение изменилось — данные обновлены';
      delete selection[item.ref];
      await load();
      if (visibleItems.value.some((entry) => entry.ref === item.ref)) {
        itemAlerts[item.ref] = { kind: 'warn', text };
      } else {
        notice.value = text;
      }
    } else if (action === 'task' && !allowUnanalyzedAttachments
        && ['attachment_analysis_required', 'attachments_skipped'].includes(code)) {
      itemAlerts[item.ref] = {
        kind: 'warn',
        text: err?.message || 'Не удалось полностью разобрать содержимое вложений.',
        allowUnanalyzedAttachments: true,
        retry: { revision: item.revision, messageRefs: [...messageRefs] },
      };
    } else {
      itemAlerts[item.ref] = {
        kind: 'bad', text: err?.message || 'Не удалось выполнить действие с обращением.',
      };
    }
  } finally {
    busy.value = '';
  }
}

async function createWithUnanalyzedAttachments(item) {
  if (busy.value || itemReadOnly(item) || !canDecide(item)) return;
  const retry = itemAlerts[item.ref]?.retry;
  if (!retry || retry.revision !== item.revision
      || !sameRefs(retry.messageRefs, selectedRefs(item))) {
    itemAlerts[item.ref] = {
      kind: 'warn',
      text: 'Обращение или выбор изменились. Снова нажмите «Создать задачу», чтобы проверить вложения.',
    };
    return;
  }
  const confirmed = await confirmDialog(
    'Содержимое части вложений не удалось разобрать. Всё равно создать задачу с доступными исходными файлами? Неразобранное содержимое не попадёт в постановку.',
    { okText: 'Создать без разбора' },
  );
  if (!confirmed) return;
  if (retry.revision !== item.revision || !sameRefs(retry.messageRefs, selectedRefs(item))) {
    itemAlerts[item.ref] = {
      kind: 'warn',
      text: 'Обращение изменилось во время подтверждения. Данные нужно проверить заново.',
    };
    return;
  }
  await mutateItem(item, 'task', { allowUnanalyzedAttachments: true });
}

async function changeParticipation(channel, action) {
  if (busy.value || channel.readOnly || !Number.isSafeInteger(channel.activationVersion)) return;
  if (action === 'deactivate' && !(await confirmDialog(
    'Остановить приём? Сообщения, пришедшие во время паузы, не попадут в очередь после возобновления.',
    { okText: 'Остановить приём' },
  ))) return;
  busy.value = `${channel.id}:${action}`;
  error.value = '';
  try {
    await api.post(`/api/inbox/channels/${encodeURIComponent(channel.id)}/${action}`, {
      activationVersion: channel.activationVersion,
    });
    notice.value = action === 'activate'
      ? `${channel.label}: приём новых обращений включён.`
      : `${channel.label}: приём остановлен; пауза не станет backlog.`;
    await load();
  } catch (err) {
    error.value = err?.message || 'Не удалось изменить приём канала.';
  } finally {
    busy.value = '';
  }
}

function statusLabel(status) {
  return ({
    new: 'К разбору',
    mixed: 'Частично разобрано',
    task: 'Задача создана',
    skipped: 'Пропущено',
  })[status] || 'Разобрано';
}

function connectionLabel(connection) {
  return ({ connected: 'Подключён', disconnected: 'Не подключён', degraded: 'Ошибка канала' })[connection]
    || 'Состояние неизвестно';
}

function participationLabel(participation) {
  return ({
    active: 'Включён',
    deactivated: 'На паузе',
    never_activated: 'Не запускался',
  })[participation] || 'Состояние неизвестно';
}

function channelSettingsHref(id) {
  return ({ telegram: '#/telegram', github: '#/github' })[id] || '';
}

function formatTime(value) {
  const numeric = Number(value);
  const millis = numeric > 0 && numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('ru-RU');
}

function formatRemaining(value) {
  const total = Math.max(1, Math.ceil(value / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (!minutes) return `${seconds} с`;
  return seconds ? `${minutes} мин ${seconds} с` : `${minutes} мин`;
}

function formatBytes(value) {
  const size = Number(value);
  if (!Number.isFinite(size) || size < 0) return '';
  if (size < 1024) return `${Math.round(size)} Б`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} КБ`;
  return `${(size / 1024 / 1024).toFixed(size < 10 * 1024 * 1024 ? 1 : 0)} МБ`;
}

function attachmentLabel(attachment) {
  const kind = String(attachment?.displayLabel || attachment?.kind || 'Вложение').trim() || 'Вложение';
  const name = String(attachment?.name || '').trim();
  const size = formatBytes(attachment?.size);
  return [name && name !== kind ? `${kind}: ${name}` : kind, size].filter(Boolean).join(' · ');
}

function attachmentAnalysis(attachment, item) {
  const rawAnalysis = attachment?.attachmentAnalysis ?? attachment?.analysis ?? null;
  const nested = rawAnalysis && typeof rawAnalysis === 'object'
    ? rawAnalysis
    : null;
  const status = String(
    (typeof rawAnalysis === 'string' ? rawAnalysis : nested?.status) || attachment?.status || '',
  ).toLowerCase();
  const labels = {
    queued: 'Ждёт разбора',
    pending: 'Ждёт разбора',
    processing: 'Разбирается',
    running: 'Разбирается',
    transcribing: 'Разбирается',
    analyzing: 'Разбирается',
    ready: 'Содержимое разобрано',
    completed: 'Содержимое разобрано',
    done: 'Содержимое разобрано',
    transcribed: 'Содержимое разобрано',
    failed: 'Не удалось разобрать',
    error: 'Не удалось разобрать',
    unsupported: 'Разбор недоступен',
    skipped: 'Разбор недоступен',
  };
  const blocked = ['new', 'mixed'].includes(item?.status)
    && analysisBlocksByRef.value.has(item?.ref);
  const fallbackStatus = blocked ? 'failed' : 'pending';
  const fallbackLabel = blocked
    ? 'Не удалось разобрать'
    : item?.status === 'task' ? 'Приложено к задаче'
      : item?.status === 'skipped' ? 'Не разбиралось'
        : 'Будет проверено до задачи';
  return {
    status: status || fallbackStatus,
    label: labels[status] || fallbackLabel,
    text: String(nested?.transcript || nested?.text || attachment?.transcript || '').trim(),
  };
}

function autoTaskState(item) {
  if (item.status !== 'new' || !item.autoTask || typeof item.autoTask !== 'object') return null;
  if (item.autoTask.enabled !== true) return {
    kind: 'off', text: 'Автосоздание выключено для этого источника.',
  };
  const analysisBlock = analysisBlocksByRef.value.get(item.ref);
  if (analysisBlock) return {
    kind: 'blocked',
    text: `Вложения не удалось полностью разобрать. Автозадача не создастся; проверьте обращение вручную${
      Number.isSafeInteger(analysisBlock.retryAtMs)
        ? ` или дождитесь новой попытки после ${formatTime(analysisBlock.retryAtMs)}`
        : ''}.`,
  };
  const readyAtMs = Number(item.autoTask.readyAtMs);
  if (Number.isFinite(readyAtMs) && readyAtMs > nowMs.value) return {
    kind: 'waiting',
    text: `Авторазбор через ${formatRemaining(readyAtMs - nowMs.value)} тишины. Новые сообщения продлят ожидание.`,
  };
  const readiness = payload.value.worker?.readiness;
  if (readiness && readiness !== 'ready') return {
    kind: 'blocked', text: 'Обращение готово к авторазбору, но автоматика приостановлена.',
  };
  return {
    kind: 'queued',
    text: 'Обращение готово к авторазбору. Если модель не уверена, оно останется здесь для ручного решения.',
  };
}

function rememberPluginsTab() {
  localStorage.setItem('cockpit-settings-tab', 'plugins');
}

useSse((name) => { if (name === 'inbox-changed') load(); });
onMounted(() => {
  load();
  clockTimer = setInterval(() => { nowMs.value = Date.now(); }, 1000);
  clockTimer.unref?.();
});
onBeforeUnmount(() => {
  if (clockTimer) clearInterval(clockTimer);
  clockTimer = null;
});
</script>

<template>
  <main class="inbox-page">
    <header class="page-head">
      <div>
        <h1>Входящие</h1>
        <p>Общая очередь Telegram, GitHub и других подключённых каналов.</p>
      </div>
      <button class="btn" type="button" :disabled="loading" @click="load">Обновить</button>
    </header>

    <section v-if="unavailable" class="state-card" data-state="plugin-disabled">
      <h2>Входящие недоступны</h2>
      <p>Включите системный плагин «Входящие» в разделе «Настройки → Плагины».</p>
    </section>

    <template v-else>
      <p v-if="error" class="banner bad" role="alert">{{ error }}</p>
      <p v-if="notice" class="banner good" role="status">{{ notice }}</p>
      <p v-if="automationNotice" class="banner" :class="automationNotice.kind"
         data-state="automation-notice" role="status">
        {{ automationNotice.text }}
        <a v-if="automationNotice.settings" href="#/settings" class="inline-link"
           @click="rememberPluginsTab">Выбрать модель</a>
      </p>
      <p v-if="payload.truncated" class="banner warn">Показана только часть очереди: достигнут лимит ответа.</p>

      <section class="channels" aria-label="Каналы Inbox">
        <article v-for="channel in payload.channels" :key="channel.id" class="channel-card"
                 :data-channel="channel.id">
          <div class="channel-main">
            <strong>{{ channel.label }}</strong>
            <span v-if="channel.plugin === 'disabled'" class="pill off">Плагин выключен</span>
          </div>
          <dl class="channel-state">
            <div>
              <dt>Подключение</dt>
              <dd><span class="pill" :class="channel.connection">{{ connectionLabel(channel.connection) }}</span></dd>
            </div>
            <div>
              <dt>Приём новых</dt>
              <dd><span class="pill" :class="channel.participation">{{ participationLabel(channel.participation) }}</span></dd>
            </div>
          </dl>
          <p v-if="channel.participation === 'never_activated'">
            Приём ещё не начат. Старая история не будет импортирована.
          </p>
          <p v-else-if="channel.participation === 'deactivated'" class="gap-warning">
            Сообщения за время паузы не появятся после возобновления.
          </p>
          <p v-else>Новые обращения сразу попадают в очередь.</p>
          <p v-if="channel.connection !== 'connected'" class="read-only">
            Ранее принятые обращения доступны только для чтения до переподключения.
          </p>
          <div class="channel-actions">
            <a v-if="channelSettingsHref(channel.id)" class="btn" :href="channelSettingsHref(channel.id)">
              Подключение и настройки
            </a>
            <button v-if="channel.participation !== 'active'" class="btn accent" type="button"
                    :disabled="channel.readOnly || !Number.isSafeInteger(channel.activationVersion) || !!busy"
                    @click="changeParticipation(channel, 'activate')">
              {{ channel.participation === 'deactivated' ? 'Возобновить приём новых' : 'Начать принимать новые' }}
            </button>
            <button v-else class="btn" type="button"
                    :disabled="channel.readOnly || !Number.isSafeInteger(channel.activationVersion) || !!busy"
                    @click="changeParticipation(channel, 'deactivate')">Остановить приём</button>
          </div>
        </article>
        <div v-if="!payload.channels.length && !loading" class="state-card">
          <h2>Каналов пока нет</h2>
          <p>Включите и подключите хотя бы один канал.</p>
        </div>
      </section>

      <section v-if="payload.errors.length" class="channel-errors" aria-label="Ошибки каналов">
        <p v-for="entry in payload.errors" :key="`${entry.channel}:${entry.code}`" class="banner bad">
          {{ entry.channel }}: {{ entry.message }}
        </p>
      </section>

      <div v-if="loading" class="state-card"><span class="spin"></span> Загружаю очередь…</div>
      <template v-else-if="payload.items.length">
        <section class="queue-head" aria-labelledby="inbox-items-title">
          <h2 id="inbox-items-title">Обращения</h2>
          <div class="section-tabs" role="tablist" aria-label="Разделы входящих">
            <button class="section-tab" type="button" role="tab" data-section="review"
                    :aria-selected="activeSection === 'review'"
                    :class="{ active: activeSection === 'review' }"
                    @click="activeSection = 'review'">
              К разбору <span>{{ reviewItems.length }}</span>
            </button>
            <button class="section-tab" type="button" role="tab" data-section="history"
                    :aria-selected="activeSection === 'history'"
                    :class="{ active: activeSection === 'history' }"
                    @click="activeSection = 'history'">
              История <span>{{ historyItems.length }}</span>
            </button>
          </div>
        </section>
        <section v-if="visibleItems.length" class="items" aria-label="Очередь входящих">
          <article v-for="item in visibleItems" :key="item.ref" class="item-card" :data-status="item.status">
          <header class="item-head">
            <span class="channel-label">{{ item.channel.label }}</span>
            <a v-if="item.source.url" class="source" :href="item.source.url" target="_blank" rel="noreferrer">
              {{ item.source.title }}
            </a>
            <span v-else class="source">{{ item.source.title }}</span>
            <span class="status" :class="item.status">{{ statusLabel(item.status) }}</span>
          </header>
          <h2>{{ item.title }}</h2>
          <p v-if="item.description" class="description">{{ item.description }}</p>
          <p class="meta">{{ item.project }} · {{ item.kind }} · {{ formatTime(item.firstAt) }}</p>
          <p v-if="autoTaskState(item)" class="auto-state" :class="autoTaskState(item).kind">
            {{ autoTaskState(item).text }}
          </p>
          <p v-if="item.status === 'mixed'" class="mixed-note">
            Часть сообщений уже разобрана. Выберите новые сообщения для задачи или ранее
            пропущенные, чтобы вернуть их к разбору.
          </p>
          <p v-if="itemReadOnly(item)" class="read-only item-read-only">
            Канал отключён: это обращение доступно только для чтения.
          </p>
          <div v-if="itemAlerts[item.ref]" class="item-alert" :class="itemAlerts[item.ref].kind"
               :role="itemAlerts[item.ref].kind === 'bad' ? 'alert' : 'status'">
            <span>{{ itemAlerts[item.ref].text }}</span>
            <button v-if="itemAlerts[item.ref].allowUnanalyzedAttachments" class="btn" type="button"
                    data-action="attachments-only" :disabled="itemReadOnly(item) || !!busy"
                    @click="createWithUnanalyzedAttachments(item)">
              Создать без разбора
            </button>
          </div>

          <div class="messages">
            <label v-for="message in item.messages" :key="message.messageRef" class="message"
                   :class="{ decided: !!message.decision }">
              <input v-if="selectable(message)" type="checkbox"
                     :disabled="itemReadOnly(item) || !!busy"
                     :checked="selectedRefs(item).includes(message.messageRef)"
                     :aria-label="`Выбрать сообщение ${message.author.name}`"
                     @change="toggleMessage(item, message.messageRef, $event.target.checked)">
              <span v-else class="selection-placeholder" aria-hidden="true">✓</span>
              <span class="message-body">
                <span class="message-head"><strong>{{ message.author.name }}</strong>
                  <time>{{ formatTime(message.occurredAt) }}</time>
                  <span v-if="message.decision" class="decision">{{ statusLabel(message.decision.status) }}</span>
                </span>
                <span class="message-text">{{ message.text || 'Без текста' }}</span>
                <span v-if="message.attachments?.length" class="attachments">
                  <span class="attachment-list">
                    <span v-for="(attachment, attachmentIndex) in message.attachments"
                          :key="`${message.messageRef}:${attachmentIndex}`"
                          class="attachment-chip" :data-analysis="attachmentAnalysis(attachment, item).status">
                      <span>{{ attachmentLabel(attachment) }}</span>
                      <small>{{ attachmentAnalysis(attachment, item).label }}</small>
                    </span>
                  </span>
                  <span class="attachment-note">
                    Перед задачей Cockpit проверит содержимое. Без полного разбора
                    автозадача не создастся.
                  </span>
                  <span v-for="(attachment, attachmentIndex) in message.attachments"
                        :key="`${message.messageRef}:transcript:${attachmentIndex}`">
                    <span v-if="attachmentAnalysis(attachment, item).text" class="attachment-transcript">
                      {{ attachmentAnalysis(attachment, item).text }}
                    </span>
                  </span>
                </span>
              </span>
            </label>
          </div>

          <footer class="actions">
            <span v-if="item.messages.some(selectable)" class="selected-count">
              Выбрано: {{ selectedRefs(item).length }}
            </span>
            <a v-for="link in taskLinks(item)" :key="link.url" class="btn task-link"
               :href="link.url" target="_blank" rel="noreferrer">{{ link.label }}</a>
            <template v-if="selectionMode(item) === 'new'">
              <button class="btn accent" type="button" :disabled="itemReadOnly(item) || !!busy"
                      @click="mutateItem(item, 'task')">Создать задачу</button>
              <button class="btn" type="button" :disabled="itemReadOnly(item) || !!busy"
                      @click="mutateItem(item, 'dismiss')">Пропустить</button>
            </template>
            <template v-else-if="selectionMode(item) === 'skipped'">
              <span class="action-help">
                Вернёт выбранные сообщения в «К разбору». Созданные задачи не изменятся.
              </span>
              <button class="btn" type="button" :disabled="itemReadOnly(item) || !!busy"
                      @click="mutateItem(item, 'reset')">Вернуть на разбор</button>
            </template>
            <span v-else-if="item.messages.some(selectable)" class="action-help">
              Выберите сообщения для действия.
            </span>
          </footer>
          </article>
        </section>
        <section v-else class="state-card section-empty" data-state="section-empty">
          <h2>{{ activeSection === 'review' ? 'Всё разобрано' : 'История пуста' }}</h2>
          <p v-if="activeSection === 'review'">Новых и частично разобранных обращений нет.</p>
          <p v-else>Здесь появятся пропущенные обращения и созданные задачи.</p>
        </section>
      </template>
      <section v-else-if="payload.channels.length" class="state-card">
        <h2>Очередь пуста</h2>
        <p>Новых и ранее разобранных обращений пока нет.</p>
      </section>
    </template>
  </main>
</template>

<style scoped>
.inbox-page { height: 100%; overflow: auto; padding: 22px; background: var(--ground); }
.page-head { display: flex; gap: 18px; align-items: flex-start; justify-content: space-between; max-width: 1160px; margin: 0 auto 18px; }
h1 { font-size: 24px; margin: 0; } h2 { font-size: 16px; margin: 0 0 8px; }
.page-head p, .channel-card p, .state-card p { color: var(--ink-mid); margin: 4px 0 0; }
.channels, .items, .queue-head, .channel-errors, .banner, .state-card { max-width: 1160px; margin-left: auto; margin-right: auto; }
.channels { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 10px; margin-bottom: 16px; }
.channel-card, .item-card, .state-card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow); }
.channel-card { padding: 14px; }.channel-main, .item-head, .message-head, .actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.pill, .status, .channel-label, .decision { border-radius: 999px; background: var(--surface-2); padding: 2px 8px; font-size: 12px; }
.pill.connected, .pill.active, .status.task { color: var(--good); }.pill.disconnected, .pill.off, .pill.never_activated, .status.skipped { color: var(--ink-mid); }
.pill.degraded, .bad, .read-only { color: var(--bad); }.gap-warning, .warn, .mixed-note, .status.mixed, .pill.deactivated { color: var(--warn); }
.channel-state { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin: 12px 0 8px; }
.channel-state div { display: grid; gap: 5px; padding: 9px; border-radius: 8px; background: var(--surface-2); }
.channel-state dt { color: var(--ink-mid); font-size: 11px; }.channel-state dd { margin: 0; }.channel-state .pill { display: inline-flex; }
.channel-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 10px; }.state-card { padding: 20px; margin-top: 14px; }.banner { padding: 10px 13px; border: 1px solid currentColor; border-radius: 9px; }
.good { color: var(--good); }.items { display: grid; gap: 12px; }.item-card { padding: 16px; }
.queue-head { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin-top: 18px; margin-bottom: 10px; }.queue-head h2 { margin: 0; }
.section-tabs { display: inline-flex; gap: 4px; padding: 3px; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); }
.section-tab { display: inline-flex; align-items: center; gap: 7px; min-height: 34px; padding: 5px 10px; border: 0; border-radius: 7px; color: var(--ink-mid); background: transparent; cursor: pointer; }
.section-tab span { min-width: 19px; padding: 1px 6px; border-radius: 999px; background: var(--surface-2); font-size: 11px; }.section-tab.active { color: var(--ink); background: color-mix(in srgb, var(--accent) 20%, var(--surface-2)); }
.inline-link { color: currentColor; font-weight: 650; margin-left: 6px; }
.item-head .source { color: var(--accent); font-weight: 650; }.item-head .status { margin-left: auto; }.item-card h2 { margin-top: 12px; }
.description { white-space: pre-wrap; }.meta, .selected-count { color: var(--ink-mid); font-size: 12px; }.mixed-note, .item-read-only, .item-alert { padding: 8px 10px; background: var(--surface-2); border-radius: 8px; }
.item-alert { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.item-alert.bad { border: 1px solid color-mix(in srgb, var(--bad) 55%, transparent); }.item-alert.warn { border: 1px solid color-mix(in srgb, var(--warn) 55%, transparent); }
.auto-state { margin: 8px 0; padding: 8px 10px; border-radius: 8px; background: var(--surface-2); font-size: 13px; }
.auto-state.waiting, .auto-state.queued { color: var(--accent); }.auto-state.blocked { color: var(--warn); }.auto-state.off { color: var(--ink-mid); }
.messages { display: grid; gap: 7px; margin: 14px 0; }.message { display: grid; grid-template-columns: 22px minmax(0, 1fr); gap: 8px; padding: 10px; background: var(--surface-2); border: 1px solid var(--line); border-radius: 9px; }
.message input { margin-top: 4px; }.selection-placeholder { color: var(--good); text-align: center; }.message-body { display: grid; gap: 5px; min-width: 0; }
.message-head time { color: var(--ink-mid); font-size: 12px; }.message-text { white-space: pre-wrap; overflow-wrap: anywhere; }.attachments { display: grid; gap: 6px; color: var(--ink-mid); font-size: 12px; }
.attachment-list { display: flex; flex-wrap: wrap; gap: 6px; }.attachment-chip { display: inline-flex; align-items: center; gap: 7px; padding: 5px 8px; border: 1px solid var(--line-2); border-radius: 8px; background: var(--surface); color: var(--ink); }
.attachment-chip small { color: var(--accent); }.attachment-chip[data-analysis="ready"] small, .attachment-chip[data-analysis="completed"] small, .attachment-chip[data-analysis="done"] small { color: var(--good); }.attachment-chip[data-analysis="failed"] small, .attachment-chip[data-analysis="error"] small { color: var(--bad); }
.attachment-note { font-size: 11px; }.attachment-transcript { display: block; padding: 7px 9px; border-left: 2px solid var(--accent); white-space: pre-wrap; color: var(--ink-mid); }
.actions { justify-content: flex-end; }.selected-count { margin-right: auto; }.action-help { flex: 1 1 260px; color: var(--ink-mid); font-size: 12px; text-align: right; }.btn { min-height: 34px; display: inline-flex; align-items: center; padding: 6px 11px; border: 1px solid var(--line-2); border-radius: 8px; color: var(--ink); background: var(--surface-2); cursor: pointer; text-decoration: none; }
.btn:hover:not(:disabled) { border-color: var(--accent); }.btn.accent { background: color-mix(in srgb, var(--accent) 24%, var(--surface)); border-color: var(--accent); }.btn:disabled { opacity: .45; cursor: default; }
@media (max-width: 680px) { .inbox-page { padding: 14px; }.page-head, .queue-head { align-items: center; }.queue-head { align-items: stretch; flex-direction: column; }.section-tabs { display: flex; }.section-tab { flex: 1; justify-content: center; }.actions .btn { flex: 1 1 130px; }.selected-count { flex-basis: 100%; }.action-help { flex-basis: 100%; text-align: left; } }
</style>
