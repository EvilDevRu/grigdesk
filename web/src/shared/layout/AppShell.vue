<template>
  <div class="shell" :class="{ 'without-machine': !hasMachine }">
    <aside v-if="hasMachine" class="sidebar">
      <nav class="nav">
        <router-link v-for="item in nav" :key="item.to" :to="item.to" class="navitem" data-ui-shell-nav active-class="active"
                     :aria-label="navTitle(item)"
                     v-tooltip.right="navTitle(item)">
          <span class="icwrap">
            <svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path :d="ICONS[item.icon]" /></svg>
            <NavigationCount :badge="badges[item.to]" />
          </span>
        </router-link>
        <!-- Плагины: под основными разделами, за разделителем. Состав живёт в «Настройки → Плагины». -->
        <template v-if="pluginNav.length">
          <div class="navsep"></div>
          <router-link v-for="item in pluginNav" :key="item.to" :to="item.to" class="navitem" data-ui-shell-nav active-class="active"
                       :aria-label="navTitle(item)" v-tooltip.right="navTitle(item)">
            <span class="icwrap">
              <svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path :d="ICONS[item.icon] || ICONS.plugin" /></svg>
              <NavigationCount :badge="badges[item.to]" />
            </span>
            </router-link>
        </template>
        <template v-if="toolsNav.length">
          <div class="navsep"></div>
          <UiPopover v-model:open="toolsOpen" class="tools-popover" layer="tools"
                     placement="right-start" :aria-label="t('core.tools')">
          <template #trigger>
          <UiPressable class="navitem tools-trigger" data-ui-shell-nav
                       :class="{ active: toolsActive }" :aria-label="navTitle({ to: '/tools', label: t('core.tools') })"
                       v-tooltip.right="navTitle({ to: '/tools', label: t('core.tools') })">
            <span class="icwrap">
              <svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
                   stroke-linecap="round" stroke-linejoin="round"><path :d="ICONS.tools" /></svg>
              <NavigationCount :badge="badges['/tools']" />
            </span>
          </UiPressable>
          </template>
          <template #default="{ close }">
            <header>
              <strong>{{ t('core.tools') }}</strong>
              <router-link to="/tools" @click="close('action')">{{ t('core.allOnPage') }}</router-link>
            </header>
            <ToolsGrid :items="toolsNav" :badges="badges" @select="close('action')" />
          </template>
          </UiPopover>
        </template>
      </nav>
      <nav class="nav nav-bottom dock-route-nav">
        <router-link v-for="item in dockRouteNav" :key="item.to" :to="item.to" class="navitem" data-ui-shell-nav active-class="active"
                       :aria-label="navTitle(item)" v-tooltip.right="navTitle(item)">
          <span class="icwrap">
            <svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
                 stroke-linecap="round" stroke-linejoin="round"><path :d="ICONS[item.icon]" /></svg>
            <NavigationCount :badge="badges[item.to]" />
          </span>
        </router-link>
      </nav>
    </aside>

    <header data-ui-topbar class="topbar" :class="{ 'window-titlebar': isDesktopMain }">
      <span class="app-mark" aria-label="GrigDesk"><GrigDeskMark class="logo" /></span>
      <!-- Слот действий текущего экрана: сюда разделы телепортируют свои кнопки (TopbarActions) -->
      <div id="tb-slot" class="tb-slot"></div>
      <div class="status">
        <!-- CPU/RAM — самые «дёргающиеся» цифры, поэтому левее всех: их ширина меняется,
             не сдвигая остальные элементы (правый край статуса зафиксирован) -->
        <UiTopbarPanel v-if="sys" :title="t('core.computerResources')">
          <template #meta>{{ t('core.cores', { count: sys.cpu.cores }) }}</template>
          <template #trigger>
            <!-- Опрос не удался — цифры остаются, но честно блекнут: пустое место в шапке
                 выглядело как «метрики пропали», хотя пропала только связь. -->
            <UiPressable class="metric mono" data-context="topbar-metrics"
                         :class="{ stale: sysStale }" :aria-label="sysResourcesLabel">
              <span>
                CPU <b :class="loadClass(sys.cpu.percent)">{{ formatNumber(sys.cpu.percent, uiLocale) }}%</b>
              </span>
              <span class="sep" aria-hidden="true"></span>
              <span>
                RAM <b :class="loadClass(sys.mem!.percent)">
                  {{ formatNumber(sys.mem!.usedGb!, uiLocale) }}/{{ formatNumber(sys.mem!.totalGb!, uiLocale) }}
                </b>
              </span>
              <span v-if="sysResourcesAlarm" class="resources-alarm" aria-hidden="true"></span>
            </UiPressable>
          </template>
          <!-- Разбивка нагрузки полосками: одной строкой «занято 22 из 47» не видно,
               кончилась физическая память или просто лежит холодный swap. -->
          <template #default>
            <ComputerResourcesPanel :metrics="sys" :stale="sysStale" :snapshot-time="sysSnapshotTime" />
          </template>
        </UiTopbarPanel>
        <span v-if="sys" class="sep metric-sep" aria-hidden="true"></span>
        <BoardTimerPopover
          v-if="topbarTimerTasks.length"
          :tasks="topbarTimerTasks"
          :worked-today-hours="workedTodayHours"
          :busy-task-id="timerActionTaskId ?? undefined"
          :error="timerActionError"
          @open-task="openBoardTask"
          @open-board="openBoard"
          @toggle-timer="toggleBoardTimer"
        />
        <span
          v-if="topbarTimerTasks.length && pipelineTopbar.total"
          class="sep"
          aria-hidden="true"
        ></span>
        <PipelineTopbarPopover
          v-if="pipelineTopbar.total"
          :items="notifyWatch.topbarItems"
          :error="notifyWatch.error || ''"
          :icon="ICONS.pipeline!"
          @open-pipeline="openPipeline"
        />
        <span
          v-if="topbarTimerTasks.length || pipelineTopbar.total"
          class="sep"
          aria-hidden="true"
        ></span>
        <AttentionAlerts v-if="workspaceStarted" />
        <!-- Наведения на ряд иконок для чтения лимитов больше нет: свежий снимок сервер
             присылает сам (SSE providers-usage), а раскрытие всплывашки перечитывает
             его на случай оборванного потока и тикает, пока она открыта (см. usageWatch). -->
        <span v-if="runtimeProviders.length" v-svg-pixel-snap class="provbox">
          <span
            v-for="p in runtimeProviders"
            :key="p.id"
            :class="['prov-tip', `prov-${p.id}`]"
          >
            <!-- Общая плитка сохраняет ширину, когда меняются отсчёт и набор лимитов:
                 свежий снимок не сдвигает действия под курсором. -->
            <UiTopbarPanel
              :label="p.name"
              @open="usageWatch.open(p.id)"
              @close="usageWatch.close(p.id)"
            >
              <!-- Клик раскрывает всплывашку на планшете; обновление CLI остаётся ручным. -->
              <template #trigger>
                <UiPressable
                  class="prov"
                  data-context="provider-status"
                  :class="[p.id, {
                    off: !p.available,
                    upd: p.updateAvailable,
                    installing: installation.snapshot.active?.providerId === p.id,
                  }]"
                  :aria-label="provTitle(p)"
                  :style="p.available ? { color: p.color } : null"
                >
                  <span class="prov-mark">
                    <ProviderIcon
                      :provider="p"
                      :size="p.id === 'codex' || p.id === 'claude' ? 14 : 13"
                      equal-height
                    />
                    <span v-if="p.updateAvailable" class="updot" aria-hidden="true"></span>
                    <span v-if="installation.snapshot.active?.providerId === p.id"
                      :aria-label="t('settings.providerInstallationRunning')">⟳</span>
                  </span>
                </UiPressable>
              </template>
              <template #title>
                <b class="ptip-name">{{ p.name }}</b>
                <!-- «доступен» не пишем: это норма. Недоступность — единственный факт
                     шапки, который нельзя потерять вместе со строкой подробностей. -->
                <span v-if="!p.available" class="ptip-off">{{ t('core.unavailable') }}</span>
              </template>
              <template #actions="{ close }">
                <span class="ptip-actions">
                  <span
                    v-if="p.updateAvailable"
                    class="ptip-upd"
                    data-testid="provider-popover-update-dot"
                    v-tooltip="t('core.updateAvailable', { pLatest: p.latest })"
                  ></span>
                  <!-- Ставится по нажатию и отсюда: точка сообщала о новой версии, а идти
                       за ней приходилось в настройки. Ход один на весь GrigDesk, поэтому
                       пока ставится один CLI, кнопки соседей заблокированы. -->
                  <UiIconButton
                    v-if="!p.installed && p.installation?.canInstall
                      || canUpdateCli(p) || installation.snapshot.active?.providerId === p.id"
                    data-context="topbar-popover-update"
                    role="embedded"
                    :label="providerInstallationLabel(p)"
                    v-tooltip="providerInstallationLabel(p)"
                    :disabled="installation.busy && installation.snapshot.active?.providerId !== p.id"
                    @click="startProviderInstallation(p, close)"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
                         stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <path d="M12 3v12 M7 10l5 5 5-5 M4 20h16" />
                    </svg>
                  </UiIconButton>
                  <UiIconButton
                    v-if="installResultNeedsAttention(p)"
                    role="embedded"
                    tone="warning"
                    :label="t('settings.providerInstallationResult')"
                    v-tooltip="t('settings.providerInstallationResult')"
                    @click="showProviderInstallation(p.id, close)"
                  ><span aria-hidden="true">!</span></UiIconButton>
                  <!-- Проверка «прямо сейчас»: фон ходит к вендору раз в пять минут, а
                       человеку иногда нужна цифра этой минуты. Пока идёт пауза после
                       отказа вендора, кнопка гаснет и называет время: клик всё равно
                       вернул бы прошлый снимок, и молчащая кнопка честнее мёртвой. -->
                  <UiIconButton
                    data-context="topbar-popover-refresh"
                    role="embedded"
                    :label="t('core.checkLimitsNow')"
                    v-tooltip="usagePauseOf(p)
                      ? t('core.theVendorRequestedAPauseNextCheck', { value1: usagePauseOf(p) })
                      : t('core.checkLimitsNow')"
                    :disabled="!!usagePauseOf(p)"
                    :loading="prov.usageRefreshing"
                    :loading-label="t('core.checking')"
                    @click="prov.refreshUsage()"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
                         stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1 M20.5 3.5v5.5H15" />
                    </svg>
                  </UiIconButton>
                  <UiIconButton
                    data-context="topbar-popover-settings"
                    role="embedded"
                    :label="t('core.providerSettings')"
                    v-tooltip="t('core.providerSettings')"
                    @click="close('action'); toProviders()"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65"
                         stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <path :d="ICONS.settings" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                  </UiIconButton>
                </span>
              </template>
              <template #default="{ close }">
                <span class="ptip">
                  <!-- Итог установки виден, только когда он что-то значит: успех и так
                       виден пропавшим предложением обновиться. -->
                  <span
                    v-if="updateNoteOf(p)"
                    class="pu-state"
                    :class="updateNoteOf(p)!.type === 'err' ? 'is-bad' : 'is-warn'"
                  >{{ updateNoteOf(p)!.text }}</span>
                  <!-- Беда лимитов — СВЕРХУ и со ссылкой на состояние вендора: снизу её
                       читали уже после того, как начинали гадать о причине сбоя. -->
                  <span v-if="usageOf(p)!.message" class="pu-state" :class="`is-${usageOf(p)!.tone}`">
                    <span>{{ usageOf(p)!.message }}</span>
                    <!-- Срок паузы — рядом с отказом: «временно ограничил» без «до когда»
                         оставляло человека гадать, ждать минуту или час. -->
                    <span v-if="usagePauseOf(p)">{{ t('core.nextCheck') }} {{ usagePauseOf(p) }}.</span>
                    <span v-if="statusHintOf(p)" class="pu-status">
                      {{ statusHintOf(p)!.text }}
                      <UiActionLink
                        data-context="topbar-popover-status-link"
                        :href="statusHintOf(p)!.url"
                        variant="text"
                        target="_blank"
                      >{{ statusHintOf(p)!.host }}</UiActionLink>
                    </span>
                    <UiButton
                      v-if="usageOf(p)!.action"
                      data-context="topbar-popover-action"
                      variant="outline"
                      @click.stop="close('action'); runUsageAction(usageOf(p)!.action)"
                    >
                      {{ usageOf(p)!.action!.label }}
                    </UiButton>
                  </span>
                  <span v-if="usageOf(p)!.stale" class="pu-reset">{{ t('core.limitDataIsStale') }}</span>
                  <!-- Потребление лимитов подписки — как /usage в CLI -->
                  <span class="pu">
                    <span
                      v-for="b in usageOf(p)!.bars"
                      :key="b.key"
                      class="pu-row"
                      :class="{ 'pu-split': b.separated }"
                    >
                      <span class="pu-head">
                        <span class="pu-name">
                          {{ b.label }}
                          <!-- Ведро, которого раньше не было: появление нового лимита
                               иначе замечается только случайно. Гаснет само. -->
                          <span v-if="b.fresh" class="pu-new" v-tooltip="t('core.thisLimitBucketAppearedRecently')">{{ t('core.new') }}</span>
                        </span>
                        <b :class="{ hot: b.pct! >= 85 }"
                           v-tooltip="t('core.usedOfWindow', { value1: usedUsagePercent(b.pct), bLabel: b.label })"
                        >{{ usedUsagePercent(b.pct) }}</b>
                      </span>
                      <span class="pu-bar"><span class="pu-fill" :class="{ hot: b.pct! >= 85 }" :style="{ width: Math.min(100, b.pct!) + '%' }"></span></span>
                      <!-- Отсчёт отвечает «скоро ли», дата — «во сколько»: планировать по
                           одному «через 4 д» нельзя. Полоса своей ширины не меняет, поэтому
                           вторая половина уходит к правому краю, а не удлиняет строку. -->
                      <span v-if="b.note || resetIn(b.resetsAt, undefined, uiLocale)" class="pu-reset">
                        <span>{{ b.note || resetIn(b.resetsAt, undefined, uiLocale) }}</span>
                        <span v-if="!b.note && resetAt(b.resetsAt, undefined, uiLocale)" class="pu-reset-at">
                          {{ resetAt(b.resetsAt, undefined, uiLocale) }}
                        </span>
                      </span>
                    </span>
                    <!-- Слот плагинов под полосами: кто здесь стоит, решают реестр размещений
                         и настройки плагинов, всплывашка ни одного из них не знает. -->
                    <PluginSlot name="provider.popover.after-bars" :context="{ providerId: p.id }" />
                    <!-- Доплата и прочие ресурсы аккаунта — только на чтение: менять их
                         можно в «Настройках → Исполнители», кнопка на них ведёт ниже. -->
                    <ProviderUsageResources
                      :provider-id="p.id"
                      :resources="usageOf(p)!.resources"
                      readonly
                    />
                  </span>
                </span>
              </template>
            </UiTopbarPanel>
          </span>
        </span>
        <span v-if="runtimeProviders.length && sys?.net" class="sep" aria-hidden="true"></span>
        <UiTopbarPanel v-if="sys?.net" :title="t('core.network')">
          <template #trigger>
            <UiPressable class="netbox mono" data-context="topbar-network" :aria-label="t('core.networkInformation')">
              <span class="flag">{{ flagOf(sys.net!.countryCode) }}</span>
            </UiPressable>
          </template>
          <template #default>
            {{ t('core.brainPublicIP') }} {{ sys.net!.ip }}
            <template v-if="sys.net!.country"> · {{ sys.net!.country }}</template>
          </template>
        </UiTopbarPanel>
      </div>
      <!-- Колокольчик — над стопкой тостов: ушедшее само оповещение можно найти здесь. -->
      <div class="topbar-actions">
        <ConnectionButton :icon="ICONS.connection" />
        <PhoneConnectButton />
        <AlertHistoryPopover />
        <UiIconButton v-if="active" variant="link" role="rail" data-context="topbar-action"
          :label="t('settings.settings')" v-tooltip="t('settings.settings')"
          aria-haspopup="dialog" :pressed="settings.isOpen"
          @click="openSettings()">
        <svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65"
             stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path :d="ICONS.settings" />
          <circle cx="12" cy="12" r="3" />
        </svg>
        </UiIconButton>
      </div>
    </header>

    <main class="content" :class="{ 'is-workspace': !hasMachine || route.meta.layout === 'workspace' }"
          :inert="toolDock.isExpanded" :aria-hidden="toolDock.isExpanded ? 'true' : undefined">
      <slot />
    </main>
    <ToolHost v-if="workspaceStarted" />
    <PhoneConnectDialog />
    <ProviderInstallDialog />

  </div>
</template>

<script setup lang="ts">
import { formatNumber, intlLocale } from '../../../../shared/i18n/formats.ts';
import { uiLocale } from '../../ui.ts';

import { t } from '../../ui.ts';

import { isRecord } from '../../../../shared/lib/objects.ts';
import { failureText } from '../apiClient.ts';
import type { BoardTask } from '../boardContracts.ts';

import { installAlertDeepLinks, openAlertTarget } from '../alertDeepLinks.ts';
import ConnectionButton from './ConnectionButton.vue';
import ComputerResourcesPanel from './ComputerResourcesPanel.vue';
import { loadClass, resourcesAlarm } from './resourceMetrics.ts';
import PhoneConnectButton from './PhoneConnectButton.vue';
import ProviderInstallDialog from '../ProviderInstallDialog.vue';
import { useProviderInstallStore } from '../../stores/providerInstall.ts';
import { usePhoneAccessStore } from '../../stores/phoneAccess.ts';
import PhoneConnectDialog from '../../views/settings/PhoneConnectDialog.vue';
import { setAlertTargetOpener } from '../alerts.ts';
import { ref, computed, onUnmounted, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useRoute, useRouter } from 'vue-router';
import {
  UiActionLink,
  UiButton,
  UiIconButton,
  UiPopover,
  UiTopbarPanel,
  UiPressable,
  vTooltip,
} from '../../ui';
import { useSse } from '../../composables/useSse.ts';
import { useSystemStore } from '../../stores/system.ts';
import { useProvidersStore } from '../../stores/providers.ts';
import { isTopbarProvider } from '../../../../shared/chat/executorTypes.ts';
import { localizeProviderAuthLabel } from '../../features/providers/providerLocale.ts';
import { usePluginsStore } from '../../stores/plugins.ts';
import { useStudio3dStore } from '../../stores/studio3d.ts';
import { useAuthStore } from '../../stores/auth.ts';
import { useNotifyWatchStore } from '../../stores/notifyWatch.ts';
import { useGrigDeskUpdateStore } from '../../stores/grigdeskUpdate.ts';
import { useChatStore } from '../../stores/chat.ts';
import { useBoardStore } from '../../stores/board.ts';
import { useTasksStore } from '../../stores/tasks.ts';
import { useUiStore } from '../../stores/ui.ts';
import { startInboxSummary, stopInboxSummary, useInboxStore } from '../../actions/inbox';
import { useDockStore } from '../../stores/dock.ts';
import {
  providerStatusHint,
  providerUsageView,
  resetAt,
  resetIn,
} from '../../features/providers/providerUsage.ts';
import { usedUsagePercent } from '../../features/providers/providerUsageSummary';
import {
  aggregateNavBadges,
  chatNavBadge,
  inboxNavBadge,
  pipelineNavBadge,
  shelfNavBadge,
} from '../navBadges.ts';
import { useTaskShelfStore } from '../../stores/taskShelf.ts';
import NavigationCount from './NavigationCount.vue';
import BoardTimerPopover from '../../features/board/BoardTimerPopover.vue';
import PipelineTopbarPopover from '../../features/pipeline/PipelineTopbarPopover.vue';
import ProviderIcon from '../ProviderIcon.vue';
import { vSvgPixelSnap } from '../svgPixelSnap.ts';
import GrigDeskMark from '../GrigDeskMark.vue';
import ProviderUsageResources from '../../features/providers/ProviderUsageResources.vue';
import PluginSlot from '../../plugins/PluginSlot.vue';
import { createUsageWatch } from '../../features/providers/usageWatch.ts';
import AttentionAlerts from '../../features/analysis/AttentionAlerts.vue';
import AlertHistoryPopover from '../../features/alerts/AlertHistoryPopover.vue';
import ToolHost from './ToolHost.vue';
import ToolsGrid from './ToolsGrid.vue';
import { toolById } from '../tools/registry.ts';
import { useToolLauncher } from '../tools/launcher.ts';
import { openSettings } from '../settingsNavigation.ts';
import { useSettingsStore } from '../../stores/settings.ts';
import { useShellStore } from '../../stores/shell.ts';
import { currentDesktopMode } from '../desktopSettings.ts';

const props = defineProps({
  active: {
    type: Boolean,
    default: true,
  },
});

type TopbarProvider = ReturnType<typeof useProvidersStore>['providers'][number];
type NavLink = { to: string; label: string };

const workspaceStarted = ref(props.active);
const isDesktopMain = currentDesktopMode() === 'main';

const settings = useSettingsStore();
const shell = useShellStore();
const hasMachine = computed(() => !shell.present || Boolean(shell.profile));
const route = useRoute();
const router = useRouter();
const ui = useUiStore();
const toolDock = useDockStore();
const { data: sys, stale: sysStale, updatedAt: sysUpdatedAt } = storeToRefs(useSystemStore());
// Время последнего удачного снимка метрик — для подсказки «устарело».
const sysSnapshotTime = computed(() => (sysUpdatedAt.value
  ? new Date(sysUpdatedAt.value).toLocaleTimeString(intlLocale(uiLocale))
  : '—'));
// Снимок обновления общий для настроек и уведомлений. Оболочка запускает опрос
// и перечитывает его по серверному событию; поток SSE один на вкладку.
const grigDeskUpdate = useGrigDeskUpdateStore();

// Реестр LLM-исполнителей — иконки доступных агентов в топбаре.
const prov = useProvidersStore();
const installation = useProviderInstallStore();
// Setup-only карточки (сейчас Kimi) живут в настройках, но не изображают работающего
// чат-исполнителя в шапке до появления transport-а и каталога моделей.
const runtimeProviders = computed(() => prov.providers.filter(isTopbarProvider));
const plugins = usePluginsStore();

const studio3d = useStudio3dStore();
const studioAuth = useAuthStore();

// Подписка живёт вместе с авторизованной оболочкой, включая переходы между страницами.
// Disable и logout закрывают requests; повторный start не создаёт вторую SSE подписку.
watch(() => [studioAuth.authenticated, studioAuth.clientScope, plugins.loaded, plugins.enabled('studio3d')],
  ([authenticated, clientScope, loaded, enabled]) => {
    if (authenticated && loaded && enabled) {
      void studio3d.start(String(clientScope));
    } else {
      studio3d.stop();
    }
  }, { immediate: true });
onUnmounted(() => studio3d.stop());

const inboxStore = useInboxStore();

watch(() => (props.active && plugins.loaded ? plugins.enabled('inbox') : null), (enabled) => {
  if (enabled) {
    startInboxSummary();
  } else {
    stopInboxSummary();
  }
}, { immediate: true });
onUnmounted(() => stopInboxSummary());
// Каталог Codex зависит не только от версии CLI, но и от rollout/доступа аккаунта.
// Пока приложение открыто, перечитываем реестр раз в минуту: новая модель появляется
// в селекторе без F5 и без обновления GrigDesk.
const providersTimer = setInterval(() => {
  if (props.active) {
    void prov.load();
  }
}, 60_000);

if (typeof providersTimer === 'object' && 'unref' in providersTimer) {
  (providersTimer as { unref?: () => void }).unref?.();
}

onUnmounted(() => clearInterval(providersTimer));

/**
 * Подсказка провайдера объединяет собственные подписи с неизменёнными данными каталога.
 * Она вычисляется при показе, сохраняя текущий язык верхней панели.
 */
function provTitle(p: TopbarProvider) {
  return t('core.caption', {
    pName: p.name,
    pVendor: p.vendor,
    value3: p.available ? t('core.available') : t('core.unavailable'),
    pAuthLabel: localizeProviderAuthLabel(p, uiLocale),
  })
    + (p.version ? ` · ${p.version}` : '');
}
// Кнопка выбирает страницу в общей сессии, не меняя маршрут и текущий инструмент.
// Popover закрывается вызывающей кнопкой до запроса открытия модала.
const { openTerminal } = useToolLauncher();

function toProviders() {
  openSettings({ pageId: 'agents.providers' });
}

const usageOf = (p: TopbarProvider) => providerUsageView(prov.usage[p.id], p, uiLocale);
// Пауза после «стучитесь реже»: сервер кладёт её срок в retryAt снимка. Пока она идёт,
// принудительная проверка вернёт прошлый снимок — кнопка гаснет и называет время. Формат
// тот же, что у сброса полосы: «сегодня 03:45», и в прошлом он пуст — пауза снята.
const usagePauseOf = (p: TopbarProvider) => {
  const usage = prov.usage[p.id];

  return usage?.state === 'rate_limited' ? resetAt(usage.retryAt, undefined, uiLocale) : '';
};
// Основной источник свежести — фоновый тик сервера (SSE providers-usage). Открытая
// всплывашка перечитывает лимиты сама на случай оборванного потока: force обходит
// минутный троттл стора, а серверный кэш остаётся — он и стережёт частоту походов
// в API вендора, поэтому такое чтение к вендору не ходит.
const usageWatch = createUsageWatch(() => prov.loadUsage(true));

onUnmounted(() => usageWatch.stop());
// Кнопка установки во всплывашке: только у отставшего CLI, который GrigDesk умеет ставить
// сам. Пока идёт установка, кнопка остаётся на месте — иначе она исчезла бы вместе с
// ходом, который сама и начала, и человек не понял бы, ставится ли ещё.
/**
 * Первая установка ещё не имеет latest, поэтому её подпись не подставляет пустую версию.
 * Активный статус остаётся доступным действием повторного открытия общего окна.
 */
function providerInstallationLabel(p: TopbarProvider): string {
  if (installation.snapshot.active?.providerId === p.id) {
    return t('settings.providerInstallationRunning');
  }
  if (!p.installed) {
    return t('settings.providerInstallationInstall');
  }

  return p.latest ? t('core.updateTo', { pLatest: p.latest }) : t('settings.providerInstallationUpdate');
}

/**
 * Всплывашка закрывается до подтверждения и открытия установки.
 * Её верхний слой не должен закрывать команду и шаги нового окна на телефоне.
 */
function startProviderInstallation(p: TopbarProvider, close: () => void): void {
  close();
  void installation.requestInstall(p.id, p.installed ? 'update' : 'install');
}

/**
 * Просмотр уже сохранённого результата открывает то же окно без нового запуска.
 * Исходная всплывашка освобождает экран, как и при первом открытии.
 */
function showProviderInstallation(id: string, close: () => void): void {
  close();
  installation.show(id);
}

/**
 * Сервер хранит последний итог бессрочно, поэтому кнопка итога во всплывашке видна только
 * пока итог требует действия: отказ, прерывание, предупреждение или вход после первой установки.
 * Удачное обновление объявлять нечем — оно закончено, а полный итог остаётся в настройках.
 */
function installResultNeedsAttention(p: TopbarProvider): boolean {
  const result = installation.snapshot.recent[p.id];

  if (!result || installation.snapshot.active?.providerId === p.id) {
    return false;
  }

  return result.status !== 'succeeded' || result.warnings.length > 0
    || (result.operation === 'install' && !p.available);
}

function canUpdateCli(p: TopbarProvider) {
  return Boolean(p.installed && p.canUpdate && (p.updateAvailable || prov.updating === p.id));
}
// Итог установки во всплывашке: показываем отказ и «ничего не изменилось». Удачную
// установку объявлять нечем — предложение обновиться просто исчезает, а полный текст
// («Обновлён: X → Y») живёт в плашке настроек, где у него есть своя строка.
function updateNoteOf(p: TopbarProvider) {
  const result = prov.updateResults[p.id];

  return result && (result.type === 'err' || result.changed === false) ? result : null;
}
// Куда смотреть при сбое вендора. Домен объявляет адаптер исполнителя, поэтому
// всплывашка не знает ни одного вендорского адреса.
const statusHintOf = (p: TopbarProvider) => providerStatusHint(p, prov.usage[p.id] || {}, uiLocale);

function runUsageAction(action: { kind: string; command?: string } | null | undefined) {
  if (action?.kind !== 'terminal' || !action.command) {
    return;
  }

  openTerminal({ insert: action.command });
}

const sysResourcesAlarm = computed(() => resourcesAlarm(sys.value));
const sysResourcesLabel = computed(() => sysResourcesAlarm.value
  ? `${t('core.computerResources')} · ${t('core.resourcesAlarm')}`
  : t('core.computerResources'));

// Эмодзи-флаг из ISO-кода страны (2 буквы → региональные индикаторы).
function flagOf(cc: string | null | undefined) {
  if (!cc || cc.length !== 2) {
    return '🏳';
  }

  return cc.toUpperCase().replace(/[A-Z]/g, (c) => String.fromCodePoint(127397 + c.charCodeAt(0)));
}

// ── Бейджи в навигации ──
// Правило одно на все разделы: жёлтый пульсирующий — работа СТОИТ, пока не подойду;
// красный — что-то сломалось и ждёт разбора; синий — просто «посмотри, когда сможешь».

// Чаты: сколько чатов ждут МЕНЯ (агент задал вопрос и стоит) и сколько просто
// непрочитано. Ждущие важнее — их бейдж перекрывает непрочитанные.
const chatStore = useChatStore();

// Тост и системное оповещение ведут в одно место: открывалку ставит оболочка,
// а командные параметры ссылки поглощает общий обработчик.
const alertLinkDeps = {
  route,
  router,
  chat: chatStore,
  ui,
};
let stopAlertLinks: (() => void) | null = null;

setAlertTargetOpener((target) => openAlertTarget(target, alertLinkDeps));
onUnmounted(() => {
  stopAlertLinks?.();
  setAlertTargetOpener(null);
});
// Таймеры доски показаны в топбаре: оттуда можно открыть задачу и управлять учётом.
// При паузе сохраняем строку, чтобы таймер можно было сразу продолжить.
const boardStore = useBoardStore();
const taskStore = useTasksStore();
const recentPausedTimerIds = ref<string[]>([]);
const timerActionTaskId = ref<string | null>(null);
const timerActionError = ref('');
const boardTasks = computed(() => boardStore.data?.tasks || []);
const workedTodayHours = computed(() => boardStore.data?.today?.hours ?? 0);
const topbarTimerTasks = computed(() => {
  const recentIds = new Set(recentPausedTimerIds.value);

  return boardTasks.value.filter((task) => (
    task.timerRunning || recentIds.has(String(task.id))
  ));
});

function openBoardTask(taskId: string | number) {
  ui.openTask(taskId);
}

function openBoard() {
  router.push('/board');
}

function openPipeline() {
  router.push('/pipeline');
}

/**
 * Переключает таймер через общий B24-store. Поставленную здесь паузу запоминаем,
 * чтобы строка не исчезла и человек мог сразу продолжить учёт времени кнопкой play.
 */
async function toggleBoardTimer(task: BoardTask) {
  if (timerActionTaskId.value !== null) {
    return;
  }

  const taskId = String(task.id);
  const action = task.timerRunning ? 'pause' : 'start';
  const wasRemembered = recentPausedTimerIds.value.includes(taskId);

  timerActionTaskId.value = taskId;
  timerActionError.value = '';

  if (action === 'pause' && !wasRemembered) {
    recentPausedTimerIds.value = [...recentPausedTimerIds.value, taskId];
  }

  try {
    await taskStore.timer(task.id, action);

    if (action === 'start') {
      recentPausedTimerIds.value = recentPausedTimerIds.value.filter((id) => id !== taskId);
    }
  } catch (error) {
    if (action === 'pause' && !wasRemembered) {
      recentPausedTimerIds.value = recentPausedTimerIds.value.filter((id) => id !== taskId);
    }

    timerActionError.value = failureText(error, t('core.couldNotToggleTheTimer'));
  } finally {
    timerActionTaskId.value = null;
  }
}

// Конвейер: один классифицированный список питает и три числа popover, и его видимость.
// В боковой навигации считаем только вмешательство, а в топбаре сохраняем обычную работу.
const notifyWatch = useNotifyWatchStore();

// Каркас приложения доступен до готовности сервера, включая кнопку выбора машины.
// Загрузки и панели с API запускаются после входа; потеря связи сохраняет уже открытые инструменты.
watch(() => props.active, (active) => {
  if (!active) {
    grigDeskUpdate.stop();

    return;
  }

  workspaceStarted.value = true;

  if (!stopAlertLinks) {
    stopAlertLinks = installAlertDeepLinks(alertLinkDeps);
  }

  void chatStore.ensure();
  grigDeskUpdate.start();
  void plugins.load();
  void prov.load();
  void prov.loadUsage();
  notifyWatch.start();
}, { immediate: true });

const pipelineTopbar = computed(() => {
  return {
    total: notifyWatch.topbarItems.length,
  };
});
const shelfStore = useTaskShelfStore();
const badges = computed(() => {
  const out: Record<string, ReturnType<typeof chatNavBadge>> = inboxNavBadge(
    { reviewCount: inboxStore.reviewCount }, uiLocale,
  );
  const unseen = boardStore.activity.unseenCount;

  out['/chats'] = chatNavBadge(chatStore, uiLocale);
  out['/pipeline'] = pipelineNavBadge(notifyWatch.badgeSummary, uiLocale);
  out['/shelf'] = shelfNavBadge(shelfStore.rows, uiLocale);
  out['/board'] = unseen ? {
    n: unseen,
    kind: 'info',
    title: t('core.newTasks', { unseen: unseen }),
  } : null;

  const toolsBadge = aggregateNavBadges(toolsNav.value.map((item) => ({
    label: item.label,
    badge: out[item.to],
  })));

  if (toolsBadge) {
    out['/tools'] = toolsBadge;
  }

  return out;
});


function navTitle(item: NavLink) {
  const detail = badges.value[item.to]?.title;

  return detail ? `${item.label} · ${detail}` : item.label;
}

const ICONS: Record<string, string> = {
  connection: 'M4 5h16v10H4z M8 20h8 M12 15v5',
  cube: 'M12 2l9 5v10l-9 5-9-5V7z M12 22V12 M21 7l-9 5-9-5',
  board: 'M3 3h7v7H3z M14 3h7v7h-7z M14 14h7v7h-7z M3 14h7v7H3z',
  pipeline: 'M6 3v12 M15 6a3 3 0 1 0 6 0 3 3 0 1 0-6 0 M3 18a3 3 0 1 0 6 0 3 3 0 1 0-6 0 M18 9a9 9 0 0 1-9 9',
  // Горка песка с песчинками буквально обозначает песочницу.
  sandbox: 'M3 20h18 M4 20c4-2 5-8 8-8s4 6 8 8 M9 5h.01 M14 3h.01 M12 8h.01 M9 17h.01 M15 18h.01',
  chats: 'M8 10h8 M8 14h5 M7 4h10a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H9l-4 4v-4a3 3 0 0 1-1-2V7a3 3 0 0 1 3-3z',
  routes: 'M9 3 3 6v15l6-3 6 3 6-3V3l-6 3-6-3z M9 3v15 M15 6v15',
  projects: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z',
  code: 'M9 8l-4 4 4 4 M15 8l4 4-4 4',
  shelf: 'M4 5v14 M20 5v14 M4 9h16 M4 15h16 M8 5v4 M16 9v6 M10 15v4',
  video: 'M15 8l6-4v16l-6-4V8z M3 6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6z',
  // Самолётик со складкой крыла: знак Телеграма узнаётся именно по ней, без неё
  // получается обычная кнопка «отправить».
  telegram: 'M20.4 5.2 4 11.6l5.3 2 1.7 5.2 2.5-3 4.1 3.1z M9.3 13.6 20.4 5.2 13.5 15.8',
  inbox: 'M4 4h16v12a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V4z M4 13h4l2 3h4l2-3h4',
  github: 'M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.87c-2.78.6-3.37-1.18-3.3'
    + '7-1.18-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.'
    + '53 1.03.9 1.53 2.34 1.09 2.91.83.09-.65.35-1.09.64-1.34-2.22-.25-4.56-1.11-4'
    + '.56-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.64 0 0 .84-.27 2.75 1.'
    + '02A9.6 9.6 0 0 1 12 6.84a9.6 9.6 0 0 1 2.5.34c1.91-1.29 2.75-1.02 2.75-1.02.'
    + '55 1.37.2 2.39.1 2.64.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36'
    + '.31.68.92.68 1.86v2.74c0 .27.18.58.69.48A10 10 0 0 0 12 2z',
  terminal: 'M4 5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z M7 9l3 3-3 3 M13 15h4',
  tools: 'M4 4h6v6H4z M14 4h6v6h-6z M4 14h6v6H4z M14 14h6v6h-6z',
  settings: 'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-'
    + '.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.09a2 2 0 0 1 1 1.74v.51'
    + 'a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.0'
    + '8a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-'
    + '.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38'
    + 'a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.51a2 2 0 0 1 1-1.74l.15-.09a'
    + '2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.2'
    + '5a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z',
  plugin: 'M4 7h3a2 2 0 1 1 4 0h3v3a2 2 0 1 1 0 4v3h-3a2 2 0 1 0-4 0H4v-3a2 2 0 1 0 0-4V7z',
};
// Основные разделы сохраняют прежние адреса и порядок при смене языка.
const nav = [
  {
    to: '/board',
    get label() {
      return t('core.board');
    },
    icon: 'board',
  },
  {
    to: '/pipeline',
    get label() {
      return t('core.pipeline');
    },
    icon: 'pipeline',
  },
  {
    to: '/sandboxes',
    get label() {
      return t('core.sandboxes');
    },
    icon: 'sandbox',
  },
  {
    to: '/chats',
    get label() {
      return t('settings.chats');
    },
    icon: 'chats',
  },
  {
    to: '/routes',
    get label() {
      return t('core.routes');
    },
    icon: 'routes',
  },
  {
    to: '/projects',
    get label() {
      return t('core.projects');
    },
    icon: 'projects',
  },
];
// Плагины в сайдбаре: включённые и с СУЩЕСТВУЮЩЕЙ страницей во фронте. У системных
// страница собрана в бандл, у пользовательских — своя папка web, которую ведёт общий
// роут /ext/:id; пункт с мёртвой ссылкой хуже отсутствующего — такие скрываем.
const routeExists = (item: NavLink) => router.resolve(item.to).matched.length > 0;
const pluginNav = computed(() => plugins.railNav.filter(routeExists));
const toolsNav = computed(() => plugins.toolsNav.filter(routeExists));
// До 900 px правой рейки нет, поэтому dock-инструменты становятся обычными
// route-ссылками. Незарегистрированную Vue-панель скрываем fail-closed.
const dockRouteNav = computed(() => [
  ...plugins.dockNav.filter((item) => routeExists(item) && toolById(plugins, item.id)),
  {
    id: 'terminal',
    to: '/terminal',
    sourceLabel: 'Терминал',
    get label() {
      return t('core.terminal');
    },
    icon: 'terminal',
    order: 30,
  },
].sort((a, b) => (a.order || 0) - (b.order || 0)
  || (('sourceLabel' in a ? a.sourceLabel : '') || a.label)
    .localeCompare(('sourceLabel' in b ? b.sourceLabel : '') || b.label, 'ru')));

const toolsOpen = ref(false);
const toolsActive = computed(() => route.path === '/tools'
  || toolsNav.value.some((item) => item.to === route.path));

watch(() => route.fullPath, () => {
  toolsOpen.value = false;
});

const phoneAccess = usePhoneAccessStore();

const { connected } = useSse((name, data) => {
  if (name === 'mobile-changed' && phoneAccess.open) {
    void phoneAccess.refresh().catch(() => {});
  }


  if (name === 'state-change') {
    notifyWatch.check();
  }
  // Фоновая проверка нашла новую версию CLI — подтягиваем реестр, чтобы зажечь индикатор.
  if (name === 'providers-update') {
    if (isRecord(data) && typeof data.credentials === 'string' && data.credentials) {
      void prov.invalidateCredentials(data.credentials);
    } else {
      void prov.load();
    }
  }
  // Фоновый тик сервера принёс свежие лимиты — полосы в шапке идут за ними без наведения.
  if (name === 'providers-usage') {
    prov.applyUsage(isRecord(data) ? data.usage : undefined);
  }
  if (name === 'grigdesk-update') {
    grigDeskUpdate.load({ quiet: true });
  }
});

watch(connected, (value) => prov.noteUsageConnection(value), { immediate: true, flush: 'sync' });
</script>

<style scoped>
.shell {
  display: grid; height: 100%; min-width: 0; overflow: hidden;
  grid-template-columns: var(--app-rail-w) minmax(0, 1fr) var(--app-rail-w);
  grid-template-rows: max(var(--app-topbar-h), env(titlebar-area-height, 0px)) minmax(0, 1fr);
}

.shell.without-machine {
  grid-template-columns: 0 minmax(0, 1fr) 0;
}

/* ── Сайдбар ── */
.sidebar {
  grid-row: 2; grid-column: 1;
  background: var(--sidebar); border-right: 1px solid var(--line);
  display: flex; flex-direction: column; padding: 4px 0; scrollbar-width: none;
  min-height: 0; overflow-y: auto;
}
.nav { display: flex; flex-direction: column; align-items: center; gap: 4px; flex: none; padding-block: 0; }
.navsep { width: 14px; height: 1px; margin: 6px 8px; background: var(--line); }
.navitem {
  display: flex; align-items: center; justify-content: center; flex: none;
}
.ic { width: 16px; height: 16px; flex: none; }
/* Счётчик занимает свою строку под рисунком внутри прежней кнопки 30 px.
   Общий NavigationCount одинаково оформляет числа в обеих рейках. */
.icwrap { display: grid; justify-items: center; align-content: center; gap: 1px; }
.nav-bottom { margin-top: auto; }
.dock-route-nav { display: none; }
/* ── Топбар ── */
.topbar {
  grid-row: 1; grid-column: 1 / -1;
  display: flex; align-items: center; justify-content: flex-start; gap: 8px;
  padding: 0;
  /* Нижняя линия не участвует в высоте: ось содержимого совпадает с серединой
     топбара и системных кнопок окна, а не поднимается на половину её толщины. */
  box-shadow: inset 0 -1px 0 var(--line);
  background: linear-gradient(100deg,
    color-mix(in srgb, var(--accent) 10%, var(--topbar)) 0%,
    var(--topbar) 42%, var(--surface) 100%);
}
/* Геометрия системных кнопок приходит от Electron с учётом стороны и масштаба.
   Свободная часть шапки двигает окно; группы с действиями сохраняют события мыши. */
.window-titlebar {
  padding-left: env(titlebar-area-x, 0px);
  padding-right: max(0px, calc(100% - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100%)));
  -webkit-app-region: drag;
  user-select: none;
}
.window-titlebar :is(.tb-slot, .status, .topbar-actions) {
  -webkit-app-region: no-drag;
}
.app-mark {
  display: grid; place-items: center; flex: none; width: var(--app-rail-w); height: 100%;
}
.app-mark .logo { width: 16px; height: 16px; color: var(--ink); }
/* Слот действий экрана — сразу после заголовка; статус уезжает вправо */
.tb-slot { display: flex; align-items: center; gap: 8px; min-width: 0; overflow: hidden; }
.tb-slot:empty { display: none; }
.status { margin-left: auto; }
.status {
  display: flex;
  height: 100%;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  /* Текст центрируется по той же оси, что и иконки: при 1.4 строка 12px
     давала дробный сдвиг глифов вверх, особенно заметный при масштабе экрана. */
  line-height: 1;
  white-space: nowrap;
}
.topbar-actions { display: flex; align-items: center; flex: none; gap: 0; }
.stale-note { color: var(--warn); border-top: 0; padding-top: 4px; }
/* Разделитель не зависит от шрифта: центр и отступы задаёт та же flex-строка.
   Внутри метрик и между группами используется одна геометрия без отрицательных полей. */
.sep {
  flex: none;
  width: 1px;
  height: 12px;
  background: var(--line-2);
}
.provbox { display: inline-flex; align-items: center; gap: 0; }
/* Нулевая высота строки убирает baseline-зазор SVG. ProviderIcon с equal-height
   центрирует видимые рисунки и уравнивает их высоту, сохраняя пропорции каждого знака. */
.prov-tip {
  display: inline-flex;
  align-items: center;
  line-height: 0;
  vertical-align: middle;
}
/* Точка обновления привязана к рисунку, а не к большой площадке нажатия.
   Обёртка сохраняет это положение при изменении размера и пропорций логотипа. */
.prov-mark { position: relative; display: inline-flex; }
.updot { position: absolute; top: -2px; right: -3px; width: 6px; height: 6px; border-radius: 50%;
  background: var(--warn, #e0a33a); box-shadow: 0 0 0 2px var(--surface); }
/* Шапка всплывашки: короткое имя слева, точка обновления — справа. */
.ptip-name { color: var(--ink); font-weight: 600; }
.ptip-off { color: var(--bad); font-size: 11px; }
/* Точка обновления и переход в настройки живут одной группой у правого края: имя
   слева тянется, а расстояние между индикатором и шестерёнкой не зависит от длины имени. */
.ptip-actions { display: inline-flex; align-items: center; gap: 7px; margin-left: auto; }
/* Та же точка, что и в плашке настроек: обновление ручное, поэтому это индикатор. */
.ptip-upd { flex: none; width: 7px; height: 7px; border-radius: 50%;
  background: var(--warn, #e0a33a); }
/* Ссылка на состояние вендора идёт за текстом одной строкой, а не отдельным блоком.
   Цвет нейтральный: тревожный тон блока — про НАШУ беду с лимитами, а слова вендора о
   своём состоянии («о сбое не сообщает») красным читались бы как ещё одна поломка. */
.pu-status { display: block; color: var(--ink-mid); }
/* Содержимое общей плитки: состояние, лимиты и дополнительные ресурсы. */
.ptip { display: flex; flex-direction: column; gap: 12px; min-width: 0; text-align: left; }
.pu { display: flex; flex-direction: column; gap: 14px; }
.pu-row { display: flex; flex-direction: column; gap: 4px; }
.pu-head { display: flex; justify-content: space-between; align-items: baseline; font-size: 11.5px; color: var(--ink-mid); }
.pu-head b { color: var(--ink); font-variant-numeric: tabular-nums; }
.pu-head b.hot { color: var(--bad); }
.pu-bar { height: 3px; background: var(--surface-2); overflow: hidden; }
.pu-fill { display: block; height: 100%; background: var(--accent); }
.pu-fill.hot { background: var(--bad); }
.pu-reset {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 8px;
  font-size: 10.5px;
  color: var(--ink-mid);
}
/* Календарная дата — тише отсчёта: читают её реже, а места в строке занимает больше. */
.pu-reset-at { flex: none; color: var(--ink-low); font-variant-numeric: tabular-nums; }
/* Граница ведра лимитов. Модификатор, а не правка .pu-row: тот же класс рисует
   полосы процессора и памяти в соседней всплывашке, где делить нечего. */
.pu-row.pu-split { border-top: 1px solid var(--line); padding-top: 8px; }
/* Подпись занимает свою колонку: без min-width её не сжать, и длинное имя ведра
   вытолкнуло бы процент за край всплывашки. */
.pu-name { display: inline-flex; align-items: center; gap: 5px; min-width: 0; }
.pu-new {
  flex: none;
  padding: 0 5px; border-radius: 999px;
  font-size: 9.5px; line-height: 14px; letter-spacing: .02em;
  color: var(--accent); background: color-mix(in srgb, var(--accent) 18%, transparent);
}
.pu-state {
  display: flex; flex-direction: column; align-items: flex-start; gap: 5px;
  padding-top: 7px; border-top: 1px solid var(--line);
  font-size: 11px; line-height: 1.45; color: var(--ink-mid);
}
.pu-state.is-bad { color: var(--bad); }
.pu-state.is-warn { color: var(--warn); }
/* Полоски нагрузки «мозга» — те же пороги, что и у цифр в шапке (60% / 85%).
   Селекторы с тегом: иначе .pu-head b перебивает .lv-* по специфичности. */
.pu-fill.lv-warn { background: var(--warn); }
.pu-fill.lv-bad { background: var(--bad); }
.pu-head b.lv-warn { color: var(--warn); }
.pu-head b.lv-bad { color: var(--bad); }
.sysnote { font-size: 10.5px; color: var(--ink-mid); padding-top: 8px; border-top: 1px solid var(--line); }
.lv-ok { color: var(--ink); } .lv-warn { color: var(--warn); } .lv-bad { color: var(--bad); }

/* scrollbar-gutter: stable — место под полосу прокрутки зарезервировано всегда,
   иначе контент «скачет» по горизонтали, когда скролл появляется/исчезает при смене
   раздела. Не overflow-y: scroll: на полноэкранных страницах (чаты) внешний скролл
   не нужен, и принудительная полоса висела бы там мёртвой. */
.content { grid-row: 2; grid-column: 2; overflow-y: auto; scrollbar-gutter: stable; padding: var(--page-gutter); }

.content.is-workspace { padding: 0; scrollbar-gutter: auto; overflow: hidden; }
@media (max-width: 899px) {
  .shell { grid-template-columns: var(--app-rail-w) minmax(0, 1fr); }
  .dock-route-nav { display: flex; }
  .metric, .metric-sep { display: none; }
  .status { min-width: 0; overflow: hidden; }
}
</style>
