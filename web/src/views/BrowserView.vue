<template>
  <section class="browser-workspace ui-workspace" data-ui-workspace :aria-label="t('core.browserTitle')">
    <div v-if="!browser.available" class="browser-empty" role="status">
      <svg class="browser-empty__icon" v-bind="ICON" aria-hidden="true">
        <rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8M12 17v4" />
      </svg>
      <h2>{{ t('core.browserDesktopOnly') }}</h2>
      <p>{{ t('core.browserDesktopHint') }}</p>
    </div>
    <template v-else>
      <div class="browser-tab-row">
        <div v-if="browser.snapshot.tabs.length" ref="tabRow" class="browser-tabs-scroll" @wheel="scrollTabs">
          <UiTabs
            :model-value="selected"
            :label="t('core.browserTabs')"
            data-ui-browser-tabs
            @update:model-value="selectTab"
          >
            <UiPopover
                v-for="tab in browser.snapshot.tabs"
                :key="tab.id"
                :open="contextTab === tab.id"
                has-popup="menu"
                :return-focus="false"
                @update:open="menuState(tab.id, $event)"
                @close="menuClosed($event, tab.id)"
            >
              <template #trigger>
                <div
                    data-ui-browser-tab
                    :data-selected="tab.id === selected"
                    :data-dragging="draggedTab === tab.id"
                    :data-drop="dropTab === tab.id ? dropSide : undefined"
                    draggable="true"
                    @contextmenu.prevent.stop="contextTab = tab.id"
                    @keydown="tabMenuKey($event, tab.id)"
                    @auxclick.middle.prevent="closeTab(tab.id)"
                    @dragstart="startDrag($event, tab.id)"
                    @dragover="overTab($event, tab.id)"
                    @drop="dropOnTab($event, tab.id)"
                    @dragend="endDrag"
                >
                  <UiTab :id="`browser-tab-${tab.id}`" :value="tab.id" controls="browser-page">
                    <svg class="browser-tab-icon" v-bind="ICON" aria-hidden="true">
                      <circle cx="12" cy="12" r="9" />
                      <path d="M3 12h18M12 3a16 16 0 0 1 0 18a16 16 0 0 1 0-18" />
                    </svg>
                    <span class="browser-tab-label" v-tooltip="tabName(tab)">
                      {{ tabName(tab) }}
                    </span>
                  </UiTab>
                  <UiIconButton
                      role="embedded"
                      data-context="workspace-toolbar"
                      :label="t('core.browserCloseNamed', { name: tabName(tab) })"
                      v-tooltip="t('core.browserCloseNamed', { name: tabName(tab) })"
                      @click.stop="closeTab(tab.id)"
                  >
                    <svg v-bind="ICON" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
                  </UiIconButton>
                </div>
              </template>
              <template #default>
                <div class="browser-tab-menu">
                  <UiButton role="menuitem" variant="ghost" @click="tabMenuAction('new', tab.id)">
                    {{ t('core.browserNewTab') }}
                  </UiButton>
                  <UiButton role="menuitem" variant="ghost" @click="tabMenuAction('reload', tab.id)">
                    {{ t('core.browserReload') }}
                  </UiButton>
                  <UiButton role="menuitem" variant="ghost" @click="tabMenuAction('duplicate', tab.id)">
                    {{ t('core.browserDuplicateTab') }}
                  </UiButton>
                  <UiButton role="menuitem" variant="ghost" @click="tabMenuAction('close', tab.id)">
                    {{ t('core.browserCloseTab') }}
                  </UiButton>
                  <UiButton
                      role="menuitem"
                      variant="ghost"
                      :disabled="browser.snapshot.tabs.length < 2"
                      @click="tabMenuAction('others', tab.id)"
                  >
                    {{ t('core.browserCloseOtherTabs') }}
                  </UiButton>
                  <UiButton
                      role="menuitem"
                      variant="ghost"
                      :disabled="browser.snapshot.tabs.at(-1)?.id === tab.id"
                      @click="tabMenuAction('right', tab.id)"
                  >
                    {{ t('core.browserCloseTabsRight') }}
                  </UiButton>
                </div>
              </template>
            </UiPopover>
          </UiTabs>
        </div>
        <div class="browser-tab-row__create">
          <UiIconButton
              role="embedded"
              data-context="workspace-toolbar"
              :disabled="Boolean(browser.busy)"
              :label="t('core.browserNewTab')"
              v-tooltip="t('core.browserNewTab')"
              @click="newTab"
          >
            <svg v-bind="ICON" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
          </UiIconButton>
        </div>
      </div>

      <form class="browser-toolbar" @submit.prevent="submit">
        <div class="browser-toolbar__navigation">
          <UiIconButton
              role="embedded"
              data-context="workspace-toolbar"
              :disabled="!active?.canBack || Boolean(browser.busy)"
              :label="t('core.browserBack')"
              v-tooltip="t('core.browserBack')"
              @click="history('back')"
          >
            <svg v-bind="ICON" aria-hidden="true"><path d="m12 5-7 7 7 7M5 12h14" /></svg>
          </UiIconButton>
          <UiIconButton
              role="embedded"
              data-context="workspace-toolbar"
              :disabled="!active?.canForward || Boolean(browser.busy)"
              :label="t('core.browserForward')"
              v-tooltip="t('core.browserForward')"
              @click="history('forward')"
          >
            <svg v-bind="ICON" aria-hidden="true"><path d="m12 5 7 7-7 7M5 12h14" /></svg>
          </UiIconButton>
          <UiIconButton
              role="embedded"
              data-context="workspace-toolbar"
              :disabled="!active || Boolean(browser.busy)"
              :label="t('core.browserReload')"
              v-tooltip="t('core.browserReload')"
              @click="history('reload')"
          >
            <UiRefreshIcon />
          </UiIconButton>
        </div>
        <div class="browser-address">
          <UiInput
            ref="address"
            v-model="draft"
            type="text"
            autocomplete="off"
            spellcheck="false"
            :aria-label="t('core.browserAddress')"
            :placeholder="t('core.browserAddressPlaceholder')"
            @focus="addressFocused = true"
            @blur="addressFocused = false"
          />
          <UiIconButton
              role="embedded"
              data-context="workspace-toolbar"
              type="submit"
              :disabled="!draft || Boolean(browser.busy)"
              :label="t('core.browserGo')"
              v-tooltip="t('core.browserGo')"
          >
            <svg v-bind="ICON" aria-hidden="true"><path d="m12 5 7 7-7 7M5 12h14" /></svg>
          </UiIconButton>
        </div>
        <div class="browser-toolbar__zoom">
          <UiSelect
            :aria-label="t('core.browserZoom')"
            :model-value="String(active?.zoom ?? 100)"
            :disabled="!active"
            @update:model-value="zoom(Number($event))"
          >
            <option v-for="percent in zoomLevels" :key="percent" :value="String(percent)">
              {{ percent }}%
            </option>
          </UiSelect>
        </div>
      </form>

      <UiInlineMessage v-if="error || browser.error" tone="danger" class="browser-message">
        {{ errorText }}
      </UiInlineMessage>

      <div v-if="browser.preferences.agents" class="browser-control">
        <div class="browser-control__summary">
          <span class="browser-host" :data-phase="browser.hostStatus.phase" role="status" v-tooltip="hostText">
            <i aria-hidden="true"></i>{{ hostLabel }}
          </span>
          <div v-if="active" class="browser-control__context">
            <span v-tooltip="t('core.browserOwner', { name: ownerName(active.owner) })">
              {{ t('core.browserOwner', { name: ownerName(active.owner) }) }}
            </span>
            <span v-tooltip="t('core.browserController', { name: ownerName(active.grantee) })">
              {{ t('core.browserController', { name: ownerName(active.grantee) }) }}
            </span>
          </div>
          <UiButton
              v-if="browser.hostStatus.phase === 'conflict'"
              size="compact"
              @click="browser.retryHost(true)"
          >
            {{ t('core.browserTakeover') }}
          </UiButton>
          <UiButton
              v-else-if="browser.hostStatus.phase === 'error'"
              size="compact"
              @click="browser.retryHost()"
          >
            {{ t('core.browserRetryConnection') }}
          </UiButton>
          <div v-if="active" class="browser-control__actions">
            <UiButton size="compact" @click="pause">
              {{ t(active.paused ? 'core.browserResume' : 'core.browserPause') }}
            </UiButton>
            <UiButton size="compact" @click="revoke">{{ t('core.browserRevoke') }}</UiButton>
            <UiDisclosureButton
                v-model:open="accessExpanded"
                controls="browser-access"
                size="compact"
            >
              {{ t('core.browserGrantTo') }}
            </UiDisclosureButton>
          </div>
        </div>
        <div v-if="active" v-show="accessExpanded" id="browser-access" class="browser-grant">
          <div class="browser-grant__owner">
            <UiSelect
              v-model="chosenOwner"
              :aria-label="t('core.browserGrantTo')"
              :disabled="browser.hostStatus.phase !== 'online'"
            >
              <option value="">{{ t('core.browserChooseOwner') }}</option>
              <option v-for="owner in browser.owners" :key="owner.id" :value="owner.id">{{ owner.label }}</option>
            </UiSelect>
          </div>
          <UiButton size="compact" :disabled="!chosenOwner || grantBusy" @click="grant">
            {{ t('core.browserGrant') }}
          </UiButton>
          <UiIconButton
              role="embedded"
              data-context="workspace-toolbar"
              :label="t('core.browserRefreshOwners')"
              v-tooltip="t('core.browserRefreshOwners')"
              :disabled="browser.hostStatus.phase !== 'online'"
              @click="loadOwners"
          >
            <UiRefreshIcon />
          </UiIconButton>
        </div>
      </div>

      <div
          id="browser-page"
          class="browser-stage"
          role="tabpanel"
          :aria-labelledby="active ? `browser-tab-${active.id}` : undefined"
      >
        <UiInlineMessage v-if="active?.loading" class="browser-message">
          {{ t('core.browserLoading') }}
        </UiInlineMessage>
        <UiInlineMessage v-if="active?.error" tone="danger" class="browser-message">
          {{ t('core.browserPageFailed') }}
        </UiInlineMessage>
        <BrowserViewport v-if="hasPage" :key="active?.id" />
        <div v-else class="browser-empty">
          <svg class="browser-empty__icon" v-bind="ICON" aria-hidden="true">
            <rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M7 6.5h.01M10 6.5h.01" />
          </svg>
          <h2>{{ t('core.browserNewTab') }}</h2>
          <p>{{ t('core.browserEnterAddress') }}</p>
          <span class="browser-empty__shortcut">{{ t('core.browserAddressShortcut') }}</span>
        </div>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { SVGAttributes } from 'vue';

import {
  UiRefreshIcon,
  UiButton,
  UiDisclosureButton,
  UiIconButton,
  UiInlineMessage,
  UiInput,
  UiPopover,
  UiSelect,
  UiTab,
  UiTabs,
  t,
  vTooltip,
} from '../ui.ts';
import { browserAddress } from '../../../shared/browser/browserContract.ts';
import { useBrowserStore } from '../stores/browser.ts';
import { browserOwnerScope } from '../shared/browser/browserUi.ts';
import type { BrowserTab } from '../shared/browser/browserUi.ts';
import BrowserViewport from '../shared/browser/BrowserViewport.vue';

const ICON: SVGAttributes = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  'stroke-width': '1.6',
  'stroke-linecap': 'round',
  'stroke-linejoin': 'round',
};

const browser = useBrowserStore();
const active = computed(() => browser.active);
const draft = ref('');
const addressFocused = ref(false);
const address = ref<InstanceType<typeof UiInput> | null>(null);
const tabRow = ref<HTMLElement | null>(null);
const chosenOwner = ref('');
const accessExpanded = ref(false);
const grantBusy = ref(false);
const error = ref('');
const contextTab = ref('');
const draggedTab = ref('');
const dropTab = ref('');
const dropSide = ref<'before' | 'after'>('before');
const selected = computed(() => active.value?.id ?? '');
const hasPage = computed(() => Boolean(active.value?.url && active.value.url !== 'about:blank'));
const zoomLevels = [25, 50, 75, 100, 125, 150, 175, 200, 250, 300];
let stopNativeIntent: (() => void) | undefined;
let tabObserver: ResizeObserver | null = null;

function tabName(tab: BrowserTab): string {
  return tab.title || (tab.url === 'about:blank' ? '' : tab.url) || t('core.browserNewTab');
}

/**
 * Выбранная вкладка остаётся видна целиком вместе с кнопкой закрытия.
 * Измерение после Vue update учитывает и новый список, и сужение полосы вкладок.
 */
function revealActiveTab(): void {
  void nextTick(() => {
    tabRow.value?.querySelector('[data-ui-browser-tab][data-selected="true"]')
      ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  });
}

/**
 * Интерфейс показывает только проверенную подпись canonical owner scope.
 * Отсутствие владельца отображается как человеческая вкладка без выдачи прав.
 */
function ownerName(value: string | null): string {
  const scope = browserOwnerScope(value);

  return scope ? t(scope.kind === 'chat' ? 'core.browserChatScope' : 'core.browserTaskScope',
    { key: scope.key }) : t('core.browserHuman');
}

const errorText = computed(() => (error.value || browser.error) === 'browser_app_missing'
  ? t('core.browserAppMissing') : (error.value || browser.error) === 'browser_sync_failed'
    ? t('core.browserSyncFailed') : t('core.browserRequestFailed'));
const hostMessages = {
  off: 'core.browserHostOff',
  starting: 'core.browserHostStarting',
  online: 'core.browserHostOnline',
  conflict: 'core.browserHostConflict',
  error: 'core.browserHostError',
} as const;
const hostText = computed(() => t(hostMessages[browser.hostStatus.phase]));
const hostLabel = computed(() => browser.hostStatus.phase === 'online'
  ? t('core.browserAgentsReady') : hostText.value);

/**
 * Ошибки обработчиков остаются в странице и не становятся unhandled rejection Vue.
 * Выбор новой вкладки завершает черновик только после native ACK успешного открытия.
 */
async function action(value: unknown): Promise<boolean> {
  error.value = '';

  try {
    await browser.control(value);

    return true;
  } catch {
    error.value = browser.error || 'browser_request_failed';

    return false;
  }
}

/**
 * Новый адрес не перезаписывает страницу до явного submit человека.
 * Native guest предыдущей вкладки скрывается lifecycle BrowserViewport, а не закрывается.
 */
async function newTab(): Promise<void> {
  if (await action({
    operation: 'open',
    target: 'internal',
    url: '',
    deduplicate: false
  })) {
    draft.value = '';
    await nextTick();
    address.value?.focus();
  }
}

/**
 * Переключение обновляет адрес только после native ACK активной вкладки.
 * Черновик перестаёт считаться focused при явном выборе другого документа.
 */
async function selectTab(id: string | number): Promise<void> {
  if (await action({ operation: 'activate', tabId: String(id) })) {
    addressFocused.value = false;
    draft.value = active.value?.url === 'about:blank' ? '' : active.value?.url ?? '';
  }
}

/**
 * Адрес без схемы или поисковый запрос преобразуется в абсолютный HTTP(S) URL.
 * Выбранная поисковая система берётся из подтверждённых настроек компьютера.
 * Invalid/unknown result не вызывает fallback во внешний браузер.
 */
async function submit(): Promise<void> {
  let url: string;

  try {
    url = browserAddress(draft.value, browser.preferences.search);
  } catch {
    error.value = 'browser_request_failed';

    return;
  }

  const request = !active.value
    ? {
      operation: 'open',
      target: 'internal',
      url,
      deduplicate: false
    }
    : {
      operation: 'navigate',
      tabId: active.value.id,
      url
    };

  if (await action(request)) {
    addressFocused.value = false;
    draft.value = active.value?.url ?? url;
  }
}

async function history(operation: 'back' | 'forward' | 'reload'): Promise<void> {
  if (active.value) {
    await action({ operation, tabId: active.value.id });
  }
}

/**
 * Закрытие сфокусированной кнопки возвращает клавиатуру на оставшуюся вкладку.
 * Если вкладок больше нет, следующий адрес можно сразу набрать в строке ввода.
 */
async function closeTab(tabId: string): Promise<void> {
  const focused = tabRow.value?.contains(document.activeElement);

  if (await action({ operation: 'close', tabId }) && focused) {
    await nextTick();

    const selectedTab = tabRow.value?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');

    if (selectedTab) {
      selectedTab.focus();
    } else {
      address.value?.focus();
    }
  }
}

function menuState(tabId: string, open: boolean): void {
  if (!open && contextTab.value === tabId) {
    contextTab.value = '';
  }
}

function menuClosed(reason: string, tabId: string): void {
  if (reason === 'escape') {
    document.getElementById(`browser-tab-${tabId}`)?.focus();
  }
}

function scrollTabs(event: WheelEvent): void {
  const strip = tabRow.value;

  if (strip && strip.scrollWidth > strip.clientWidth && event.deltaY && !event.ctrlKey) {
    event.preventDefault();
    strip.scrollLeft += event.deltaY;
  }
}

function tabMenuKey(event: KeyboardEvent, tabId: string): void {
  if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') {
    event.preventDefault();
    contextTab.value = tabId;
  }
}

/**
 * Меню действует на указанную вкладку, даже если выбрана другая страница.
 * Групповое закрытие фиксирует список до первого await и останавливается при отказе native.
 */
async function tabMenuAction(
  operation: 'new' | 'reload' | 'duplicate' | 'close' | 'others' | 'right',
  tabId: string,
): Promise<void> {
  contextTab.value = '';

  const tabs = [...browser.snapshot.tabs];
  const index = tabs.findIndex((tab) => tab.id === tabId);
  const tab = tabs[index];

  if (!tab) {
    return;
  }

  if (operation === 'new') {
    await newTab();

    return;
  }

  if (operation === 'reload') {
    await action({ operation: 'reload', tabId });
  } else if (operation === 'duplicate') {
    await action({
      operation: 'open',
      target: 'internal',
      url: tab.url === 'about:blank' ? '' : tab.url,
      deduplicate: false,
    });
  } else {
    const closing = operation === 'others' ? tabs.filter((item) => item.id !== tabId)
      : operation === 'right' ? tabs.slice(index + 1) : [tab];

    if (operation === 'others' && !await action({ operation: 'activate', tabId })) {
      return;
    }

    for (const item of closing) {
      if (!await action({ operation: 'close', tabId: item.id })) {
        break;
      }
    }
  }

  await nextTick();
  tabRow.value?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();

  if (!active.value) {
    address.value?.focus();
  }
}

/**
 * Drag содержит лишь локальный ID вкладки и не принимает перенос с сайта или из другого окна.
 * Начало переноса закрывает меню, чтобы overlay не перехватил drop полосы вкладок.
 */
function startDrag(event: DragEvent, tabId: string): void {
  if (!event.dataTransfer) {
    return;
  }

  contextTab.value = '';
  draggedTab.value = tabId;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', tabId);
}

/**
 * Левая и правая половины вкладки задают точное место вставки.
 * Края прокручиваемой полосы позволяют дотянуть перенос до скрытых вкладок.
 */
function overTab(event: DragEvent, tabId: string): void {
  if (!draggedTab.value || draggedTab.value === tabId || !event.dataTransfer) {
    return;
  }

  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';

  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  const strip = tabRow.value;

  dropTab.value = tabId;
  dropSide.value = event.clientX < rect.left + rect.width / 2 ? 'before' : 'after';

  if (strip) {
    const bounds = strip.getBoundingClientRect();

    if (event.clientX < bounds.left + 32) {
      strip.scrollLeft -= 24;
    } else if (event.clientX > bounds.right - 32) {
      strip.scrollLeft += 24;
    }
  }
}

/**
 * Перестановку подтверждает native-реестр, иначе следующий snapshot отменит порядок.
 * ID соседней вкладки устойчив к закрытию или появлению других вкладок во время drag.
 */
async function dropOnTab(event: DragEvent, tabId: string): Promise<void> {
  if (!draggedTab.value || dropTab.value !== tabId) {
    return;
  }

  event.preventDefault();

  const tabIds = browser.snapshot.tabs.map((tab) => tab.id);
  const beforeId = dropSide.value === 'before' ? tabId : tabIds[tabIds.indexOf(tabId) + 1] ?? null;
  const moving = draggedTab.value;

  endDrag();

  if (moving !== beforeId) {
    await action({
      operation: 'move',
      tabId: moving,
      beforeId,
    });
    revealActiveTab();
  }
}

function endDrag(): void {
  draggedTab.value = '';
  dropTab.value = '';
}

async function zoom(value: number): Promise<void> {
  if (active.value && Number.isFinite(value)) {
    await action({
      operation: 'zoom',
      tabId: active.value.id,
      percent: value
    });
  }
}

/**
 * Пауза и продолжение доступны независимо от занятой агентской очереди.
 * Native синхронно меняет grant epoch перед следующими эффектами.
 */
async function pause(): Promise<void> {
  if (active.value) {
    await action({ operation: active.value.paused ? 'resume' : 'pause', tabId: active.value.id });
  }
}

async function revoke(): Promise<void> {
  if (active.value) {
    await browser.revoke(active.value.id).catch(() => {
      error.value = 'browser_request_failed';
    });
  }
}

async function loadOwners(): Promise<void> {
  await browser.loadOwners().catch(() => {
    error.value = 'browser_request_failed';
  });
}

/**
 * Grant использует захваченные page/grant epochs именно выбранного документа.
 * Переход/отзыв во время запроса обязан дать отказ native, а не разрешение новой странице.
 */
async function grant(): Promise<void> {
  const tab = active.value;

  if (!tab || !chosenOwner.value || grantBusy.value) {
    return;
  }

  grantBusy.value = true;

  try {
    await browser.grant({
      tabId: tab.id,
      ownerId: chosenOwner.value,
      pageEpoch: tab.pageEpoch,
      grantEpoch: tab.grantEpoch,
    });
  } catch {
    error.value = 'browser_request_failed';
  } finally {
    grantBusy.value = false;
  }
}

/**
 * При первом показе читается свежий snapshot, дальнейшие изменения приходят push-ом.
 * После unmount поздний read может обновить metadata, но ни один tab не закрывается.
 */
async function refresh(): Promise<void> {
  if (!browser.available) {
    return;
  }

  try {
    await browser.refresh();
  } catch {
    error.value = 'browser_request_failed';
  }
}

/**
 * Главное окно и guest пересылают лишь фиксированные intents, без JS от сайта.
 * Сочетание не закрывает BrowserWindow и не навигирует основной UI назад.
 */
function shortcut(intent: string): void {
  if (intent === 'address') {
    address.value?.focus();
    address.value?.select();
  } else if (intent === 'new') {
    void newTab();
  } else if (intent === 'close') {
    if (active.value) {
      void closeTab(active.value.id);
    }
  } else if (intent === 'back' || intent === 'forward') {
    void history(intent);
  }
}

/**
 * Preload передаёт только фиксированный intent канала guest, без DOM event.
 * Неизвестный payload не превращается в вызов операции или исполняемый текст.
 */
function onNativeIntent(value: unknown): void {
  if (typeof value === 'string' && ['address', 'new', 'close', 'back', 'forward'].includes(value)) {
    shortcut(value);
  }
}

/**
 * Фиксированные сочетания управляют вкладкой браузера текущего раздела.
 * Ввод IME и неизвестные клавиши сохраняют обычную обработку документа.
 */
function onKey(event: KeyboardEvent): void {
  const key = event.key.toLowerCase();
  const intent = (event.ctrlKey || event.metaKey) && !event.altKey
    ? ({
      l: 'address',
      t: 'new',
      w: 'close'
    } as Record<string, string>)[key]
    : event.altKey && !event.ctrlKey && !event.metaKey
      ? ({ arrowleft: 'back', arrowright: 'forward' } as Record<string, string>)[key] : undefined;

  if (intent && !event.isComposing) {
    event.preventDefault();
    shortcut(intent);
  }
}

watch(() => active.value?.id, () => {
  chosenOwner.value = '';

  draft.value = active.value?.url === 'about:blank' ? '' : active.value?.url ?? '';

  revealActiveTab();
}, { immediate: true });

// Полоса появляется после первой вкладки; каждый её DOM-экземпляр имеет одного наблюдателя.
// Сужение контейнера повторяет прокрутку, даже когда выбранная вкладка не менялась.
watch(tabRow, (element) => {
  tabObserver?.disconnect();
  tabObserver = null;

  if (element && typeof ResizeObserver !== 'undefined') {
    tabObserver = new ResizeObserver(revealActiveTab);
    tabObserver.observe(element);
  }
});

watch(() => active.value?.url, (url) => {
  if (!addressFocused.value) {
    draft.value = url === 'about:blank' ? '' : url ?? '';
  }
});
watch(() => browser.hostStatus.phase, (phase) => {
  if (phase === 'online') {
    void loadOwners();
  }
}, { immediate: true });

onMounted(() => {
  window.addEventListener('keydown', onKey);
  stopNativeIntent = window.grigdeskBrowser?.subscribeIntent(onNativeIntent);
  void refresh();
});
onBeforeUnmount(() => {
  tabObserver?.disconnect();
  window.removeEventListener('keydown', onKey);
  stopNativeIntent?.();
  stopNativeIntent = undefined;
});
</script>

<style scoped>
.browser-workspace {
  container: browser-workspace / inline-size;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: auto;
  background: var(--surface);
}

.browser-tab-row {
  display: flex;
  align-items: center;
  flex: none;
  min-width: 0;
  padding: 4px 12px 0;
  border-bottom: 1px solid var(--line);
  background: var(--surface);
  gap: 4px;
}

.browser-tabs-scroll {
  flex: 0 1 auto;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
}

.browser-tabs-scroll::-webkit-scrollbar {
  display: none;
}

.browser-tab-menu {
  display: grid;
  min-width: 200px;
  gap: 4px;
}

.browser-tab-row__create {
  display: flex;
  flex: none;
  padding-bottom: 4px;
}

.browser-tab-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.browser-tab-icon {
  flex: none;
  width: 14px;
  height: 14px;
}

.browser-toolbar {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) 88px;
  align-items: center;
  flex: none;
  min-width: 0;
  padding: 6px 12px;
  border-bottom: 1px solid var(--line);
  gap: 8px;
}

.browser-toolbar__navigation,
.browser-address,
.browser-control__actions,
.browser-grant {
  display: flex;
  align-items: center;
  min-width: 0;
  gap: 4px;
}

.browser-address > :first-child {
  min-width: 0;
  flex: 1;
}

.browser-toolbar__zoom {
  min-width: 0;
}

.browser-message {
  flex: none;
  margin: 8px 12px;
}

.browser-control {
  flex: none;
  min-width: 0;
  padding: 6px 12px;
  border-bottom: 1px solid var(--line);
  background: var(--surface);
}

.browser-control__summary {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  min-width: 0;
  gap: 8px 16px;
}

.browser-host {
  display: inline-flex;
  align-items: center;
  min-width: 0;
  gap: 6px;
  color: var(--ink-mid);
  font-size: 12px;
  overflow-wrap: anywhere;
}

.browser-host i {
  flex: none;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--idle);
}

.browser-host[data-phase='online'] i {
  background: var(--good);
}

.browser-host[data-phase='starting'] i,
.browser-host[data-phase='conflict'] i {
  background: var(--warn);
}

.browser-host[data-phase='error'] i {
  background: var(--bad);
}

.browser-control__context {
  display: flex;
  flex: 1;
  flex-wrap: wrap;
  min-width: 0;
  gap: 4px 16px;
  color: var(--ink-mid);
  font-size: 12px;
}

.browser-control__context span {
  max-width: 32ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.browser-control__actions {
  flex-wrap: wrap;
}

.browser-grant {
  flex-wrap: wrap;
  max-width: 620px;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--line);
  gap: 8px;
}

.browser-grant__owner {
  min-width: 0;
  flex: 1 1 220px;
}

.browser-stage {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 160px;
}

.browser-empty {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-width: 0;
  padding: 32px 20px;
  text-align: center;
}

.browser-empty__icon {
  width: 36px;
  height: 36px;
  margin-bottom: 16px;
  color: var(--ink-mid);
}

.browser-empty h2 {
  max-width: 420px;
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  line-height: 1.5;
}

.browser-empty p {
  max-width: 420px;
  margin: 8px 0 0;
  color: var(--ink-mid);
  font-size: 13px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}

.browser-empty__shortcut {
  margin-top: 16px;
  color: var(--ink-mid);
  font-size: 12px;
}

@container browser-workspace (max-width: 720px) {
  .browser-control__context {
    flex-basis: calc(100% - 220px);
  }

  .browser-control__actions {
    flex-basis: 100%;
  }
}

@container browser-workspace (max-width: 480px) {
  .browser-toolbar {
    grid-template-columns: minmax(0, 1fr) 88px;
  }

  .browser-address {
    grid-column: 1 / -1;
    grid-row: 1;
  }

  .browser-control__context {
    flex-basis: 100%;
  }

  .browser-grant__owner {
    flex-basis: 100%;
  }
}
</style>
