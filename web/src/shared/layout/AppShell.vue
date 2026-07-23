<script setup>
import { ref } from 'vue';
import { storeToRefs } from 'pinia';
import { useRoute } from 'vue-router';
import { api } from '../api-client.js';
import { useSse } from '../../composables/useSse.js';
import { useSystemStore } from '../../stores/system.js';
import { usePwaStore } from '../../stores/pwa.js';

const route = useRoute();
const health = ref(null);
const { data: sys } = storeToRefs(useSystemStore());
const pwa = usePwaStore();

function loadClass(p) { return p >= 85 ? 'lv-bad' : p >= 60 ? 'lv-warn' : 'lv-ok'; }

const collapsed = ref(localStorage.getItem('cockpit-sidebar') === '1');
function toggleSidebar() { collapsed.value = !collapsed.value; localStorage.setItem('cockpit-sidebar', collapsed.value ? '1' : '0'); }

const ICONS = {
  board: 'M3 3h7v7H3z M14 3h7v7h-7z M14 14h7v7h-7z M3 14h7v7H3z',
  pipeline: 'M6 3v12 M15 6a3 3 0 1 0 6 0 3 3 0 1 0-6 0 M3 18a3 3 0 1 0 6 0 3 3 0 1 0-6 0 M18 9a9 9 0 0 1-9 9',
  agents: 'M8 10h8 M8 14h5 M7 4h10a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H9l-4 4v-4a3 3 0 0 1-1-2V7a3 3 0 0 1 3-3z',
  routes: 'M9 3 3 6v15l6-3 6 3 6-3V3l-6 3-6-3z M9 3v15 M15 6v15',
  video: 'M15 8l6-4v16l-6-4V8z M3 6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6z',
  terminal: 'M4 5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z M7 9l3 3-3 3 M13 15h4',
  settings: 'M21 4h-7 M10 4H3 M21 12h-9 M8 12H3 M21 20h-5 M12 20H3 M14 2v4 M8 10v4 M16 18v4',
};
const nav = [
  { to: '/board', label: 'Доска', icon: 'board' },
  { to: '/pipeline', label: 'Конвейер', icon: 'pipeline' },
  { to: '/agents', label: 'Агенты', icon: 'agents' },
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
const { connected } = useSse((name) => { if (name === 'state-change') loadHealth(); });
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
          <svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path :d="ICONS[item.icon]" /></svg>
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
      <div class="status">
        <span v-if="sys" class="metric mono"
              :title="`CPU ${sys.cpu.percent}% (${sys.cpu.cores} ядер) · RAM+swap: занято ${sys.mem.usedGb} из ${sys.mem.totalGb} ГБ (свободно ${sys.mem.freeGb})` + (sys.mem.swapTotalGb ? ` · swap ${sys.mem.swapUsedGb}/${sys.mem.swapTotalGb} ГБ` : '')">
          CPU <b :class="loadClass(sys.cpu.percent)">{{ sys.cpu.percent }}%</b>
          · RAM <b :class="loadClass(sys.mem.percent)">{{ sys.mem.usedGb }}/{{ sys.mem.totalGb }}</b>
        </span>
        <span class="conn" :class="connected ? 'on' : 'off'" :title="connected ? 'канал жив' : 'нет связи'">
          <span class="dot"></span>
          <span class="host mono">{{ health ? health.host : 'офлайн' }}</span>
        </span>
      </div>
    </header>

    <main class="content"><slot /></main>

    <div v-if="pwa.needRefresh" class="updbar">
      <span>Доступно обновление кокпита</span>
      <button :disabled="pwa.updating" @click="pwa.doUpdate()">
        <span v-if="pwa.updating" class="spin"></span>{{ pwa.updating ? 'Обновляю…' : 'Обновить' }}
      </button>
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
.nav-bottom { margin-top: auto; }
.collapse-btn { margin-top: 4px; }

/* Свёрнутый сайдбар: только иконки по центру, подписи скрыты */
.collapsed .brand .name, .collapsed .lbl { display: none; }
.collapsed .brand { justify-content: center; padding: 8px 0 16px; }
.collapsed .navitem, .collapsed .collapse-btn { justify-content: center; padding: 10px 0; gap: 0; }

/* ── Топбар ── */
.topbar {
  grid-row: 1; grid-column: 2;
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 0 22px; background: var(--topbar); border-bottom: 1px solid var(--line);
}
.tbleft { display: flex; align-items: center; gap: 10px; min-width: 0; }
.mlogo { display: none; color: var(--accent); font-size: 18px; }
.page { margin: 0; font-size: 15px; font-weight: 640; letter-spacing: -.01em; }
.status { display: flex; align-items: center; gap: 14px; font-size: 12px; white-space: nowrap; }
.metric { color: var(--ink-mid); }
.metric b { font-weight: 600; }
.lv-ok { color: var(--ink); } .lv-warn { color: var(--warn); } .lv-bad { color: var(--bad); }
.conn { display: flex; align-items: center; gap: 7px; color: var(--ink-mid); }
.conn .dot { width: 8px; height: 8px; border-radius: 50%; }
.conn.on .dot { background: var(--good); box-shadow: 0 0 6px color-mix(in srgb, var(--good) 60%, transparent); }
.conn.off .dot { background: var(--bad); }
.host { overflow: hidden; text-overflow: ellipsis; max-width: 200px; }

.content { grid-row: 2; grid-column: 2; overflow-y: auto; padding: 22px; }

.updbar {
  position: fixed; top: 14px; left: 50%; transform: translateX(-50%); z-index: 200;
  display: flex; align-items: center; gap: 12px;
  background: var(--accent); color: #fff; border-radius: 999px;
  padding: 8px 10px 8px 18px; font-size: 13px; box-shadow: 0 8px 26px #0009;
}
.updbar button { background: #fff; color: var(--accent); border: none; border-radius: 999px; padding: 6px 14px; font-size: 13px; font-weight: 600; cursor: pointer; }

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
  @media (max-width: 440px) { .metric { display: none; } }
}
</style>
