<script setup>
import { ref, computed } from 'vue';
import { storeToRefs } from 'pinia';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api-client.js';
import { useSse } from '../../composables/useSse.js';
import { useSystemStore } from '../../stores/system.js';
import { usePwaStore } from '../../stores/pwa.js';
import { useProvidersStore } from '../../stores/providers.js';
import { useNotifyWatchStore } from '../../stores/notify-watch.js';
import { useChatStore } from '../../stores/chat.js';
import ProviderIcon from '../ProviderIcon.vue';
import AttentionAlerts from './AttentionAlerts.vue';
import HelpTip from '../ui/HelpTip.vue';

const route = useRoute();
const health = ref(null);
const { data: sys } = storeToRefs(useSystemStore());
const pwa = usePwaStore();

// Реестр LLM-исполнителей — иконки доступных агентов в топбаре.
const prov = useProvidersStore();
prov.load();
prov.loadUsage();
function provTitle(p) {
  return `${p.name} (${p.vendor}) · ${p.available ? 'доступен' : 'недоступен'} · ${p.authLabel}`
    + (p.version ? ` · ${p.version}` : '');
}
// Клик по иконке исполнителя — сразу на вкладку «Исполнители» настроек
// (таб настроек запоминается в localStorage, поэтому просто задаём его).
const router = useRouter();
function toProviders() {
  localStorage.setItem('cockpit-settings-tab', 'providers');
  router.push('/settings');
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
// Эмодзи-флаг из ISO-кода страны (2 буквы → региональные индикаторы).
function flagOf(cc) { if (!cc || cc.length !== 2) return '🏳'; return cc.toUpperCase().replace(/[A-Z]/g, (c) => String.fromCodePoint(127397 + c.charCodeAt(0))); }

// Активные чаты (агент работает) — бейдж на пункте «Чаты».
const chatStore = useChatStore();
chatStore.ensure();
const activeChats = computed(() => chatStore.sessions.filter((s) => s.sending).length);

const collapsed = ref(localStorage.getItem('cockpit-sidebar') === '1');
function toggleSidebar() { collapsed.value = !collapsed.value; localStorage.setItem('cockpit-sidebar', collapsed.value ? '1' : '0'); }

const ICONS = {
  board: 'M3 3h7v7H3z M14 3h7v7h-7z M14 14h7v7h-7z M3 14h7v7H3z',
  pipeline: 'M6 3v12 M15 6a3 3 0 1 0 6 0 3 3 0 1 0-6 0 M3 18a3 3 0 1 0 6 0 3 3 0 1 0-6 0 M18 9a9 9 0 0 1-9 9',
  chats: 'M8 10h8 M8 14h5 M7 4h10a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H9l-4 4v-4a3 3 0 0 1-1-2V7a3 3 0 0 1 3-3z',
  agents: 'M12 3v3 M12 3a1.2 1.2 0 1 0 0-.01 M8 6h8a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3z M9 12h.01 M15 12h.01 M9.5 16h5',
  routes: 'M9 3 3 6v15l6-3 6 3 6-3V3l-6 3-6-3z M9 3v15 M15 6v15',
  video: 'M15 8l6-4v16l-6-4V8z M3 6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6z',
  terminal: 'M4 5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z M7 9l3 3-3 3 M13 15h4',
  settings: 'M21 4h-7 M10 4H3 M21 12h-9 M8 12H3 M21 20h-5 M12 20H3 M14 2v4 M8 10v4 M16 18v4',
};
const nav = [
  { to: '/board', label: 'Доска', icon: 'board' },
  { to: '/pipeline', label: 'Конвейер', icon: 'pipeline' },
  { to: '/agents', label: 'Агенты', icon: 'agents' },
  { to: '/chats', label: 'Чаты', icon: 'chats' },
  { to: '/routes', label: 'Маршруты', icon: 'routes' },
  { to: '/video', label: 'Видео', icon: 'video' },
  { to: '/settings', label: 'Настройки', icon: 'settings' },
];
// Служебные пункты — прижаты к низу сайдбара.
const navBottom = [
  { to: '/terminal', label: 'Терминал', icon: 'terminal' },
];

async function loadHealth() { try { health.value = await api.get('/api/health'); } catch { health.value = null; } }
loadHealth();
// Вотчер оповещений: «конвейер отработал и ждёт тебя»
const notifyWatch = useNotifyWatchStore();
notifyWatch.start();
const { connected } = useSse((name) => {
  if (name === 'state-change') { loadHealth(); notifyWatch.check(); }
  // Фоновая проверка нашла новую версию CLI — подтягиваем реестр, чтобы зажечь индикатор.
  if (name === 'providers-update') prov.load();
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
        <router-link v-for="item in nav" :key="item.to" :to="item.to" class="navitem" active-class="active" :title="item.label">
          <span class="icwrap">
            <svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path :d="ICONS[item.icon]" /></svg>
            <!-- Агент работает в N чатах -->
            <span v-if="item.to === '/chats' && activeChats" class="navbadge">{{ activeChats }}</span>
          </span>
          <span class="lbl">{{ item.label }}</span>
        </router-link>
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
        <HelpTip v-if="sys" align="right"
                 :text="`CPU ${sys.cpu.percent}% (${sys.cpu.cores} ядер) · RAM+swap: занято ${sys.mem.usedGb} из ${sys.mem.totalGb} ГБ (свободно ${sys.mem.freeGb})` + (sys.mem.swapTotalGb ? ` · swap ${sys.mem.swapUsedGb}/${sys.mem.swapTotalGb} ГБ` : '')">
          <span class="metric mono">
            CPU <b :class="loadClass(sys.cpu.percent)">{{ sys.cpu.percent }}%</b>
            · RAM <b :class="loadClass(sys.mem.percent)">{{ sys.mem.usedGb }}/{{ sys.mem.totalGb }}</b>
          </span>
        </HelpTip>
        <span v-if="sys" class="sep" aria-hidden="true">·</span>
        <AttentionAlerts />
        <span v-if="prov.providers.length" class="provbox" @mouseenter="prov.loadUsage()">
          <HelpTip v-for="p in prov.providers" :key="p.id" class="prov-tip">
            <!-- Клик ведёт в настройки: обновление CLI — только вручную, кнопкой -->
            <span class="prov" :class="{ off: !p.available, upd: p.updateAvailable }"
                  :style="p.available ? { color: p.color } : null" @click="toProviders">
              <ProviderIcon :provider="p" :size="15" />
              <span v-if="p.updateAvailable" class="updot" aria-hidden="true"></span>
            </span>
            <template #tip>
              <span class="ptip">
                <span>{{ provTitle(p) }}</span>
                <!-- Индикатор новой версии. Кокпит НИЧЕГО не обновляет сам — только сообщает. -->
                <span v-if="p.updateAvailable" class="pupd">
                  Доступно обновление: <b>{{ p.latest }}</b> (стоит {{ (p.version || '').split(' ')[0] || '?' }})<br>
                  Обновить — в «Настройки → Исполнители» (клик по иконке)
                </span>
                <!-- Потребление лимитов подписки — как /usage в CLI -->
                <span v-if="prov.usage[p.id]?.length" class="pu">
                  <span v-for="b in prov.usage[p.id]" :key="b.key" class="pu-row">
                    <span class="pu-head"><span>{{ b.label }}</span><b :class="{ hot: b.pct >= 85 }">{{ b.pct }}%</b></span>
                    <span class="pu-bar"><span class="pu-fill" :class="{ hot: b.pct >= 85 }" :style="{ width: Math.min(100, b.pct) + '%' }"></span></span>
                    <span v-if="b.note || resetIn(b.resetsAt)" class="pu-reset">{{ b.note || resetIn(b.resetsAt) }}</span>
                  </span>
                </span>
              </span>
            </template>
          </HelpTip>
        </span>
        <span v-if="prov.providers.length && sys?.net" class="sep" aria-hidden="true">·</span>
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
  display: grid; height: 100%;
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
.navitem, .collapse-btn {
  display: flex; align-items: center; gap: 11px; padding: 9px 11px; border-radius: 9px;
  color: var(--ink-mid); font-size: 14px; background: none; border: none; cursor: pointer; text-align: left; width: 100%;
  transition: background .12s, color .12s;
}
.navitem:hover, .collapse-btn:hover { background: var(--surface); color: var(--ink); }
.navitem.active { background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--accent); }
.ic { width: 19px; height: 19px; flex: none; }
.icwrap { position: relative; display: inline-flex; flex: none; }
/* Бейдж «агент работает в N чатах» — пульсирует, виден и в свёрнутом сайдбаре */
.navbadge { position: absolute; top: -5px; right: -7px; min-width: 14px; height: 14px; padding: 0 3px;
  border-radius: 999px; background: var(--accent); color: #fff; font-size: 9.5px; font-weight: 700;
  display: grid; place-items: center; line-height: 1; animation: navbadge-pulse 1.6s ease-in-out infinite; }
@keyframes navbadge-pulse { 50% { box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 25%, transparent); } }
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
.metric { color: var(--ink-mid); font-variant-numeric: tabular-nums; }
.metric b { font-weight: 600; }
.sep { color: var(--ink-mid); margin: 0 -4px; }
.provbox { display: inline-flex; align-items: center; gap: 9px; }
.prov { display: inline-grid; place-items: center; position: relative; cursor: pointer; }
.prov.off { color: var(--ink-mid); opacity: .45; }
/* Точка «вышла новая версия CLI». Обновление — только руками из настроек. */
.updot { position: absolute; top: -2px; right: -3px; width: 6px; height: 6px; border-radius: 50%;
  background: var(--warn, #e0a33a); box-shadow: 0 0 0 2px var(--surface); }
.prov.upd { opacity: 1; }
.pupd { display: block; margin-top: 6px; padding-top: 6px; border-top: 1px solid var(--line);
  color: var(--warn, #e0a33a); line-height: 1.5; }
.pupd b { font-weight: 600; }
/* Тултип исполнителя: статус + прогрессбары потребления лимитов */
.prov-tip :deep(.ht-tip) { max-width: 320px; }
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
.netbox { display: inline-flex; align-items: center; gap: 6px; color: var(--ink-mid); }
.netbox .flag { font-size: 14px; line-height: 1; }
.netbox .ip { letter-spacing: .01em; }
.lv-ok { color: var(--ink); } .lv-warn { color: var(--warn); } .lv-bad { color: var(--bad); }
.conn { display: flex; align-items: center; gap: 7px; color: var(--ink-mid); }
.conn .dot { width: 8px; height: 8px; border-radius: 50%; }
.conn.on .dot { background: var(--good); box-shadow: 0 0 6px color-mix(in srgb, var(--good) 60%, transparent); }
.conn.off .dot { background: var(--bad); }
.host { overflow: hidden; text-overflow: ellipsis; max-width: 200px; }

.content { grid-row: 2; grid-column: 2; overflow-y: auto; padding: 22px; }

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

/* ── Мобайл: сайдбар → нижняя навигация ── */
@media (max-width: 759px) {
  .shell, .shell.collapsed { grid-template-columns: 1fr; grid-template-rows: 52px 1fr auto; }
  .sidebar { grid-row: 3; grid-column: 1; flex-direction: row; padding: 0; border-right: none; border-top: 1px solid var(--line);
    padding-bottom: env(safe-area-inset-bottom, 0); }
  .brand, .collapse-btn { display: none; }
  /* На мобиле обе навигации сливаются в один нижний ряд */
  .nav, .nav-bottom { display: contents; }
  .navitem { flex: 1; flex-direction: column; gap: 3px; font-size: 11px; padding: 9px 0; border-radius: 0; }
  .navitem.active { background: none; }
  .topbar { grid-row: 1; grid-column: 1; padding: 0 16px; }
  .mlogo { display: inline; }
  .content { grid-row: 2; grid-column: 1; padding: 16px; }
  .host { display: none; }
  @media (max-width: 440px) { .metric { display: none; } .netbox .ip { display: none; } }
}
</style>
