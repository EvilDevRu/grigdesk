<template>
  <div class="shell" :class="{ collapsed }">
    <aside class="sidebar">
      <div class="brand">
        <span class="logo">◧</span>
        <span class="name">Кокпит</span>
      </div>
      <nav class="nav">
        <router-link v-for="item in nav" :key="item.to" :to="item.to" class="navitem" active-class="active"
                     :title="item.to === '/board' && boardChipVisible ? `${item.label} · ${boardChipTitle}` : item.label">
          <span class="icwrap">
            <svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path :d="ICONS[item.icon]" /></svg>
            <span v-if="item.to === '/board' && boardChipVisible"
                  class="boardchip"
                  :class="{
                    timing: boardNavActivity.activeTimerCount,
                    'only-new': !boardNavActivity.activeTimerCount,
                  }"
                  role="status" :aria-label="boardChipTitle" :title="boardChipTitle">
              <span v-if="boardNavActivity.activeTimerCount">
                {{ boardNavActivity.activeTimerCount > 99 ? '99+' : boardNavActivity.activeTimerCount }}
              </span>
              <span v-if="boardNavActivity.activeTimerCount" class="boardtimer" aria-hidden="true"></span>
              <span v-if="boardNavActivity.unseenCount && boardNavActivity.activeTimerCount"
                    class="boardnew" aria-hidden="true"></span>
            </span>
            <!-- У конвейера цветной круг показывает состав: красный — аварии, жёлтый —
                 готовые задачи на воротах, синий — ещё выполняются. Число внутри не
                 включает синие задачи. У остальных разделов чип остаётся одноцветным. -->
            <span v-if="badges[item.to]" class="navbadge"
                  :class="[badges[item.to].kind, badges[item.to].pulseKind]"
                  :style="badges[item.to].style"
                  role="status" :aria-label="badges[item.to].title"
                  :title="badges[item.to].title">{{ badges[item.to].n }}</span>
          </span>
          <span class="lbl">{{ item.label }}</span>
        </router-link>
        <!-- Плагины: под основными разделами, за разделителем. Состав живёт в «Настройки → Плагины». -->
        <template v-if="pluginNav.length">
          <div class="navsep"></div>
          <router-link v-for="item in pluginNav" :key="item.to" :to="item.to" class="navitem" active-class="active" :title="item.label">
            <span class="icwrap">
              <svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path :d="ICONS[item.icon] || ICONS.plugin" /></svg>
              <span v-if="badges[item.to]" class="navbadge" :class="badges[item.to].kind"
                    role="status" :aria-label="badges[item.to].title" :title="badges[item.to].title">
                {{ badges[item.to].n > 99 ? '99+' : badges[item.to].n }}
              </span>
            </span>
            <span class="lbl">{{ item.label }}</span>
          </router-link>
        </template>
        <template v-if="toolsNav.length">
          <div class="navsep"></div>
          <UiPressable ref="toolsTrigger" class="navitem tools-trigger"
                       :class="{ active: toolsActive }" title="Инструменты"
                       :aria-expanded="toolsOpen" aria-haspopup="true" @click="toggleTools">
            <span class="icwrap">
              <svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
                   stroke-linecap="round" stroke-linejoin="round"><path :d="ICONS.tools" /></svg>
              <span v-if="badges['/tools']" class="navbadge" :class="badges['/tools'].kind"
                    role="status" :aria-label="badges['/tools'].title" :title="badges['/tools'].title">
                {{ badges['/tools'].n > 99 ? '99+' : badges['/tools'].n }}
              </span>
            </span>
            <span class="lbl">Инструменты</span>
          </UiPressable>
          <router-link to="/tools" class="navitem tools-mobile" active-class="active" title="Инструменты">
            <span class="icwrap">
              <svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
                   stroke-linecap="round" stroke-linejoin="round"><path :d="ICONS.tools" /></svg>
              <span v-if="badges['/tools']" class="navbadge" :class="badges['/tools'].kind"
                    role="status" :aria-label="badges['/tools'].title" :title="badges['/tools'].title">
                {{ badges['/tools'].n > 99 ? '99+' : badges['/tools'].n }}
              </span>
            </span>
            <span class="lbl">Инструменты</span>
          </router-link>
        </template>
      </nav>
      <nav class="nav nav-bottom dock-route-nav">
        <router-link v-for="item in dockRouteNav" :key="item.to" :to="item.to" class="navitem" active-class="active" :title="item.label">
          <svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path :d="ICONS[item.icon]" /></svg>
          <span class="lbl">{{ item.label }}</span>
        </router-link>
      </nav>
      <UiPressable class="collapse-btn" :title="collapsed ? 'Развернуть' : 'Свернуть'"
                   @click="toggleSidebar">
        <svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path :d="collapsed ? 'M9 18l6-6-6-6' : 'M15 18l-6-6 6-6'" /></svg>
        <span class="lbl">Свернуть</span>
      </UiPressable>
    </aside>

    <header class="topbar">
      <div class="tbleft">
        <span class="mlogo">◧</span>
        <h1 class="page">{{ route.meta.title || 'Кокпит' }}</h1>
      </div>
      <!-- Слот действий текущего экрана: сюда разделы телепортируют свои кнопки (TopbarActions) -->
      <div id="tb-slot" class="tb-slot"></div>
      <UpdateBanner />
      <div class="status">
        <!-- CPU/RAM — самые «дёргающиеся» цифры, поэтому левее всех: их ширина меняется,
             не сдвигая остальные элементы (правый край статуса зафиксирован) -->
        <UiTooltip
          v-if="sys"
          placement="top-end"
          :surface-style="{ maxWidth: '320px' }"
        >
          <template #trigger>
            <span class="metric mono" tabindex="0">
              CPU <b :class="loadClass(sys.cpu.percent)">{{ sys.cpu.percent }}%</b>
              · RAM
              <b :class="loadClass(sys.mem.percent)">
                {{ sys.mem.usedGb }}/{{ sys.mem.totalGb }}
              </b>
            </span>
          </template>
          <!-- Разбивка нагрузки полосками: одной строкой «занято 22 из 47» не видно,
               кончилась физическая память или просто лежит холодный swap. -->
          <template #tip>
            <span class="ptip">
              <span class="pu">
                <span class="pu-row">
                  <span class="pu-head"><span>Процессор · {{ sys.cpu.cores }} ядер</span><b :class="loadClass(sys.cpu.percent)">{{ sys.cpu.percent }}%</b></span>
                  <span class="pu-bar"><span class="pu-fill" :class="loadClass(sys.cpu.percent)" :style="{ width: Math.min(100, sys.cpu.percent) + '%' }"></span></span>
                  <span class="pu-reset">средняя загрузка за минуту — {{ sys.cpu.load1 }}</span>
                </span>
                <span class="pu-row">
                  <span class="pu-head"><span>Оперативная память</span><b :class="loadClass(mem.ramPercent)">{{ mem.ramPercent }}%</b></span>
                  <span class="pu-bar"><span class="pu-fill" :class="loadClass(mem.ramPercent)" :style="{ width: Math.min(100, mem.ramPercent) + '%' }"></span></span>
                  <span class="pu-reset">занято {{ mem.ramUsed }} из {{ mem.ramTotal }} ГБ · свободно {{ mem.ramFree }} ГБ</span>
                </span>
                <span v-if="mem.swapTotal" class="pu-row">
                  <span class="pu-head"><span>Подкачка (swap)</span><b :class="loadClass(mem.swapPercent)">{{ mem.swapPercent }}%</b></span>
                  <span class="pu-bar"><span class="pu-fill" :class="loadClass(mem.swapPercent)" :style="{ width: Math.min(100, mem.swapPercent) + '%' }"></span></span>
                  <span class="pu-reset">занято {{ mem.swapUsed }} из {{ mem.swapTotal }} ГБ</span>
                </span>
                <span v-else class="pu-reset">подкачка выключена</span>
              </span>
              <span class="sysnote">В шапке ОЗУ и подкачка сложены: занято {{ sys.mem.usedGb }} из {{ sys.mem.totalGb }} ГБ</span>
            </span>
          </template>
        </UiTooltip>
        <span v-if="sys" class="sep" aria-hidden="true">·</span>
        <BoardTimerPopover
          v-if="topbarTimerTasks.length"
          :tasks="topbarTimerTasks"
          :worked-today-hours="workedTodayHours"
          :busy-task-id="timerActionTaskId"
          :error="timerActionError"
          @open-task="openBoardTask"
          @open-board="openBoard"
          @toggle-timer="toggleBoardTimer"
        />
        <span
          v-if="topbarTimerTasks.length && pipelineTopbar.total"
          class="sep"
          aria-hidden="true"
        >·</span>
        <PipelineTopbarPopover
          v-if="pipelineTopbar.total"
          :items="notifyWatch.topbarItems"
          :error="notifyWatch.error || ''"
          :icon="ICONS.pipeline"
          @open-pipeline="openPipeline"
        />
        <span
          v-if="topbarTimerTasks.length || pipelineTopbar.total"
          class="sep"
          aria-hidden="true"
        >·</span>
        <!-- Компаньон стоит в ряду исполнителей: на /chats плавающей фигурки нет,
             а здесь он доступен всегда. Свой разделитель рисует сам. -->
        <CompanionTopbarButton />
        <AttentionAlerts />
        <!-- Наведения на ряд иконок для чтения лимитов больше нет: раскрытие всплывашки
             перечитывает их само и тикает, пока она открыта (см. usageWatch). -->
        <span v-if="runtimeProviders.length" class="provbox">
          <span
            v-for="p in runtimeProviders"
            :key="p.id"
            :class="['prov-tip', `prov-${p.id}`]"
          >
            <UiPopover
              trigger-mode="both"
              focus-policy="none"
              placement="top"
              :style="{ maxWidth: '320px' }"
              @open="usageWatch.open(p.id)"
              @close="usageWatch.close(p.id)"
            >
              <!-- Клик раскрывает всплывашку на планшете; обновление CLI остаётся ручным. -->
              <template #trigger>
                <UiPressable
                  class="prov"
                  data-context="provider-status"
                  :class="[p.id, { off: !p.available, upd: p.updateAvailable }]"
                  :aria-label="provTitle(p)"
                  :style="p.available && !['codex', 'kimi'].includes(p.id)
                    ? { color: p.color }
                    : null"
                >
                  <ProviderIcon :provider="p" :size="15" />
                  <span v-if="p.updateAvailable" class="updot" aria-hidden="true"></span>
                </UiPressable>
              </template>
              <template #default="{ close }">
              <span class="ptip">
                <!-- Шапка — только имя исполнителя: вендор, способ авторизации и версия
                     живут в его плашке настроек, а здесь место нужно лимитам. Обновление
                     сжато до точки справа; кокпит НИЧЕГО не обновляет сам — только сообщает.
                     Переход в настройки — шестерёнка в той же строке: полосой во всю ширину
                     внизу он занимал место, которого во всплывашке и так мало. -->
                <span class="ptip-head">
                  <b class="ptip-name">{{ p.name }}</b>
                  <!-- «доступен» не пишем: это норма. Недоступность — единственный факт
                       шапки, который нельзя потерять вместе со строкой подробностей. -->
                  <span v-if="!p.available" class="ptip-off">недоступен</span>
                  <span class="ptip-actions">
                    <span
                      v-if="p.updateAvailable"
                      class="ptip-upd"
                      data-testid="provider-popover-update-dot"
                      :title="`Доступно обновление: ${p.latest}`"
                    ></span>
                    <!-- Ставится по нажатию и отсюда: точка сообщала о новой версии, а идти
                         за ней приходилось в настройки. Ход один на весь кокпит, поэтому
                         пока ставится один CLI, кнопки соседей заблокированы. -->
                    <UiIconButton
                      v-if="canUpdateCli(p)"
                      data-context="topbar-popover-update"
                      role="embedded"
                      :label="`Обновить до ${p.latest}`"
                      :title="`Обновить CLI до ${p.latest}. Каталог моделей перечитается.`"
                      :disabled="!!prov.updating"
                      :loading="prov.updating === p.id"
                      loading-label="Обновляю"
                      @click="prov.updateCli(p.id)"
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
                           stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="M12 3v12 M7 10l5 5 5-5 M4 20h16" />
                      </svg>
                    </UiIconButton>
                    <UiIconButton
                      data-context="topbar-popover-settings"
                      role="embedded"
                      label="Настройки исполнителей"
                      title="Настройки исполнителей"
                      @click="close('action'); toProviders()"
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65"
                           stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path :d="ICONS.settings" />
                        <circle cx="12" cy="12" r="3" />
                      </svg>
                    </UiIconButton>
                  </span>
                </span>
                <!-- Итог установки виден, только когда он что-то значит: успех и так
                     виден пропавшим предложением обновиться. -->
                <span
                  v-if="updateNoteOf(p)"
                  class="pu-state"
                  :class="updateNoteOf(p).type === 'err' ? 'is-bad' : 'is-warn'"
                >{{ updateNoteOf(p).text }}</span>
                <!-- Беда лимитов — СВЕРХУ и со ссылкой на состояние вендора: снизу её
                     читали уже после того, как начинали гадать о причине сбоя. -->
                <span v-if="usageOf(p).message" class="pu-state" :class="`is-${usageOf(p).tone}`">
                  <span>{{ usageOf(p).message }}</span>
                  <span v-if="statusHintOf(p)" class="pu-status">
                    {{ statusHintOf(p).text }}
                    <UiActionLink
                      data-context="topbar-popover-status-link"
                      :href="statusHintOf(p).url"
                      variant="text"
                      target="_blank"
                    >{{ statusHintOf(p).host }}</UiActionLink>
                  </span>
                  <UiButton
                    v-if="usageOf(p).action"
                    data-context="topbar-popover-action"
                    variant="outline"
                    @click.stop="close('action'); runUsageAction(usageOf(p).action)"
                  >
                    {{ usageOf(p).action.label }}
                  </UiButton>
                </span>
                <!-- Потребление лимитов подписки — как /usage в CLI -->
                <span class="pu">
                  <span
                    v-for="b in usageOf(p).bars"
                    :key="b.key"
                    class="pu-row"
                    :class="{ 'pu-split': b.separated }"
                  >
                    <span class="pu-head">
                      <span class="pu-name">
                        {{ b.label }}
                        <!-- Ведро, которого раньше не было: появление нового лимита
                             иначе замечается только случайно. Гаснет само. -->
                        <span v-if="b.fresh" class="pu-new" title="Это ведро лимитов появилось недавно">новое</span>
                      </span>
                      <b :class="{ hot: b.pct >= 85 }">{{ b.pct }}%</b>
                    </span>
                    <span class="pu-bar"><span class="pu-fill" :class="{ hot: b.pct >= 85 }" :style="{ width: Math.min(100, b.pct) + '%' }"></span></span>
                    <span v-if="b.note || resetIn(b.resetsAt)" class="pu-reset">{{ b.note || resetIn(b.resetsAt) }}</span>
                  </span>
                  <!-- Доплата и прочие ресурсы аккаунта — только на чтение: менять их
                       можно в «Настройках → Исполнители», кнопка на них ведёт ниже. -->
                  <ProviderUsageResources
                    :provider-id="p.id"
                    :resources="usageOf(p).resources"
                    readonly
                  />
                </span>
              </span>
              </template>
            </UiPopover>
          </span>
        </span>
        <span v-if="runtimeProviders.length && sys?.net" class="sep" aria-hidden="true">·</span>
        <UiTooltip
          v-if="sys?.net"
          :text="`Публичный IP мозга: ${sys.net.ip}`
            + (sys.net.country ? ` · ${sys.net.country}` : '')"
        >
          <template #trigger>
            <span class="netbox mono" tabindex="0">
              <span class="flag">{{ flagOf(sys.net.countryCode) }}</span>
              <span class="ip">{{ sys.net.ip }}</span>
            </span>
          </template>
        </UiTooltip>
        <span v-if="sys?.net" class="sep" aria-hidden="true">·</span>
        <UiTooltip
          placement="top-end"
          :text="connected
            ? 'Связь с сервером кокпита — канал жив'
            : 'Нет связи с сервером кокпита'"
        >
          <template #trigger>
            <span class="conn" :class="connected ? 'on' : 'off'" tabindex="0">
              <span class="dot"></span>
              <span class="host mono">{{ health ? health.host : 'офлайн' }}</span>
            </span>
          </template>
        </UiTooltip>
      </div>
      <span v-if="cockpitVersion" class="cockpit-tip">
        <UiPopover
          trigger-mode="both"
          focus-policy="none"
          placement="top-end"
          :style="{ maxWidth: 'min(340px, calc(100vw - 20px))' }"
        >
          <template #trigger>
            <UiPressable
              class="cockpit-version"
              data-context="cockpit-version"
              :class="cockpitUpdate.tone"
              :aria-label="cockpitToneTitle"
              :title="cockpitToneTitle"
            >
              <!-- «◧» рисуем SVG: текстовый глиф сидел ниже геометрического центра. -->
              <svg class="ic" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M5 5h7v14H5z" fill="currentColor" />
                <rect
                  x="5"
                  y="5"
                  width="14"
                  height="14"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.8"
                />
              </svg>
              <span v-if="cockpitUpdate.tone" class="cockpit-dot" aria-hidden="true"></span>
            </UiPressable>
          </template>
          <template #default="{ close }">
          <span class="ptip cockpit-version-tip">
            <b>{{ cockpitToneTitle }}</b>
            <span>
              Запущено: {{ cockpitVersion.running.version }} ·
              <span class="mono">{{ shortSha(cockpitVersion.running.sha) }}</span>
            </span>
            <span v-if="cockpitVersion.checkoutChanged || cockpitVersion.checkout.dirty">
              Checkout: {{ cockpitVersion.checkout.version }} ·
              <span class="mono">{{ shortSha(cockpitVersion.checkout.sha) }}</span> ·
              {{ cockpitVersion.checkout.branch || 'detached HEAD' }}<template v-if="cockpitVersion.checkout.dirty"> · dirty</template>
            </span>
            <span v-if="cockpitVersion.latest">Доступно: {{ cockpitVersion.latest.tag }}</span>
            <span class="pu-reset">Проверено: {{ checkedLabel(cockpitVersion.checkedAt) }}</span>
            <span v-if="cockpitVersion.checkError" class="pu-state is-warn">
              {{ cockpitVersion.checkError.message }}
            </span>
            <span v-if="cockpitVersion.installBlockReasons?.length" class="pu-reset">
              {{ blockReasonLabel(cockpitVersion.installBlockReasons[0]) }}
            </span>
            <span class="ptip-go">
              <UiButton
                block
                data-context="topbar-popover-footer"
                variant="outline"
                @click="close('action'); toCockpitSettings()"
              >
                Настройки обновления
              </UiButton>
            </span>
          </span>
          </template>
        </UiPopover>
      </span>
      <router-link to="/settings" class="settings-link" active-class="active"
                   title="Настройки" aria-label="Настройки">
        <svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65"
             stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path :d="ICONS.settings" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      </router-link>
    </header>

    <main class="content" :inert="toolDock.isExpanded"
          :aria-hidden="toolDock.isExpanded ? 'true' : undefined"><slot /></main>
    <ToolHost />

    <Teleport to="body">
      <section v-if="toolsOpen" ref="toolsPopover" class="tools-popover" :style="toolsPopoverStyle"
               aria-label="Инструменты">
        <header>
          <strong>Инструменты</strong>
          <router-link to="/tools" @click="closeTools()">Все на странице →</router-link>
        </header>
        <ToolsGrid :items="toolsNav" :badges="badges" @select="closeTools()" />
      </section>
    </Teleport>

    <!-- Установка на устройство. Появляется только когда браузер сам счёл приложение
         устанавливаемым (https + иконки + живой SW) — по http-адресу кнопки не будет. -->
    <div v-if="pwa.canInstall" class="instbar">
      <span>Установить кокпит как приложение</span>
      <UiButton variant="solid" tone="accent" @click="pwa.install()">Установить</UiButton>
      <UiButton variant="text" @click="pwa.installPrompt = null">Позже</UiButton>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, nextTick, onUnmounted, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useRoute, useRouter } from 'vue-router';
import {
  UiActionLink,
  UiButton,
  UiIconButton,
  UiPopover,
  UiPressable,
  UiTooltip,
  useUiLayer,
} from '../../ui';
import { api } from '../api-client.js';
import { useSse } from '../../composables/useSse.js';
import { useSystemStore } from '../../stores/system.js';
import { usePwaStore } from '../../stores/pwa.js';
import { useProvidersStore } from '../../stores/providers.js';
import { usePluginsStore } from '../../stores/plugins.js';
import { useNotifyWatchStore } from '../../stores/notify-watch.js';
import { blockReasonLabel, useCockpitUpdateStore } from '../../stores/cockpit-update.js';
import { useChatStore } from '../../stores/chat.js';
import { useBoardStore } from '../../stores/board.js';
import { useTasksStore } from '../../stores/tasks.js';
import { useUiStore } from '../../stores/ui.js';
import { useInboxStore } from '../../stores/inbox.js';
import { useDockStore } from '../../stores/dock.js';
import {
  providerStatusHint,
  providerUsageView,
  resetIn,
} from '../../features/providers/providerUsage.js';
import { aggregateNavBadges, inboxNavBadge } from '../nav-badges.js';
import CompanionTopbarButton from '../../features/companion/CompanionTopbarButton.vue';
import BoardTimerPopover from '../../features/board/BoardTimerPopover.vue';
import PipelineTopbarPopover from '../../features/pipeline/PipelineTopbarPopover.vue';
import UpdateBanner from '../../features/pwa/UpdateBanner.vue';
import ProviderIcon from '../ProviderIcon.vue';
import ProviderUsageResources from '../../features/providers/ProviderUsageResources.vue';
import { createUsageWatch } from '../../features/providers/usageWatch.js';
import AttentionAlerts from '../../features/analysis/AttentionAlerts.vue';
import ToolHost from './ToolHost.vue';
import ToolsGrid from './ToolsGrid.vue';
import { TOOL_BY_ID } from '../tools/registry.js';
import { useToolLauncher } from '../tools/launcher.js';

const route = useRoute();
const router = useRouter();
const ui = useUiStore();
const toolDock = useDockStore();
const health = ref(null);
const { data: sys } = storeToRefs(useSystemStore());
const pwa = usePwaStore();
const cockpitUpdate = useCockpitUpdateStore();
const { status: cockpitVersion } = storeToRefs(cockpitUpdate);
cockpitUpdate.start();

const shortSha = (sha) => sha?.slice(0, 7) || '—';
const cockpitToneTitle = computed(() => ({
  error: 'Последнее обновление Cockpit завершилось ошибкой',
  checkout: 'Checkout Cockpit изменился после запуска сервера',
  release: 'Доступен новый стабильный релиз Cockpit',
}[cockpitUpdate.tone] || 'Версия Cockpit актуальна'));
function checkedLabel(value) {
  if (!value) return 'ещё не проверялось';
  try { return new Intl.DateTimeFormat('ru', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)); }
  catch { return value; }
}
function toCockpitSettings() {
  localStorage.setItem('cockpit-settings-tab', 'server');
  router.push('/settings');
}

// Реестр LLM-исполнителей — иконки доступных агентов в топбаре.
const prov = useProvidersStore();
// Setup-only карточки (сейчас Kimi) живут в настройках, но не изображают работающего
// чат-исполнителя в шапке до появления transport-а и каталога моделей.
const runtimeProviders = computed(() => prov.providers.filter((p) => p.chatEnabled !== false));
const plugins = usePluginsStore();
plugins.load();
const inboxStore = useInboxStore();
watch(() => (plugins.loaded ? plugins.enabled('inbox') : null), (enabled) => {
  if (enabled) inboxStore.start();
  else inboxStore.stop();
}, { immediate: true });
onUnmounted(() => inboxStore.stop());
prov.load();
prov.loadUsage();
// Каталог Codex зависит не только от версии CLI, но и от rollout/доступа аккаунта.
// Пока приложение открыто, перечитываем реестр раз в минуту: новая модель появляется
// в селекторе без F5 и без обновления Cockpit.
const providersTimer = setInterval(() => { prov.load(); }, 60_000);
providersTimer.unref?.();
onUnmounted(() => clearInterval(providersTimer));
function provTitle(p) {
  return `${p.name} (${p.vendor}) · ${p.available ? 'доступен' : 'недоступен'} · ${p.authLabel}`
    + (p.version ? ` · ${p.version}` : '');
}
// Кнопка «Настройки исполнителей» во всплывашке — на вкладку «Исполнители» настроек
// (таб настроек запоминается в localStorage, поэтому просто задаём его).
const { openTerminal } = useToolLauncher();
function toProviders() {
  localStorage.setItem('cockpit-settings-tab', 'providers');
  router.push('/settings');
}
const usageOf = (p) => providerUsageView(prov.usage[p.id], p);
// Открытая всплывашка держит лимиты свежими: force обходит минутный троттл стора, а
// серверный кэш остаётся — он и стережёт частоту походов в API вендора.
const usageWatch = createUsageWatch(() => prov.loadUsage(true));
onUnmounted(() => usageWatch.stop());
// Кнопка установки во всплывашке: только у отставшего CLI, который кокпит умеет ставить
// сам. Пока идёт установка, кнопка остаётся на месте — иначе она исчезла бы вместе с
// ходом, который сама и начала, и человек не понял бы, ставится ли ещё.
function canUpdateCli(p) {
  return Boolean(p.installed && p.canUpdate && (p.updateAvailable || prov.updating === p.id));
}
// Итог установки во всплывашке: показываем отказ и «ничего не изменилось». Удачную
// установку объявлять нечем — предложение обновиться просто исчезает, а полный текст
// («Обновлён: X → Y») живёт в плашке настроек, где у него есть своя строка.
function updateNoteOf(p) {
  const result = prov.updateResults[p.id];

  return result && (result.type === 'err' || result.changed === false) ? result : null;
}
// Куда смотреть при сбое вендора. Домен объявляет адаптер исполнителя, поэтому
// всплывашка не знает ни одного вендорского адреса.
const statusHintOf = (p) => providerStatusHint(p, prov.usage[p.id] || {});
function runUsageAction(action) {
  if (action?.kind !== 'terminal' || !action.command) return;
  openTerminal({ insert: action.command });
}
function loadClass(p) { return p >= 85 ? 'lv-bad' : p >= 60 ? 'lv-warn' : 'lv-ok'; }
// Разбивка памяти для всплывашки: физическая отдельно, подкачка отдельно.
// `??` — страховка на окно между выкаткой фронта и перезапуском сервера: пока сервер
// старой сборки, полей ram*/swapPercent нет, и без фолбэка всплывашка покажет undefined.
const mem = computed(() => {
  const m = sys.value?.mem;
  if (!m) return null;
  const swapTotal = m.swapTotalGb || 0;
  const swapUsed = m.swapUsedGb || 0;
  const ramTotal = m.ramTotalGb ?? +(m.totalGb - swapTotal).toFixed(1);
  const ramUsed = m.ramUsedGb ?? +(m.usedGb - swapUsed).toFixed(1);
  return {
    ramTotal, ramUsed, ramFree: m.ramFreeGb ?? +(ramTotal - ramUsed).toFixed(1),
    ramPercent: m.ramPercent ?? (ramTotal ? Math.round((ramUsed / ramTotal) * 100) : 0),
    swapTotal, swapUsed,
    swapPercent: m.swapPercent ?? (swapTotal ? Math.round((swapUsed / swapTotal) * 100) : 0),
  };
});
// Эмодзи-флаг из ISO-кода страны (2 буквы → региональные индикаторы).
function flagOf(cc) { if (!cc || cc.length !== 2) return '🏳'; return cc.toUpperCase().replace(/[A-Z]/g, (c) => String.fromCodePoint(127397 + c.charCodeAt(0))); }

// ── Бейджи в навигации ──
// Правило одно на все разделы: жёлтый пульсирующий — работа СТОИТ, пока не подойду;
// красный — что-то сломалось и ждёт разбора; синий — просто «посмотри, когда сможешь».

// Чаты: сколько чатов ждут МЕНЯ (агент задал вопрос и стоит) и сколько просто
// непрочитано. Ждущие важнее — их бейдж перекрывает непрочитанные.
const chatStore = useChatStore();
chatStore.ensure();
const unreadChats = computed(() => chatStore.unreadCount);
const waitingChats = computed(() => chatStore.waitingCount);
const chatsBadgeTitle = computed(() => (waitingChats.value
  ? `ждут твоего ответа: ${waitingChats.value}` + (unreadChats.value ? ` · непрочитанных: ${unreadChats.value}` : '')
  : `непрочитанные чаты: ${unreadChats.value}`));

// Доска: число в чипе — задачи с живым таймером; зелёная точка — таймер идёт;
// синяя точка — после последнего просмотра появилась новая задача.
const boardStore = useBoardStore();
const taskStore = useTasksStore();
const recentPausedTimerIds = ref([]);
const timerActionTaskId = ref(null);
const timerActionError = ref('');
const boardNavActivity = computed(() => boardStore.activity);
const boardTasks = computed(() => boardStore.data?.tasks || []);
const workedTodayHours = computed(() => boardStore.data?.today?.hours ?? 0);
const topbarTimerTasks = computed(() => {
  const recentIds = new Set(recentPausedTimerIds.value);

  return boardTasks.value.filter((task) => (
    task.timerRunning || recentIds.has(String(task.id))
  ));
});
const boardChipVisible = computed(() => {
  const a = boardNavActivity.value;
  return !!(a.activeTimerCount || a.unseenCount);
});
const boardChipTitle = computed(() => {
  const a = boardNavActivity.value;
  const parts = [a.activeTimerCount
    ? `сейчас с таймером: ${a.activeTimerCount}`
    : 'активных задач с таймером нет'];
  if (a.unseenCount) parts.push(`новых задач: ${a.unseenCount}`);
  return parts.join(' · ');
});
function openBoardTask(taskId) {
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
async function toggleBoardTimer(task) {
  if (timerActionTaskId.value !== null) return;

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

    timerActionError.value = error?.message || 'Не удалось переключить таймер';
  } finally {
    timerActionTaskId.value = null;
  }
}

// Конвейер: один классифицированный список питает и три числа popover, и его видимость.
// Чип внимания использует сводку того же классификатора; второго запроса не заводим.
const notifyWatch = useNotifyWatchStore();
notifyWatch.start();
const pipelineTopbar = computed(() => {
  return {
    total: notifyWatch.topbarItems.length,
  };
});
const pipelineBadgeStyle = computed(() => {
  const s = notifyWatch.badgeSummary;
  return {
    '--pipeline-error-end': `${s.errorEnd}%`,
    '--pipeline-waiting-end': `${s.waitingEnd}%`,
  };
});

const badges = computed(() => {
  const out = inboxNavBadge({ reviewCount: inboxStore.reviewCount });
  if (waitingChats.value || unreadChats.value) {
    out['/chats'] = {
      n: waitingChats.value || unreadChats.value,
      kind: waitingChats.value ? 'wait' : '',
      title: chatsBadgeTitle.value,
    };
  }
  if (notifyWatch.attentionCount) {
    out['/pipeline'] = {
      n: notifyWatch.attentionCount,
      kind: 'pipeline',
      // Вставший конвейер тревожнее ждущих ворот. Класс задаёт только цвет пульса,
      // сам круг теперь всегда сохраняет все красные, жёлтые и синие доли.
      pulseKind: notifyWatch.badgeSummary.errorCount ? 'stall' : 'wait',
      style: pipelineBadgeStyle.value,
      title: notifyWatch.attentionTitle,
    };
  }
  const toolsBadge = aggregateNavBadges(toolsNav.value.map((item) => ({
    label: item.label,
    badge: out[item.to],
  })));
  if (toolsBadge) out['/tools'] = toolsBadge;
  return out;
});

const collapsed = ref(localStorage.getItem('cockpit-sidebar') === '1');
function toggleSidebar() { collapsed.value = !collapsed.value; localStorage.setItem('cockpit-sidebar', collapsed.value ? '1' : '0'); }

const ICONS = {
  board: 'M3 3h7v7H3z M14 3h7v7h-7z M14 14h7v7h-7z M3 14h7v7H3z',
  pipeline: 'M6 3v12 M15 6a3 3 0 1 0 6 0 3 3 0 1 0-6 0 M3 18a3 3 0 1 0 6 0 3 3 0 1 0-6 0 M18 9a9 9 0 0 1-9 9',
  chats: 'M8 10h8 M8 14h5 M7 4h10a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H9l-4 4v-4a3 3 0 0 1-1-2V7a3 3 0 0 1 3-3z',
  agents: 'M12 3v3 M12 3a1.2 1.2 0 1 0 0-.01 M8 6h8a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3z M9 12h.01 M15 12h.01 M9.5 16h5',
  routes: 'M9 3 3 6v15l6-3 6 3 6-3V3l-6 3-6-3z M9 3v15 M15 6v15',
  projects: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z',
  code: 'M9 8l-4 4 4 4 M15 8l4 4-4 4',
  shelf: 'M4 5v14 M20 5v14 M4 9h16 M4 15h16 M8 5v4 M16 9v6 M10 15v4',
  video: 'M15 8l6-4v16l-6-4V8z M3 6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6z',
  // Самолётик со складкой крыла: знак Телеграма узнаётся именно по ней, без неё
  // получается обычная кнопка «отправить».
  telegram: 'M20.4 5.2 4 11.6l5.3 2 1.7 5.2 2.5-3 4.1 3.1z M9.3 13.6 20.4 5.2 13.5 15.8',
  inbox: 'M4 4h16v12a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V4z M4 13h4l2 3h4l2-3h4',
  github: 'M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.87c-2.78.6-3.37-1.18-3.37-1.18-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.9 1.53 2.34 1.09 2.91.83.09-.65.35-1.09.64-1.34-2.22-.25-4.56-1.11-4.56-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.64 0 0 .84-.27 2.75 1.02A9.6 9.6 0 0 1 12 6.84a9.6 9.6 0 0 1 2.5.34c1.91-1.29 2.75-1.02 2.75-1.02.55 1.37.2 2.39.1 2.64.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.86v2.74c0 .27.18.58.69.48A10 10 0 0 0 12 2z',
  terminal: 'M4 5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z M7 9l3 3-3 3 M13 15h4',
  tools: 'M4 4h6v6H4z M14 4h6v6h-6z M4 14h6v6H4z M14 14h6v6h-6z',
  settings: 'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.09a2 2 0 0 1 1 1.74v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.51a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z',
  plugin: 'M4 7h3a2 2 0 1 1 4 0h3v3a2 2 0 1 1 0 4v3h-3a2 2 0 1 0-4 0H4v-3a2 2 0 1 0 0-4V7z',
};
const nav = [
  { to: '/board', label: 'Доска', icon: 'board' },
  { to: '/pipeline', label: 'Конвейер', icon: 'pipeline' },
  // Чаты сразу под конвейером: это два раздела, куда ходят постоянно (и оба зажигают
  // чипы). Базы агентов и маршрутов — редкая настройка, им ниже.
  { to: '/chats', label: 'Чаты', icon: 'chats' },
  { to: '/agents', label: 'Агенты', icon: 'agents' },
  { to: '/routes', label: 'Маршруты', icon: 'routes' },
  { to: '/projects', label: 'Проекты', icon: 'projects' },
];
// Плагины в сайдбаре: включённые и с СУЩЕСТВУЮЩЕЙ страницей во фронте. У пользовательских
// плагинов фронтовых страниц пока не бывает (только роуты /api/ext/…), а пункт с мёртвой
// ссылкой хуже отсутствующего — такие скрываем, пока страница не появится в бандле.
const routeExists = (item) => router.resolve(item.to).matched.length > 0;
const pluginNav = computed(() => plugins.railNav.filter(routeExists));
const toolsNav = computed(() => plugins.toolsNav.filter(routeExists));
// До 900 px правой рейки нет, поэтому dock-инструменты становятся обычными
// route-ссылками. Незарегистрированную Vue-панель скрываем fail-closed.
const dockRouteNav = computed(() => [
  ...plugins.dockNav.filter((item) => routeExists(item) && TOOL_BY_ID.has(item.id)),
  { id: 'terminal', to: '/terminal', label: 'Терминал', icon: 'terminal', order: 30 },
].sort((a, b) => (a.order || 0) - (b.order || 0) || a.label.localeCompare(b.label, 'ru')));

const toolsOpen = ref(false);
const toolsTrigger = ref(null);
const toolsPopover = ref(null);
const toolsPopoverStyle = ref({});
const toolsActive = computed(() => route.path === '/tools' || toolsNav.value.some((item) => item.to === route.path));
useUiLayer('tools', {
  id: 'tools-popover',
  enabled: toolsOpen,
  element: toolsPopover,
  onEscape: () => {
    closeTools({ focus: true });
  },
});

function placeToolsPopover() {
  const rect = toolsTrigger.value?.el?.getBoundingClientRect?.();
  if (!rect) return;
  const width = Math.min(360, window.innerWidth - 24);
  const left = Math.min(rect.right + 8, window.innerWidth - width - 12);
  toolsPopoverStyle.value = { left: `${Math.max(12, left)}px`, top: `${Math.max(62, rect.top)}px`, width: `${width}px` };
}
function closeTools({ focus = false } = {}) {
  if (!toolsOpen.value) return;
  toolsOpen.value = false;
  if (focus) nextTick(() => toolsTrigger.value?.focus?.());
}
async function toggleTools() {
  if (toolsOpen.value) { closeTools({ focus: true }); return; }
  placeToolsPopover();
  toolsOpen.value = true;
  await nextTick();
  toolsPopover.value?.querySelector?.('a')?.focus?.();
}
function toolsOutside(event) {
  if (toolsTrigger.value?.el?.contains(event.target)
      || toolsPopover.value?.contains(event.target)) return;
  closeTools();
}
watch(toolsOpen, (open) => {
  if (open) {
    document.addEventListener('pointerdown', toolsOutside, true);
    window.addEventListener('resize', placeToolsPopover, { passive: true });
  } else {
    document.removeEventListener('pointerdown', toolsOutside, true);
    window.removeEventListener('resize', placeToolsPopover);
  }
});
watch(() => route.fullPath, () => closeTools());
onUnmounted(() => {
  document.removeEventListener('pointerdown', toolsOutside, true);
  window.removeEventListener('resize', placeToolsPopover);
});

async function loadHealth() { try { health.value = await api.get('/api/health'); } catch { health.value = null; } }
loadHealth();
const { connected } = useSse((name) => {
  if (name === 'state-change') { loadHealth(); notifyWatch.check(); }
  // Фоновая проверка нашла новую версию CLI — подтягиваем реестр, чтобы зажечь индикатор.
  if (name === 'providers-update') prov.load();
  if (name === 'cockpit-update') cockpitUpdate.load({ quiet: true });
});
</script>

<style scoped>
.shell {
  display: grid; height: 100%; min-width: 0; overflow: hidden;
  grid-template-columns: 216px minmax(0, 1fr) 44px;
  grid-template-rows: 54px 1fr;
  transition: grid-template-columns .16s ease-out;
}
.shell.collapsed { grid-template-columns: 62px minmax(0, 1fr) 44px; }

/* ── Сайдбар ── */
.sidebar {
  grid-row: 1 / -1; grid-column: 1;
  background: var(--sidebar); border-right: 1px solid var(--line);
  display: flex; flex-direction: column; padding: 12px 10px;
}
.brand { display: flex; align-items: center; gap: 11px; padding: 8px 10px 16px; }
.brand .logo { color: var(--accent); font-size: 20px; line-height: 1; }
.brand .name { font-weight: 680; font-size: 16px; letter-spacing: -.01em; }
.nav { display: flex; flex-direction: column; gap: 2px; }
.navsep { height: 1px; margin: 6px 8px; background: var(--line); }
.navitem, .collapse-btn {
  display: flex; align-items: center; gap: 11px; padding: 9px 11px; border-radius: 9px;
  color: var(--ink-mid); font-size: 14px; background: none; border: none; cursor: pointer; text-align: left; width: 100%;
  transition: background .12s, color .12s;
}
.navitem:hover, .collapse-btn:hover { background: var(--surface); color: var(--ink); }
.navitem.active { background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--accent); }
.ic { width: 19px; height: 19px; flex: none; }
.icwrap { position: relative; display: inline-flex; flex: none; }
/* Чип доски совмещает число задач с живым таймером (зелёная точка)
   и новую непросмотренную задачу (синяя точка сверху). */
.boardchip {
  position: absolute; top: -6px; right: -16px; min-width: 17px; height: 16px; padding: 0 4px;
  border: 1px solid var(--line-2); border-radius: 999px; background: var(--surface-2); color: var(--ink);
  display: inline-flex; align-items: center; justify-content: center; gap: 3px;
  font-size: 9.5px; font-weight: 750; font-variant-numeric: tabular-nums; line-height: 1;
  box-shadow: 0 0 0 2px var(--sidebar); z-index: 1;
}
.boardchip.timing { border-color: color-mix(in srgb, var(--good) 55%, var(--line)); }
.boardtimer {
  width: 5px; height: 5px; border-radius: 50%; background: var(--good);
  box-shadow: 0 0 5px color-mix(in srgb, var(--good) 75%, transparent);
  animation: boardtimerpulse 1.6s ease-in-out infinite;
}
.boardnew {
  position: absolute; top: -3px; right: -3px; width: 7px; height: 7px; border-radius: 50%;
  background: var(--accent); border: 2px solid var(--sidebar);
}
.boardchip.only-new {
  top: -4px; right: -6px; width: 8px; min-width: 8px; height: 8px; padding: 0;
  border: 0; background: var(--accent);
}
@keyframes boardtimerpulse { 50% { opacity: .35; } }
/* Бейдж «N непрочитанных чатов» — виден и в свёрнутом сайдбаре. Без анимации:
   непрочитанное висит до прочтения, пульсировать всё это время незачем. */
.navbadge { position: absolute; top: -5px; right: -7px; min-width: 14px; height: 14px; padding: 0 3px;
  border-radius: 999px; background: var(--accent); color: #fff; font-size: 9.5px; font-weight: 700;
  display: grid; place-items: center; line-height: 1; }
/* «Ждут меня» — работа СТОИТ, пока не подойду (вопрос агента, ворота конвейера):
   этот случай пульсирует, в отличие от непрочитанного, и перебивает его цветом.
   «Встал» — конвейер упёрся или оборвался: там нет кнопки, поэтому цвет аварийный. */
.navbadge.wait, .navbadge.stall { animation: badgepulse 1.9s ease-in-out infinite; }
.navbadge.wait { background: var(--warn, #e0a33a); color: #1a1206; --pulse: var(--warn, #e0a33a); }
.navbadge.stall { background: var(--bad, #f0564c); color: #fff; --pulse: var(--bad, #f0564c); }
/* Составной чип — кольцо, чтобы число читалось одинаково и на красном, и на жёлтом.
   Границы секторов приходят из реальных количеств; синий входит в знаменатель круга,
   но не в число по центру. */
.navbadge.pipeline {
  width: 18px; min-width: 18px; height: 18px; padding: 0; color: #fff;
  font-size: 9px; font-variant-numeric: tabular-nums;
  text-shadow: 0 1px 2px #000, 0 0 2px #000;
  background:
    radial-gradient(circle, var(--sidebar) 0 42%, transparent 48%),
    conic-gradient(
      var(--bad, #f0564c) 0 var(--pipeline-error-end),
      var(--warn, #e0a33a) var(--pipeline-error-end) var(--pipeline-waiting-end),
      var(--accent) var(--pipeline-waiting-end) 100%
    );
}
@keyframes badgepulse {
  0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--pulse, var(--warn, #e0a33a)) 65%, transparent); }
  60% { box-shadow: 0 0 0 5px transparent; }
}
@media (prefers-reduced-motion: reduce) {
  .shell { transition: none; }
  .boardtimer, .navbadge.wait, .navbadge.stall { animation: none; }
}
.nav-bottom { margin-top: auto; }
.dock-route-nav { display: none; }
.collapse-btn { margin-top: auto; }
.tools-mobile { display: none; }

/* Свёрнутый сайдбар: только иконки по центру, подписи скрыты */
.collapsed .brand .name, .collapsed .lbl { display: none; }
.collapsed .brand { justify-content: center; padding: 8px 0 16px; }
.collapsed .navitem, .collapsed .collapse-btn { justify-content: center; padding: 10px 0; gap: 0; }

/* ── Топбар ── */
.topbar {
  grid-row: 1; grid-column: 2 / 4;
  display: flex; align-items: center; justify-content: flex-start; gap: 14px;
  padding: 0 22px; background: var(--topbar); border-bottom: 1px solid var(--line);
}
.tbleft { display: flex; align-items: center; gap: 10px; min-width: 0; flex: none; }
/* Слот действий экрана — сразу после заголовка; статус уезжает вправо */
.tb-slot { display: flex; align-items: center; gap: 8px; min-width: 0; overflow: hidden; }
.tb-slot:empty { display: none; }
.status { margin-left: auto; }
.mlogo { display: none; color: var(--accent); font-size: 18px; }
.page { margin: 0; font-size: 15px; font-weight: 640; letter-spacing: -.01em; }
.status { display: flex; align-items: center; gap: 14px; font-size: 12px; white-space: nowrap; }
.settings-link {
  width: 32px; height: 32px; flex: none; display: grid; place-items: center;
  border-radius: 8px; color: var(--ink-mid); transition: background .12s, color .12s;
}
.cockpit-tip { display: inline-flex; align-items: center; height: 32px; }
.settings-link { line-height: 0; }
.settings-link .ic { display: block; }
.cockpit-dot {
  position: absolute; top: 4px; right: 4px; width: 7px; height: 7px; border-radius: 50%;
  background: currentColor; border: 2px solid var(--topbar);
}
.cockpit-version-tip { min-width: 260px; }
.settings-link .ic { width: 16px; height: 16px; }
.settings-link:hover { background: var(--surface); color: var(--ink); }
.settings-link.active { background: color-mix(in srgb, var(--accent) 8%, transparent); color: var(--accent); }
.metric { color: var(--ink-mid); font-variant-numeric: tabular-nums; }
.metric b { font-weight: 600; }
.sep { color: var(--ink-mid); margin: 0 -4px; }
.provbox { display: inline-flex; align-items: center; gap: 9px; }
/* В топбаре это обычные знаки, без кнопочных контейнеров. Нулевая высота строки
   убирает baseline-зазор SVG и ставит все три логотипа на одну оптическую ось. */
.prov-tip {
  display: inline-flex;
  align-items: center;
  line-height: 0;
  vertical-align: middle;
}
/* У Kimi широкий SVG-кадр: правое плечо «K» заканчивается раньше его блока. Без
   поправки визуальный зазор до следующего знака на 4px больше, чем у Codex → Kimi. */
.prov-kimi + .prov-ollama { margin-left: -4px; }
/* Точка «вышла новая версия CLI». Обновление — только руками из настроек. */
.updot { position: absolute; top: -2px; right: -3px; width: 6px; height: 6px; border-radius: 50%;
  background: var(--warn, #e0a33a); box-shadow: 0 0 0 2px var(--surface); }
/* Шапка всплывашки: короткое имя слева, точка обновления — справа. */
.ptip-head { display: flex; align-items: center; gap: 7px; }
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
/* Тултип исполнителя: статус + прогрессбары потребления лимитов (ширина — :tip-style) */
.ptip { display: flex; flex-direction: column; gap: 10px; min-width: 240px; text-align: left; }
.pu { display: flex; flex-direction: column; gap: 9px; }
.pu-row { display: flex; flex-direction: column; gap: 4px; }
.pu-head { display: flex; justify-content: space-between; align-items: baseline; font-size: 11.5px; color: var(--ink-mid); }
.pu-head b { color: var(--ink); font-variant-numeric: tabular-nums; }
.pu-head b.hot { color: var(--bad); }
.pu-bar { height: 5px; border-radius: 999px; background: var(--surface-2); overflow: hidden; }
.pu-fill { display: block; height: 100%; border-radius: 999px; background: var(--accent); }
.pu-fill.hot { background: var(--bad); }
.pu-reset { font-size: 10.5px; color: var(--ink-mid); }
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
/* Подвал всплывашки «мозга»: у версии кокпита переход в настройки остаётся полосой —
   там это единственное действие, и сжимать его в иконку нечего ради. */
.ptip-go { display: flex; padding-top: 8px; border-top: 1px solid var(--line); }

/* Полоски нагрузки «мозга» — те же пороги, что и у цифр в шапке (60% / 85%).
   Селекторы с тегом: иначе .pu-head b перебивает .lv-* по специфичности. */
.pu-fill.lv-warn { background: var(--warn); }
.pu-fill.lv-bad { background: var(--bad); }
.pu-head b.lv-warn { color: var(--warn); }
.pu-head b.lv-bad { color: var(--bad); }
.sysnote { font-size: 10.5px; color: var(--ink-mid); padding-top: 8px; border-top: 1px solid var(--line); }
.netbox { display: inline-flex; align-items: center; gap: 6px; color: var(--ink-mid); }
.netbox .flag { font-size: 14px; line-height: 1; }
.netbox .ip { letter-spacing: .01em; }
.lv-ok { color: var(--ink); } .lv-warn { color: var(--warn); } .lv-bad { color: var(--bad); }
.conn { display: flex; align-items: center; height: 32px; gap: 7px; color: var(--ink-mid); }
.conn .dot { width: 8px; height: 8px; border-radius: 50%; }
.conn.on .dot { background: var(--good); box-shadow: 0 0 6px color-mix(in srgb, var(--good) 60%, transparent); }
.conn.off .dot { background: var(--bad); }
.host { display: inline-flex; align-items: center; height: 32px; line-height: 1; overflow: hidden; text-overflow: ellipsis; max-width: 200px; }

/* scrollbar-gutter: stable — место под полосу прокрутки зарезервировано всегда,
   иначе контент «скачет» по горизонтали, когда скролл появляется/исчезает при смене
   раздела. Не overflow-y: scroll: на полноэкранных страницах (чаты) внешний скролл
   не нужен, и принудительная полоса висела бы там мёртвой. */
.content { grid-row: 2; grid-column: 2; overflow-y: auto; scrollbar-gutter: stable; padding: 22px; }

.tools-popover {
  position: fixed; z-index: 75; max-height: calc(100vh - 74px); overflow: auto;
  padding: 12px; border: 1px solid var(--line-2); border-radius: 14px;
  background: var(--surface); box-shadow: 0 18px 48px #000c;
}
.tools-popover header { display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 2px 2px 10px; }
.tools-popover header strong { font-size: 13px; }
.tools-popover header a { color: var(--accent); font-size: 11px; }
.tools-popover :deep(.tools-grid) { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.tools-popover :deep(.tool-tile) { min-height: 86px; }

/* Планшет: полная рейка съедает четверть экрана и выталкивает рабочую область.
   Оставляем узнаваемые иконки и все пункты, но освобождаем 154 px контенту. */
@media (min-width: 760px) and (max-width: 1099px) {
  .brand .name, .lbl { display: none; }
  .brand { justify-content: center; padding: 8px 0 16px; }
  .navitem, .collapse-btn { justify-content: center; padding: 10px 0; gap: 0; }
  .content { padding: 18px; }
  .topbar { padding-inline: 18px; }
}
@media (min-width: 900px) and (max-width: 1099px) {
  .shell, .shell.collapsed { grid-template-columns: 62px minmax(0, 1fr) 44px; }
}
@media (min-width: 760px) and (max-width: 899px) {
  .shell, .shell.collapsed { grid-template-columns: 62px minmax(0, 1fr); }
  .topbar { grid-column: 2; }
  .dock-route-nav { display: flex; }
  /* Здесь нижний блок Code/Terminal сам занимает свободное место над кнопкой. */
  .collapse-btn { margin-top: 4px; }
  .metric, .netbox .ip { display: none; }
}

/* Плашка установки — снизу, чтобы не спорить с баннером обновления сверху.
   На мобиле поднята над нижней навигацией. */
.instbar {
  position: fixed; bottom: calc(14px + env(safe-area-inset-bottom, 0px)); left: 50%; transform: translateX(-50%); z-index: 200;
  display: flex; align-items: center; gap: 10px;
  background: var(--surface); color: var(--ink); border: 1px solid var(--line); border-radius: 999px;
  padding: 8px 10px 8px 18px; font-size: 13px; box-shadow: 0 8px 26px #0009;
  max-width: calc(100vw - 24px);
}
@media (max-width: 759px) {
  .instbar { bottom: calc(64px + env(safe-area-inset-bottom, 0px)); }
}
@media (max-width: 639px) {
  .instbar { gap: 3px; padding: 5px; }
  .instbar > span { display: none; }
}

/* ── Мобайл: сайдбар → нижняя навигация ── */
@media (max-width: 759px) {
  /* Содержимое верхней панели не должно расширять мобильную колонку за край экрана. */
  .shell, .shell.collapsed {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: 52px 1fr auto;
  }
  .sidebar { grid-row: 3; grid-column: 1; flex-direction: row; overflow-x: auto; padding: 0; border-right: none; border-top: 1px solid var(--line);
    padding-bottom: env(safe-area-inset-bottom, 0); scrollbar-width: none; }
  .sidebar::-webkit-scrollbar { display: none; }
  .brand, .collapse-btn { display: none; }
  .tools-trigger { display: none; }
  .tools-mobile { display: flex; }
  .dock-route-nav { display: contents; }
  /* На мобиле обе навигации сливаются в один нижний ряд */
  .nav, .nav-bottom { display: contents; }
  .navitem { flex: 0 0 62px; min-width: 62px; flex-direction: column; gap: 3px; font-size: 10px; padding: 9px 2px; border-radius: 0; }
  .navitem.active { background: none; }
  .topbar { grid-row: 1; grid-column: 1; padding: 0 16px; }
  .mlogo { display: inline; }
  .content { grid-row: 2; grid-column: 1; padding: 16px; }
  .host { display: none; }
  @media (max-width: 440px) { .metric { display: none; } .netbox .ip { display: none; } }
}
</style>
