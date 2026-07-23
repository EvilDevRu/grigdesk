<script setup>
import { ref, watch, nextTick, onMounted } from 'vue';
import { storeToRefs } from 'pinia';
import { api } from '../shared/api-client.js';
import { useChatStore } from '../stores/chat.js';
import { useTasksStore } from '../stores/tasks.js';

const chat = useChatStore();
const tasks = useTasksStore();
const { open, taskId, model, effort, messages, sending, error } = storeToRefs(chat);

const MODELS = ['opus', 'sonnet', 'haiku', 'fable'];
const EFFORTS = ['low', 'medium', 'high', 'max'];
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
    <button v-if="!open" class="fab" title="Чат с агентом" @click="chat.toggle()">💬</button>

    <div v-if="open" class="panel">
      <header class="ph">
        <span class="ttl">Чат с агентом</span>
        <button class="x" @click="chat.close()">✕</button>
      </header>

      <div class="controls">
        <select :value="taskId || ''" @change="chat.setTask($event.target.value)">
          <option value="" disabled>Задача…</option>
          <option v-for="t in taskList" :key="t.task" :value="t.task">#{{ t.task }} · {{ t.route }}</option>
        </select>
        <select :value="model" @change="chat.setModel($event.target.value)" title="Модель">
          <option v-for="m in MODELS" :key="m" :value="m">{{ m }}</option>
        </select>
        <select :value="effort" @change="chat.setEffort($event.target.value)" title="Усилие">
          <option v-for="e in EFFORTS" :key="e" :value="e">{{ e }}</option>
        </select>
        <button class="mini" title="Новый разговор" @click="chat.reset()">⟳</button>
      </div>

      <div ref="body" class="body">
        <p v-if="!messages.length" class="hint muted">Обсуди реализацию, спроси про строчки кода. Модель/усилие сверху. Ctrl+Enter — отправить. Контекст задачи (worktree) агент видит.</p>
        <div v-for="(m, i) in messages" :key="i" class="msg" :class="m.role">
          <div class="who">{{ m.role === 'user' ? 'Ты' : m.role === 'assistant' ? 'Агент' : 'Ошибка' }}<span v-if="m.cost" class="cost">${{ m.cost.toFixed(3) }}</span></div>
          <div class="text">{{ m.text }}</div>
        </div>
        <div v-if="sending" class="msg assistant"><div class="who">Агент</div><div class="text"><span class="spin"></span> думает…</div></div>
      </div>

      <div v-if="messages.length && taskId" class="actions">
        <button class="act" :disabled="sending" @click="toConveyor" title="Направить задачу на конвейер с учётом обсуждения">🏭 На конвейер</button>
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
.fab { position: fixed; right: 18px; bottom: 18px; z-index: 90; width: 52px; height: 52px; border-radius: 50%;
  background: var(--accent); color: #fff; border: none; font-size: 22px; cursor: pointer; box-shadow: 0 6px 22px #0008; }
.panel { position: fixed; right: 18px; bottom: 18px; z-index: 95; width: min(440px, calc(100vw - 24px));
  height: min(72vh, 640px); display: flex; flex-direction: column;
  background: var(--surface); border: 1px solid var(--line); border-radius: 14px; box-shadow: 0 10px 40px #000a; }
.ph { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; border-bottom: 1px solid var(--line); }
.ph .ttl { font-weight: 640; }
.x, .mini { background: var(--surface-2); border: 1px solid var(--line); color: var(--ink-mid); border-radius: 8px; width: 30px; height: 30px; cursor: pointer; }
.controls { display: flex; gap: 6px; padding: 10px 12px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
.controls select { background: var(--ground); border: 1px solid var(--line); color: var(--ink); border-radius: 8px; padding: 5px 8px; font-size: 12.5px; }
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
</style>
