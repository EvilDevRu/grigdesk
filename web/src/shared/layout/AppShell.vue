<script setup>
import { ref } from 'vue';
import { storeToRefs } from 'pinia';
import { useRoute } from 'vue-router';
import { api } from '../api-client.js';
import { useSse } from '../../composables/useSse.js';
import { useSystemStore } from '../../stores/system.js';
import { usePwaStore } from '../../stores/pwa.js';

import { ref as vref } from 'vue';

const route = useRoute();
const health = ref(null);
const { data: sys } = storeToRefs(useSystemStore());
const pwa = usePwaStore();

// Цвет метрики по нагрузке: спокойно / внимание / критично.
function loadClass(p) { return p >= 85 ? 'lv-bad' : p >= 60 ? 'lv-warn' : 'lv-ok'; }

// Свёрнутый сайдбар (запоминается).
const collapsed = vref(localStorage.getItem('cockpit-sidebar') === '1');
function toggleSidebar() { collapsed.value = !collapsed.value; localStorage.setItem('cockpit-sidebar', collapsed.value ? '1' : '0'); }

// Современные линейные иконки (Lucide-style).
const ICONS = {
  board: 'M4 4h7v7H4z M13 4h7v7h-7z M13 13h7v7h-7z M4 13h7v7H4z',
  pipeline: 'M6 3v12 M18 6a3 3 0 100-.01 M6 21a3 3 0 100-.01 M18 6a9 9 0 01-9 9',
  routes: 'M9 6l-5-2v14l5 2 6-2 5 2V6l-5-2-6 2z M9 4v16 M15 6v16',
  settings: 'M4 21v-7 M4 10V3 M12 21v-9 M12 8V3 M20 21v-5 M20 12V3 M2 14h4 M10 8h4 M18 16h4',
};
const nav = [
  { to: '/board', label: 'Доска', icon: 'board' },
  { to: '/pipeline', label: 'Конвейер', icon: 'pipeline' },
  { to: '/routes', label: 'Маршруты', icon: 'routes' },
  { to: '/settings', label: 'Настройки', icon: 'settings' },
];

async function loadHealth() {
  try { health.value = await api.get('/api/health'); }
  catch { health.value = null; }
}
loadHealth();

// Индикатор живого канала (SSE). При обновлении состояния — перечитываем health.
const { connected } = useSse((name) => { if (name === 'state-change') loadHealth(); });
</script>

<template>
  <div class="shell" :class="{ collapsed }">
    <div v-if="pwa.needRefresh" class="updbar">
      <span>Доступно обновление кокпита</span>
      <button @click="pwa.doUpdate()">Обновить</button>
    </div>
    <header class="topbar">
      <div class="brand">
        <span class="logo">▣</span>
        <span class="name">Кокпит</span>
        <span class="page muted">{{ route.meta.title || '' }}</span>
      </div>
      <div class="status">
        <span v-if="sys" class="metric mono"
              :title="`CPU ${sys.cpu.percent}% (${sys.cpu.cores} ядер) · RAM: занято ${sys.mem.usedGb} из ${sys.mem.totalGb} ГБ (свободно ${sys.mem.freeGb})`">
          CPU <b :class="loadClass(sys.cpu.percent)">{{ sys.cpu.percent }}%</b>
          · RAM <b :class="loadClass(sys.mem.percent)">{{ sys.mem.usedGb }}/{{ sys.mem.totalGb }} ГБ</b>
        </span>
        <span class="sep" v-if="sys"></span>
        <span class="dot" :class="connected ? 'on' : 'off'" :title="connected ? 'канал жив' : 'нет связи'"></span>
        <template v-if="health">
          <span class="host mono muted">{{ health.host }}</span>
          <span class="mono muted">{{ health.taskCount }} задач</span>
        </template>
        <span v-else class="mono muted">мозг офлайн</span>
      </div>
    </header>

    <main class="content">
      <slot />
    </main>

    <nav class="bottomnav">
      <router-link v-for="item in nav" :key="item.to" :to="item.to" class="navitem" active-class="active" :title="item.label">
        <svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path :d="ICONS[item.icon]" /></svg>
        <span class="lbl">{{ item.label }}</span>
      </router-link>
      <button class="collapse-btn" :title="collapsed ? 'Развернуть' : 'Свернуть'" @click="toggleSidebar">
        <svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path :d="collapsed ? 'M9 18l6-6-6-6' : 'M15 18l-6-6 6-6'" />
        </svg>
        <span class="lbl">Свернуть</span>
      </button>
    </nav>
  </div>
</template>

<style scoped>
.shell {
  display: grid;
  grid-template-rows: auto 1fr auto;
  height: 100%;
}
/* Плашка обновления — плавающая, не влияет на grid */
.updbar {
  position: fixed; top: 14px; left: 50%; transform: translateX(-50%); z-index: 200;
  display: flex; align-items: center; gap: 12px;
  background: var(--accent); color: #fff; border-radius: 999px;
  padding: 8px 10px 8px 18px; font-size: 13px; box-shadow: 0 6px 22px #0007;
}
.updbar button {
  background: #fff; color: var(--accent); border: none; border-radius: 999px;
  padding: 6px 14px; font-size: 13px; font-weight: 600; cursor: pointer;
}
.topbar {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 12px 16px; border-bottom: 1px solid var(--line);
  background: var(--surface); position: sticky; top: 0; z-index: 10;
}
.brand { display: flex; align-items: baseline; gap: 10px; min-width: 0; }
.logo { color: var(--accent); font-size: 18px; flex: none; }
.name { font-weight: 650; flex: none; }
.page { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.status { display: flex; align-items: center; gap: 8px; font-size: 12px; white-space: nowrap; min-width: 0; }
/* Имя хоста прячем на узком экране, чтобы шапка не распирала ширину. */
.host { overflow: hidden; text-overflow: ellipsis; }
.metric { color: var(--ink-mid); }
.metric b { font-weight: 600; }
.lv-ok { color: var(--ink); }
.lv-warn { color: var(--warn); }
.lv-bad { color: var(--bad); }
.sep { width: 1px; height: 12px; background: var(--line); flex: none; }
@media (max-width: 520px) { .host { display: none; } }
@media (max-width: 440px) { .metric, .sep { display: none; } }
.dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
.dot.on { background: var(--good); }
.dot.off { background: var(--bad); }

.content { overflow-y: auto; padding: 16px; }

.bottomnav {
  display: flex; border-top: 1px solid var(--line); background: var(--surface);
  padding-bottom: env(safe-area-inset-bottom, 0);
}
.navitem, .collapse-btn {
  flex: 1; display: flex; flex-direction: column; align-items: center; gap: 3px;
  padding: 10px 0; color: var(--ink-mid); font-size: 11px;
  background: none; border: none; cursor: pointer;
}
.navitem.active { color: var(--accent); }
.ic { width: 20px; height: 20px; flex: none; }
.collapse-btn { display: none; } /* только на десктопе */

/* Десктоп: навигация уезжает в шапку слева, нижней панели нет. */
@media (min-width: 760px) {
  .shell { grid-template-rows: auto 1fr; grid-template-columns: 200px 1fr; }
  .topbar { grid-column: 1 / -1; }
  .bottomnav {
    grid-row: 2; grid-column: 1; flex-direction: column; border-top: none;
    border-right: 1px solid var(--line); padding: 12px 8px; gap: 4px;
  }
  .navitem, .collapse-btn { flex: none; flex-direction: row; justify-content: flex-start; gap: 10px;
    padding: 10px 12px; border-radius: var(--radius); font-size: 14px; }
  .navitem.active { background: var(--surface-2); }
  .content { grid-row: 2; grid-column: 2; }
  .collapse-btn { display: flex; margin-top: auto; color: var(--ink-mid); }
  .collapse-btn:hover { background: var(--surface-2); }

  /* Свёрнутый сайдбар */
  .shell.collapsed { grid-template-columns: 60px 1fr; }
  .collapsed .navitem, .collapsed .collapse-btn { justify-content: center; padding: 10px 0; }
  .collapsed .lbl { display: none; }
}
</style>
