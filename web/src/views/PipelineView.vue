<script setup>
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';
import { api } from '../shared/api-client.js';
import { useSse } from '../composables/useSse.js';
import { useUiStore } from '../stores/ui.js';
import { useTasksStore } from '../stores/tasks.js';
import { useBoardStore } from '../stores/board.js';
import { useChatStore } from '../stores/chat.js';
import { secToHMS } from '../shared/format.js';
import { mdToHtml } from '../shared/md.js';
import { sandboxUrl } from '../shared/sandbox.js';
import FactoryGraph from './pipeline/FactoryGraph.vue';
import OpenDiffButton from './OpenDiffButton.vue';

const ui = useUiStore();
const chat = useChatStore();
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
const stageDoc = ref('');       // документ этапа (план/разведнота/диагноз…) — рендерится в модалке
const stageDocOpen = ref(true);
const stageLogOpen = ref(false);
const liveFeed = ref(null);
const stageDocLoading = ref(false);
let actPoll = null;
// Какой документ показывать на каком узле: у ворот плана — сам план, у приёмки — отчёт.
const NODE_DOC = {
  gate_plan: 'plan', plan: 'plan', skeptic: 'plan', validate: 'plan', translator: 'plan',
  scout: 'recon', diagnose: 'diag', hyposkeptic: 'diag', proof: 'diag', gate_cause: 'diag',
  ship: 'ship', gate_accept: 'report', browser: 'report', measure: 'report',
};
const STAGE_HINT = {
  done: 'пройден', run: 'выполняется сейчас', wait: 'ждёт твоего решения', pending: 'ещё не начинался',
  skip: 'пропущен осознанно', idle: 'нет данных (прогон по прежней схеме)', stall: 'завис — агент молчит',
  skipbad: 'пропущен без причины — аномалия', premature: 'преждевременно: хвост не доделан',
};
const FORCE_STATUSES = ['running', 'done', 'skipped', 'pending'];

const LIVE_ICONS = { tool: '⚙', subagent: '🤖', text: '💬', think: '🧠' };
function liveIcon(a) { return LIVE_ICONS[a.type] || '·'; }

function openStage(t, node) {
  stage.value = {
    task: t.task, id: node.nid, key: t.graph.keys?.[node.nid] || node.nid.toUpperCase(),
    isGate: node.nid.startsWith('gate_'), label: stripEmoji(node.label), sub: node.sub,
    status: node.status, meta: t.graph.nodeMeta?.[node.nid] || {},
  };
  stageComment.value = ''; stageActivity.value = null; stageInstruction.value = '';
  stageDoc.value = ''; stageDocOpen.value = true; stageDocLoading.value = false;
  stageLogOpen.value = false;
  const doc = NODE_DOC[node.nid];
  if (doc) {
    stageDocLoading.value = true;
    api.get(`/api/tasks/${t.task}/doc/${doc}`)
      .then((r) => { stageDoc.value = r.text || ''; })
      .catch(() => { /* документа нет — секция не показывается */ })
      .finally(() => { stageDocLoading.value = false; });
  }
  api.get(`/api/tasks/${t.task}/instruction`).then((r) => { stageInstruction.value = r.text || ''; }).catch(() => {});
  clearInterval(actPoll);
  if (node.status === 'run') { pollActivity(); actPoll = setInterval(pollActivity, 3000); }
}
function closeStage() { stage.value = null; clearInterval(actPoll); }
async function pollActivity() {
  if (!stage.value) return;
  try { stageActivity.value = await api.get(`/api/tasks/${stage.value.task}/activity`); } catch { /* игнор */ }
}
// Автопрокрутка ленты действий агента вниз при обновлении.
watch(() => stageActivity.value?.live?.actions?.length, () => {
  nextTick(() => { if (liveFeed.value) liveFeed.value.scrollTop = liveFeed.value.scrollHeight; });
});
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
        <button class="task mono" title="Свернуть/развернуть" @click="toggleCard(t.task)">#{{ t.task }}</button>
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
          стенд · <a :href="sandboxUrl(t.graph.fePort)" target="_blank" rel="noopener">фронт :{{ t.graph.fePort }}</a>
          <a v-if="t.graph.apiPort" :href="sandboxUrl(t.graph.apiPort)" target="_blank" rel="noopener">API :{{ t.graph.apiPort }}</a>
        </span>
        <!-- Стенд ещё строится: живой прогресс сборки песочницы из t*.stage -->
        <span v-else-if="t.graph.sandbox" class="chunk building">
          <span class="spin"></span>
          стенд строится · {{ t.graph.sandbox.step }}/{{ t.graph.sandbox.total }} · {{ t.graph.sandbox.label }}
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

        <!-- Компактная строка метаданных -->
        <div class="smeta">
          <span class="sbadge" :class="stage.status">{{ STAGE_HINT[stage.status] || stage.status }}</span>
          <span v-if="stage.meta.at" class="smchip mono">{{ stage.meta.at.slice(11, 16) || stage.meta.at }}</span>
          <span v-if="stage.meta.dur != null" class="smchip">{{ stage.meta.dur }} мин</span>
          <span v-if="stage.meta.fanout != null" class="smchip">{{ stage.meta.fanout }} субаг.</span>
          <span v-if="stage.meta.tokens" class="smchip mono">{{ stage.meta.tokens.toLocaleString('ru') }} ток.</span>
          <span v-if="stage.meta.fails" class="smchip bad">{{ stage.meta.fails }} возвр.</span>
          <span v-if="stage.sub" class="smchip">{{ stage.sub }}</span>
          <span v-if="stageActivity" class="smchip jf" :class="{ on: stageActivity.journalFresh }">{{ stageActivity.journalFresh ? 'агент пишет' : 'тихо' }}</span>
        </div>

        <div class="sb">
          <!-- Ворота: принять/отклонить — первым делом, если ждёт решения -->
          <div v-if="stage.isGate && (stage.status === 'wait' || stage.status === 'premature')" class="sect gate-sect">
            <div class="secth">Ворота — твоё решение</div>
            <textarea v-model="stageComment" rows="2" placeholder="Что доработать / замечание агенту (при отклонении)"></textarea>
            <div class="gbtns">
              <button class="btn good" :disabled="stageBusy === 'gate'" @click="gateDecide('approve')">✓ Принять</button>
              <button class="btn bad" :disabled="stageBusy === 'gate'" @click="gateDecide('reject')">✗ Отклонить</button>
            </div>
          </div>

          <!-- Живая лента действий агента (для идущего этапа) -->
          <div v-if="stage.status === 'run' && stageActivity?.live" class="sect">
            <div class="secth"><span class="live-dot"></span> Агент сейчас</div>
            <div v-if="stageActivity.live.actions.length" class="live-feed" ref="liveFeed">
              <div v-for="(a, i) in stageActivity.live.actions" :key="i" class="lf-row" :class="a.status">
                <span class="lf-icon">{{ liveIcon(a) }}</span>
                <span class="lf-body">
                  <template v-if="a.type === 'tool' || a.type === 'subagent'">
                    <span class="lf-name">{{ a.name }}</span>
                    <span v-if="a.desc" class="lf-desc">{{ a.desc }}</span>
                    <span v-if="a.type === 'subagent' && a.tokens" class="lf-sub mono">{{ (a.tokens / 1000).toFixed(1) }}k ток · {{ a.tools }} инстр.{{ a.lastTool ? ' · ' + a.lastTool : '' }}</span>
                  </template>
                  <template v-else>
                    <span class="lf-text">{{ a.text }}</span>
                  </template>
                </span>
                <span class="lf-st" :class="a.status">{{ a.status === 'run' ? '●' : a.status === 'error' ? '✗' : '✓' }}</span>
              </div>
            </div>
            <p v-else class="muted small">Ожидание действий агента…</p>
            <div v-if="stageActivity.live.model" class="lf-model mono">{{ stageActivity.live.model }}</div>
          </div>

          <!-- Журнал этапов (stages.log) — сворачиваемый -->
          <div v-if="stage.status === 'run' && stageActivity?.tail?.length" class="sect">
            <div class="secth doct" @click="stageLogOpen = !stageLogOpen">
              {{ stageLogOpen ? '▾' : '▸' }} Журнал этапов
              <span class="muted small" style="margin-left:auto">{{ stageActivity.tail.length }}</span>
            </div>
            <div v-if="stageLogOpen" class="log">
              <div v-for="(l, i) in stageActivity.tail" :key="i" class="logline"><span class="mono muted">{{ l.ts.slice(11) }}</span> {{ l.event }}</div>
            </div>
          </div>

          <!-- Документ этапа: план у ворот плана, диагноз у ворот причины, отчёт на приёмке -->
          <div v-if="stageDocLoading" class="sect">
            <div class="secth"><span class="spin"></span> Документ этапа</div>
          </div>
          <div v-else-if="stageDoc" class="sect">
            <div class="secth doct" @click="stageDocOpen = !stageDocOpen">
              {{ stageDocOpen ? '▾' : '▸' }} Документ этапа
            </div>
            <div v-if="stageDocOpen" class="sdoc md" v-html="mdToHtml(stageDoc)"></div>
          </div>

          <!-- Действия -->
          <div class="sect sactions">
            <button class="btn" @click="chat.openFor(stage.task, title(stage.task)); closeStage()">💬 Обсудить с агентом</button>
            <OpenDiffButton :task-id="stage.task" />
            <button class="btn play" :disabled="stageBusy === 'force'" @click="forceStatus('running')" title="Сделать этот этап текущим">
              {{ stageBusy === 'force' ? '…' : '▶ Перейти сюда' }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pipeline { display: flex; flex-direction: column; gap: 14px; }
/* Липкий тулбар: full-bleed по бокам; top:-22px компенсирует padding-top .content,
   иначе sticky прилипает ниже паддинга и над ним светит прокрученный контент. */
.toolbar { position: sticky; top: -22px; z-index: 30; background: var(--ground);
  padding: 14px 22px 12px; margin: 0 -22px 6px; display: flex; flex-direction: column; gap: 8px;
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
.task { font-weight: 650; font-size: 15px; background: none; border: none; color: var(--ink); cursor: pointer; padding: 0; }
.task:hover { color: var(--accent); }
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
.chunk.building { color: var(--accent); }
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
.soverlay { position: fixed; inset: 0; background: #04060acc; backdrop-filter: blur(4px); display: flex; align-items: flex-start;
  justify-content: center; padding: 60px 16px; z-index: 100; overflow-y: auto; }
.smodal { background: var(--surface); border: 1px solid var(--line-2); border-radius: 16px;
  width: 100%; max-width: 760px; box-shadow: 0 20px 60px #000b; overflow: hidden; }
.sh { display: flex; align-items: center; gap: 10px; padding: 14px 16px; border-bottom: 1px solid var(--line); }
.sh h3 { flex: 1; margin: 0; font-size: 16px; font-weight: 640; }
.sx { background: var(--surface-2); border: 1px solid var(--line); color: var(--ink-mid); width: 30px; height: 30px; border-radius: 8px; cursor: pointer; }

/* Компактная строка метаданных */
.smeta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 10px 16px;
  border-bottom: 1px solid var(--line); background: var(--ground); }
.sbadge { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em;
  padding: 3px 10px; border-radius: 999px; }
.sbadge.run { background: color-mix(in srgb, var(--accent) 18%, transparent); color: var(--accent); }
.sbadge.done { background: color-mix(in srgb, var(--good) 18%, transparent); color: var(--good); }
.sbadge.wait, .sbadge.premature { background: color-mix(in srgb, var(--warn) 18%, transparent); color: var(--warn); }
.sbadge.pending, .sbadge.idle { background: var(--surface-2); color: var(--ink-mid); }
.sbadge.stall, .sbadge.skipbad { background: color-mix(in srgb, var(--bad) 18%, transparent); color: var(--bad); }
.sbadge.skip { background: var(--surface-2); color: var(--ink-mid); }
.smchip { font-size: 11.5px; color: var(--ink-mid); background: var(--surface-2); padding: 2px 8px; border-radius: 6px; }
.smchip.bad { color: var(--bad); background: color-mix(in srgb, var(--bad) 12%, transparent); }
.jf { font-size: 11px; color: var(--ink-mid); padding: 2px 8px; border-radius: 6px;
  background: var(--surface-2); text-transform: none; letter-spacing: 0; margin-left: auto; }
.jf.on { color: var(--good); background: color-mix(in srgb, var(--good) 12%, transparent); }

.sb { padding: 12px 16px; display: flex; flex-direction: column; }

/* Живая лента действий */
.live-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--bad);
  animation: live-pulse 1.2s ease-in-out infinite; display: inline-block; }
@keyframes live-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .3; } }
.live-feed { max-height: 300px; overflow-y: auto; background: var(--ground); border: 1px solid var(--line);
  border-radius: 10px; padding: 4px 0; }
.lf-row { display: flex; align-items: flex-start; gap: 8px; padding: 5px 12px; font-size: 12.5px;
  border-bottom: 1px solid color-mix(in srgb, var(--line) 40%, transparent); }
.lf-row:last-child { border-bottom: none; }
.lf-row.run { background: color-mix(in srgb, var(--accent) 6%, transparent); }
.lf-icon { flex: none; width: 18px; text-align: center; font-size: 13px; line-height: 1.4; }
.lf-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.lf-name { font-weight: 600; color: var(--ink); }
.lf-desc { color: var(--ink-mid); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lf-text { color: var(--ink-mid); font-style: italic; }
.lf-sub { font-size: 11px; color: var(--ink-mid); }
.lf-st { flex: none; width: 16px; text-align: center; font-size: 11px; }
.lf-st.done { color: var(--good); }
.lf-st.run { color: var(--accent); animation: live-pulse 1s ease-in-out infinite; }
.lf-st.error { color: var(--bad); }
.lf-model { font-size: 10.5px; color: var(--ink-mid); margin-top: 6px; text-align: right; }

.sect { padding-top: 10px; margin-top: 4px; display: flex; flex-direction: column; gap: 8px; }
.sect.row { flex-direction: row; flex-wrap: wrap; align-items: center; }
.secth { font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: var(--ink-mid); display: flex; align-items: center; gap: 8px; }
.log { max-height: 160px; overflow-y: auto; background: var(--ground); border: 1px solid var(--line); border-radius: 8px; padding: 8px; }
.logline { font-size: 12px; padding: 2px 0; }
.small { font-size: 12px; }
.sect textarea { background: var(--ground); border: 1px solid var(--line); border-radius: 8px; color: var(--ink); padding: 8px 10px; font-family: inherit; font-size: 13.5px; resize: vertical; }
.secth.doct { cursor: pointer; user-select: none; }
.sdoc { max-height: 52vh; overflow-y: auto; overflow-x: hidden; overflow-wrap: anywhere;
  background: var(--ground); border: 1px solid var(--line);
  border-radius: 10px; padding: 12px 16px; font-size: 13px; line-height: 1.55; }
.sdoc :deep(h1) { font-size: 15px; margin: 4px 0 8px; }
.sdoc :deep(h2) { font-size: 13.5px; margin: 12px 0 6px; }
.sdoc :deep(h3) { font-size: 12.5px; margin: 10px 0 4px; }
.sdoc :deep(code) { background: var(--surface-2); border-radius: 4px; padding: 1px 5px; font-size: 12px; }
.sdoc :deep(pre) { background: var(--surface-2); border-radius: 8px; padding: 10px; overflow-x: auto; }
.sdoc :deep(table) { border-collapse: collapse; }
.sdoc :deep(td), .sdoc :deep(th) { border: 1px solid var(--line); padding: 4px 8px; font-size: 12px; }
.gate-sect { background: color-mix(in srgb, var(--warn) 6%, transparent); border: 1px solid color-mix(in srgb, var(--warn) 25%, transparent);
  border-radius: 10px; padding: 12px; margin-bottom: 4px; }
.sect textarea:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
.gbtns { display: flex; flex-wrap: wrap; gap: 8px; }
.sactions { flex-direction: row; flex-wrap: wrap; align-items: center; gap: 8px;
  border-top: 1px solid var(--line); padding-top: 12px; margin-top: 8px; }
.sect .btn { background: var(--surface-2); border: 1px solid var(--line); color: var(--ink); border-radius: 8px; padding: 7px 13px; font-size: 13px; cursor: pointer; align-self: flex-start; }
.sect .btn.good { background: var(--good); border-color: var(--good); color: #06210f; }
.sect .btn.bad { background: var(--bad); border-color: var(--bad); color: #2a0a0c; }
.sect .btn.small { padding: 5px 10px; font-size: 12px; }
.sect .btn:disabled { opacity: .5; cursor: default; }
</style>
