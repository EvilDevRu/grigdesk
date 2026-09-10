<template>
  <main class="inbox-page">
    <header class="page-head">
      <div>
        <h1>Входящие</h1>
        <p>Общая очередь Telegram, GitHub и других подключённых каналов.</p>
      </div>
      <UiButton class="btn" :loading="loading" loading-label="Обновляю" @click="load">Обновить</UiButton>
    </header>

    <section v-if="unavailable" class="state-card" data-state="plugin-disabled">
      <h2>Входящие недоступны</h2>
      <p>Включите системный плагин «Входящие» в разделе «Настройки → Плагины».</p>
    </section>

    <template v-else>
      <p v-if="error" class="banner bad" role="alert">{{ error }}</p>
      <p v-if="notice" class="banner" :class="noticeKind" role="status">{{ notice }}</p>
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
            <UiActionLink v-if="channelSettingsHref(channel.id)" class="btn" :href="channelSettingsHref(channel.id)">
              Подключение и настройки
            </UiActionLink>
            <UiButton v-if="channel.participation !== 'active'" class="btn accent" tone="accent"
                    :disabled="channel.readOnly || !Number.isSafeInteger(channel.activationVersion) || !!busy"
                    @click="changeParticipation(channel, 'activate')">
              {{ channel.participation === 'deactivated' ? 'Возобновить приём новых' : 'Начать принимать новые' }}
            </UiButton>
            <UiButton v-else class="btn"
                    :disabled="channel.readOnly || !Number.isSafeInteger(channel.activationVersion) || !!busy"
                    @click="changeParticipation(channel, 'deactivate')">Остановить приём</UiButton>
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

      <div v-if="loading" class="state-card"><UiSpinner decorative /> Загружаю очередь…</div>
      <template v-else-if="payload.items.length">
        <section class="queue-head" aria-labelledby="inbox-items-title">
          <h2 id="inbox-items-title">Обращения</h2>
          <UiTabs v-model="activeSection" class="section-tabs" label="Разделы входящих">
            <UiTab class="section-tab" value="review" data-section="review">
              К разбору <span>{{ reviewItems.length }}</span>
            </UiTab>
            <UiTab class="section-tab" value="history" data-section="history">
              История <span>{{ historyItems.length }}</span>
            </UiTab>
          </UiTabs>
        </section>
        <section v-if="visibleItems.length" class="items" aria-label="Очередь входящих">
          <article v-for="item in visibleItems" :key="item.ref" class="item-card" :data-status="item.status">
          <header class="item-head">
            <span class="channel-label">{{ item.channel.label }}</span>
            <a v-if="item.source.url" class="source" :href="item.source.url" target="_blank" rel="noreferrer">
              {{ item.source.title }}
            </a>
            <span v-else class="source">{{ item.source.title }}</span>
            <span class="status" :class="item.status">{{ itemStatusLabel(item) }}</span>
          </header>
          <h2>{{ item.title }}</h2>
          <p v-if="item.description" class="description">{{ item.description }}</p>
          <p class="meta">{{ item.project }} · {{ item.kind }} · {{ formatTime(item.firstAt) }}</p>
          <div v-for="auto in autoTaskStates(item)" :key="`${item.ref}:auto`"
               class="auto-state" :class="auto.kind">
            <p>
              <UiSpinner v-if="auto.kind === 'judging'" decorative />
              {{ auto.text }}
            </p>
            <ul v-if="auto.attachments?.length" class="blocked-attachments">
              <li v-for="(attachment, blockedIndex) in auto.attachments"
                  :key="`${item.ref}:blocked:${blockedIndex}`">
                <strong>{{ attachment.label }}</strong>
                <span v-if="attachment.reason"> — {{ attachment.reason }}</span>
              </li>
            </ul>
          </div>
          <p v-if="item.status === 'mixed'" class="mixed-note">
            <template v-if="pendingMessages(item).length">
              Часть сообщений уже разобрана. Выберите новые сообщения для задачи или ранее
              пропущенные, чтобы вернуть их к разбору.
            </template>

            <template v-else>
              Обращение разобрано по частям: у сообщений разные решения. Пропущенные можно
              вернуть к разбору, выбрав их ниже.
            </template>
          </p>
          <p v-if="itemReadOnly(item)" class="read-only item-read-only">
            Канал отключён: это обращение доступно только для чтения.
          </p>
          <div v-for="alert in itemAlertList(item)" :key="`${item.ref}:alert`"
               class="item-alert" :class="alert.kind"
               :role="alert.kind === 'bad' ? 'alert' : 'status'">
            <span>{{ alert.text }}</span>
          </div>

          <div class="messages">
            <div v-for="message in item.messages" :key="message.messageRef" class="message"
                 :class="{ decided: !!message.decision }">
              <UiCheckbox v-if="selectable(message)"
                          :disabled="itemReadOnly(item) || !!busy"
                          :checked="selectedRefs(item).includes(message.messageRef)"
                          :aria-label="`Выбрать сообщение ${message.author.name}`"
                          @update:checked="toggleMessage(item, message.messageRef, $event)" />
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
                    автозадача не создастся, а вручную задача ставится с вашим пояснением.
                  </span>
                  <span v-for="(attachment, attachmentIndex) in message.attachments"
                        :key="`${message.messageRef}:transcript:${attachmentIndex}`">
                    <span v-if="attachmentAnalysis(attachment, item).text" class="attachment-transcript">
                      {{ attachmentAnalysis(attachment, item).text }}
                    </span>
                  </span>
                </span>
              </span>
            </div>
          </div>

          <footer class="actions">
            <span v-if="item.messages.some(selectable)" class="selected-count">
              Выбрано: {{ selectedRefs(item).length }}
            </span>
            <UiActionLink v-for="link in taskLinks(item)" :key="link.url" class="btn task-link"
                          :href="link.url" target="_blank" rel="noreferrer">{{ link.label }}</UiActionLink>
            <template v-if="selectionMode(item) === 'new'">
              <UiButton class="btn accent" tone="accent" :loading="busy === `${item.ref}:task`"
                        :disabled="itemReadOnly(item) || (!!busy && busy !== `${item.ref}:task`)"
                        loading-label="Разбираю и создаю" @click="mutateItem(item, 'task')">Создать задачу</UiButton>
              <UiButton class="btn" :disabled="itemReadOnly(item) || !!busy"
                        @click="mutateItem(item, 'dismiss')">Пропустить</UiButton>
            </template>
            <template v-else-if="selectionMode(item) === 'skipped'">
              <span class="action-help">
                Вернёт выбранные сообщения в «К разбору». Созданные задачи не изменятся.
              </span>
              <UiButton class="btn" :disabled="itemReadOnly(item) || !!busy"
                        @click="mutateItem(item, 'reset')">Вернуть на разбор</UiButton>
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

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import {
  inboxApi,
  inboxBlockedAttachments,
  inboxErrorCode,
  inboxErrorMessage,
  inboxPluginDisabled,
} from '../shared/inboxApi.ts';
import type {
  InboxAttachment,
  InboxBlockedAttachment,
  InboxChannel,
  InboxDecision,
  InboxDecisionInput,
  InboxDecisionResult,
  InboxItem,
  InboxList,
  InboxMessage,
} from '../../../shared/inboxContracts.ts';
import {
  UiActionLink,
  UiButton,
  UiCheckbox,
  UiSpinner,
  UiTab,
  UiTabs,
  confirmDialog,
  promptDialog,
} from '../ui';
import { useSse } from '../composables/useSse.ts';

// Inbox показывает только public projection общего API. Provider identity,
// accountRef и native payload в браузере не нужны и здесь не ожидаются.
const loading = ref(true);
const unavailable = ref(false);
const error = ref('');
const notice = ref('');
// Успех бывает неполным: задача создана, а ответ в исходный чат не ушёл. Это
// не ошибка действия (повторять его нельзя — будет вторая задача), поэтому
// плашка та же, но цветом честно предупреждает.
const noticeKind = ref('good');
const busy = ref('');
const activeSection = ref('review');
const payload = ref<InboxList>({
  items: [],
  channels: [],
  errors: [],
  truncated: false,
  limit: null,
  worker: null,
});
const selection = reactive<Record<string, string[]>>({});
const itemAlerts = reactive<Record<string, {
  kind: string;
  text: string;
  retry?: { revision: string; messageRefs: string[] };
}>>({});
// Набранное пояснение живёт до успешной отправки: карточка может обновиться по
// SSE прямо во время набора, а переписывать абзац заново человек не должен.
const noteDrafts = reactive<Record<string, string>>({});
const nowMs = ref(Date.now());
let loadVersion = 0;
let clockTimer: ReturnType<typeof setInterval> | null = null;

const channelsById = computed(() => new Map(
  payload.value.channels.map((channel) => [channel.id, channel]),
));

// Делит очередь и историю НЕРЕШЁННОЕ СООБЩЕНИЕ, а не статус карточки: разбитая на
// несколько задач карточка полностью покрыта решениями, но остаётся `mixed`. По статусу
// она висела бы в «К разбору» без единой доступной кнопки, а из «Истории» выпадала бы
// вовсе. Правило то же, что у серверного счётчика очереди.
const pendingMessages = (item: InboxItem) => (item.messages || [])
  .filter((message) => !message.decision);
const reviewItems = computed(() => payload.value.items.filter(
  (item) => pendingMessages(item).length > 0,
));
const historyItems = computed(() => payload.value.items.filter(
  (item) => pendingMessages(item).length === 0,
));
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

// Почему автозадачи молчат. Причины разные, и следующий шаг у них разный: у одной не
// выбрана модель, у другой не подключён Битрикс24, у третьей упал сам разбор. Свести
// их к общему «остановлено» значило бы отправить человека искать неисправность вслепую.
const automationNotice = computed(() => {
  const worker = payload.value.worker;

  if (!worker) {
    return null;
  }
  if (worker.readiness === 'no_model') {
    return {
      kind: 'warn',
      text: 'Автозадачи приостановлены: в плагине «Входящие» не выбрана модель разбора.',
      settings: true,
    };
  }
  if (worker.readiness === 'no_b24') {
    return {
      kind: 'warn',
      text: 'Автозадачи приостановлены: Битрикс24 не подключён.',
      settings: false,
    };
  }

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

  if (incompatibleModel.includes(String(worker.readiness))
      || incompatibleModel.includes(String(worker.lastReason))) {
    return {
      kind: 'warn',
      text: 'Автозадачи приостановлены: выбранная модель не поддерживает '
        + 'безопасный разбор входящих.',
      settings: true,
    };
  }
  if (worker.readiness === 'stopped') {
    return {
      kind: 'bad',
      text: 'Автообработчик входящих остановлен.',
      settings: false,
    };
  }
  if (worker.readiness === 'unavailable') {
    return {
      kind: 'bad',
      text: 'Состояние автообработчика временно недоступно.',
      settings: false,
    };
  }
  if (['snapshot_failed', 'tick_failed'].includes(String(worker.lastReason))) {
    return {
      kind: 'bad',
      text: 'Последний автоматический разбор завершился технической ошибкой.',
      settings: false,
    };
  }

  return null;
});

function selectable(message: InboxMessage | undefined): boolean {
  return Boolean(message) && (!message?.decision || message.decision.status === 'skipped');
}

// Ключ выбора: новые сообщения выбираются вместе, а пропущенные — только внутри
// одного решения, иначе возврат к разбору задел бы соседнее чужое решение.
function selectionKey(message: InboxMessage | undefined): string {
  if (!message?.decision) {
    return 'new';
  }
  if (message.decision.status !== 'skipped') {
    return '';
  }

  return `skipped:${message.decision.decisionId}:${message.decision.version}`;
}

/**
 * Выбор внутри одной карточки. Смешивать новые сообщения с пропущенными нельзя:
 * первые становятся задачей, вторые возвращаются к разбору — это разные решения,
 * и общая кнопка на них означала бы два действия под одним нажатием.
 */
function normalizeSelection(item: InboxItem, refs: string[]): string[] {
  const messagesByRef = new Map(item.messages.map((message) => [message.messageRef, message]));
  const allowed = refs.map((ref) => messagesByRef.get(ref)).filter(selectable);
  const key = selectionKey(allowed[0]);

  if (!key) {
    return [];
  }

  const accepted = new Set(allowed.filter((message) => selectionKey(message) === key)
    .map((message) => message?.messageRef));

  return item.messages.map((message) => message.messageRef).filter((ref) => accepted.has(ref));
}

function sameRefs(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((ref, index) => ref === right[index]);
}

// Выбор и плашки живут рядом с карточками: пропавшие уносятся вместе с ними, а у
// выживших выбор пересобирается — сообщение могло стать решённым, пока человек
// смотрел в другую сторону, и прежняя отметка означала бы уже не то же самое.
function syncSelection(items: InboxItem[]): void {
  const live = new Set(items.map((item) => item.ref));

  for (const ref of Object.keys(selection)) {
    if (!live.has(ref)) {
      delete selection[ref];
    }
  }
  for (const ref of Object.keys(itemAlerts)) {
    if (!live.has(ref)) {
      delete itemAlerts[ref];
    }
  }
  for (const item of items) {
    if (Object.hasOwn(selection, item.ref)) {
      selection[item.ref] = normalizeSelection(item, selection[item.ref] || []);
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
        || !sameRefs(retry.messageRefs, selection[item.ref] || []))) {
      delete itemAlerts[item.ref];
    }
  }
}

// Полная перезагрузка раздела. Ответ, пришедший позже своего запроса, отбрасывается:
// SSE и ручное обновление легко обгоняют друг друга, и старый список затёр бы новый
// прямо под руками у человека.
async function load(): Promise<void> {
  const own = ++loadVersion;

  if (!payload.value.items.length && !payload.value.channels.length) {
    loading.value = true;
  }

  try {
    const next = await inboxApi.list();

    if (own !== loadVersion) {
      return;
    }

    payload.value = next;
    syncSelection(next.items);
    unavailable.value = false;
    error.value = '';
  } catch (err) {
    if (own !== loadVersion) {
      return;
    }
    if (inboxPluginDisabled(err)) {
      unavailable.value = true;
      error.value = '';
      payload.value = {
        items: [],
        channels: [],
        errors: [],
        truncated: false,
        limit: null,
        worker: null,
      };
    } else {
      error.value = inboxErrorMessage(err, 'Не удалось загрузить входящие.');
    }
  } finally {
    if (own === loadVersion) {
      loading.value = false;
    }
  }
}

function selectedRefs(item: InboxItem): string[] {
  return selection[item.ref] || [];
}

// Отметка одного сообщения. Новые и пропущенные не смешиваются: отметка другого рода
// сбрасывает прежний выбор, иначе одна кнопка означала бы два разных решения сразу.
function toggleMessage(item: InboxItem, messageRef: string, checked: boolean): void {
  const target = item.messages.find((message) => message.messageRef === messageRef);

  if (!target || !selectable(target)) {
    return;
  }

  const refs = new Set(selectedRefs(item));

  if (checked) {
    const key = selectionKey(target);

    for (const message of selectedMessages(item)) {
      if (selectionKey(message) !== key) {
        refs.delete(message.messageRef);
      }
    }

    refs.add(messageRef);
  } else {
    refs.delete(messageRef);
  }

  selection[item.ref] = normalizeSelection(item, [...refs]);
  delete itemAlerts[item.ref];
}

function selectedMessages(item: InboxItem): InboxMessage[] {
  const refs = new Set(selectedRefs(item));

  return item.messages.filter((message) => refs.has(message.messageRef));
}

function canDecide(item: InboxItem): boolean {
  const messages = selectedMessages(item);

  return messages.length > 0 && messages.every((message) => !message.decision);
}

/**
 * Решение, к которому относится выбор. Вернуть к разбору можно только целое чужое
 * решение: половина пропущенных сообщений одного решения — это уже другое решение,
 * и записывать его поверх прежнего нельзя.
 */
function resetDecision(item: InboxItem): InboxDecision | null {
  const messages = selectedMessages(item);

  if (!messages.length || messages.some((message) => message.decision?.status !== 'skipped')) {
    return null;
  }

  const first = messages[0]?.decision;

  if (!first) {
    return null;
  }

  return messages.every((message) => message.decision?.decisionId === first.decisionId
      && message.decision?.version === first.version)
    ? first
    : null;
}

// Что сейчас можно сделать с выбором: поставить задачу, вернуть к разбору или ничего.
// Шаблон спрашивает об этом одним словом вместо трёх проверок на каждой карточке.
function selectionMode(item: InboxItem): string {
  if (canDecide(item)) {
    return 'new';
  }
  if (resetDecision(item)) {
    return 'skipped';
  }

  return 'none';
}

// Ссылки на созданные задачи. Разбитая на части карточка ведёт в несколько задач,
// поэтому дубли по адресу снимаются, а подпись называет номер только при выборе.
function taskLinks(item: InboxItem) {
  const decisions = [item.decision, ...item.messages.map((message) => message.decision)];
  const seen = new Set();

  return decisions.filter((decision) => {
    if (!decision?.taskUrl || seen.has(decision.taskUrl)) {
      return false;
    }

    seen.add(decision.taskUrl);

    return true;
  }).map((decision, index, links) => ({
    url: String(decision?.taskUrl || ''),
    label: links.length === 1
      ? 'Открыть задачу'
      : `Открыть задачу ${decision?.taskId || index + 1}`,
  }));
}

function itemReadOnly(item: InboxItem): boolean {
  return channelsById.value.get(item.channel?.id)?.readOnly !== false;
}

const notificationReasons: Record<string, string> = Object.freeze({
  unreachable: 'связь с Telegram оборвалась',
  rejected: 'канал отклонил отправку',
  plugin_disabled: 'канал выключен',
});

/**
 * Хвост к «Задача создана», когда ответ в исходный чат не ушёл.
 *
 * Молчать об этом нельзя: автоповтора у ответа нет по замыслу (Bot API не даёт
 * idempotency key, повтор после таймаута прислал бы дубль), значит сообщить в
 * чате придётся человеку — а он об этом узнавал только из журнала сервера.
 * Правило `enabled` уважаем: у чата без галки ответа и не ждали.
 */
function notificationFailure(notification: InboxDecisionResult['notification']): string {
  if (!notification || notification.enabled === false || notification.sent === true) {
    return '';
  }

  const why = notificationReasons[String(notification.reason)];

  return `, но ответ в исходный чат не отправлен${why ? ` (${why})` : ''} — сообщите там сами`;
}

/**
 * Одно решение по карточке: задача, пропуск или возврат к разбору.
 *
 * Ревизия карточки и версия решения уезжают в теле — это оптимистичная блокировка.
 * Отказ по протухшим данным не повторяется вслепую: список перечитывается, а человеку
 * говорят, что обращение изменилось, — слепой повтор создал бы вторую задачу.
 */
async function mutateItem(
  item: InboxItem,
  action: string,
  { operatorNote = '' }: { operatorNote?: string } = {},
): Promise<void> {
  if (busy.value || itemReadOnly(item)) {
    return;
  }

  const messageRefs = [...selectedRefs(item)];
  const body: InboxDecisionInput = { revision: item.revision, messageRefs };

  if (action === 'reset') {
    const decision = resetDecision(item);

    if (!decision) {
      return;
    }

    body.decisionId = decision.decisionId;
    body.decisionVersion = decision.version;
  } else if (!canDecide(item)) {
    return;
  }
  if (action === 'task' && operatorNote) {
    body.operatorNote = operatorNote;
  }

  busy.value = `${item.ref}:${action}`;
  error.value = '';
  notice.value = '';
  noticeKind.value = 'good';
  delete itemAlerts[item.ref];

  try {
    const done = await inboxApi.decide(item.ref, action, body);
    const undelivered = action === 'task' && notificationFailure(done.notification);

    if (undelivered) {
      noticeKind.value = 'warn';
    }

    notice.value = action === 'task' ? `Задача создана${undelivered}`
      : action === 'dismiss' ? 'Обращение пропущено и перенесено в историю'
        : 'Обращение возвращено к разбору';
    delete selection[item.ref];
    delete noteDrafts[item.ref];
    await load();
  } catch (err) {
    const code = inboxErrorCode(err);

    if (['stale_item', 'stale_decision', 'account_changed'].includes(code)) {
      const text = 'Обращение изменилось — данные обновлены';

      delete selection[item.ref];
      await load();

      if (visibleItems.value.some((entry) => entry.ref === item.ref)) {
        itemAlerts[item.ref] = { kind: 'warn', text };
      } else {
        notice.value = text;
      }
    } else if (action === 'task' && !operatorNote
        && ['attachment_analysis_required', 'attachments_skipped'].includes(code)) {
      // Не тупик, а вопрос к человеку: он видел вложение в самом канале и может
      // пересказать суть. Модалка открывается сразу — отдельная плашка с кнопкой
      // означала бы лишний клик ровно там, где решение уже принято.
      openNoteDialog(item, messageRefs, {
        message: inboxErrorMessage(err, 'Содержимое вложений разобрано не полностью.'),
        attachments: inboxBlockedAttachments(err),
      });
    } else {
      itemAlerts[item.ref] = {
        kind: 'bad',
        text: inboxErrorMessage(err, 'Не удалось выполнить действие с обращением.'),
      };
    }
  } finally {
    busy.value = '';
  }
}

/**
 * Пояснение человека вместо содержимого, которое машина не прочитала.
 *
 * Прежняя кнопка «Создать без разбора» ставила задачу из голого текста
 * сообщений: обращение «на видео предложение по доработке» превращалось в
 * задачу без сути. Теперь человек, который видел вложение в самом канале,
 * пересказывает его — и этот текст уходит модели наравне с обращением.
 */
async function openNoteDialog(
  item: InboxItem,
  messageRefs: string[],
  { message, attachments }: { message: string; attachments: InboxBlockedAttachment[] },
): Promise<void> {
  const lines = [message];

  if (attachments.length) {
    lines.push('', 'Не удалось разобрать:');

    for (const attachment of attachments) {
      lines.push(attachment.reason
        ? `• ${attachment.label} — ${attachment.reason}`
        : `• ${attachment.label}`);
    }
  }

  lines.push(
    '',
    'Опишите своими словами, что там было и что нужно сделать.',
    'Текст уйдёт на разбор модели вместе с обращением и попадёт в описание задачи.',
  );

  const answer = await promptDialog({
    title: 'Опишите содержимое вложений',
    text: lines.join('\n'),
    placeholder: 'Например: на видео после сохранения фильтра таблица сбрасывает сортировку…',
    okText: 'Разобрать и создать задачу',
    value: noteDrafts[item.ref] || '',
  });

  if (answer === null) {
    return;
  }

  const note = String(answer).trim();

  // Черновик переживает и пустой ввод, и смену карточки: человек мог написать
  // абзац, и терять его из-за подсказки или гонки с новым сообщением нельзя.
  noteDrafts[item.ref] = note;

  if (!note) {
    itemAlerts[item.ref] = {
      kind: 'warn',
      text: 'Без пояснения задача потеряет суть вложения. '
        + 'Нажмите «Создать задачу» ещё раз и опишите содержимое.',
    };

    return;
  }

  const current = payload.value.items.find((entry) => entry.ref === item.ref);

  if (!current || current.revision !== item.revision
      || !sameRefs(messageRefs, selectedRefs(item))) {
    itemAlerts[item.ref] = {
      kind: 'warn',
      text: 'Обращение или выбор изменились, пока вы писали. Проверьте выбор '
        + 'и нажмите «Создать задачу» — текст пояснения сохранён.',
    };

    return;
  }

  await mutateItem(item, 'task', { operatorNote: note });
}

// Приём новых обращений каналом. Пауза не копит backlog: пришедшее за неё в очередь
// потом не вернётся, поэтому остановка спрашивает подтверждение, а включение — нет.
async function changeParticipation(channel: InboxChannel, action: string): Promise<void> {
  if (busy.value || channel.readOnly || !Number.isSafeInteger(channel.activationVersion)) {
    return;
  }
  if (action === 'deactivate' && !(await confirmDialog(
    'Остановить приём? Сообщения, пришедшие во время паузы, '
    + 'не попадут в очередь после возобновления.',
    { okText: 'Остановить приём' },
  ))) {
    return;
  }

  busy.value = `${channel.id}:${action}`;
  error.value = '';

  try {
    await inboxApi.changeParticipation(channel.id, action, channel.activationVersion);
    notice.value = action === 'activate'
      ? `${channel.label}: приём новых обращений включён.`
      : `${channel.label}: приём остановлен; пауза не станет backlog.`;
    await load();
  } catch (err) {
    error.value = inboxErrorMessage(err, 'Не удалось изменить приём канала.');
  } finally {
    busy.value = '';
  }
}

function statusLabel(status: string): string {
  return ({
    new: 'К разбору',
    mixed: 'Частично разобрано',
    task: 'Задача создана',
    skipped: 'Пропущено',
  })[status] || 'Разобрано';
}

/** «Частично» верно только пока есть что разбирать: разбитая карточка покрыта целиком. */
function itemStatusLabel(item: InboxItem): string {
  if (item.status === 'mixed' && !pendingMessages(item).length) {
    return 'Разобрано по частям';
  }

  return statusLabel(item.status);
}

function connectionLabel(connection: string): string {
  return ({
    connected: 'Подключён',
    disconnected: 'Не подключён',
    degraded: 'Ошибка канала',
  })[connection] || 'Состояние неизвестно';
}

function participationLabel(participation: string): string {
  return ({
    active: 'Включён',
    deactivated: 'На паузе',
    never_activated: 'Не запускался',
  })[participation] || 'Состояние неизвестно';
}

function channelSettingsHref(id: string): string {
  return ({ telegram: '#/telegram', github: '#/github' } as Record<string, string>)[id] || '';
}

// Время приходит и в секундах, и в миллисекундах: у сообщений канала — Unix seconds,
// у служебных отметок кокпита — миллисекунды. Различаем их по величине, а не по полю:
// поле у разных каналов называется по-разному, а порядок величины — общий.
function formatTime(value: number): string {
  const numeric = Number(value);
  const millis = numeric > 0 && numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  const date = new Date(millis);

  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('ru-RU');
}

// Остаток тишины до авторазбора. Секунды показываются только вместе с минутами:
// «через 0 мин» человек читает как «уже сейчас», а это неправда.
function formatRemaining(value: number): string {
  const total = Math.max(1, Math.ceil(value / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;

  if (!minutes) {
    return `${seconds} с`;
  }

  return seconds ? `${minutes} мин ${seconds} с` : `${minutes} мин`;
}

// Размер вложения человеческой единицей. Отрицательное и нечисловое значение — это
// не ноль, а «размер неизвестен»: пустая подпись честнее выдуманных «0 Б».
function formatBytes(value: unknown): string {
  const size = Number(value);

  if (!Number.isFinite(size) || size < 0) {
    return '';
  }
  if (size < 1024) {
    return `${Math.round(size)} Б`;
  }
  if (size < 1024 * 1024) {
    return `${Math.round(size / 1024)} КБ`;
  }

  return `${(size / 1024 / 1024).toFixed(size < 10 * 1024 * 1024 ? 1 : 0)} МБ`;
}

// Подпись вложения: род, имя файла и размер. Имя, повторяющее род, не показывается —
// иначе строка читалась бы как «Фото: Фото» у файлов без собственного названия.
function attachmentLabel(attachment: InboxAttachment): string {
  const kind = String(attachment?.displayLabel || attachment?.kind || 'Вложение').trim();
  const name = String(attachment?.name || '').trim();
  const size = formatBytes(attachment?.size);
  const label = kind || 'Вложение';

  return [name && name !== label ? `${label}: ${name}` : label, size].filter(Boolean).join(' · ');
}

// Ход разбора вложения для человека. Канал мог его вовсе не начинать, поэтому
// подпись всегда есть: она берётся из состояния самой карточки.
function attachmentAnalysis(attachment: InboxAttachment, item: InboxItem) {
  const rawAnalysis = attachment?.attachmentAnalysis ?? attachment?.analysis ?? null;
  const nested = rawAnalysis && typeof rawAnalysis === 'object' ? rawAnalysis : null;
  const status = String(
    (typeof rawAnalysis === 'string' ? rawAnalysis : nested?.status) || attachment?.status || '',
  ).toLowerCase();
  const labels: Record<string, string> = {
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
  const autoTaskDone = item?.status === 'task' && item?.decision?.by === 'auto';
  let fallbackStatus = 'pending';
  let fallbackLabel = 'Будет проверено до задачи';

  if (blocked) {
    fallbackStatus = 'failed';
    fallbackLabel = 'Не удалось разобрать';
  } else if (autoTaskDone) {
    fallbackStatus = 'ready';
    fallbackLabel = 'Содержимое разобрано';
  } else if (item?.status === 'task') {
    fallbackLabel = 'Приложено к задаче';
  } else if (item?.status === 'skipped') {
    fallbackLabel = 'Не разбиралось';
  }

  return {
    status: status || fallbackStatus,
    label: labels[status] || fallbackLabel,
    text: String(nested?.transcript || nested?.text || attachment?.transcript || '').trim(),
  };
}

// Обёртка для шаблона: ноль или один элемент вместо повторных вызовов с проверкой
// на каждой строке. Наличие состояния проверяется один раз, а не четырежды.
function autoTaskStates(item: InboxItem) {
  const state = autoTaskState(item);

  return state ? [state] : [];
}

// То же для плашки обращения: она либо есть, либо её нет.
function itemAlertList(item: InboxItem) {
  const alert = itemAlerts[item.ref];

  return alert ? [alert] : [];
}

// Что происходит с автозадачей этой карточки. Живое состояние воркера сильнее
// расписания: между обратным отсчётом и готовым решением проходят минуты разбора,
// и карточка обязана показывать эту работу, а не молчаливый обратный отсчёт.
function autoTaskState(item: InboxItem) {
  const judging = payload.value.worker?.judging;

  if (judging?.ref === item.ref && ['new', 'mixed'].includes(item.status)) {
    return {
      kind: 'judging',
      text: 'Разбирается прямо сейчас: модель читает обращение '
        + 'и решает, какие задачи создать.',
    };
  }
  if (item.status !== 'new' || !item.autoTask || typeof item.autoTask !== 'object') {
    return null;
  }
  if (item.autoTask.enabled !== true) {
    return {
      kind: 'off',
      text: 'Автосоздание выключено для этого источника.',
    };
  }

  const analysisBlock = analysisBlocksByRef.value.get(item.ref);

  if (analysisBlock) {
    return {
      kind: 'blocked',
      text: 'Вложения не удалось полностью разобрать. Автозадача не создастся; нажмите '
        + `«Создать задачу» и опишите содержимое${
          Number.isSafeInteger(analysisBlock.retryAtMs)
            ? ` либо дождитесь новой попытки после ${formatTime(Number(analysisBlock.retryAtMs))}`
            : ''}.`,
      // Причина у каждого файла своя: потолок Telegram в 20 МБ не лечится
      // ожиданием, а сетевой сбой лечится. Без неё человек не знает, что делать.
      attachments: Array.isArray(analysisBlock.attachments) ? analysisBlock.attachments : [],
    };
  }

  const readyAtMs = Number(item.autoTask.readyAtMs);

  if (Number.isFinite(readyAtMs) && readyAtMs > nowMs.value) {
    return {
      kind: 'waiting',
      text: `Авторазбор через ${formatRemaining(readyAtMs - nowMs.value)} тишины. `
        + 'Новые сообщения продлят ожидание.',
    };
  }

  const readiness = payload.value.worker?.readiness;

  if (readiness && readiness !== 'ready') {
    return {
      kind: 'blocked',
      text: 'Обращение готово к авторазбору, но автоматика приостановлена.',
    };
  }

  return {
    kind: 'queued',
    text: 'Обращение готово к авторазбору. Если модель не уверена, '
      + 'оно останется здесь для ручного решения.',
  };
}

function rememberPluginsTab() {
  localStorage.setItem('cockpit-settings-tab', 'plugins');
}

useSse((name: string) => {
  if (name === 'inbox-changed') {
    void load();
  }
});
onMounted(() => {
  load();
  clockTimer = setInterval(() => {
    nowMs.value = Date.now();
  }, 1000);
  (clockTimer as { unref?: () => void }).unref?.();
});
onBeforeUnmount(() => {
  if (clockTimer) {
    clearInterval(clockTimer);
  }

  clockTimer = null;
});
</script>

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
.section-tabs { display: inline-flex; }
.section-tab { gap: 7px; }
.section-tab span { min-width: 19px; padding: 1px 6px; border-radius: 999px; background: var(--surface-2); font-size: 11px; }
.inline-link { color: currentColor; font-weight: 650; margin-left: 6px; }
.item-head .source { color: var(--accent); font-weight: 650; }.item-head .status { margin-left: auto; }.item-card h2 { margin-top: 12px; }
.description { white-space: pre-wrap; }.meta, .selected-count { color: var(--ink-mid); font-size: 12px; }.mixed-note, .item-read-only, .item-alert { padding: 8px 10px; background: var(--surface-2); border-radius: 8px; }
.item-alert { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.item-alert.bad { border: 1px solid color-mix(in srgb, var(--bad) 55%, transparent); }.item-alert.warn { border: 1px solid color-mix(in srgb, var(--warn) 55%, transparent); }
.auto-state { margin: 8px 0; padding: 8px 10px; border-radius: 8px; background: var(--surface-2); font-size: 13px; }
.auto-state.waiting, .auto-state.queued, .auto-state.judging { color: var(--accent); }.auto-state.blocked { color: var(--warn); }.auto-state.off { color: var(--ink-mid); }
.auto-state p { margin: 0; }
.blocked-attachments { margin: 6px 0 0; padding-left: 18px; color: var(--ink-mid); font-size: 12px; }
.blocked-attachments strong { color: var(--ink); font-weight: 500; }
.messages { display: grid; gap: 7px; margin: 14px 0; }.message { display: grid; grid-template-columns: 22px minmax(0, 1fr); gap: 8px; padding: 10px; background: var(--surface-2); border: 1px solid var(--line); border-radius: 9px; }
.selection-placeholder { color: var(--good); text-align: center; }.message-body { display: grid; gap: 5px; min-width: 0; }
.message-head time { color: var(--ink-mid); font-size: 12px; }.message-text { white-space: pre-wrap; overflow-wrap: anywhere; }.attachments { display: grid; gap: 6px; color: var(--ink-mid); font-size: 12px; }
.attachment-list { display: flex; flex-wrap: wrap; gap: 6px; }.attachment-chip { display: inline-flex; align-items: center; gap: 7px; padding: 5px 8px; border: 1px solid var(--line-2); border-radius: 8px; background: var(--surface); color: var(--ink); }
.attachment-chip small { color: var(--accent); }.attachment-chip[data-analysis="ready"] small, .attachment-chip[data-analysis="completed"] small, .attachment-chip[data-analysis="done"] small { color: var(--good); }.attachment-chip[data-analysis="failed"] small, .attachment-chip[data-analysis="error"] small { color: var(--bad); }
.attachment-note { font-size: 11px; }.attachment-transcript { display: block; padding: 7px 9px; border-left: 2px solid var(--accent); white-space: pre-wrap; color: var(--ink-mid); }
.actions { justify-content: flex-end; }.selected-count { margin-right: auto; }.action-help { flex: 1 1 260px; color: var(--ink-mid); font-size: 12px; text-align: right; }
@media (max-width: 680px) { .inbox-page { padding: 14px; }.page-head, .queue-head { align-items: center; }.queue-head { align-items: stretch; flex-direction: column; }.section-tabs { display: flex; }.section-tab { flex: 1; justify-content: center; }.actions .btn { flex: 1 1 130px; }.selected-count { flex-basis: 100%; }.action-help { flex-basis: 100%; text-align: left; } }
</style>
