<script setup>
// Плагин «Демо фичи»: съёмка демо-видео с живого стенда задачи (по кнопке,
// вне конвейера) + галерея готовых роликов из STATE_DIR/demo.
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { api } from '../shared/api-client.js';
import { usePluginsStore } from '../stores/plugins.js';
import { useTasksStore } from '../stores/tasks.js';
import { fmtBytes } from '../shared/format.js';

const plugins = usePluginsStore();
const taskStore = useTasksStore();
const overview = ref(null);
const error = ref(null);
const busy = ref(null); // task id, по которому нажали «Снять»

const off = computed(() => plugins.loaded && !plugins.enabled('demo'));

async function load() {
  try {
    overview.value = await api.get('/api/demo/overview');
    error.value = null;
  } catch (e) { error.value = e.message; }
}

async function runDemo(task) {
  busy.value = task;
  try {
    const r = await api.post(`/api/demo/${task}/run`, {});
    if (r.outcome === 'already_running') error.value = `демо #${task} уже снимается`;
    await load();
  } catch (e) { error.value = e.message; }
  finally { busy.value = null; }
}

const DEMO_LABEL = { pending: '—', running: 'снимается…', done: 'снято', failed: 'не удалось', skipped: '—' };

let poll = null;
onMounted(async () => {
  if (!plugins.loaded) await plugins.load();
  await load();
  poll = setInterval(load, 5000);
});
onUnmounted(() => clearInterval(poll));
</script>

<template>
  <div class="page">
    <div v-if="off" class="empty">
      Плагин «Демо» выключен. Включить — «Настройки → Плагины».
    </div>
    <template v-else>
      <div v-if="error" class="err">{{ error }}</div>

      <h2>Съёмка</h2>
      <p class="hint">Демо снимается с живого стенда задачи — агент проходит фичу браузером и пишет видео с озвучкой. Стенд должен быть поднят.</p>
      <div v-if="!overview" class="empty">Загрузка…</div>
      <div v-else-if="!overview.tasks.length" class="empty">Задач на фабрике нет.</div>
      <table v-else class="tbl">
        <thead><tr><th>Задача</th><th>Стенд</th><th>Демо</th><th></th></tr></thead>
        <tbody>
          <tr v-for="t in overview.tasks" :key="t.task">
            <td>#{{ t.task }} <span class="tname">{{ taskStore.title(t.task) || '' }}</span></td>
            <td>
              <span v-if="t.sandboxAlive" class="ok">жив · :{{ t.fePort }}</span>
              <span v-else class="mut">нет</span>
            </td>
            <td>
              <span :class="{ ok: t.demo === 'done', bad: t.demo === 'failed', run: t.demo === 'running' }">
                {{ DEMO_LABEL[t.demo] || t.demo }}</span>
            </td>
            <td>
              <button class="btn" :disabled="!t.sandboxAlive || t.demo === 'running' || busy === t.task"
                @click="runDemo(t.task)">
                {{ t.demo === 'done' ? 'Переснять' : 'Снять демо' }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>

      <h2>Ролики</h2>
      <div v-if="!overview?.videos?.length" class="empty">Готовых роликов пока нет.</div>
      <div v-else class="gallery">
        <div v-for="v in overview.videos" :key="v.file" class="clip">
          <video :src="v.url" controls preload="metadata"></video>
          <div class="cmeta">{{ v.file }} · {{ fmtBytes(v.size) }}</div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.page { padding: 18px 22px; max-width: 1100px; }
h2 { font-size: 15px; margin: 18px 0 8px; }
.hint { color: var(--mut); font-size: 12.5px; margin: 0 0 10px; }
.err { color: var(--bad, #e5534b); margin-bottom: 10px; }
.empty { color: var(--mut); padding: 14px 0; }
.tbl { width: 100%; border-collapse: collapse; font-size: 13px; }
.tbl th { text-align: left; color: var(--mut); font-weight: 500; padding: 6px 10px; border-bottom: 1px solid var(--line); }
.tbl td { padding: 8px 10px; border-bottom: 1px solid var(--line); }
.tname { color: var(--mut); margin-left: 6px; }
.ok { color: var(--good, #57ab5a); }
.bad { color: var(--bad, #e5534b); }
.run { color: var(--accent); }
.mut { color: var(--mut); }
.btn { background: var(--surface); border: 1px solid var(--line); color: var(--ink); border-radius: 7px; padding: 5px 12px; cursor: pointer; }
.btn:hover:not(:disabled) { border-color: var(--accent); }
.btn:disabled { opacity: .45; cursor: default; }
.gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 14px; }
.clip video { width: 100%; border-radius: 10px; background: #000; }
.cmeta { color: var(--mut); font-size: 12px; margin-top: 4px; overflow-wrap: anywhere; }
</style>
