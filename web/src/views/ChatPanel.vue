<script setup>
import { ref, watch, nextTick, onMounted } from 'vue';
import { storeToRefs } from 'pinia';
import { api } from '../shared/api-client.js';
import { useChatStore } from '../stores/chat.js';
import { useTasksStore } from '../stores/tasks.js';

const chat = useChatStore();
const tasks = useTasksStore();
const { open, taskId, model, effort, messages, sending, error, sessionId } = storeToRefs(chat);

const MODELS = ['opus', 'sonnet', 'haiku', 'fable'];
const taskList = ref([]);
const input = ref('');
const body = ref(null);
const launchMsg = ref(null);

onMounted(async () => {
  try { taskList.value = (await api.get('/api/tasks')).tasks || []; } catch { /* пусто */ }
});

async function submit() {
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  await chat.send(text);
  await nextTick();
  if (body.value) body.value.scrollTop = body.value.scrollHeight;
}
function onKey(e) { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit(); }

// Действие из чата: направить на конвейер (доработать/запустить).
async function toConveyor() {
  if (!taskId.value) return;
  launchMsg.value = 'запуск…';
  try { const r = await tasks.launch(taskId.value, chat.messages.map((m) => m.text).join('\n').slice(-3000)); launchMsg.value = r.outcome; }
  catch (e) { launchMsg.value = `ошибка: ${e.message}`; }
}

watch(messages, async () => { await nextTick(); if (body.value) body.value.scrollTop = body.value.scrollHeight; }, { deep: true });
</script>

<template>
  <div class="chatw">
    <!-- Плавающая кнопка вызова: логотип Клода (лучи) -->
    <button v-if="!open" class="fab" title="Чат с агентом" @click="chat.toggle()">
      <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true">
        <path d="M12 2.2c.4 0 .75.26.87.64l1.9 5.9 5.9 1.9a.92.92 0 0 1 0 1.74l-5.9 1.9-1.9 5.9a.92.92 0 0 1-1.74 0l-1.9-5.9-5.9-1.9a.92.92 0 0 1 0-1.74l5.9-1.9 1.9-5.9c.12-.38.47-.64.87-.64Z" />
      </svg>
    </button>

    <div v-if="open" class="panel">
      <header class="ph">
        <span class="ttl">Чат с агентом</span>
        <div class="phbtns">
          <button class="mini" title="Очистить переписку" :disabled="!messages.length" @click="chat.clearChat()">🧹</button>
          <button class="mini" :title="sessionId ? 'Сбросить контекст (новый сеанс)' : 'Контекст пуст'" :class="{ hot: sessionId }" :disabled="!sessionId" @click="chat.resetContext()">⟳</button>
          <button class="x" title="Закрыть" @click="chat.close()">✕</button>
        </div>
      </header>

      <div class="controls">
        <div class="sel grow">
          <select :value="taskId || ''" @change="chat.setTask($event.target.value)">
            <option value="" disabled>Задача…</option>
            <option v-for="t in taskList" :key="t.task" :value="t.task">#{{ t.task }} · {{ t.route }}</option>
          </select>
        </div>
        <div class="sel">
          <select :value="model" title="Модель" @change="chat.setModel($event.target.value)">
            <option v-for="m in MODELS" :key="m" :value="m">{{ m }}</option>
          </select>
        </div>
        <!-- Усилие — циклическая кнопка (как переключатель в расширении VS Code) -->
        <button class="effort" :data-lvl="effort" title="Усилие рассуждения (клик — переключить)" @click="chat.cycleEffort()">{{ effort }}</button>
      </div>

      <div ref="body" class="body">
        <p v-if="!messages.length" class="hint muted">Обсуди реализацию, спроси про строчки кода. Модель/усилие сверху. Ctrl+Enter — отправить. Контекст задачи (worktree) агент видит; переписка сохраняется при перезагрузке.</p>
        <div v-for="(m, i) in messages" :key="i" class="msg" :class="m.role">
          <div class="who">{{ m.role === 'user' ? 'Ты' : m.role === 'assistant' ? 'Агент' : 'Ошибка' }}<span v-if="m.cost" class="cost">${{ m.cost.toFixed(3) }}</span></div>
          <div class="text">{{ m.text }}</div>
        </div>
        <div v-if="sending" class="msg assistant"><div class="who">Агент</div><div class="text"><span class="spin"></span> думает…</div></div>
      </div>

      <div v-if="messages.length && taskId" class="actions">
        <button class="act" :disabled="sending" title="Направить задачу на конвейер с учётом обсуждения" @click="toConveyor">🏭 На конвейер</button>
        <span v-if="launchMsg" class="lm muted">{{ launchMsg }}</span>
      </div>

      <div class="inputrow">
        <textarea v-model="input" rows="2" placeholder="Сообщение агенту…" @keydown="onKey"></textarea>
        <button class="send" :disabled="sending || !input.trim() || !taskId" @click="submit">↑</button>
      </div>
      <p v-if="error" class="err">{{ error }}</p>
    </div>
  </div>
</template>

<style scoped>
.fab { position: fixed; right: 18px; bottom: 18px; z-index: 90; width: 52px; height: 52px; border-radius: 16px;
  display: grid; place-items: center;
  background: linear-gradient(150deg, #d97757, #c15f3c); color: #fff; border: none; cursor: pointer;
  box-shadow: 0 6px 22px #0009, inset 0 1px 0 #ffffff2e; transition: transform .12s, box-shadow .12s; }
.fab:hover { transform: translateY(-2px); box-shadow: 0 10px 28px #000a, inset 0 1px 0 #ffffff2e; }
.panel { position: fixed; right: 18px; bottom: 18px; z-index: 95; width: min(440px, calc(100vw - 24px));
  height: min(72vh, 640px); display: flex; flex-direction: column;
  background: var(--surface); border: 1px solid var(--line-2); border-radius: 16px; box-shadow: 0 18px 50px #000c; }
.ph { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; border-bottom: 1px solid var(--line); }
.ph .ttl { font-weight: 640; }
.phbtns { display: flex; gap: 6px; }
.x, .mini { background: var(--surface-2); border: 1px solid var(--line); color: var(--ink-mid); border-radius: 8px; width: 30px; height: 30px; cursor: pointer; font-size: 13px; }
.x:hover, .mini:not(:disabled):hover { color: var(--ink); border-color: var(--line-2); }
.mini:disabled { opacity: .4; cursor: default; }
.mini.hot { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 40%, var(--line)); }

.controls { display: flex; gap: 6px; padding: 10px 12px; border-bottom: 1px solid var(--line); align-items: stretch; }
/* Кастомная стрелка селекта (нативная «съезжала») */
.sel { position: relative; }
.sel.grow { flex: 1; min-width: 0; }
.sel::after { content: ''; position: absolute; right: 9px; top: 50%; width: 7px; height: 7px; pointer-events: none;
  border-right: 1.6px solid var(--ink-mid); border-bottom: 1.6px solid var(--ink-mid);
  transform: translateY(-70%) rotate(45deg); }
.sel select { width: 100%; -webkit-appearance: none; appearance: none; background: var(--ground); border: 1px solid var(--line);
  color: var(--ink); border-radius: 8px; padding: 6px 26px 6px 9px; font-size: 12.5px; cursor: pointer;
  text-overflow: ellipsis; }
.sel select:focus { outline: none; border-color: var(--line-2); }
.effort { min-width: 62px; text-transform: capitalize; background: var(--ground); border: 1px solid var(--line);
  color: var(--ink); border-radius: 8px; padding: 6px 10px; font-size: 12.5px; cursor: pointer; font-weight: 600; }
.effort[data-lvl="low"] { color: var(--ink-mid); }
.effort[data-lvl="medium"] { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 35%, var(--line)); }
.effort[data-lvl="high"] { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 40%, var(--line)); }
.effort[data-lvl="max"] { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 45%, var(--line)); }

.body { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
.hint { font-size: 12.5px; }
.msg { display: flex; flex-direction: column; gap: 3px; }
.msg .who { font-size: 11px; color: var(--ink-mid); text-transform: uppercase; letter-spacing: .06em; display: flex; gap: 8px; }
.cost { color: var(--ink-mid); }
.msg .text { font-size: 13.5px; white-space: pre-wrap; line-height: 1.5; padding: 8px 10px; border-radius: 10px; }
.msg.user .text { background: color-mix(in srgb, var(--accent) 16%, transparent); align-self: flex-start; }
.msg.assistant .text { background: var(--surface-2); }
.msg.error .text { background: color-mix(in srgb, var(--bad) 14%, transparent); color: var(--bad); }
.actions { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-top: 1px solid var(--line); }
.act { background: var(--surface-2); border: 1px solid var(--line); color: var(--ink); border-radius: 8px; padding: 6px 11px; font-size: 12.5px; cursor: pointer; }
.lm { font-size: 12px; }
.inputrow { display: flex; gap: 8px; padding: 10px 12px; border-top: 1px solid var(--line); }
.inputrow textarea { flex: 1; resize: none; background: var(--ground); border: 1px solid var(--line); color: var(--ink); border-radius: 9px; padding: 8px 10px; font-family: inherit; font-size: 14px; }
.send { width: 40px; background: var(--accent); color: #fff; border: none; border-radius: 9px; font-size: 18px; cursor: pointer; }
.send:disabled { opacity: .5; cursor: default; }
.err { color: var(--bad); font-size: 12px; padding: 0 12px 8px; margin: 0; }

@media (max-width: 759px) {
  .fab { bottom: 74px; }
  .panel { bottom: 8px; right: 8px; height: min(80vh, 620px); }
}
</style>
