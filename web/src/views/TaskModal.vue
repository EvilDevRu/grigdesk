<script setup>
import { ref, computed, watch, onUnmounted } from 'vue';
import { storeToRefs } from 'pinia';
import { useRouter } from 'vue-router';
import { api } from '../shared/api-client.js';
import { confirmDialog } from '../shared/ui/confirm.js';
import { useUiStore } from '../stores/ui.js';
import { useTasksStore } from '../stores/tasks.js';
import { useBoardStore } from '../stores/board.js';
import { useAnalysisStore } from '../stores/analysis.js';
import { secToHMS } from '../shared/format.js';
import { mdToHtml } from '../shared/md.js';
import OpenDiffButton from './OpenDiffButton.vue';

const router = useRouter();

const ui = useUiStore();
const tasks = useTasksStore();
const board = useBoardStore();
const { taskId } = storeToRefs(ui);
const { loadedAt: boardLoadedAt } = storeToRefs(board);

const detail = ref(null);
const loading = ref(false);
const busy = ref(null);   // какое действие выполняется
const err = ref(null);
const commentText = ref('');
const now = ref(Date.now());

let ticker = null;

// Таймер задачи — из кеша доски (там timerRunning/elapsed/startedAt).
const boardTask = computed(() => {
  const d = board.data; if (!d || !taskId.value) return null;
  const id = Number(taskId.value);
  for (const list of [d.tasks, d.toReview, d.created, d.accomplice, d.auditor]) {
    const t = (list || []).find((x) => x.id === id);
    if (t) return t;
  }
  return null;
});
const running = computed(() => !!boardTask.value?.timerRunning);
const elapsed = computed(() => {
  const t = boardTask.value; if (!t) return null;
  const extra = t.timerRunning ? (now.value - boardLoadedAt.value) / 1000 : 0;
  return (t.timerElapsed || 0) + extra;
});

// B24 отдаёт описание с HTML/entities — чистим до читаемого текста.
function htmlToText(s) {
  return (s || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/\n{3,}/g, '\n\n').trim();
}
const cleanDesc = computed(() => htmlToText(detail.value?.description));

// Описание — текстом, но URL в нём должны жить: экранируем и оборачиваем ссылки.
function linkify(s) {
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return esc(s || '').replace(/(https?:\/\/[^\s&]+(?:&amp;[^\s&]+)*)/g,
    (u) => `<a href="${u.replace(/&amp;/g, '&')}" target="_blank" rel="noopener">${u}</a>`);
}
const descHtml = computed(() => linkify(cleanDesc.value));

async function loadDetail(force = false) {
  if (!taskId.value) return;
  loading.value = true; err.value = null;
  try { detail.value = await tasks.load(taskId.value, force); }
  catch (e) { err.value = e.message; }
  finally { loading.value = false; }
}

// ── Триаж: оценка сложности/рисков разведкой кода (без стенда) ──
const analysisStore = useAnalysisStore();
const triage = ref(null);        // ответ /api/analysis/:id
const showNote = ref(false);     // разведнота развёрнута
let triageTimer = null;
const triageState = computed(() => triage.value?.status?.state || null);
const triageBusy = computed(() => triageState.value === 'queued' || triageState.value === 'running');
const noteHtml = computed(() => (triage.value?.note ? mdToHtml(triage.value.note) : ''));

async function loadTriage() {
  if (!taskId.value) return;
  try { triage.value = await analysisStore.detail(taskId.value); } catch { /* блок триажа не ломает модалку */ }
  // Пока идёт — подтягиваем статус; закончилось — останавливаемся.
  if (triageBusy.value && !triageTimer) {
    triageTimer = setInterval(loadTriage, 6000);
  } else if (!triageBusy.value && triageTimer) {
    clearInterval(triageTimer); triageTimer = null;
  }
}
const analyzeNow = () => act('analyze', async () => {
  await analysisStore.analyze(taskId.value);
  await loadTriage();
});

// Ответ на вопросы триажа: уходит комментарием в B24 (агент читает комментарии
// вместе с тикетом) и сразу запускает переоценку — цикл уточнения в один клик.
const clarifyText = ref('');
const sendClarify = () => act('clarify', async () => {
  await tasks.comment(taskId.value, `Уточнение к триажу:\n${clarifyText.value.trim()}`);
  clarifyText.value = '';
  await analysisStore.analyze(taskId.value);
  await loadTriage();
});

// Уже ли задача на конвейере (есть в состоянии фабрики) — для защиты от повторного запуска.
const conveyor = ref(null);
async function loadConveyor() {
  conveyor.value = null;
  if (!taskId.value) return;
  try {
    const { tasks: list } = await api.get('/api/tasks');
    conveyor.value = (list || []).find((t) => String(t.task) === String(taskId.value)) || null;
  } catch { /* нет данных фабрики — не блокируем */ }
}
function openConveyor() { ui.close(); router.push('/pipeline'); }

async function act(name, fn) {
  busy.value = name; err.value = null;
  try { await fn(); }
  catch (e) { err.value = e.message; }
  finally { busy.value = null; }
}
const toggleTimer = () => act('timer', () => tasks.timer(taskId.value, running.value ? 'pause' : 'start'));
const complete = async () => { if (await confirmDialog('Завершить задачу?', { okText: 'Завершить' })) act('complete', async () => { await tasks.complete(taskId.value); ui.close(); }); };
const launchMsg = ref(null);
const launch = async () => {
  // Защита: задача уже на конвейере — не запускаем повторно.
  if (conveyor.value) { launchMsg.value = 'Уже на конвейере'; return; }
  if (!(await confirmDialog(`Направить задачу #${taskId.value} на конвейер? Запустит фабрику (песочница + агенты).`, { okText: 'На конвейер' }))) return;
  act('launch', async () => {
    const ticket = `${detail.value?.title || ''}\n${cleanDesc.value || ''}`.trim();
    const r = await tasks.launch(taskId.value, ticket);
    launchMsg.value = r.outcome === 'already_running' ? 'Уже идёт на конвейере'
      : r.outcome === 'launched' ? `Запущено (профиль ${r.profile})`
      : r.note || 'Отправлено';
  });
};
const sendComment = () => act('comment', async () => { await tasks.comment(taskId.value, commentText.value); commentText.value = ''; });
const refresh = () => { loadDetail(true); board.load(true); };

// Открытие/закрытие модалки по taskId.
watch(taskId, (id) => {
  if (id) {
    detail.value = null; launchMsg.value = null;
    triage.value = null; showNote.value = false;
    loadDetail();
    loadConveyor();
    loadTriage();
    if (!ticker) ticker = setInterval(() => { now.value = Date.now(); }, 1000);
  } else {
    if (ticker) { clearInterval(ticker); ticker = null; }
    if (triageTimer) { clearInterval(triageTimer); triageTimer = null; }
  }
}, { immediate: true });
onUnmounted(() => {
  if (ticker) clearInterval(ticker);
  if (triageTimer) clearInterval(triageTimer);
});

function onKey(e) { if (e.key === 'Escape') ui.close(); }
watch(taskId, (id) => {
  if (id) window.addEventListener('keydown', onKey);
  else window.removeEventListener('keydown', onKey);
});
</script>

<template>
  <div v-if="taskId" class="overlay" @click.self="ui.close()">
    <div class="panel">
      <header class="mhead">
        <span class="mid mono">#{{ taskId }}</span>
        <h3 class="mtitle"><span v-if="loading && !detail" class="spin"></span> {{ detail?.title || (loading ? 'Загрузка…' : 'Задача') }}</h3>
        <button class="icon" title="Обновить" @click="refresh">⟳</button>
        <button class="icon" title="Закрыть" @click="ui.close()">✕</button>
      </header>

      <div class="mbody">
        <p v-if="err" class="err">{{ err }}</p>

        <div class="meta">
          <span v-if="detail?.status_label" class="tag">{{ detail.status_label }}</span>
          <span v-if="detail?.priority_label" class="tag">{{ detail.priority_label }}</span>
          <span v-if="boardTask?.group" class="tag">{{ boardTask.group }}</span>
          <span v-if="boardTask?.deadline" class="tag" :class="{ over: boardTask.overdue }">до {{ boardTask.deadline }}</span>
        </div>

        <p v-if="cleanDesc" class="desc" v-html="descHtml"></p>

        <!-- Триаж: оценка сложности/рисков без стенда -->
        <div class="triage">
          <div class="thead2">
            <span class="tlbl">Триаж</span>
            <template v-if="triage?.analysis">
              <span class="tchip" :class="triage.analysis.complexity >= 4 ? 'warn' : triage.analysis.complexity === 3 ? 'acc' : ''">сложность {{ triage.analysis.complexity }}/5</span>
              <span class="tchip" :class="triage.analysis.risk >= 4 ? 'bad' : triage.analysis.risk === 3 ? 'warn' : ''">риск {{ triage.analysis.risk }}/5</span>
              <span class="tchip">дифф {{ triage.analysis.diff_size }}</span>
              <span class="tchip">{{ triage.analysis.route_guess }}</span>
              <span v-if="triage.analysis.confidence !== 'high'" class="tchip" :class="triage.analysis.confidence === 'low' ? 'warn' : ''">уверенность: {{ triage.analysis.confidence }}</span>
            </template>
            <span v-else-if="triageBusy" class="tmuted"><span class="spin"></span> {{ triageState === 'running' ? 'разведка идёт…' : 'в очереди…' }}</span>
            <span v-else-if="triageState === 'failed'" class="terr" :title="triage?.status?.error">триаж упал: {{ (triage?.status?.error || '').slice(0, 80) }}</span>
            <span v-else class="tmuted">задача не оценена</span>
            <button class="btn tbtn" :disabled="triageBusy || busy === 'analyze'" @click="analyzeNow">
              {{ triageBusy ? '…' : triage?.analysis ? '↻ Переоценить' : '🔍 Оценить' }}
            </button>
          </div>

          <template v-if="triage?.analysis">
            <p v-if="triage.analysis.summary" class="tsum">{{ triage.analysis.summary }}</p>
            <p v-if="triage.stale?.length" class="tstale">
              ⚠ Код под оценкой менялся: {{ triage.stale.slice(0, 5).join(', ') }}{{ triage.stale.length > 5 ? ` и ещё ${triage.stale.length - 5}` : '' }} — стоит переоценить.
            </p>
            <ul v-if="triage.analysis.risk_markers?.length" class="tlist">
              <li v-for="m in triage.analysis.risk_markers" :key="m">⚠ {{ m }}</li>
            </ul>
            <ul v-if="triage.analysis.questions?.length" class="tlist q">
              <li v-for="qq in triage.analysis.questions" :key="qq">? {{ qq }}</li>
            </ul>
            <div v-if="triage.analysis.questions?.length || triage.analysis.needs_clarification" class="clarify">
              <textarea v-model="clarifyText" rows="2"
                        placeholder="Ответ на вопросы (текст обсуждения, детали) — уйдёт комментарием в задачу…"></textarea>
              <button class="btn tbtn" :disabled="busy === 'clarify' || triageBusy || !clarifyText.trim()" @click="sendClarify">
                {{ busy === 'clarify' ? '…' : '↻ Уточнить и переоценить' }}
              </button>
            </div>
            <button v-if="triage.note" class="tnote-toggle" @click="showNote = !showNote">
              {{ showNote ? '▾ Свернуть разведноту' : '▸ Разведнота (карта кода для планировщика)' }}
            </button>
            <div v-if="showNote" class="tnote" v-html="noteHtml"></div>
            <p class="tmeta mono">
              {{ triage.analysis.generated_at ? new Date(triage.analysis.generated_at).toLocaleString('ru-RU') : '' }}
              <template v-if="triage.analysis.meta">· {{ triage.analysis.meta.model }} · {{ Math.round((triage.analysis.meta.duration_ms || 0) / 60000) }} мин<template v-if="triage.analysis.meta.cost_usd"> · ${{ triage.analysis.meta.cost_usd.toFixed(2) }}</template></template>
            </p>
          </template>
        </div>

        <!-- Управление -->
        <div class="controls">
          <div class="timer mono" :class="{ run: running }">
            <span class="tclock">{{ elapsed !== null ? secToHMS(elapsed) : '—' }}</span>
            <span class="tstate">{{ running ? 'идёт' : 'остановлен' }}</span>
          </div>
          <div class="cbtns">
            <button class="btn" :class="running ? 'warn' : 'primary'" :disabled="busy === 'timer'" @click="toggleTimer">
              {{ busy === 'timer' ? '…' : running ? '⏸ Остановить учёт' : '▶ Начать учёт' }}
            </button>
            <button class="btn good" :disabled="busy === 'complete'" @click="complete">
              {{ busy === 'complete' ? '…' : '✓ Завершить' }}
            </button>
            <!-- Уже на конвейере — вместо запуска показываем переход, повторный старт заблокирован -->
            <button v-if="conveyor" class="btn onconv" @click="openConveyor"
                    :title="`Задача уже на конвейере (${conveyor.route || 'маршрут'}) — открыть`">
              🏭 {{ conveyor.daemonAlive ? 'Идёт на конвейере' : 'Уже на конвейере' }} →
            </button>
            <button v-else class="btn launch" :disabled="busy === 'launch'" @click="launch" title="Запустить фабрику по задаче">
              {{ busy === 'launch' ? '…' : '🏭 На конвейер' }}
            </button>
            <OpenDiffButton :task-id="taskId" />
          </div>
          <span v-if="launchMsg" class="lmsg">{{ launchMsg }}</span>
        </div>

        <!-- Комментарий -->
        <div class="comment">
          <textarea v-model="commentText" rows="2" placeholder="Добавить комментарий…"></textarea>
          <button class="btn" :disabled="busy === 'comment' || !commentText.trim()" @click="sendComment">
            {{ busy === 'comment' ? 'Отправка…' : 'Отправить' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.overlay { position: fixed; inset: 0; background: #04060acc; backdrop-filter: blur(4px); display: flex; align-items: flex-start;
  justify-content: center; padding: 48px 16px; z-index: 100; overflow-y: auto; }
.panel { background: var(--surface); border: 1px solid var(--line-2); border-radius: 16px;
  width: 100%; max-width: 860px; box-shadow: 0 20px 60px #000b; overflow: hidden; }
.mhead { display: flex; align-items: center; gap: 10px; padding: 14px 16px; border-bottom: 1px solid var(--line); }
.mid { color: var(--ink-mid); font-size: 13px; flex: none; }
.mtitle { flex: 1; margin: 0; font-size: 16px; font-weight: 640; min-width: 0; }
.icon { background: var(--surface-2); border: 1px solid var(--line); color: var(--ink-mid);
  width: 30px; height: 30px; border-radius: 8px; cursor: pointer; flex: none; }
.icon:hover { color: var(--ink); }
.mbody { padding: 16px; display: flex; flex-direction: column; gap: 14px; }
.err { color: var(--bad); margin: 0; font-size: 13px; }
.meta { display: flex; flex-wrap: wrap; gap: 6px; }
.tag { font-size: 12px; color: var(--ink-mid); background: var(--surface-2); border: 1px solid var(--line);
  border-radius: 999px; padding: 2px 10px; }
.tag.over { color: var(--bad); }
.desc { margin: 0; font-size: 14px; color: var(--ink); white-space: pre-wrap; line-height: 1.55;
  max-height: 300px; overflow-y: auto; }
.desc :deep(a) { color: var(--accent); text-decoration: none; word-break: break-all; }
.desc :deep(a:hover) { text-decoration: underline; }
.triage { background: var(--ground); border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px;
  display: flex; flex-direction: column; gap: 8px; }
.thead2 { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.tlbl { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--ink-mid); margin-right: 4px; }
.tchip { font-size: 12px; font-family: var(--mono, monospace); color: var(--ink-mid);
  border: 1px solid var(--line); border-radius: 999px; padding: 2px 9px; }
.tchip.acc { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 40%, transparent); }
.tchip.warn { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 40%, transparent); }
.tchip.bad { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 40%, transparent); }
.tmuted { color: var(--ink-mid); font-size: 13px; display: inline-flex; align-items: center; gap: 6px; }
.terr { color: var(--bad); font-size: 12px; }
.tbtn { margin-left: auto; height: 32px; padding: 0 12px; font-size: 12px; }
.tsum { margin: 0; font-size: 13px; color: var(--ink); line-height: 1.5; }
.tstale { margin: 0; font-size: 12px; color: var(--warn); }
.tlist { margin: 0; padding: 0 0 0 4px; list-style: none; font-size: 12px; color: var(--ink-mid); display: flex; flex-direction: column; gap: 3px; }
.tlist.q li { color: var(--warn); }
.clarify { display: flex; gap: 8px; align-items: flex-end; }
.clarify textarea { flex: 1; resize: vertical; padding: 8px 10px; border: 1px solid var(--line);
  border-radius: 9px; background: var(--surface-2); color: var(--ink); font-family: inherit; font-size: 13px; }
.clarify textarea:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
.tnote-toggle { background: none; border: none; color: var(--accent); font-size: 12px; cursor: pointer; text-align: left; padding: 0; }
.tnote { font-size: 13px; color: var(--ink); line-height: 1.55; max-height: 360px; overflow-y: auto;
  border-top: 1px solid var(--line); padding-top: 8px; }
.tnote :deep(h3), .tnote :deep(h4), .tnote :deep(h5), .tnote :deep(h6) { margin: 10px 0 4px; font-size: 13px; color: var(--ink); }
.tnote :deep(p) { margin: 4px 0; }
.tnote :deep(ul) { margin: 4px 0; padding-left: 18px; }
.tnote :deep(code) { font-family: var(--mono, monospace); font-size: 12px; background: var(--surface-2);
  border-radius: 4px; padding: 1px 4px; }
.tnote :deep(pre) { background: var(--surface-2); border-radius: 8px; padding: 8px 10px; overflow-x: auto; }
.tmeta { margin: 0; font-size: 11px; color: var(--ink-mid); }
.controls { display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
  padding: 14px 16px; background: var(--ground); border: 1px solid var(--line); border-radius: 12px; }
.timer { display: flex; flex-direction: column; margin-right: auto; }
.tclock { font-size: 19px; font-weight: 650; }
.timer.run .tclock { color: var(--good); }
.tstate { font-size: 11px; color: var(--ink-mid); }
.cbtns { display: flex; align-items: stretch; gap: 8px; flex-wrap: wrap; }
.btn { height: 40px; padding: 0 15px; border-radius: 9px; border: 1px solid var(--line); background: var(--surface-2);
  color: var(--ink); font-size: 13px; font-weight: 500; line-height: 1; cursor: pointer; white-space: nowrap;
  display: inline-flex; align-items: center; justify-content: center; }
.btn:disabled { opacity: .5; cursor: default; }
.btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.btn.good { background: var(--good); border-color: var(--good); color: #06210f; }
.btn.warn { background: var(--warn); border-color: var(--warn); color: #241802; }
.btn.onconv { background: color-mix(in srgb, var(--accent) 16%, transparent);
  border-color: color-mix(in srgb, var(--accent) 45%, var(--line)); color: var(--accent); }
.btn.onconv:hover { background: color-mix(in srgb, var(--accent) 24%, transparent); }
.lmsg { font-size: 12px; color: var(--good); flex-basis: 100%; }
.comment { display: flex; gap: 8px; align-items: flex-end; }
.comment textarea { flex: 1; resize: vertical; padding: 9px 11px; border: 1px solid var(--line);
  border-radius: 9px; background: var(--ground); color: var(--ink); font-family: inherit; font-size: 14px; }
.comment textarea:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
</style>
