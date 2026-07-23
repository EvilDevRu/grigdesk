<script setup>
import { ref, computed, watch, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { api } from '../shared/api-client.js';

// Раздел «Код»: встроенный VS Code (code serve-web через реверс-прокси кокпита /vscode).
// При заходе лениво поднимаем serve-web; папку задачи получаем из ?folder=… в маршруте.
const route = useRoute();
const status = ref('booting'); // booting | ready | error
const error = ref('');
const elapsed = ref(0);
let timer = null;

const folder = computed(() => (route.query.folder ? String(route.query.folder) : ''));
const src = computed(() => {
  const base = (api.base || '') + '/vscode/';
  return folder.value ? `${base}?folder=${encodeURIComponent(folder.value)}` : base;
});
const openUrl = computed(() => src.value); // для «в новой вкладке»

async function boot() {
  status.value = 'booting'; error.value = ''; elapsed.value = 0;
  timer = setInterval(() => { elapsed.value += 1; }, 1000);
  try {
    const r = await api.post('/api/vscode/ensure');
    if (r.running) { status.value = 'ready'; }
    else { status.value = 'error'; error.value = r.error || 'VS Code не поднялся.'; }
  } catch (e) {
    status.value = 'error'; error.value = e.message;
  } finally { clearInterval(timer); }
}

onMounted(boot);
// Смена задачи (folder) при уже готовом сервере — просто перезагружаем iframe (src реактивен).
watch(folder, () => { if (status.value !== 'ready') boot(); });
</script>

<template>
  <div class="code-view">
    <div class="bar">
      <span class="lbl">VS Code</span>
      <span v-if="folder" class="folder mono" :title="folder">{{ folder }}</span>
      <span v-else class="folder muted">папка не выбрана — открой из задачи</span>
      <div class="right">
        <a v-if="status === 'ready'" class="act" :href="openUrl" target="_blank" rel="noopener">В новой вкладке ↗</a>
        <button v-if="status === 'ready'" class="act" @click="boot">Перезагрузить</button>
      </div>
    </div>

    <div v-if="status === 'ready'" class="frame-wrap">
      <iframe :src="src" class="frame" title="VS Code"></iframe>
    </div>

    <div v-else-if="status === 'booting'" class="state">
      <span class="spin big"></span>
      <p>Поднимаю VS Code на «мозге»…</p>
      <p class="muted sm">Первый запуск докачивает веб-сборку (нужна сеть). {{ elapsed }} с</p>
    </div>

    <div v-else class="state">
      <p class="bad">Не удалось запустить VS Code</p>
      <p class="muted sm">{{ error }}</p>
      <button class="act" @click="boot">Повторить</button>
    </div>
  </div>
</template>

<style scoped>
.code-view { height: 100%; display: flex; flex-direction: column; min-height: 0; }
.bar { display: flex; align-items: center; gap: 12px; padding: 8px 12px; border-bottom: 1px solid var(--line); }
.lbl { font-weight: 640; font-size: 13px; flex: none; }
.folder { font-size: 12px; color: var(--ink-mid); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.right { margin-left: auto; display: flex; gap: 8px; flex: none; }
.act { background: var(--surface-2); border: 1px solid var(--line); color: var(--ink-mid); border-radius: 7px;
  padding: 5px 11px; font-size: 12.5px; cursor: pointer; }
.act:hover { color: var(--ink); border-color: var(--line-2); }
.frame-wrap { flex: 1; min-height: 0; }
.frame { width: 100%; height: 100%; border: 0; display: block; background: var(--ground); }
.state { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; text-align: center; padding: 24px; }
.state p { margin: 0; }
.sm { font-size: 12.5px; }
.bad { color: var(--bad); font-weight: 600; }
.spin.big { width: 26px; height: 26px; border-width: 3px; }
</style>
