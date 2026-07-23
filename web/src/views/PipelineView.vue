<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { api } from '../shared/api-client.js';
import { useSse } from '../composables/useSse.js';
import { useUiStore } from '../stores/ui.js';
import { useTasksStore } from '../stores/tasks.js';
import { useBoardStore } from '../stores/board.js';
import { secToHMS } from '../shared/format.js';
import FactoryGraph from './pipeline/FactoryGraph.vue';

const ui = useUiStore();
const taskStore = useTasksStore();
const board = useBoardStore();

const tasks = ref([]);
const error = ref(null);
const loaded = ref(false);
const now = ref(Date.now());

// Названия задач фабрики (из B24) — для кликабельного заголовка карточки.
function title(taskNum) { return taskStore.title(taskNum); }

// Таймеры, идущие ВНЕ фабрики: активные задачи доски, которых нет на конвейере.
const factoryIds = computed(() => new Set(tasks.value.map((t) => Number(t.task))));
const outsideTimers = computed(() => {
  const d = board.data; if (!d) return [];
  return (d.tasks || []).filter((t) => t.timerRunning && !factoryIds.value.has(t.id));
});
function outsideElapsed(t) {
  return (t.timerElapsed || 0) + (now.value - (board.loadedAt || now.value)) / 1000;
}

let ticker = null;
onMounted(() => { ticker = setInterval(() => { now.value = Date.now(); }, 1000); });
onUnmounted(() => { if (ticker) clearInterval(ticker); clearInterval(actPoll); });

// Тумблеры (переживают перезагрузку — как в старом дашборде).
const compact = ref(localStorage.getItem('cockpit-compact') === '1');
const loopsOn = ref(localStorage.getItem('cockpit-loops') === '1');
function toggleCompact() { compact.value = !compact.value; localStorage.setItem('cockpit-compact', compact.value ? '1' : '0'); }
function toggleLoops() { loopsOn.value = !loopsOn.value; localStorage.setItem('cockpit-loops', loopsOn.value ? '1' : '0'); }

// Фильтр по проектам (профилям).
const activeProject = ref(localStorage.getItem('cockpit-project') || 'all');
function setProject(p) { activeProject.value = p; localStorage.setItem('cockpit-project', p); }
const projects = computed(() => [...new Set(tasks.value.map((t) => t.profile).filter(Boolean))]);
const filteredTasks = computed(() => (activeProject.value === 'all'
  ? tasks.value : tasks.value.filter((t) => t.profile === activeProject.value)));

// По-карточное сворачивание (запоминается). Свёрнута, если глобальный compact ИЛИ отмечена.
const collapsedSet = ref(new Set(JSON.parse(localStorage.getItem('cockpit-cards-collapsed') || '[]')));
function toggleCard(task) {
  const s = new Set(collapsedSet.value);
  s.has(task) ? s.delete(task) : s.add(task);
  collapsedSet.value = s;
  localStorage.setItem('cockpit-cards-collapsed', JSON.stringify([...s]));
}
function isCollapsed(task) { return compact.value || collapsedSet.value.has(task); }
const waitingCount = computed(() => filteredTasks.value.filter((t) => waitingReason(t.graph)).length);

// Модалка этапа (клик по узлу графа): инфо + управление (ворота/форс/указание/активность).
const stage = ref(null);
const stageBusy = ref(null);
const stageComment = ref('');
const stageInstruction = ref('');
const stageActivity = ref(null);
let actPoll = null;
const STAGE_HINT = {
  done: 'пройден', run: 'выполняется сейчас', wait: 'ждёт твоего решения', pending: 'ещё не начинался',
  skip: 'пропущен осознанно', idle: 'нет данных (прогон по прежней схеме)', stall: 'завис — агент молчит',
  skipbad: 'пропущен без причины — аномалия', premature: 'преждевременно: хвост не доделан',
};
const FORCE_STATUSES = ['running', 'done', 'skipped', 'pending'];

function openStage(t, node) {
  stage.value = {
    task: t.task, id: node.nid, key: t.graph.keys?.[node.nid] || node.nid.toUpperCase(),
    isGate: node.nid.startsWith('gate_'), label: stripEmoji(node.label), sub: node.sub,
    status: node.status, meta: t.graph.nodeMeta?.[node.nid] || {},
  };
  stageComment.value = ''; stageActivity.value = null; stageInstruction.value = '';
  api.get(`/api/tasks/${t.task}/instruction`).then((r) => { stageInstruction.value = r.text || ''; }).catch(() => {});
  clearInterval(actPoll);
  if (node.status === 'run') { pollActivity(); actPoll = setInterval(pollActivity, 3000); }
}
function closeStage() { stage.value = null; clearInterval(actPoll); }
async function pollActivity() {
  if (!stage.value) return;
  try { stageActivity.value = await api.get(`/api/tasks/${stage.value.task}/activity`); } catch { /* игнор */ }
}
async function gateDecide(decision) {
  stageBusy.value = 'gate';
  try { await api.post(`/api/tasks/${stage.value.task}/gate/${stage.value.key}/${decision}`, { comment: stageComment.value }); await load(); closeStage(); }
  catch (e) { alert(`Ошибка: ${e.message}`); } finally { stageBusy.value = null; }
}
async function forceStatus(status) {
  if (!confirm(`Принудительно: этап «${stage.value.label}» → ${status}?`)) return;
  stageBusy.value = 'force';
  try { await api.post(`/api/tasks/${stage.value.task}/stage/${stage.value.key}/${status}`); await load(); closeStage(); }
  catch (e) { alert(`Ошибка: ${e.message}`); } finally { stageBusy.value = null; }
}
async function saveInstruction() {
  stageBusy.value = 'instr';
  try { await api.post(`/api/tasks/${stage.value.task}/instruction`, { text: stageInstruction.value }); }
  catch (e) { alert(`Ошибка: ${e.message}`); } finally { stageBusy.value = null; }
}

// «Ждёт тебя» — по узлу-воротам в статусе wait/premature.
const GATE_REASON = {
  gate_accept: 'принять работу — проверить в браузере', gate_plan: 'утвердить план работ',
  gate_cause: 'подтвердить причину', gate_demo: 'посмотреть демо-видео', gate_demo_ok: 'принять демо',
};
function waitingReason(g) {
  for (const nid of Object.keys(g.pos)) {
    const s = g.statuses[nid];
    if ((s === 'wait' || s === 'premature') && nid.startsWith('gate_')) {
      return { text: GATE_REASON[nid] || stripEmoji(g.nodes[nid]?.[1]) || nid, premature: s === 'premature' };
    }
  }
  return null;
}

async function sandboxDown(task) {
  if (!confirm(`Снести стенд задачи #${task}? Действие необратимо.`)) return;
  try { await api.post(`/api/tasks/${task}/sandbox/down`); load(); }
  catch (e) { alert(e.status === 501 ? 'Снос стенда не настроен (COCKPIT_SANDBOX_DOWN_CMD).' : `Ошибка: ${e.message}`); }
}

const ROUTE_ICON = { feature: '✨', debug: '🔍', trivial: '⚡', dev: '🛠', quick: '⚡' };
function stripEmoji(s) { return (s || '').replace(/^[^\wА-Яа-яЁё]+/, '').trim(); }

async function load() {
  try {
    const { tasks: list } = await api.get('/api/tasks');
    const graphs = await Promise.all(
      list.map((t) => api.get(`/api/tasks/${t.task}/graph`).catch(() => null)),
    );
    tasks.value = list.map((t, i) => ({ ...t, graph: graphs[i] })).filter((x) => x.graph);
    // Названия задач из B24 (для заголовка) + доска (для «таймеров вне фабрики»).
    tasks.value.forEach((t) => taskStore.load(t.task).catch(() => {}));
    board.load();
    error.value = null;
  } catch (e) {
    error.value = e.message;
  } finally {
    loaded.value = true;
  }
}
load();
useSse((name) => { if (name === 'state-change') load(); });

// Класс полосы прогресса по текущему статусу.
function progressClass(g) {
  const cur = g.progress.current;
  const s = cur ? g.statuses[cur] : 'done';
  if (s === 'run') return 'pk-run';
  if (s === 'wait' || s === 'premature') return 'pk-wait';
  return 'pk-done';
}
function currentLabel(g) {
  const cur = g.progress.current;
  return cur ? stripEmoji(g.nodes[cur]?.[1]) : 'готово';
}
function loopList(g) {
  return Object.entries(g.loops || {}).map(([k, n]) => `${stripEmoji(g.nodes[k]?.[1]) || k} ×${n}`);
}
function cardState(g) {
  const vals = Object.values(g.statuses);
  if (vals.includes('wait') || vals.includes('premature')) return 'attn';
  if (vals.includes('run')) return 'act';
  return '';
}
</script>

<template>
  <div class="pipeline">
    <div class="toolbar">
      <div class="tbrow">
        <h2 class="ttl">Задачи в работе <span class="cnt">{{ filteredTasks.length }}</span>
          <span v-if="waitingCount" class="needme">⏳ ждут тебя: {{ waitingCount }}</span>
        </h2>
        <div class="tools">
          <button :class="{ on: loopsOn }" @click="toggleLoops">↻ петли</button>
          <button :class="{ on: compact }" @click="toggleCompact">{{ compact ? '▤ подробно' : '☰ компактно' }}</button>
        </div>
      </div>
      <div v-if="projects.length" class="projects">
        <button class="pchip" :class="{ on: activeProject === 'all' }" @click="setProject('all')">все <b>{{ tasks.length }}</b></button>
        <button v-for="p in projects" :key="p" class="pchip" :class="{ on: activeProject === p }" @click="setProject(p)">
          {{ p }} <b>{{ tasks.filter(t => t.profile === p).length }}</b>
        </button>
      </div>
    </div>

    <p v-if="!loaded" class="muted">Загрузка…</p>
    <p v-else-if="error" class="err">Ошибка: {{ error }}</p>
    <p v-else-if="!tasks.length" class="muted">Задач в состоянии фабрики нет.</p>

    <article v-for="t in filteredTasks" :key="t.task" class="card" :class="[cardState(t.graph), { collapsed: isCollapsed(t.task) }]">
      <header class="head">
        <button v-if="!compact" class="chev" :title="isCollapsed(t.task) ? 'Развернуть' : 'Свернуть'" @click="toggleCard(t.task)">
          {{ collapsedSet.has(t.task) ? '▸' : '▾' }}
        </button>
        <span class="task mono">#{{ t.task }}</span>
        <span class="route">{{ ROUTE_ICON[t.route] || '•' }} {{ t.route }}</span>
        <button v-if="title(t.task)" class="ctitle" :title="title(t.task)" @click="ui.openTask(t.task)">{{ title(t.task) }}</button>
        <span v-else class="ctitle muted"><span class="spin"></span> загрузка названия…</span>
        <span class="daemon" :class="t.daemonAlive ? 'alive' : 'idle'">{{ t.daemonAlive ? '● идёт' : '○ стоит' }}</span>
      </header>

      <div class="progress">
        <div class="pbar-wrap">
          <div class="pbar" :class="progressClass(t.graph)"
               :style="{ width: (t.graph.progress.done / t.graph.progress.total * 100) + '%' }"></div>
        </div>
        <span class="pnum mono">{{ t.graph.progress.done }}/{{ t.graph.progress.total }}</span>
        <span class="pw">{{ currentLabel(t.graph) }}</span>
      </div>

      <!-- Ждёт тебя (видно и в свёрнутом виде) -->
      <div v-if="waitingReason(t.graph)" class="waitme" :class="{ premature: waitingReason(t.graph).premature }">
        ⏳ ждёт тебя: {{ waitingReason(t.graph).text }}
        <span v-if="waitingReason(t.graph).premature" class="pm">(преждевременно — хвост не доделан)</span>
      </div>

      <div v-if="!isCollapsed(t.task)" class="gwrap">
        <FactoryGraph :graph="t.graph" :loops-on="loopsOn" @node="(n) => openStage(t, n)" />
      </div>

      <footer v-if="!isCollapsed(t.task)" class="strip">
        <span v-if="t.graph.fePort" class="chunk">
          <span class="sdot" :class="t.daemonAlive ? 'on' : 'off'"></span>
          стенд · <a :href="`http://localhost:${t.graph.fePort}`" target="_blank">фронт :{{ t.graph.fePort }}</a>
          <a v-if="t.graph.apiPort" :href="`http://localhost:${t.graph.apiPort}`" target="_blank">API :{{ t.graph.apiPort }}</a>
        </span>
        <button v-if="t.graph.fePort" class="sbdown" @click="sandboxDown(t.task)">⏏ снести стенд</button>
        <span v-if="loopList(t.graph).length" class="chunk warn">↻ возвраты: {{ loopList(t.graph).join(', ') }}</span>
        <span v-if="t.graph.halted" class="chunk bad">⚠ застряла на {{ stripEmoji(t.graph.nodes[t.graph.halted]?.[1]) || t.graph.halted }}</span>
      </footer>
    </article>

    <!-- Таймеры вне фабрики: активные задачи B24, которых нет на конвейере -->
    <section v-if="outsideTimers.length" class="outside">
      <h3 class="ttl">Таймер идёт вне фабрики</h3>
      <div v-for="t in outsideTimers" :key="t.id" class="orow">
        <span class="oid mono">#{{ t.id }}</span>
        <button class="otitle" @click="ui.openTask(t.id)">{{ t.title }}</button>
        <span class="otimer mono">⏱ {{ secToHMS(outsideElapsed(t)) }}</span>
      </div>
    </section>

    <!-- Модалка этапа (клик по узлу графа): инфо + управление -->
    <div v-if="stage" class="soverlay" @click.self="closeStage()">
      <div class="smodal">
        <header class="sh">
          <span class="mono muted">#{{ stage.task }}</span>
          <h3>{{ stage.label }}</h3>
          <button class="sx" @click="closeStage()">✕</button>
        </header>
        <div class="sb">
          <div class="srow"><span class="k">Статус</span><span class="v">{{ stage.status }} — {{ STAGE_HINT[stage.status] || stage.status }}</span></div>
          <div v-if="stage.sub" class="srow"><span class="k">Инструмент</span><span class="v">{{ stage.sub }}</span></div>
          <div v-if="stage.meta.at" class="srow"><span class="k">Время</span><span class="v mono">{{ stage.meta.at }}</span></div>
          <div v-if="stage.meta.dur != null" class="srow"><span class="k">Длительность</span><span class="v">{{ stage.meta.dur }} мин</span></div>
          <div v-if="stage.meta.fanout != null" class="srow"><span class="k">Субагентов</span><span class="v">{{ stage.meta.fanout }}</span></div>
          <div v-if="stage.meta.fails" class="srow"><span class="k">Возвратов</span><span class="v bad">{{ stage.meta.fails }}</span></div>
          <div v-if="stage.meta.tokens" class="srow"><span class="k">Токенов</span><span class="v mono">{{ stage.meta.tokens.toLocaleString('ru') }}</span></div>

          <!-- Живая активность (для идущего этапа) -->
          <div v-if="stage.status === 'run'" class="sect">
            <div class="secth">
              <span class="spin"></span> Сейчас в работе
              <span v-if="stageActivity" class="jf" :class="{ on: stageActivity.journalFresh }">{{ stageActivity.journalFresh ? 'агент пишет' : 'тихо' }}</span>
            </div>
            <div v-if="stageActivity && stageActivity.tail.length" class="log">
              <div v-for="(l, i) in stageActivity.tail" :key="i" class="logline"><span class="mono muted">{{ l.ts.slice(11) }}</span> {{ l.event }}</div>
            </div>
            <p v-else class="muted small">Ожидание записей…</p>
          </div>

          <!-- Ворота: принять/отклонить + указание что доработать -->
          <div v-if="stage.isGate && (stage.status === 'wait' || stage.status === 'premature')" class="sect">
            <div class="secth">Ворота — твоё решение</div>
            <textarea v-model="stageComment" rows="2" placeholder="Что доработать / замечание агенту (при отклонении)"></textarea>
            <div class="gbtns">
              <button class="btn good" :disabled="stageBusy === 'gate'" @click="gateDecide('approve')">✓ Принять</button>
              <button class="btn bad" :disabled="stageBusy === 'gate'" @click="gateDecide('reject')">✗ Отклонить</button>
            </div>
          </div>

          <!-- Чат/указание агенту (применяется на границе этапов) -->
          <div class="sect">
            <div class="secth">Указание агенту</div>
            <textarea v-model="stageInstruction" rows="2" placeholder="Вопрос/уточнение по реализации — агент прочитает в начале следующего этапа"></textarea>
            <button class="btn" :disabled="stageBusy === 'instr'" @click="saveInstruction">{{ stageBusy === 'instr' ? '…' : 'Сохранить указание' }}</button>
          </div>

          <!-- Принудительный переход -->
          <div class="sect">
            <div class="secth">Принудительно перевести этап</div>
            <div class="gbtns">
              <button v-for="s in FORCE_STATUSES" :key="s" class="btn small" :disabled="stageBusy === 'force'" @click="forceStatus(s)">{{ s }}</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pipeline { display: flex; flex-direction: column; gap: 14px; }
/* Липкий тулбар: остаётся сверху при скролле */
.toolbar { position: sticky; top: 0; z-index: 15; background: var(--ground);
  padding: 10px 0; margin: -10px 0 0; display: flex; flex-direction: column; gap: 8px;
  border-bottom: 1px solid var(--line); }
.tbrow { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.ttl { font-size: 12px; text-transform: uppercase; letter-spacing: .14em; color: var(--ink-mid); margin: 0; display: flex; align-items: center; gap: 10px; }
.needme { color: var(--warn); text-transform: none; letter-spacing: 0; font-size: 12px; }
.projects { display: flex; flex-wrap: wrap; gap: 6px; }
.pchip { background: var(--surface-2); border: 1px solid var(--line); color: var(--ink-mid);
  border-radius: 999px; padding: 3px 12px; font-size: 12.5px; cursor: pointer; }
.pchip b { color: var(--ink); margin-left: 4px; }
.pchip.on { background: var(--accent); border-color: var(--accent); color: #fff; }
.pchip.on b { color: #fff; }
.chev { background: none; border: none; color: var(--ink-mid); cursor: pointer; font-size: 13px; padding: 0 2px; flex: none; }
.chev:hover { color: var(--ink); }
.waitme { margin: 6px 0 0; font-size: 12.5px; color: var(--warn);
  background: color-mix(in srgb, var(--warn) 12%, transparent); border: 1px solid color-mix(in srgb, var(--warn) 30%, transparent);
  border-radius: 8px; padding: 6px 10px; }
.waitme.premature { color: var(--bad); background: color-mix(in srgb, var(--bad) 12%, transparent); border-color: color-mix(in srgb, var(--bad) 30%, transparent); }
.waitme .pm { color: var(--bad); }
.sbdown { background: var(--surface-2); border: 1px solid var(--line); color: var(--ink-mid);
  border-radius: 8px; padding: 4px 10px; font-size: 12px; cursor: pointer; }
.sbdown:hover { color: var(--bad); border-color: var(--bad); }
.cnt { color: var(--ink); background: var(--surface-2); border-radius: 999px; padding: 1px 8px; margin-left: 6px; }
.tools { display: flex; gap: 6px; }
.tools button { background: var(--surface-2); border: 1px solid var(--line); color: var(--ink-mid);
  border-radius: 8px; padding: 5px 11px; font-size: 12px; cursor: pointer; }
.tools button.on { background: var(--accent); border-color: var(--accent); color: #fff; }

.err { color: var(--bad); }

.card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius);
  padding: 14px 16px; box-shadow: var(--shadow); border-left: 3px solid var(--line); }
.card.attn { border-left-color: var(--warn); }
.card.act { border-left-color: var(--accent); }

.head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.task { font-weight: 650; font-size: 15px; }
.route { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--accent);
  background: color-mix(in srgb, var(--accent) 14%, transparent); padding: 2px 8px; border-radius: 999px; }
.spacer { flex: 1; }
.daemon { font-size: 12px; }
.daemon.alive { color: var(--good); }
.daemon.idle { color: var(--ink-mid); }

.progress { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
.pbar-wrap { flex: 1; height: 6px; background: var(--surface-2); border-radius: 999px; overflow: hidden; }
.pbar { height: 100%; border-radius: 999px; transition: width .3s; }
.pbar.pk-run { background: var(--accent); }
.pbar.pk-wait { background: var(--warn); }
.pbar.pk-done { background: var(--good); }
.pnum { font-size: 12px; color: var(--ink-mid); flex: none; }
.pw { font-size: 12px; color: var(--ink); flex: none; }

.gwrap { overflow-x: auto; margin: 8px 0; }
.gwrap :deep(svg.graph) { min-width: 1160px; }

.strip { display: flex; flex-wrap: wrap; gap: 14px; font-size: 12.5px; color: var(--ink-mid);
  border-top: 1px solid var(--line); padding-top: 10px; }
.chunk { display: inline-flex; align-items: center; gap: 6px; }
.chunk.warn { color: var(--warn); }
.chunk.bad { color: var(--bad); }
.strip a { color: var(--accent); margin-left: 6px; }
.sdot { width: 8px; height: 8px; border-radius: 50%; }
.sdot.on { background: var(--good); }
.sdot.off { background: var(--ink-mid); }

.ctitle { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  background: none; border: none; color: var(--ink); text-align: left; font-size: 14px; font-weight: 600; cursor: pointer; padding: 0; }
.ctitle:hover { color: var(--accent); }

.outside { margin-top: 4px; }
.outside .ttl { font-size: 12px; text-transform: uppercase; letter-spacing: .14em; color: var(--ink-mid); margin: 0 0 8px; }
.orow { display: flex; align-items: center; gap: 12px; background: var(--surface); border: 1px solid var(--line);
  border-radius: 10px; padding: 10px 14px; margin-bottom: 8px; }
.oid { color: var(--ink-mid); font-size: 13px; flex: none; }
.otitle { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  background: none; border: none; color: var(--ink); text-align: left; font-size: 14px; font-weight: 600; cursor: pointer; padding: 0; }
.otitle:hover { color: var(--accent); }
.otimer { color: var(--good); font-size: 15px; flex: none; }

/* Модалка этапа */
.soverlay { position: fixed; inset: 0; background: #000a; display: flex; align-items: flex-start;
  justify-content: center; padding: 60px 16px; z-index: 100; }
.smodal { background: var(--surface); border: 1px solid var(--line); border-radius: 14px;
  width: 100%; max-width: 440px; box-shadow: var(--shadow); }
.sh { display: flex; align-items: center; gap: 10px; padding: 14px 16px; border-bottom: 1px solid var(--line); }
.sh h3 { flex: 1; margin: 0; font-size: 16px; font-weight: 640; }
.sx { background: var(--surface-2); border: 1px solid var(--line); color: var(--ink-mid); width: 30px; height: 30px; border-radius: 8px; cursor: pointer; }
.sb { padding: 12px 16px; display: flex; flex-direction: column; }
.srow { display: flex; justify-content: space-between; gap: 16px; padding: 8px 0; border-bottom: 1px solid var(--line-soft, var(--line)); font-size: 13.5px; }
.srow:last-child { border-bottom: none; }
.srow .k { color: var(--ink-mid); }
.srow .v.bad { color: var(--bad); }

.sect { border-top: 1px solid var(--line); padding-top: 12px; margin-top: 6px; display: flex; flex-direction: column; gap: 8px; }
.secth { font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: var(--ink-mid); display: flex; align-items: center; gap: 8px; }
.jf { text-transform: none; letter-spacing: 0; font-size: 11px; color: var(--ink-mid); margin-left: auto; }
.jf.on { color: var(--good); }
.log { max-height: 160px; overflow-y: auto; background: var(--ground); border: 1px solid var(--line); border-radius: 8px; padding: 8px; }
.logline { font-size: 12px; padding: 2px 0; }
.small { font-size: 12px; }
.sect textarea { background: var(--ground); border: 1px solid var(--line); border-radius: 8px; color: var(--ink); padding: 8px 10px; font-family: inherit; font-size: 13.5px; resize: vertical; }
.sect textarea:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
.gbtns { display: flex; flex-wrap: wrap; gap: 8px; }
.sect .btn { background: var(--surface-2); border: 1px solid var(--line); color: var(--ink); border-radius: 8px; padding: 7px 13px; font-size: 13px; cursor: pointer; align-self: flex-start; }
.sect .btn.good { background: var(--good); border-color: var(--good); color: #06210f; }
.sect .btn.bad { background: var(--bad); border-color: var(--bad); color: #2a0a0c; }
.sect .btn.small { padding: 5px 10px; font-size: 12px; }
.sect .btn:disabled { opacity: .5; cursor: default; }
</style>
