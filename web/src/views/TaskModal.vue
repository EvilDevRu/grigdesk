<script setup>
import { ref, computed, watch, onUnmounted } from 'vue';
import { storeToRefs } from 'pinia';
import { useUiStore } from '../stores/ui.js';
import { useTasksStore } from '../stores/tasks.js';
import { useBoardStore } from '../stores/board.js';
import { secToHMS } from '../shared/format.js';

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

async function loadDetail(force = false) {
  if (!taskId.value) return;
  loading.value = true; err.value = null;
  try { detail.value = await tasks.load(taskId.value, force); }
  catch (e) { err.value = e.message; }
  finally { loading.value = false; }
}

async function act(name, fn) {
  busy.value = name; err.value = null;
  try { await fn(); }
  catch (e) { err.value = e.message; }
  finally { busy.value = null; }
}
const toggleTimer = () => act('timer', () => tasks.timer(taskId.value, running.value ? 'pause' : 'start'));
const complete = () => { if (confirm('Завершить задачу?')) act('complete', async () => { await tasks.complete(taskId.value); ui.close(); }); };
const launchMsg = ref(null);
const launch = () => {
  if (!confirm(`Направить задачу #${taskId.value} на конвейер? Запустит фабрику (песочница + агенты).`)) return;
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
    detail.value = null;
    loadDetail();
    if (!ticker) ticker = setInterval(() => { now.value = Date.now(); }, 1000);
  } else if (ticker) { clearInterval(ticker); ticker = null; }
}, { immediate: true });
onUnmounted(() => { if (ticker) clearInterval(ticker); });

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

        <p v-if="cleanDesc" class="desc">{{ cleanDesc }}</p>

        <!-- Управление -->
        <div class="controls">
          <div class="timer mono" :class="{ run: running }">
            <span class="tclock">{{ elapsed !== null ? secToHMS(elapsed) : '—' }}</span>
            <span class="tstate">{{ running ? 'идёт' : 'остановлен' }}</span>
          </div>
          <button class="btn" :class="running ? 'warn' : 'primary'" :disabled="busy === 'timer'" @click="toggleTimer">
            {{ busy === 'timer' ? '…' : running ? '⏸ Остановить учёт' : '▶ Начать учёт' }}
          </button>
          <button class="btn good" :disabled="busy === 'complete'" @click="complete">
            {{ busy === 'complete' ? '…' : '✓ Завершить' }}
          </button>
          <button class="btn" :disabled="busy === 'launch'" @click="launch" title="Запустить фабрику по задаче">
            {{ busy === 'launch' ? '…' : '🏭 На конвейер' }}
          </button>
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
  width: 100%; max-width: 640px; box-shadow: 0 20px 60px #000b; overflow: hidden; }
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
.desc { margin: 0; font-size: 14px; color: var(--ink); white-space: pre-wrap; line-height: 1.5;
  max-height: 240px; overflow-y: auto; }
.controls { display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding: 12px; background: var(--ground); border: 1px solid var(--line); border-radius: 10px; }
.timer { display: flex; flex-direction: column; margin-right: auto; }
.tclock { font-size: 18px; font-weight: 650; }
.timer.run .tclock { color: var(--good); }
.tstate { font-size: 11px; color: var(--ink-mid); }
.btn { padding: 9px 13px; border-radius: 9px; border: 1px solid var(--line); background: var(--surface-2);
  color: var(--ink); font-size: 13px; cursor: pointer; }
.btn:disabled { opacity: .5; cursor: default; }
.btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.btn.good { background: var(--good); border-color: var(--good); color: #06210f; }
.btn.warn { background: var(--warn); border-color: var(--warn); color: #241802; }
.lmsg { font-size: 12px; color: var(--good); flex-basis: 100%; }
.comment { display: flex; gap: 8px; align-items: flex-end; }
.comment textarea { flex: 1; resize: vertical; padding: 9px 11px; border: 1px solid var(--line);
  border-radius: 9px; background: var(--ground); color: var(--ink); font-family: inherit; font-size: 14px; }
.comment textarea:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
</style>
