<script setup>
import { ref, computed, watch, nextTick, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../../shared/api-client.js';
import { useChatStore, CONTEXT_WINDOW } from '../../stores/chat.js';
import { useTasksStore } from '../../stores/tasks.js';

// Одна сессия чата. Переиспользуется в плавающей панели и на странице «Агенты».
const props = defineProps({
  sid: { type: String, required: true },
  variant: { type: String, default: 'panel' }, // 'panel' | 'page'
});

const router = useRouter();
const chat = useChatStore();
const tasks = useTasksStore();

const MODELS = ['opus', 'sonnet', 'haiku', 'fable'];
const sess = computed(() => chat.sessions.find((s) => s.id === props.sid) || null);

// ── Список задач для селекта (с ЗАГОЛОВКАМИ, не только номером) ──
let taskListPromise = null;
function fetchTaskList() {
  if (!taskListPromise) taskListPromise = api.get('/api/tasks').then((r) => r.tasks || []).catch(() => []);
  return taskListPromise;
}
const taskOpts = ref([]); // [{ task, route, title }]
onMounted(async () => {
  chat.loadConveyor();
  const list = await fetchTaskList();
  taskOpts.value = list.map((t) => ({ task: String(t.task), route: t.route, title: '' }));
  // Подтягиваем названия из B24 (для «#7785 · Ключевые фразы…»).
  list.forEach((t) => tasks.load(t.task).then((d) => {
    const o = taskOpts.value.find((x) => x.task === String(t.task));
    if (o && d?.title) o.title = d.title;
  }).catch(() => {}));
});
function optLabel(o) { return `#${o.task} · ${o.title || o.route || 'задача'}`; }
function onTaskChange(e) {
  const val = e.target.value;
  const o = taskOpts.value.find((x) => x.task === val);
  chat.setTask(props.sid, val || null, o ? (o.title || `#${o.task}`) : '');
}

// ── Контекст ──
const ctxPct = computed(() => Math.min(100, Math.round(((sess.value?.contextTokens || 0) / CONTEXT_WINDOW) * 100)));
const ctxK = computed(() => {
  const t = sess.value?.contextTokens || 0;
  return t >= 1000 ? `${(t / 1000).toFixed(t >= 10000 ? 0 : 1)}k` : String(t);
});
const ctxClass = computed(() => (ctxPct.value >= 85 ? 'hi' : ctxPct.value >= 60 ? 'mid' : ''));

// ── Ввод ──
const input = ref('');
const body = ref(null);
async function submit() {
  const t = input.value.trim();
  if (!t || !sess.value) return;
  input.value = '';
  await chat.send(props.sid, t);
  await nextTick();
  if (body.value) body.value.scrollTop = body.value.scrollHeight;
}
function onKey(e) { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit(); }
watch(() => sess.value?.messages.length, async () => { await nextTick(); if (body.value) body.value.scrollTop = body.value.scrollHeight; });

// ── Действие «На конвейер» с защитой ──
const onConveyor = computed(() => chat.isOnConveyor(sess.value?.taskId));
const launchMsg = ref(null);
async function toConveyor() {
  const s = sess.value; if (!s?.taskId) return;
  if (onConveyor.value) { router.push('/pipeline'); chat.close(); return; }
  launchMsg.value = 'запуск…';
  try {
    const r = await tasks.launch(s.taskId, s.messages.map((m) => m.text).join('\n').slice(-3000));
    launchMsg.value = r.outcome === 'already_running' ? 'уже идёт' : r.outcome === 'launched' ? `запущено (${r.profile})` : (r.note || 'отправлено');
    chat.loadConveyor();
  } catch (e) { launchMsg.value = `ошибка: ${e.message}`; }
}
</script>

<template>
  <div v-if="sess" class="cs" :class="variant">
    <!-- Панель управления -->
    <div class="cs-top">
      <div class="row1">
        <div class="sel grow">
          <select :value="sess.taskId || ''" @change="onTaskChange">
            <option value="">— без задачи (свободный вопрос) —</option>
            <option v-for="o in taskOpts" :key="o.task" :value="o.task">{{ optLabel(o) }}</option>
          </select>
        </div>
        <div class="sel">
          <select :value="sess.model" title="Модель" @change="chat.setModel(sid, $event.target.value)">
            <option v-for="m in MODELS" :key="m" :value="m">{{ m }}</option>
          </select>
        </div>
        <button class="effort" :data-lvl="sess.effort" title="Усилие рассуждения (клик — переключить)" @click="chat.cycleEffort(sid)">{{ sess.effort }}</button>
      </div>
      <!-- Контекст + управление сеансом -->
      <div class="row2">
        <div class="ctx" :class="ctxClass" :title="`Контекст: ${sess.contextTokens.toLocaleString('ru')} токенов из ~${CONTEXT_WINDOW.toLocaleString('ru')} (${ctxPct}%)`">
          <span class="ctx-lbl">контекст</span>
          <span class="ctx-bar"><i :style="{ width: ctxPct + '%' }"></i></span>
          <span class="ctx-val mono">{{ ctxPct }}% · {{ ctxK }}</span>
        </div>
        <button class="mini" title="Очистить переписку" :disabled="!sess.messages.length" @click="chat.clearChat(sid)">🧹</button>
        <button class="mini" :class="{ hot: sess.sessionId }" :title="sess.sessionId ? 'Сбросить контекст (новый сеанс)' : 'Контекст пуст'" :disabled="!sess.sessionId" @click="chat.resetContext(sid)">⟳</button>
      </div>
    </div>

    <!-- Сообщения -->
    <div ref="body" class="cs-body">
      <p v-if="!sess.messages.length" class="hint muted">
        {{ sess.taskId ? 'Агент видит код задачи (worktree). ' : 'Свободный вопрос без привязки к задаче. ' }}Модель/усилие сверху. Ctrl+Enter — отправить.
      </p>
      <div v-for="(m, i) in sess.messages" :key="i" class="msg" :class="m.role">
        <div class="who">{{ m.role === 'user' ? 'Ты' : m.role === 'assistant' ? 'Агент' : 'Ошибка' }}<span v-if="m.cost" class="cost">${{ m.cost.toFixed(3) }}</span></div>
        <div class="text">{{ m.text }}</div>
      </div>
      <div v-if="sess.sending" class="msg assistant"><div class="who">Агент</div><div class="text"><span class="spin"></span> думает…</div></div>
    </div>

    <!-- Действие на конвейер (только для задачи) -->
    <div v-if="sess.taskId && sess.messages.length" class="cs-act">
      <button class="act" :class="{ onconv: onConveyor }" @click="toConveyor">
        🏭 {{ onConveyor ? 'Уже на конвейере →' : 'На конвейер' }}
      </button>
      <span v-if="launchMsg" class="lm muted">{{ launchMsg }}</span>
    </div>

    <!-- Ввод -->
    <div class="cs-input">
      <textarea v-model="input" rows="2" placeholder="Сообщение агенту…" @keydown="onKey"></textarea>
      <button class="send" :disabled="sess.sending || !input.trim()" @click="submit">↑</button>
    </div>
  </div>
</template>

<style scoped>
.cs { display: flex; flex-direction: column; min-height: 0; height: 100%; }

.cs-top { padding: 10px 12px; border-bottom: 1px solid var(--line); display: flex; flex-direction: column; gap: 8px; }
.row1 { display: flex; gap: 6px; align-items: stretch; }
.row2 { display: flex; gap: 6px; align-items: center; }
.sel { position: relative; }
.sel.grow { flex: 1; min-width: 0; }
.sel::after { content: ''; position: absolute; right: 9px; top: 50%; width: 7px; height: 7px; pointer-events: none;
  border-right: 1.6px solid var(--ink-mid); border-bottom: 1.6px solid var(--ink-mid); transform: translateY(-70%) rotate(45deg); }
.sel select { width: 100%; -webkit-appearance: none; appearance: none; background: var(--ground); border: 1px solid var(--line);
  color: var(--ink); border-radius: 8px; padding: 6px 26px 6px 9px; font-size: 12.5px; cursor: pointer; text-overflow: ellipsis; }
.sel select:focus { outline: none; border-color: var(--line-2); }
.effort { min-width: 62px; text-transform: capitalize; background: var(--ground); border: 1px solid var(--line);
  color: var(--ink); border-radius: 8px; padding: 6px 10px; font-size: 12.5px; cursor: pointer; font-weight: 600; }
.effort[data-lvl="low"] { color: var(--ink-mid); }
.effort[data-lvl="medium"] { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 35%, var(--line)); }
.effort[data-lvl="high"] { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 40%, var(--line)); }
.effort[data-lvl="max"] { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 45%, var(--line)); }

.ctx { flex: 1; min-width: 0; display: flex; align-items: center; gap: 7px; font-size: 11px; color: var(--ink-mid);
  background: var(--ground); border: 1px solid var(--line); border-radius: 8px; padding: 4px 9px; }
.ctx-lbl { text-transform: uppercase; letter-spacing: .05em; font-size: 10px; flex: none; }
.ctx-bar { flex: 1; min-width: 30px; height: 5px; background: var(--surface-2); border-radius: 999px; overflow: hidden; }
.ctx-bar i { display: block; height: 100%; background: var(--good); border-radius: 999px; transition: width .3s; }
.ctx-val { flex: none; font-size: 11px; }
.ctx.mid .ctx-bar i { background: var(--warn); }
.ctx.mid .ctx-val { color: var(--warn); }
.ctx.hi .ctx-bar i { background: var(--bad); }
.ctx.hi .ctx-val { color: var(--bad); }
.mini { background: var(--surface-2); border: 1px solid var(--line); color: var(--ink-mid); border-radius: 8px; width: 30px; height: 30px; cursor: pointer; flex: none; font-size: 13px; }
.mini:not(:disabled):hover { color: var(--ink); border-color: var(--line-2); }
.mini:disabled { opacity: .4; cursor: default; }
.mini.hot { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 40%, var(--line)); }

.cs-body { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
.hint { font-size: 12.5px; }
.msg { display: flex; flex-direction: column; gap: 3px; }
.msg .who { font-size: 11px; color: var(--ink-mid); text-transform: uppercase; letter-spacing: .06em; display: flex; gap: 8px; }
.cost { color: var(--ink-mid); }
.msg .text { font-size: 13.5px; white-space: pre-wrap; line-height: 1.5; padding: 8px 10px; border-radius: 10px; }
.msg.user .text { background: color-mix(in srgb, var(--accent) 16%, transparent); align-self: flex-start; }
.msg.assistant .text { background: var(--surface-2); }
.msg.error .text { background: color-mix(in srgb, var(--bad) 14%, transparent); color: var(--bad); }
.page .msg .text { font-size: 14.5px; }

.cs-act { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-top: 1px solid var(--line); }
.act { background: var(--surface-2); border: 1px solid var(--line); color: var(--ink); border-radius: 8px; padding: 6px 11px; font-size: 12.5px; cursor: pointer; }
.act.onconv { background: color-mix(in srgb, var(--accent) 16%, transparent); border-color: color-mix(in srgb, var(--accent) 45%, var(--line)); color: var(--accent); }
.lm { font-size: 12px; }

.cs-input { display: flex; gap: 8px; padding: 10px 12px; border-top: 1px solid var(--line); }
.cs-input textarea { flex: 1; resize: none; background: var(--ground); border: 1px solid var(--line); color: var(--ink); border-radius: 9px; padding: 8px 10px; font-family: inherit; font-size: 14px; }
.page .cs-input textarea { min-height: 54px; }
.send { width: 40px; background: var(--accent); color: #fff; border: none; border-radius: 9px; font-size: 18px; cursor: pointer; }
.send:disabled { opacity: .5; cursor: default; }
</style>
