<script setup>
import { ref, computed, watch, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { api } from '../shared/api-client.js';
import TopbarActions from '../shared/layout/TopbarActions.vue';

// Раздел «Код»: встроенный VS Code (code serve-web через реверс-прокси кокпита /vscode).
// При заходе лениво поднимаем serve-web; папку задачи получаем из ?folder=… в маршруте.
// Если папка не выбрана — всё равно поднимаем VS Code (общий редактор без папки).
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
const shortFolder = computed(() => { const f = folder.value; return f ? f.split('/').slice(-2).join('/') : ''; });

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
// Смена папки при уже готовом сервере — iframe перезагрузится сам (src реактивен), иначе бустим.
watch(folder, () => { if (status.value !== 'ready') boot(); });
</script>

<template>
  <!-- Действия экрана — в топбар (единый слот) -->
  <TopbarActions>
    <span class="folder mono" :class="{ muted: !folder }" :title="folder || 'редактор без папки'">
      {{ folder ? shortFolder : 'без папки' }}
    </span>
    <a v-if="status === 'ready'" class="act" :href="src" target="_blank" rel="noopener" title="Открыть в новой вкладке">Вкладка ↗</a>
    <button v-if="status === 'ready'" class="act" @click="boot" title="Перезагрузить">↻</button>
  </TopbarActions>

  <div class="code-view">
    <iframe v-if="status === 'ready'" :src="src" class="frame" title="VS Code"></iframe>

    <div v-else-if="status === 'booting'" class="state">
      <span class="spin big"></span>
      <p>Поднимаю VS Code на «мозге»…</p>
      <p class="muted sm">Первый запуск докачивает веб-сборку (нужна сеть). {{ elapsed }} с</p>
    </div>

    <div v-else class="state">
      <p class="bad">Не удалось запустить VS Code</p>
      <p class="muted sm">{{ error }}</p>
      <button class="act big" @click="boot">Повторить</button>
    </div>
  </div>
</template>

<style scoped>
.code-view { height: 100%; min-height: 0; }
.frame { width: 100%; height: 100%; border: 0; display: block; background: var(--ground); }
.state { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; text-align: center; padding: 24px; }
.state p { margin: 0; }
.sm { font-size: 12.5px; }
.bad { color: var(--bad); font-weight: 600; }
.spin.big { width: 26px; height: 26px; border-width: 3px; }

/* Кнопки/лейбл в топбар-слоте */
.folder { font-size: 12px; max-width: 40vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.act { background: var(--surface-2); border: 1px solid var(--line); color: var(--ink-mid); border-radius: 7px;
  padding: 4px 10px; font-size: 12.5px; cursor: pointer; text-decoration: none; }
.act:hover { color: var(--ink); border-color: var(--line-2); }
.act.big { padding: 6px 14px; }
</style>
