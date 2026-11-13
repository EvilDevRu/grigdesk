<template>
  <main class="inbox-page ui-workspace"
    :data-perf-pending="loading ? '' : undefined" data-ui-workspace>
    <UiPaneHeader>
      <template #title><h1 class="ui-workspace-title">{{ t('core.navInbox') }}</h1></template>
      <template #actions>
        <UiIconButton :label="t('core.trackerUpdate')" :loading="loading" data-context="workspace-toolbar"
                      :loading-label="t('core.updating')" @click="load">
          <UiRefreshIcon />
        </UiIconButton>
      </template>
    </UiPaneHeader>

    <section v-if="unavailable" class="state-card" data-state="plugin-disabled">
      <h2>{{ t('core.inboxVhodyaschieNedostupny') }}</h2>
      <p>{{ t('core.inboxVklyuchiteSistemnyyPlaginVhodyaschie') }}</p>
    </section>

    <template v-else>
      <div class="inbox-notices">
        <p v-if="error" class="banner bad" role="alert"
    :data-perf-error="!loading && error && !payload.items.length ? '' : undefined">{{ error }}</p>
        <p v-if="automationNotice" class="banner" :class="automationNotice.kind"
          data-state="automation-notice" role="status">
          {{ automationNotice.text }}
          <UiActionLink v-if="automationNotice.settings" href="#/settings" variant="text"
            @click.prevent="openInboxSettings">{{ t('core.inboxVybratModel') }}</UiActionLink>
        </p>
        <p v-if="payload.truncated" class="banner warn"> {{ t('core.inboxPokazanaTolkoChastOcheredi') }} </p>
      </div>

      <details class="channels-disclosure ui-workspace-disclosure"
               data-context="workspace-inline" data-inset="content">
        <summary>
          {{ t('core.inboxChannelsSummary', {
            total: payload.channels.length,
            connected: connectedChannels,
          }) }}
        </summary>
        <section class="channels" :aria-label="t('core.inboxKanalyInbox')">
          <article v-for="channel in payload.channels" :key="channel.id" class="channel-card"
            :data-channel="channel.id">
            <div class="channel-main">
              <strong>{{ channel.label }}</strong>
              <span v-if="channel.plugin === 'disabled'" class="pill off">{{ t('core.inboxPlaginVyklyuchen') }}</span>
            </div>
            <dl class="channel-state">
              <div>
                <dt>{{ t('core.machineConnectionTitle') }}</dt>
                <dd>
                  <span class="pill" :class="channel.connection">{{ connectionLabel(channel.connection) }}</span>
                </dd>
              </div>
              <div>
                <dt>{{ t('core.inboxPriemNovyh') }}</dt>
                <dd>
                  <span class="pill" :class="channel.participation">
                    {{ participationLabel(channel.participation) }}
                  </span>
                </dd>
              </div>
            </dl>
            <p v-if="channel.participation === 'never_activated'"> {{ t('core.inboxPriemEscheNeNachat') }} </p>
            <p v-else-if="channel.participation === 'deactivated'" class="gap-warning"> {{ t('core.inboxSoobscheniyaZaVremyaPauzy') }} </p>
            <p v-else>{{ t('core.inboxNovyeObrascheniyaSrazuPopadayut') }}</p>
            <p v-if="channel.connection !== 'connected'" class="read-only"> {{ t('core.inboxRaneePrinyatyeObrascheniyaDostupny') }} </p>
            <div class="channel-actions">
              <UiActionLink v-if="channelSettingsHref(channel.id)" class="btn" wrap
                :href="channelSettingsHref(channel.id)"> {{ t('core.inboxPodklyuchenieINastroyki') }} </UiActionLink>
              <UiButton v-if="channel.participation !== 'active'" class="btn accent" tone="accent"
                :disabled="channel.readOnly || !Number.isSafeInteger(channel.activationVersion) || !!busy"
                @click="changeParticipation(channel, 'activate')">
                {{ channel.participation === 'deactivated'
                  ? t('core.inboxVozobnovitPriemNovyh') : t('core.inboxNachatPrinimatNovye') }}
              </UiButton>
              <UiButton v-else class="btn"
                :disabled="channel.readOnly || !Number.isSafeInteger(channel.activationVersion) || !!busy"
              @click="changeParticipation(channel, 'deactivate')">{{ t('core.inboxOstanovitPriem') }}</UiButton>
            </div>
          </article>
          <div v-if="!payload.channels.length && !loading" class="state-card">
            <h2>{{ t('core.inboxKanalovPokaNet') }}</h2>
            <p>{{ t('core.inboxVklyuchiteIPodklyuchiteHotya') }}</p>
          </div>
        </section>

      </details>

      <section v-if="payload.errors.length" class="channel-errors" :aria-label="t('core.inboxOshibkiKanalov')">
        <p v-for="entry in payload.errors" :key="`${entry.channel}:${entry.code}`" class="banner bad">
          {{ entry.channel }}: {{ entry.message }}
        </p>
      </section>

      <InboxLoading v-if="loading && !payload.items.length" :label="t('core.inboxZagruzhayuOchered')" :failed="Boolean(error)" />
      <template v-else-if="payload.items.length">
        <div class="inbox-workspace" :data-panel="panel">
          <aside ref="catalog" class="inbox-catalog" :aria-label="t('core.inboxQueueLabel')">
            <div class="catalog-tools">
              <UiTabs v-model="activeSection" class="section-tabs" data-ui-workspace-tabs size="compact"
                :label="t('core.inboxRazdelyVhodyaschih')">
                <UiTab class="section-tab" value="review" data-section="review"> {{ t('core.inboxKRazboru') }} <span>{{ reviewItems.length }}</span>
                </UiTab>
                <UiTab class="section-tab" value="history" data-section="history"> {{ t('core.inboxIstoriya') }} <span>{{ historyItems.length }}</span>
                </UiTab>
              </UiTabs>
              <UiSearchInput v-model="search" :placeholder="t('core.inboxSearchPlaceholder')"
                :aria-label="t('core.inboxSearchLabel')" />
              <UiSelect v-if="payload.channels.length > 1" v-model="channelFilter"
                :aria-label="t('core.inboxChannelFilter')">
                <option value="">{{ t('core.inboxAllChannels') }}</option>
                <option v-for="channel in payload.channels" :key="channel.id" :value="channel.id">
                  {{ channel.label }}
                </option>
              </UiSelect>
            </div>
            <div class="queue-list">
              <UiButton v-for="entry in visibleItems" :key="entry.ref" class="queue-row"
                data-context="workspace-catalog-row" data-inbox-row
                :pressed="selectedItem?.ref === entry.ref"
                :aria-current="selectedItem?.ref === entry.ref ? 'page' : undefined"
                aria-controls="inbox-detail" @click="selectItem(entry)">
                <span class="queue-row-head">
                  <span class="queue-channel">{{ entry.channel.label }}</span>
                  <time class="queue-time">{{ formatTime(entry.lastAt) }}</time>
                </span>
                <strong class="queue-title">{{ displayTitle(entry) }}</strong>
                <span class="queue-source">{{ entry.source.title }}</span>
                <span v-if="previewText(entry)" class="queue-preview">{{ previewText(entry) }}</span>
                <span class="queue-row-foot">
                  <span class="queue-status" :class="entry.status">{{ itemStatusLabel(entry) }}</span>
                  <span class="queue-message-count">
                    {{ t('core.inboxMessageCount', { count: entry.messages.length }) }}
                  </span>
                </span>
              </UiButton>
              <section v-if="!visibleItems.length" class="section-empty" data-state="section-empty">
                <template v-if="filtered">
                  <h2>{{ t('core.inboxNoResults') }}</h2>
                  <p>{{ t('core.inboxNoResultsHint') }}</p>
                  <UiButton variant="text" @click="resetFilters">{{ t('core.inboxResetFilters') }}</UiButton>
                </template>
                <template v-else>
                  <h2>{{ activeSection === 'review' ? t('core.inboxVseRazobrano') : t('core.inboxIstoriyaPusta') }}</h2>
                  <p v-if="activeSection === 'review'">{{ t('core.inboxNovyhIChastichnoRazobrannyh') }}</p>
                  <p v-else>{{ t('core.inboxZdesPoyavyatsyaPropuschennyeObrascheniya') }}</p>
                </template>
              </section>
            </div>
          </aside>
          <section id="inbox-detail" class="inbox-detail" :aria-label="t('core.inboxDetailLabel')">
            <div class="detail-navigation">
              <UiButton variant="text" data-context="workspace-toolbar" @click="showQueue">
                ← {{ t('core.inboxBackToQueue') }}
              </UiButton>
            </div>
            <article v-for="item in selectedItems" :key="item.ref" class="item-card"
              :data-status="item.status">
              <div ref="itemScroll" class="item-scroll">
                <header class="item-head">
                  <span class="channel-label">{{ item.channel.label }}</span>
                  <a v-if="item.source.url" class="source" :href="item.source.url"
                    target="_blank" rel="noreferrer">
                    {{ item.source.title }}
                  </a>
                  <span v-else class="source">{{ item.source.title }}</span>
                  <span class="status" :class="item.status">{{ itemStatusLabel(item) }}</span>
                </header>
                <h2 class="item-title" tabindex="-1">{{ displayTitle(item) }}</h2>
                <p class="meta">{{ item.project }} · {{ item.kind }} · {{ formatTime(item.firstAt) }}</p>
                <details v-if="item.description && item.messages.length" class="source-description">
                  <summary>{{ t('core.inboxSourceDescription') }}</summary>
                  <p class="description">{{ item.description }}</p>
                </details>
                <p v-else-if="item.description" class="description">{{ item.description }}</p>
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
                  <template v-if="pendingMessages(item).length"> {{ t('core.inboxChastSoobscheniyUzheRazobrana') }} </template>

                  <template v-else> {{ t('core.inboxObraschenieRazobranoPoChastyam') }} </template>
                </p>
                <p v-if="itemReadOnly(item)" class="read-only item-read-only"> {{ t('core.inboxKanalOtklyuchenEtoObraschenie') }} </p>
                <div v-for="alert in itemAlertList(item)" :key="`${item.ref}:alert`"
                  class="item-alert" :class="alert.kind"
                  :role="alert.kind === 'bad' ? 'alert' : 'status'">
                  <span>{{ alert.text }}</span>
                </div>

                <div class="messages-heading">
                  <h3>{{ t('core.inboxConversation') }}</h3>
                  <span>{{ t('core.inboxMessageCount', { count: item.messages.length }) }}</span>
                </div>
                <div class="messages">
                  <div v-for="message in item.messages" :key="message.messageRef" class="message"
                    :class="{ decided: !!message.decision }">
                    <UiCheckbox v-if="selectable(message)"
                      :disabled="itemReadOnly(item) || !!busy"
                      :checked="selectedRefs(item).includes(message.messageRef)"
                      :aria-label="t('core.inboxVybratSoobschenieName', { name: message.author.name ?? '' })"
                      @update:checked="toggleMessage(item, message.messageRef, $event)" />
                    <span v-else class="selection-placeholder" aria-hidden="true">✓</span>
                    <span class="message-body">
                      <span class="message-head"><strong>{{ message.author.name }}</strong>
                        <time>{{ formatTime(message.occurredAt) }}</time>
                        <span v-if="message.decision" class="decision">
                          {{ statusLabel(message.decision.status) }}
                        </span>
                      </span>
                      <span class="message-text">{{ message.text || t('core.inboxBezTeksta') }}</span>
                      <span v-if="message.attachments?.length" class="attachments">
                        <span class="attachment-list">
                          <span v-for="(attachment, attachmentIndex) in message.attachments"
                            :key="`${message.messageRef}:${attachmentIndex}`"
                            class="attachment-chip"
                            :data-analysis="attachmentAnalysis(attachment, item).status">
                            <span>{{ attachmentLabel(attachment) }}</span>
                            <small>{{ attachmentAnalysis(attachment, item).label }}</small>
                          </span>
                        </span>
                        <span class="attachment-note"> {{ t('core.inboxPeredZadacheyGrigdeskProverit') }} </span>
                        <span v-for="(attachment, attachmentIndex) in message.attachments"
                          :key="`${message.messageRef}:transcript:${attachmentIndex}`">
                          <span v-if="attachmentAnalysis(attachment, item).text"
                            class="attachment-transcript">
                            {{ attachmentAnalysis(attachment, item).text }}
                          </span>
                        </span>
                      </span>
                    </span>
                  </div>
                </div>
              </div>

              <footer class="actions">
                <span v-if="item.messages.some(selectable)" class="selected-count"> {{ t('core.inboxVybrano') }} {{ selectedRefs(item).length }}
                </span>
                <UiActionLink v-for="link in taskLinks(item)" :key="link.url" class="btn task-link" wrap
                :href="link.url" target="_blank" rel="noreferrer">{{ link.label }}</UiActionLink>
                <template v-if="selectionMode(item) === 'new'">
                  <UiButton class="btn accent" tone="accent" :loading="busy === `${item.ref}:task`"
                    :disabled="itemReadOnly(item) || (!!busy && busy !== `${item.ref}:task`)"
                  :loading-label="t('core.inboxRazbirayuISozdayu')" @click="mutateItem(item, 'task')"> {{ t('core.inboxSozdatZadachu') }} </UiButton>
                  <UiButton class="btn" :disabled="itemReadOnly(item) || !!busy"
                  @click="mutateItem(item, 'dismiss')">{{ t('core.inboxPropustit') }}</UiButton>
                </template>
                <template v-else-if="selectionMode(item) === 'skipped'">
                  <span class="action-help"> {{ t('core.inboxVernetVybrannyeSoobscheniyaV') }} </span>
                  <UiButton class="btn" :disabled="itemReadOnly(item) || !!busy"
                  @click="mutateItem(item, 'reset')">{{ t('core.inboxVernutNaRazbor') }}</UiButton>
                </template>
                <span v-else-if="item.messages.some(selectable)" class="action-help"> {{ t('core.inboxVyberiteSoobscheniyaDlyaDeystviya') }} </span>
              </footer>
            </article>
            <div v-if="!selectedItem" class="detail-empty">
              <svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.5"
                aria-hidden="true">
                <path d="M8 12h32v26H8zM8 27h9l4 5h6l4-5h9M16 19h16M16 23h10" />
              </svg>
              <h2>{{ t('core.inboxChooseItem') }}</h2>
              <p>{{ t('core.inboxChooseItemHint') }}</p>
            </div>
          </section>
        </div>
      </template>
      <section v-else-if="payload.channels.length" class="state-card">
        <h2>{{ t('core.inboxOcheredPusta') }}</h2>
        <p>{{ t('core.inboxNovyhIRaneeRazobrannyh') }}</p>
      </section>
    </template>
  </main>
</template>

<script setup lang="ts">
import InboxLoading from './InboxLoading.vue';

import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { errorMessage } from '../../../shared/lib/errors.ts';

import {
  inboxApi,
  inboxBlockedAttachments,
  inboxErrorCode,
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
} from '../../../shared/inbox/inboxContracts.ts';
import {
  UiActionLink, UiButton, UiCheckbox, UiIconButton, UiRefreshIcon, UiSpinner, UiTab, UiTabs,
  confirmDialog, promptDialog, showToast, UiPaneHeader, UiSearchInput, UiSelect, t, messageRef, uiLocale
} from '../ui';
import { openSettings } from '../shared/settingsNavigation.ts';
import { pluginSettingsTarget } from '../features/settings/pluginPages.ts';
import { usePluginsStore } from '../stores/plugins.ts';
import type { PluginListItem } from '../../../shared/plugins/pluginsContracts.ts';
import { useSse } from '../composables/useSse.ts';

// Inbox показывает только public projection общего API. Provider identity,
// accountRef и native payload в браузере не нужны и здесь не ожидаются.
const loading = ref(true);
const unavailable = ref(false);
const error = ref('');
const busy = ref('');
const activeSection = ref('review');
const search = ref('');
const channelFilter = ref('');
const selectedRef = ref('');
const panel = ref('list');
const catalog = ref<HTMLElement | null>(null);
const itemScroll = ref<HTMLElement[]>([]);
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
const sectionItems = computed(() => (
  activeSection.value === 'history' ? historyItems.value : reviewItems.value
));
const filtered = computed(() => Boolean(search.value.trim() || channelFilter.value));
const connectedChannels = computed(() => payload.value.channels.filter(
  (channel) => channel.connection === 'connected',
).length);
const visibleItems = computed(() => {
  const query = search.value.trim().toLocaleLowerCase();

  return sectionItems.value.filter((item) => {
    if (channelFilter.value && item.channel.id !== channelFilter.value) {
      return false;
    }

    const text = [item.title, item.description, item.project, item.source.title,
      ...item.messages.map((message) => `${message.author.name} ${message.text}`)];

    return !query || text.some((value) => value?.toLocaleLowerCase().includes(query));
  });
});
const selectedItem = computed(() => (
  visibleItems.value.find((item) => item.ref === selectedRef.value) || null
));
const selectedItems = computed(() => selectedItem.value ? [selectedItem.value] : []);

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
      text: t('core.inboxAvtozadachiPriostanovlenyVPlagine'),
      settings: true,
    };
  }
  if (worker.readiness === 'no_b24') {
    return {
      kind: 'warn',
      text: t('core.inboxAvtozadachiPriostanovlenyBitriks24Ne'),
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
      text: t('core.inboxAvtozadachiPriostanovlenyVybrannayaModel'),
      settings: true,
    };
  }
  if (worker.readiness === 'stopped') {
    return {
      kind: 'bad',
      text: t('core.inboxAvtoobrabotchikVhodyaschihOstanovlen'),
      settings: false,
    };
  }
  if (worker.readiness === 'unavailable') {
    return {
      kind: 'bad',
      text: t('core.inboxSostoyanieAvtoobrabotchikaVremennoNedostupno'),
      settings: false,
    };
  }
  if (['snapshot_failed', 'tick_failed'].includes(String(worker.lastReason))) {
    return {
      kind: 'bad',
      text: t('core.inboxPosledniyAvtomaticheskiyRazborZavershilsya'),
      settings: false,
    };
  }

  return null;
});

// Обновления очереди сохраняют открытое обращение по публичной ссылке.
// После его разбора выбирается ближайшая оставшаяся строка, а пустой список возвращает каталог.
watch(visibleItems, (items, previous) => {
  if (items.some((item) => item.ref === selectedRef.value)) {
    return;
  }

  const index = Math.max(0, previous?.findIndex((item) => item.ref === selectedRef.value) ?? 0);

  selectedRef.value = items[Math.min(index, items.length - 1)]?.ref || '';

  if (!items.length) {
    panel.value = 'list';
  }
}, { immediate: true });

watch(() => payload.value.channels, (channels) => {
  if (!channels.some((channel) => channel.id === channelFilter.value)) {
    channelFilter.value = '';
  }
});

/**
 * Открывает переписку без прокрутки всей очереди к новой карточке.
 * Прокрутка подробностей сбрасывается только при явном выборе, а не при SSE-обновлении.
 */
async function selectItem(item: InboxItem): Promise<void> {
  selectedRef.value = item.ref;
  panel.value = 'detail';
  await nextTick();
  itemScroll.value[0]?.scrollTo?.({ top: 0 });

  if (catalog.value && getComputedStyle(catalog.value).display === 'none') {
    itemScroll.value[0]?.querySelector<HTMLElement>('.item-title')?.focus({ preventScroll: true });
  }
}

/**
 * На узком экране возвращает каталог с прежним поиском и выбранной строкой.
 * Фокус восстанавливается после показа панели, чтобы клавиатура не осталась в скрытой переписке.
 */
async function showQueue(): Promise<void> {
  panel.value = 'list';
  await nextTick();
  catalog.value?.querySelector<HTMLElement>('[aria-current="page"]')?.focus();
}

function resetFilters(): void {
  search.value = '';
  channelFilter.value = '';
}

/**
 * Если заголовком стала голая ссылка, использует первую содержательную строку переписки.
 * Адрес остаётся в исходных сообщениях и свёрнутом описании, текст не пересказывается моделью.
 */
function displayTitle(item: InboxItem): string {
  const title = item.title?.trim() || '';

  if (title && !/^https?:\/\/\S+$/u.test(title)) {
    return title;
  }

  return item.messages.flatMap((message) => message.text.split('\n'))
    .map((line) => line.trim())
    .find((line) => line && !/^https?:\/\/\S+$/u.test(line)) || title || t('core.inboxUntitled');
}

function previewText(item: InboxItem): string {
  const text = item.messages.at(-1)?.text.replace(/\s+/gu, ' ').trim() || '';

  return text === displayTitle(item) ? '' : text;
}

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
      error.value = errorMessage(err, t('core.coreNeUdalosZagruzitVhodyaschie'));
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
      ? t('core.openTask')
      : t('core.inboxOtkrytZadachuTaskidindex1', { taskIdindex1: decision?.taskId || index + 1 }),
  }));
}

function itemReadOnly(item: InboxItem): boolean {
  return channelsById.value.get(item.channel?.id)?.readOnly !== false;
}

const notificationReasons: Record<string, string> = Object.freeze({
  get unreachable() {
    return t('core.coreSvyazSTelegramOborvalas');
  },
  get rejected() {
    return t('core.coreKanalOtklonilOtpravku');
  },
  get plugin_disabled() {
    return t('core.coreKanalVyklyuchen');
  },
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

  return t('core.coreNoOtvetVIshodnyy', { whywhy: why ? ` (${why})` : '' });
}

/**
 * Результат действия показывается поверх очереди, чтобы её содержимое не сдвигалось.
 * Неполный успех требует внимания человека и остаётся до закрытия или следующего результата.
 */
function showNotice(text: string, warning = false): void {
  showToast({
    id: 'inbox-action-result',
    scope: 'inbox',
    title: text,
    tone: warning ? 'warning' : 'accent',
    durationMs: warning ? 0 : 8000,
  });
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
  delete itemAlerts[item.ref];

  try {
    const done = await inboxApi.decide(item.ref, action, body);
    const undelivered = action === 'task' && notificationFailure(done.notification);

    showNotice(
      action === 'task' ? t('core.coreZadachaSozdanaUndelivered', { undelivered: undelivered || '' })
        : action === 'dismiss' ? t('core.coreObrascheniePropuschenoIPereneseno')
          : t('core.coreObraschenieVozvraschenoKRazboru'),
      Boolean(undelivered),
    );
    delete selection[item.ref];
    delete noteDrafts[item.ref];
    await load();
  } catch (err) {
    const code = inboxErrorCode(err);

    if (['stale_item', 'stale_decision', 'account_changed'].includes(code)) {
      const text = t('core.inboxObraschenieIzmenilosDannyeObnovleny');

      delete selection[item.ref];
      await load();

      if (visibleItems.value.some((entry) => entry.ref === item.ref)) {
        itemAlerts[item.ref] = { kind: 'warn', text };
      } else {
        showNotice(text, true);
      }
    } else if (action === 'task' && !operatorNote
        && ['attachment_analysis_required', 'attachments_skipped'].includes(code)) {
      // Не тупик, а вопрос к человеку: он видел вложение в самом канале и может
      // пересказать суть. Модалка открывается сразу — отдельная плашка с кнопкой
      // означала бы лишний клик ровно там, где решение уже принято.
      openNoteDialog(item, messageRefs, {
        message: errorMessage(err, t('core.coreSoderzhimoeVlozheniyRazobranoNe')),
        attachments: inboxBlockedAttachments(err),
      });
    } else {
      itemAlerts[item.ref] = {
        kind: 'bad',
        text: errorMessage(err, t('core.coreNeUdalosVypolnitDeystvie')),
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
    lines.push('', t('core.coreNeUdalosRazobrat'));

    for (const attachment of attachments) {
      lines.push(attachment.reason
        ? `• ${attachment.label} — ${attachment.reason}`
        : `• ${attachment.label}`);
    }
  }

  lines.push(
    '',
    t('core.coreOpishiteSvoimiSlovamiChto'),
    t('core.coreTekstUydetNaRazbor'),
  );

  const answer = await promptDialog({
    title: t('core.inboxOpishiteSoderzhimoeVlozheniy'),
    text: lines.join('\n'),
    placeholder: t('core.inboxNaprimerNaVideoPosle'),
    okText: t('core.inboxRazobratISozdatZadachu'),
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
      text: t('core.inboxBezPoyasneniyaZadachaPoteryaet'),
    };

    return;
  }

  const current = payload.value.items.find((entry) => entry.ref === item.ref);

  if (!current || current.revision !== item.revision
      || !sameRefs(messageRefs, selectedRefs(item))) {
    itemAlerts[item.ref] = {
      kind: 'warn',
      text: t('core.inboxObraschenieIliVyborIzmenilis'),
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
    messageRef('core.inboxOstanovitPriemSoobscheniyaPrishedshie'),
    { okText: t('core.inboxOstanovitPriem') },
  ))) {
    return;
  }

  busy.value = `${channel.id}:${action}`;
  error.value = '';

  try {
    await inboxApi.changeParticipation(channel.id, action, channel.activationVersion);
    showNotice(action === 'activate'
      ? t('core.coreLabelPriemNovyhObrascheniy', { label: channel.label })
      : t('core.coreLabelPriemOstanovlenPauza', { label: channel.label }));
    await load();
  } catch (err) {
    error.value = errorMessage(err, t('core.coreNeUdalosIzmenitPriem'));
  } finally {
    busy.value = '';
  }
}

function statusLabel(status: string): string {
  return ({
    new: t('core.videoKRazboru'),
    mixed: t('core.coreChastichnoRazobrano'),
    task: t('core.coreZadachaSozdana'),
    skipped: t('core.corePropuscheno'),
  })[status] || t('core.coreRazobrano');
}

/** «Частично» верно только пока есть что разбирать: разбитая карточка покрыта целиком. */
function itemStatusLabel(item: InboxItem): string {
  if (item.status === 'mixed' && !pendingMessages(item).length) {
    return t('core.coreRazobranoPoChastyam');
  }

  return statusLabel(item.status);
}

function connectionLabel(connection: string): string {
  return ({
    connected: t('settings.connected'),
    disconnected: t('core.trackerNone'),
    degraded: t('core.coreOshibkaKanala'),
  })[connection] || t('settings.unknownStatus');
}

function participationLabel(participation: string): string {
  return ({
    active: t('core.trackerEnabled'),
    deactivated: t('core.coreNaPauze'),
    never_activated: t('core.coreNeZapuskalsya'),
  })[participation] || t('settings.unknownStatus');
}

function channelSettingsHref(id: string): string {
  return ({ telegram: '#/telegram', github: '#/github' } as Record<string, string>)[id] || '';
}

// Время приходит и в секундах, и в миллисекундах: у сообщений канала — Unix seconds,
// у служебных отметок GrigDesk — миллисекунды. Различаем их по величине, а не по полю:
// поле у разных каналов называется по-разному, а порядок величины — общий.
function formatTime(value: number): string {
  const numeric = Number(value);
  const millis = numeric > 0 && numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  const date = new Date(millis);

  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString(uiLocale.value);
}

// Остаток тишины до авторазбора. Секунды показываются только вместе с минутами:
// «через 0 мин» человек читает как «уже сейчас», а это неправда.
function formatRemaining(value: number): string {
  const total = Math.max(1, Math.ceil(value / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;

  if (!minutes) {
    return t('core.interventionTimeoutSeconds', { seconds: seconds });
  }

  return seconds
      ? t('core.coreMinutesMinSecondsS', { minutes: minutes, seconds: seconds })
      : t('core.coreMinutesMin', { minutes: minutes });
}

// Размер вложения человеческой единицей. Отрицательное и нечисловое значение — это
// не ноль, а «размер неизвестен»: пустая подпись честнее выдуманных «0 Б».
function formatBytes(value: unknown): string {
  const size = Number(value);

  if (!Number.isFinite(size) || size < 0) {
    return '';
  }
  if (size < 1024) {
    return t('core.coreRoundsizeB', { roundsize: Math.round(size) });
  }
  if (size < 1024 * 1024) {
    return t('core.coreRoundsize1024Kb', { roundsize1024: Math.round(size / 1024) });
  }

  return t('core.coreTofixedsize101024102410Mb', {
    toFixedsize101024102410: (size / 1024 / 1024).toFixed(size < 10 * 1024 * 1024 ? 1 : 0),
  });
}

// Подпись вложения: род, имя файла и размер. Имя, повторяющее род, не показывается —
// иначе строка читалась бы как «Фото: Фото» у файлов без собственного названия.
function attachmentLabel(attachment: InboxAttachment): string {
  const kind = String(attachment?.displayLabel || attachment?.kind || t('core.inboxVlozhenie')).trim();
  const name = String(attachment?.name || '').trim();
  const size = formatBytes(attachment?.size);
  const label = kind || t('core.inboxVlozhenie');

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
    queued: t('core.inboxZhdetRazbora'),
    pending: t('core.inboxZhdetRazbora'),
    processing: t('core.inboxRazbiraetsya'),
    running: t('core.inboxRazbiraetsya'),
    transcribing: t('core.inboxRazbiraetsya'),
    analyzing: t('core.inboxRazbiraetsya'),
    ready: t('core.inboxSoderzhimoeRazobrano'),
    completed: t('core.inboxSoderzhimoeRazobrano'),
    done: t('core.inboxSoderzhimoeRazobrano'),
    transcribed: t('core.inboxSoderzhimoeRazobrano'),
    failed: t('core.inboxNeUdalosRazobrat'),
    error: t('core.inboxNeUdalosRazobrat'),
    unsupported: t('core.inboxRazborNedostupen'),
    skipped: t('core.inboxRazborNedostupen'),
  };
  const blocked = ['new', 'mixed'].includes(item?.status)
    && analysisBlocksByRef.value.has(item?.ref);
  const autoTaskDone = item?.status === 'task' && item?.decision?.by === 'auto';
  let fallbackStatus = 'pending';
  let fallbackLabel = t('core.inboxBudetProverenoDoZadachi');

  if (blocked) {
    fallbackStatus = 'failed';
    fallbackLabel = t('core.inboxNeUdalosRazobrat');
  } else if (autoTaskDone) {
    fallbackStatus = 'ready';
    fallbackLabel = t('core.inboxSoderzhimoeRazobrano');
  } else if (item?.status === 'task') {
    fallbackLabel = t('core.inboxPrilozhenoKZadache');
  } else if (item?.status === 'skipped') {
    fallbackLabel = t('core.inboxNeRazbiralos');
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
      text: t('core.inboxRazbiraetsyaPryamoSeychasModel'),
    };
  }
  if (item.status !== 'new' || !item.autoTask || typeof item.autoTask !== 'object') {
    return null;
  }
  if (item.autoTask.enabled !== true) {
    return {
      kind: 'off',
      text: t('core.inboxAvtosozdanieVyklyuchenoDlyaEtogo'),
    };
  }

  const analysisBlock = analysisBlocksByRef.value.get(item.ref);

  if (analysisBlock) {
    return {
      kind: 'blocked',
      text: t('core.inboxVlozheniyaNeUdalosPolnostyu', {
        retryAtMs: Number.isSafeInteger(analysisBlock.retryAtMs)
          ? t('core.inboxRetryAfterTime', { time: formatTime(Number(analysisBlock.retryAtMs)) })
          : '',
      }),
      // Причина у каждого файла своя: потолок Telegram в 20 МБ не лечится
      // ожиданием, а сетевой сбой лечится. Без неё человек не знает, что делать.
      attachments: Array.isArray(analysisBlock.attachments) ? analysisBlock.attachments : [],
    };
  }

  const readyAtMs = Number(item.autoTask.readyAtMs);

  if (Number.isFinite(readyAtMs) && readyAtMs > nowMs.value) {
    return {
      kind: 'waiting',
      text: t('core.inboxAvtorazborCherezValueTishiny', { value: formatRemaining(readyAtMs - nowMs.value) }),
    };
  }

  const readiness = payload.value.worker?.readiness;

  if (readiness && readiness !== 'ready') {
    return {
      kind: 'blocked',
      text: t('core.inboxObraschenieGotovoKAvtorazboru'),
    };
  }

  return {
    kind: 'queued',
    text: t('core.inboxObraschenieGotovoKAvtorazboru2'),
  };
}

/**
 * Страница раздела объявлена в карте системных плагинов; исчезнувший плагин
 * честно покажет свою причину на месте, а не пустой список магазина.
 */
async function openInboxSettings(): Promise<void> {
  const plugins = usePluginsStore();

  if (!plugins.loaded) {
    await plugins.load();
  }

  const entry = (plugins.list as PluginListItem[]).find((plugin) => plugin.nav?.path === '/inbox');

  openSettings(entry
    ? pluginSettingsTarget(entry.id, entry.system === true)
    : { pageId: 'automation.inbox' });
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
.inbox-page {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  height: 100%;
  overflow: hidden;
  container: inbox / inline-size;
  background: var(--surface);
}

.inbox-page > :deep(.ui-pane-header) {
  flex: none;
}

.inbox-notices {
  flex: none;
  max-height: 25%;
  overflow: auto;
}

.inbox-notices:empty {
  display: none;
}

.banner {
  margin: 8px 12px;
  padding: 8px 10px;
  border: 1px solid currentColor;
  border-radius: var(--radius-sm);
  overflow-wrap: anywhere;
}

.channels-disclosure {
  flex: none;
  max-height: 35%;
  overflow: auto;
  border-bottom: 1px solid var(--line);
}

.channels {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(280px, 100%), 1fr));
  gap: 12px;
  padding: 12px;
}

.channel-card {
  min-width: 0;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  overflow-wrap: anywhere;
}

.channel-main,
.channel-actions,
.item-head,
.message-head,
.actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.channel-card p,
.state-card p,
.section-empty p,
.detail-empty p {
  margin: 6px 0 0;
  color: var(--ink-mid);
}

.channel-state {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  margin: 12px 0;
}

.channel-state div {
  display: grid;
  gap: 4px;
}

.channel-state dt {
  color: var(--ink-mid);
  font-size: 12px;
}

.channel-state dd {
  margin: 0;
}

.channel-actions {
  margin-top: 12px;
}

.pill,
.status,
.channel-label,
.decision {
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--surface-2);
  font-size: 12px;
}

.pill.connected,
.pill.active,
.status.task,
.queue-status.task {
  color: var(--good);
}

.pill.disconnected,
.pill.off,
.pill.never_activated,
.status.skipped,
.queue-status.skipped {
  color: var(--ink-mid);
}

.pill.degraded,
.bad,
.read-only {
  color: var(--bad);
}

.gap-warning,
.warn,
.mixed-note,
.status.mixed,
.queue-status.mixed,
.pill.deactivated {
  color: var(--warn);
}

.channel-errors {
  flex: none;
  max-height: 20%;
  overflow: auto;
}

.state-card {
  margin: 16px;
  padding: 16px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
}

h2 {
  margin: 0;
  font-size: 16px;
}

.inbox-workspace {
  display: grid;
  grid-template-columns: minmax(300px, 360px) minmax(0, 1fr);
  flex: 1;
  min-width: 0;
  min-height: 0;
}

.inbox-catalog {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  border-right: 1px solid var(--line);
  background: var(--sidebar);
}

.catalog-tools {
  display: grid;
  flex: none;
  gap: 10px;
  padding: 12px;
  border-bottom: 1px solid var(--line);
}

.section-tabs {
  width: 100%;
}

.section-tab span {
  min-width: 18px;
  font-size: 11px;
}

.queue-list {
  flex: 1;
  min-height: 0;
  padding: 6px;
  overflow: auto;
  scrollbar-gutter: stable;
}

.queue-row {
  width: 100%;
  min-width: 0;
  margin-bottom: 3px;
}

.queue-row :deep(.ui-button__label) {
  display: grid;
  gap: 5px;
  min-width: 0;
  text-align: left;
}

.queue-row-head,
.queue-row-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
  font-size: 11px;
  line-height: 18px;
}

.queue-channel {
  color: var(--accent);
}

.queue-time,
.queue-message-count {
  flex: none;
  color: var(--ink-mid);
}

.queue-title,
.queue-preview {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow-wrap: anywhere;
}

.queue-title {
  font-size: 13px;
  line-height: 19px;
  font-weight: 600;
}

.queue-source,
.queue-preview {
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 18px;
}

.queue-source {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.queue-status {
  min-width: 0;
  color: var(--accent);
  overflow-wrap: anywhere;
}

.inbox-detail {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.detail-navigation {
  display: none;
  flex: none;
  padding: 4px 12px;
  border-bottom: 1px solid var(--line);
}

.item-card {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
}

.item-scroll {
  flex: 1;
  min-height: 0;
  padding: 24px clamp(16px, 3cqi, 48px);
  overflow: auto;
  scrollbar-gutter: stable;
}

.item-head .source {
  min-width: 0;
  color: var(--ink-mid);
  overflow-wrap: anywhere;
}

.item-head a.source:hover {
  color: var(--accent);
}

.item-head .status {
  margin-left: auto;
}

.item-title {
  margin: 16px 0 8px;
  font-size: 21px;
  line-height: 1.4;
  overflow-wrap: anywhere;
}

.meta,
.selected-count {
  color: var(--ink-mid);
  font-size: 12px;
  overflow-wrap: anywhere;
}

.meta {
  margin: 0 0 16px;
}

.source-description {
  margin-bottom: 16px;
  color: var(--ink-mid);
}

.source-description summary {
  width: fit-content;
  cursor: pointer;
  font-size: 12px;
}

.description {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.mixed-note,
.item-read-only,
.item-alert,
.auto-state {
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  overflow-wrap: anywhere;
}

.item-alert.bad {
  border: 1px solid color-mix(in srgb, var(--bad) 55%, transparent);
}

.item-alert.warn {
  border: 1px solid color-mix(in srgb, var(--warn) 55%, transparent);
}

.auto-state {
  margin: 12px 0;
  border-left: 2px solid currentColor;
  font-size: 12px;
}

.auto-state.waiting,
.auto-state.queued,
.auto-state.judging {
  color: var(--accent);
}

.auto-state.blocked {
  color: var(--warn);
}

.auto-state.off {
  color: var(--ink-mid);
}

.auto-state p {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
}

.blocked-attachments {
  margin: 6px 0 0;
  padding-left: 18px;
  color: var(--ink-mid);
  font-size: 12px;
}

.blocked-attachments strong {
  color: var(--ink);
  font-weight: 500;
}

.messages-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 24px;
  padding-bottom: 10px;
  color: var(--ink-mid);
  font-size: 12px;
  border-bottom: 1px solid var(--line);
}

.messages-heading h3 {
  margin: 0;
  color: var(--ink);
  font-size: 13px;
  font-weight: 600;
}

.message {
  display: grid;
  grid-template-columns: 22px minmax(0, 1fr);
  align-items: start;
  gap: 12px;
  padding: 16px 0;
  border-bottom: 1px solid var(--line);
}

.message > :first-child {
  margin-top: 2px;
}

.selection-placeholder {
  color: var(--good);
  text-align: center;
}

.message-body {
  display: grid;
  gap: 7px;
  min-width: 0;
}

.message-head {
  gap: 4px 10px;
  overflow-wrap: anywhere;
}

.message-head strong {
  font-size: 13px;
  font-weight: 600;
}

.message-head time {
  color: var(--ink-mid);
  font-size: 11px;
}

.message-text {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.attachments {
  display: grid;
  gap: 6px;
  color: var(--ink-mid);
  font-size: 12px;
}

.attachment-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.attachment-chip {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 7px;
  padding: 5px 8px;
  border: 1px solid var(--line-2);
  border-radius: var(--radius-sm);
  background: var(--surface);
  color: var(--ink);
  overflow-wrap: anywhere;
}

.attachment-chip small {
  color: var(--accent);
}

.attachment-chip[data-analysis='ready'] small,
.attachment-chip[data-analysis='completed'] small,
.attachment-chip[data-analysis='done'] small {
  color: var(--good);
}

.attachment-chip[data-analysis='failed'] small,
.attachment-chip[data-analysis='error'] small {
  color: var(--bad);
}

.attachment-note {
  font-size: 11px;
}

.attachment-transcript {
  display: block;
  padding: 7px 9px;
  border-left: 2px solid var(--accent);
  white-space: pre-wrap;
  color: var(--ink-mid);
}

.actions {
  flex: none;
  justify-content: flex-end;
  padding: 12px 20px;
  border-top: 1px solid var(--line);
  background: var(--topbar);
}

.selected-count {
  margin-right: auto;
}

.action-help {
  flex: 1 1 220px;
  color: var(--ink-mid);
  font-size: 12px;
}

.section-empty {
  padding: 24px 12px;
}

.detail-empty {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 24px;
  text-align: center;
}

.detail-empty svg {
  width: 48px;
  height: 48px;
  margin-bottom: 16px;
  color: var(--ink-mid);
}

@container inbox (max-width: 900px) {
  .inbox-workspace {
    grid-template-columns: minmax(0, 1fr);
  }

  .inbox-workspace[data-panel='list'] > .inbox-detail,
  .inbox-workspace[data-panel='detail'] > .inbox-catalog {
    display: none;
  }

  .inbox-catalog {
    border-right: 0;
  }

  .detail-navigation {
    display: flex;
  }

  .item-scroll {
    padding: 16px;
  }

  .item-title {
    font-size: 18px;
  }

  .actions {
    padding: 10px 12px;
  }

  .actions .btn {
    flex: 1 1 130px;
  }

  .selected-count,
  .action-help {
    flex-basis: 100%;
  }
}

@container inbox (max-width: 360px) {
  .queue-row-head {
    flex-wrap: wrap;
    gap: 0 8px;
  }

  .item-head .status {
    margin-left: 0;
  }

  .message {
    gap: 8px;
  }
}
</style>
