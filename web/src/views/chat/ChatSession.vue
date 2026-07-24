<script setup>
import { ref, computed, watch, nextTick, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../../shared/api-client.js';
import { useChatStore, CONTEXT_WINDOW } from '../../stores/chat.js';
import { useTasksStore } from '../../stores/tasks.js';
import EffortSlider from './EffortSlider.vue';

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
const ctxClass = computed(() => (ctxPct.value >= 85 ? 'hi' : ctxPct.value >= 60 ? 'mid' : ''));
// Кольцо-индикатор контекста (клик — сброс контекста).
const RING_C = 2 * Math.PI * 9;
const ringDash = computed(() => RING_C * (1 - ctxPct.value / 100));

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
    <!-- Панель управления: селект задачи слева, настройки прижаты вправо -->
    <div class="cs-top">
      <div class="col bar">
        <div class="sel task">
          <select :value="sess.taskId || ''" @change="onTaskChange">
            <option value="">— без задачи (свободный вопрос) —</option>
            <option v-for="o in taskOpts" :key="o.task" :value="o.task">{{ optLabel(o) }}</option>
          </select>
        </div>
        <div class="spacer"></div>
        <div class="sel">
          <select :value="sess.model" title="Модель" @change="chat.setModel(sid, $event.target.value)">
            <option v-for="m in MODELS" :key="m" :value="m">{{ m }}</option>
          </select>
        </div>
        <EffortSlider :model-value="sess.effort" @update:model-value="chat.setEffort(sid, $event)" />
        <!-- Контекст: маленькое кольцо-заполнение; клик — сброс контекста -->
        <button class="ctx-ring" :class="ctxClass" :disabled="!sess.sessionId"
                :title="`Контекст: ${sess.contextTokens.toLocaleString('ru')} токенов (${ctxPct}%)` + (sess.sessionId ? ' · клик — сбросить' : ' · пусто')"
                @click="chat.resetContext(sid)">
          <svg viewBox="0 0 24 24">
            <circle class="rbg" cx="12" cy="12" r="9" fill="none" stroke-width="3" />
            <circle class="rfg" cx="12" cy="12" r="9" fill="none" stroke-width="3" stroke-linecap="round"
                    :stroke-dasharray="RING_C" :stroke-dashoffset="ringDash" transform="rotate(-90 12 12)" />
          </svg>
        </button>
      </div>
    </div>

    <!-- Сообщения: ты — справа, агент — слева, ошибка — компактная плашка -->
    <div ref="body" class="cs-body">
      <div class="col flow">
        <div v-if="!sess.messages.length" class="empty">
          <div class="e-title">{{ sess.taskId ? chat.tabLabel(sess) : 'Спроси агента' }}</div>
          <p class="e-sub muted">
            {{ sess.taskId ? 'Агент видит код задачи (worktree).' : 'Свободный вопрос без привязки к задаче.' }}<br>
            Модель и усилие — сверху. Ctrl+Enter — отправить.
          </p>
        </div>
        <div v-for="(m, i) in sess.messages" :key="i" class="msg" :class="m.role">
          <div class="text">{{ m.text }}</div>
          <div v-if="m.role === 'assistant' && m.cost" class="meta muted">${{ m.cost.toFixed(3) }}</div>
        </div>
        <div v-if="sess.sending" class="msg assistant"><div class="text muted"><span class="spin"></span> думает…</div></div>
      </div>
    </div>

    <!-- Действие на конвейер (только для задачи) -->
    <div v-if="sess.taskId && sess.messages.length" class="cs-act">
      <div class="col act-row">
        <button class="act" :class="{ onconv: onConveyor }" @click="toConveyor">
          🏭 {{ onConveyor ? 'Уже на конвейере →' : 'На конвейер' }}
        </button>
        <span v-if="launchMsg" class="lm muted">{{ launchMsg }}</span>
      </div>
    </div>

    <!-- Ввод: единый композер, кнопка внутри -->
    <div class="cs-input">
      <div class="col composer">
        <textarea v-model="input" rows="2" placeholder="Сообщение агенту…" @keydown="onKey"></textarea>
        <button class="send" :disabled="sess.sending || !input.trim()" title="Отправить (Ctrl+Enter)" @click="submit">↑</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cs { display: flex; flex-direction: column; min-height: 0; height: 100%; }

/* Центральная колонка: на странице контент не растекается на всю ширину */
.col { width: 100%; min-width: 0; }
.page .col { max-width: 860px; margin: 0 auto; }

.cs-top { padding: 10px 16px; border-bottom: 1px solid var(--line); }
.bar { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.spacer { flex: 1; }
.sel { position: relative; }
.sel.task { flex: 0 1 420px; min-width: 160px; }
.sel::after { content: ''; position: absolute; right: 9px; top: 50%; width: 7px; height: 7px; pointer-events: none;
  border-right: 1.6px solid var(--ink-mid); border-bottom: 1.6px solid var(--ink-mid); transform: translateY(-70%) rotate(45deg); }
.sel select { width: 100%; height: 34px; -webkit-appearance: none; appearance: none; background: var(--ground); border: 1px solid var(--line);
  color: var(--ink); border-radius: 8px; padding: 0 26px 0 10px; font-size: 12.5px; cursor: pointer; text-overflow: ellipsis; }
.sel select:focus { outline: none; border-color: var(--line-2); }
/* Кольцо контекста — маленькое, кликабельное (сброс) */
.ctx-ring { width: 34px; height: 34px; flex: none; padding: 0; border: 1px solid var(--line); border-radius: 8px;
  background: var(--ground); cursor: pointer; display: grid; place-items: center; }
.ctx-ring svg { width: 22px; height: 22px; }
.ctx-ring .rbg { stroke: var(--surface-2); }
.ctx-ring .rfg { stroke: var(--good); transition: stroke-dashoffset .3s; }
.ctx-ring.mid .rfg { stroke: var(--warn); }
.ctx-ring.hi .rfg { stroke: var(--bad); }
.ctx-ring:not(:disabled):hover { border-color: var(--line-2); }
.ctx-ring:disabled { cursor: default; opacity: .7; }

.cs-body { flex: 1; overflow-y: auto; padding: 16px; display: flex; }
.flow { display: flex; flex-direction: column; gap: 14px; }

/* Пустое состояние — по центру, а не подсказка в углу */
.empty { margin: auto; text-align: center; padding: 24px; }
.e-title { font-size: 17px; font-weight: 600; }
.e-sub { font-size: 13px; line-height: 1.6; margin-top: 8px; }

.msg { display: flex; flex-direction: column; gap: 4px; }
.msg .text { font-size: 13.5px; white-space: pre-wrap; line-height: 1.55; }
.page .msg .text { font-size: 14.5px; }
.msg .meta { font-size: 11px; }
/* Ты — справа, пузырь с акцентом; роль ясна по стороне, лейблы не нужны */
.msg.user { align-self: flex-end; align-items: flex-end; max-width: 78%; }
.msg.user .text { background: color-mix(in srgb, var(--accent) 18%, transparent); padding: 9px 13px; border-radius: 14px 14px 4px 14px; }
/* Агент — слева, спокойный текст без коробки */
.msg.assistant { align-self: stretch; }
/* Ошибка — компактная плашка по содержимому, а не баннер во всю ширину */
.msg.error { align-self: flex-start; max-width: 80%; }
.msg.error .text { background: color-mix(in srgb, var(--bad) 12%, transparent); border: 1px solid color-mix(in srgb, var(--bad) 30%, transparent);
  color: var(--bad); padding: 8px 12px; border-radius: 10px; font-size: 12.5px; }
.msg.error .text::before { content: '⚠ '; }

.cs-act { padding: 8px 16px; border-top: 1px solid var(--line); }
.act-row { display: flex; align-items: center; gap: 10px; }
.act { background: var(--surface-2); border: 1px solid var(--line); color: var(--ink); border-radius: 8px; padding: 6px 11px; font-size: 12.5px; cursor: pointer; }
.act.onconv { background: color-mix(in srgb, var(--accent) 16%, transparent); border-color: color-mix(in srgb, var(--accent) 45%, var(--line)); color: var(--accent); }
.lm { font-size: 12px; }

.cs-input { padding: 12px 16px 14px; border-top: 1px solid var(--line); }
.composer { display: flex; gap: 8px; align-items: flex-end; background: var(--ground); border: 1px solid var(--line); border-radius: 12px; padding: 8px 8px 8px 12px; }
.composer:focus-within { border-color: var(--line-2); }
.cs-input textarea { flex: 1; resize: none; background: transparent; border: none; outline: none; color: var(--ink);
  padding: 6px 0; font-family: inherit; font-size: 14px; line-height: 1.45; }
.page .cs-input textarea { min-height: 48px; }
.send { flex: none; width: 36px; height: 36px; background: var(--accent); color: #fff; border: none; border-radius: 10px; font-size: 16px; cursor: pointer; }
.send:disabled { opacity: .5; cursor: default; }
</style>
