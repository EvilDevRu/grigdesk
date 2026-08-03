<script setup>
import { ref, computed, onUnmounted } from 'vue';
import { storeToRefs } from 'pinia';
import { useRoute, useRouter } from 'vue-router';
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
import { providerUsageView } from '../provider-usage.js';
import ProviderIcon from '../ProviderIcon.vue';
import ProviderUsageResources from '../ProviderUsageResources.vue';
import AttentionAlerts from './AttentionAlerts.vue';
import HelpTip from '../ui/HelpTip.vue';

const route = useRoute();
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
const router = useRouter();
function toProviders() {
  localStorage.setItem('cockpit-settings-tab', 'providers');
  router.push('/settings');
}
const usageOf = (p) => providerUsageView(prov.usage[p.id], p);
function runUsageAction(action) {
  if (action?.kind !== 'terminal' || !action.command) return;
  sessionStorage.setItem('cockpit-term-insert', action.command);
  router.push('/terminal');
}
// «сброс через 2ч» из ISO-даты сброса лимита
function resetIn(iso) {
  if (!iso) return '';
  const ms = new Date(iso).getTime() - Date.now();
  if (!(ms > 0)) return '';
  const h = Math.floor(ms / 3600_000);
  if (h >= 48) return `сброс через ${Math.round(h / 24)}д`;
  if (h >= 1) return `сброс через ${h}ч`;
  return `сброс через ${Math.max(1, Math.round(ms / 60_000))}м`;
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
const boardNavActivity = computed(() => boardStore.activity);
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

// Конвейер: задачи, которые встали на человеке — ворота ждут решения или движок упёрся.
// Считает вотчер оповещений: он и так обходит все задачи, второго обхода не заводим.
const notifyWatch = useNotifyWatchStore();
notifyWatch.start();

const badges = computed(() => {
  const out = {};
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
      // Вставший конвейер тревожнее ждущих ворот: у ворот есть кнопка, а тут — авария.
      // Зависший ход туда же: он жжёт лимит этапа прямо сейчас.
      kind: notifyWatch.stalled.length || notifyWatch.silent.length ? 'stall' : 'wait',
      title: notifyWatch.attentionTitle,
    };
  }
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
  video: 'M15 8l6-4v16l-6-4V8z M3 6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6z',
  terminal: 'M4 5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z M7 9l3 3-3 3 M13 15h4',
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
const pluginNav = computed(() => plugins.navItems.filter((i) => router.resolve(i.to).matched.length));
// Служебные пункты — прижаты к низу сайдбара.
const navBottom = [
  { to: '/terminal', label: 'Терминал', icon: 'terminal' },
];

async function loadHealth() { try { health.value = await api.get('/api/health'); } catch { health.value = null; } }
loadHealth();
const { connected } = useSse((name) => {
  if (name === 'state-change') { loadHealth(); notifyWatch.check(); }
  // Фоновая проверка нашла новую версию CLI — подтягиваем реестр, чтобы зажечь индикатор.
  if (name === 'providers-update') prov.load();
  if (name === 'cockpit-update') cockpitUpdate.load({ quiet: true });
});
</script>

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
            <!-- Требует человека: жёлтый — работа стоит и ждёт меня (вопрос агента,
                 ворота конвейера), красный — конвейер встал, синий — непрочитанное -->
            <span v-if="badges[item.to]" class="navbadge" :class="badges[item.to].kind"
                  :title="badges[item.to].title">{{ badges[item.to].n }}</span>
          </span>
          <span class="lbl">{{ item.label }}</span>
        </router-link>
        <!-- Плагины: под основными разделами, за разделителем. Состав живёт в «Настройки → Плагины». -->
        <template v-if="pluginNav.length">
          <div class="navsep"></div>
          <router-link v-for="item in pluginNav" :key="item.to" :to="item.to" class="navitem" active-class="active" :title="item.label">
            <svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path :d="ICONS[item.icon] || ICONS.plugin" /></svg>
            <span class="lbl">{{ item.label }}</span>
          </router-link>
        </template>
      </nav>
      <nav class="nav nav-bottom">
        <router-link v-for="item in navBottom" :key="item.to" :to="item.to" class="navitem" active-class="active" :title="item.label">
          <svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path :d="ICONS[item.icon]" /></svg>
          <span class="lbl">{{ item.label }}</span>
        </router-link>
      </nav>
      <button class="collapse-btn" :title="collapsed ? 'Развернуть' : 'Свернуть'" @click="toggleSidebar">
        <svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path :d="collapsed ? 'M9 18l6-6-6-6' : 'M15 18l-6-6 6-6'" /></svg>
        <span class="lbl">Свернуть</span>
      </button>
    </aside>

    <header class="topbar">
      <div class="tbleft">
        <span class="mlogo">◧</span>
        <h1 class="page">{{ route.meta.title || 'Кокпит' }}</h1>
      </div>
      <!-- Слот действий текущего экрана: сюда разделы телепортируют свои кнопки (TopbarActions) -->
      <div id="tb-slot" class="tb-slot"></div>
      <div class="status">
        <!-- CPU/RAM — самые «дёргающиеся» цифры, поэтому левее всех: их ширина меняется,
             не сдвигая остальные элементы (правый край статуса зафиксирован) -->
        <HelpTip v-if="sys" align="right" class="sys-tip" :tip-style="{ maxWidth: '320px' }">
          <span class="metric mono">
            CPU <b :class="loadClass(sys.cpu.percent)">{{ sys.cpu.percent }}%</b>
            · RAM <b :class="loadClass(sys.mem.percent)">{{ sys.mem.usedGb }}/{{ sys.mem.totalGb }}</b>
          </span>
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
        </HelpTip>
        <span v-if="sys" class="sep" aria-hidden="true">·</span>
        <AttentionAlerts />
        <!-- pointerdown, а не только mouseenter: на тач-экране ховера нет, и без него
             свежие лимиты приезжали бы уже после раскрытия всплывашки -->
        <span v-if="runtimeProviders.length" class="provbox"
              @mouseenter="prov.loadUsage()" @pointerdown="prov.loadUsage()">
          <HelpTip v-for="p in runtimeProviders" :key="p.id" class="prov-tip" toggle
                   :tip-style="{ maxWidth: '320px' }">
            <!-- Клик раскрывает саму всплывашку (на планшете ховера нет), а в настройки
                 ведёт кнопка внутри неё: обновление CLI — только вручную, кнопкой -->
            <span class="prov" :class="[p.id, { off: !p.available, upd: p.updateAvailable }]"
                  :style="p.available && !['codex', 'kimi'].includes(p.id) ? { color: p.color } : null">
              <ProviderIcon :provider="p" :size="15" />
              <span v-if="p.updateAvailable" class="updot" aria-hidden="true"></span>
            </span>
            <template #tip>
              <span class="ptip">
                <span>{{ provTitle(p) }}</span>
                <!-- Индикатор новой версии. Кокпит НИЧЕГО не обновляет сам — только сообщает. -->
                <span v-if="p.updateAvailable" class="pupd">
                  Доступно обновление: <b>{{ p.latest }}</b>
                </span>
                <!-- Потребление лимитов подписки — как /usage в CLI -->
                <span class="pu">
                  <span v-for="b in usageOf(p).bars" :key="b.key" class="pu-row">
                    <span class="pu-head"><span>{{ b.label }}</span><b :class="{ hot: b.pct >= 85 }">{{ b.pct }}%</b></span>
                    <span class="pu-bar"><span class="pu-fill" :class="{ hot: b.pct >= 85 }" :style="{ width: Math.min(100, b.pct) + '%' }"></span></span>
                    <span v-if="b.note || resetIn(b.resetsAt)" class="pu-reset">{{ b.note || resetIn(b.resetsAt) }}</span>
                  </span>
                  <ProviderUsageResources :provider-id="p.id" :resources="usageOf(p).resources" />
                  <span v-if="usageOf(p).message" class="pu-state" :class="`is-${usageOf(p).tone}`">
                    <span>{{ usageOf(p).message }}</span>
                    <span v-if="usageOf(p).note" class="pu-reset">{{ usageOf(p).note }}</span>
                    <button v-if="usageOf(p).action" type="button"
                            @click.stop="runUsageAction(usageOf(p).action)">
                      {{ usageOf(p).action.label }}
                    </button>
                  </span>
                </span>
                <span class="ptip-go">
                  <button type="button" @click="toProviders">Настройки исполнителей</button>
                </span>
              </span>
            </template>
          </HelpTip>
        </span>
        <span v-if="runtimeProviders.length && sys?.net" class="sep" aria-hidden="true">·</span>
        <HelpTip v-if="sys?.net" :text="`Публичный IP мозга: ${sys.net.ip}` + (sys.net.country ? ` · ${sys.net.country}` : '')">
          <span class="netbox mono">
            <span class="flag">{{ flagOf(sys.net.countryCode) }}</span>
            <span class="ip">{{ sys.net.ip }}</span>
          </span>
        </HelpTip>
        <span v-if="sys?.net" class="sep" aria-hidden="true">·</span>
        <HelpTip align="right" :text="connected ? 'Связь с сервером кокпита — канал жив' : 'Нет связи с сервером кокпита'">
          <span class="conn" :class="connected ? 'on' : 'off'">
            <span class="dot"></span>
            <span class="host mono">{{ health ? health.host : 'офлайн' }}</span>
          </span>
        </HelpTip>
      </div>
      <HelpTip v-if="cockpitVersion" align="right" class="cockpit-tip" toggle
               :tip-style="{ maxWidth: 'min(340px, calc(100vw - 20px))' }">
        <span class="cockpit-version" :class="cockpitUpdate.tone"
              role="status" :aria-label="cockpitToneTitle" :title="cockpitToneTitle">
          <span aria-hidden="true">◧</span>
          <span v-if="cockpitUpdate.tone" class="cockpit-dot" aria-hidden="true"></span>
        </span>
        <template #tip>
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
              <button type="button" @click="toCockpitSettings">Настройки обновления</button>
            </span>
          </span>
        </template>
      </HelpTip>
      <router-link to="/settings" class="settings-link" active-class="active"
                   title="Настройки" aria-label="Настройки">
        <svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65"
             stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path :d="ICONS.settings" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      </router-link>
    </header>

    <main class="content"><slot /></main>

    <!-- Баннер обновления живёт в App.vue: он нужен и на экране входа, куда оболочка
         не доходит (см. shared/ui/UpdateBanner.vue). -->

    <!-- Установка на устройство. Появляется только когда браузер сам счёл приложение
         устанавливаемым (https + иконки + живой SW) — по http-адресу кнопки не будет. -->
    <div v-if="pwa.canInstall" class="instbar">
      <span>Установить кокпит как приложение</span>
      <button @click="pwa.install()">Установить</button>
      <button class="ghost" @click="pwa.installPrompt = null">Позже</button>
    </div>
  </div>
</template>

<style scoped>
.shell {
  display: grid; height: 100%; min-width: 0; overflow: hidden;
  grid-template-columns: 216px 1fr;
  grid-template-rows: 54px 1fr;
}
.shell.collapsed { grid-template-columns: 62px 1fr; }

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
@keyframes badgepulse {
  0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--pulse, var(--warn, #e0a33a)) 65%, transparent); }
  60% { box-shadow: 0 0 0 5px transparent; }
}
@media (prefers-reduced-motion: reduce) {
  .boardtimer, .navbadge.wait, .navbadge.stall { animation: none; }
}
.nav-bottom { margin-top: auto; }
.collapse-btn { margin-top: 4px; }

/* Свёрнутый сайдбар: только иконки по центру, подписи скрыты */
.collapsed .brand .name, .collapsed .lbl { display: none; }
.collapsed .brand { justify-content: center; padding: 8px 0 16px; }
.collapsed .navitem, .collapsed .collapse-btn { justify-content: center; padding: 10px 0; gap: 0; }

/* ── Топбар ── */
.topbar {
  grid-row: 1; grid-column: 2;
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
.cockpit-tip :deep(.ht-tr) { display: inline-flex; align-items: center; height: 32px; }
.cockpit-version > span:first-child { display: block; line-height: 1; }
.settings-link { line-height: 0; }
.settings-link .ic { display: block; }
.cockpit-version {
  width: 32px; height: 32px; flex: none; display: grid; place-items: center; position: relative;
  border-radius: 8px; color: var(--ink-mid); font-size: 16px; cursor: pointer;
  transition: background .12s, color .12s;
}
.cockpit-version:hover { background: var(--surface); color: var(--ink); }
.cockpit-version.checkout { color: var(--accent); }
.cockpit-version.release { color: var(--warn, #e0a33a); }
.cockpit-version.error { color: var(--bad); }
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
.prov-tip { display: inline-flex; align-items: center; vertical-align: middle; }
.prov-tip :deep(.ht-tr) { line-height: 0; }
.prov { display: inline-grid; place-items: center; position: relative; cursor: pointer; }
/* OpenAI и Kimi в шапке нейтральные: цвет здесь означает состояние, а не бренд. */
.prov.codex, .prov.kimi { color: var(--ink); }
.prov.off { color: var(--ink-mid); opacity: .45; }
/* Точка «вышла новая версия CLI». Обновление — только руками из настроек. */
.updot { position: absolute; top: -2px; right: -3px; width: 6px; height: 6px; border-radius: 50%;
  background: var(--warn, #e0a33a); box-shadow: 0 0 0 2px var(--surface); }
.prov.upd { opacity: 1; }
.pupd { display: block; margin-top: 6px; padding-top: 6px; border-top: 1px solid var(--line);
  color: var(--warn, #e0a33a); line-height: 1.5; }
.pupd b { font-weight: 600; }
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
.pu-state {
  display: flex; flex-direction: column; align-items: flex-start; gap: 5px;
  padding-top: 7px; border-top: 1px solid var(--line);
  font-size: 11px; line-height: 1.45; color: var(--ink-mid);
}
.pu-state.is-bad { color: var(--bad); }
.pu-state.is-warn { color: var(--warn); }
.pu-state button {
  padding: 4px 10px; border-radius: 7px; cursor: pointer;
  border: 1px solid var(--line-2); background: var(--surface-2); color: var(--ink);
  font-size: 11px;
}
.pu-state button:hover { border-color: var(--accent); color: var(--accent); }
/* Переход в настройки исполнителей — теперь кнопкой внутри всплывашки, а не кликом по иконке */
.ptip-go { display: flex; padding-top: 8px; border-top: 1px solid var(--line); }
.ptip-go button {
  width: 100%; padding: 6px 10px; border-radius: 7px; cursor: pointer;
  border: 1px solid var(--line-2); background: var(--surface-2); color: var(--ink-mid);
  font-size: 11.5px;
}
.ptip-go button:hover { border-color: var(--accent); color: var(--accent); }

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

.content { grid-row: 2; grid-column: 2; overflow-y: auto; padding: 22px; }

/* Планшет: полная рейка съедает четверть экрана и выталкивает рабочую область.
   Оставляем узнаваемые иконки и все пункты, но освобождаем 154 px контенту. */
@media (min-width: 760px) and (max-width: 1099px) {
  .shell, .shell.collapsed { grid-template-columns: 62px minmax(0, 1fr); }
  .brand .name, .lbl { display: none; }
  .brand { justify-content: center; padding: 8px 0 16px; }
  .navitem, .collapse-btn { justify-content: center; padding: 10px 0; gap: 0; }
  .content { padding: 18px; }
  .topbar { padding-inline: 18px; }
}
@media (min-width: 760px) and (max-width: 899px) {
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
.instbar button { background: var(--accent); color: #fff; border: none; border-radius: 999px; padding: 6px 14px; font-size: 13px; font-weight: 600; cursor: pointer; }
.instbar button.ghost { background: none; color: var(--ink-mid); font-weight: 400; padding: 6px 8px; }
@media (max-width: 759px) {
  .instbar { bottom: calc(64px + env(safe-area-inset-bottom, 0px)); }
}
@media (max-width: 639px) {
  .instbar { gap: 3px; padding: 5px; }
  .instbar > span { display: none; }
  .instbar button { min-height: 36px; }
}

/* ── Мобайл: сайдбар → нижняя навигация ── */
@media (max-width: 759px) {
  .shell, .shell.collapsed { grid-template-columns: 1fr; grid-template-rows: 52px 1fr auto; }
  .sidebar { grid-row: 3; grid-column: 1; flex-direction: row; overflow-x: auto; padding: 0; border-right: none; border-top: 1px solid var(--line);
    padding-bottom: env(safe-area-inset-bottom, 0); scrollbar-width: none; }
  .sidebar::-webkit-scrollbar { display: none; }
  .brand, .collapse-btn { display: none; }
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
