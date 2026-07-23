<script setup>
import { ref, computed, onUnmounted } from 'vue';
import { api } from '../shared/api-client.js';

const BASE = (import.meta.env.VITE_BRAIN_URL || '').replace(/\/$/, '');
const TOKEN = import.meta.env.VITE_COCKPIT_TOKEN || '';

const doctorOk = ref(null);
const uploading = ref(false);
const jobId = ref(null);
const job = ref(null);       // { status, progress, result }
const error = ref(null);
const drafts = ref([]);      // черновики задач [{ title, description }]
const creating = ref(false);
const created = ref([]);
let poll = null;

api.get('/api/media/doctor').then((d) => { doctorOk.value = d.ok; }).catch(() => { doctorOk.value = false; });

function mmss(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
const segments = computed(() => job.value?.result?.transcript?.segments || []);
const fullText = computed(() => segments.value.map((s) => s.text).join(' ').trim());

async function onFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  uploading.value = true; error.value = null; job.value = null; drafts.value = []; created.value = [];
  try {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch(`${BASE}/api/media/upload`, {
      method: 'POST', body: fd, headers: TOKEN ? { 'X-Cockpit-Token': TOKEN } : {},
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || data.error || `HTTP ${res.status}`);
    jobId.value = data.jobId;
    startPoll();
  } catch (err) { error.value = err.message; } finally { uploading.value = false; }
}

function startPoll() {
  clearInterval(poll);
  poll = setInterval(async () => {
    try {
      const j = await api.get(`/api/media/ingest/${jobId.value}`);
      job.value = j;
      if (j.status === 'done') { clearInterval(poll); drafts.value = [{ title: '', description: fullText.value }]; }
      if (j.status === 'failed') { clearInterval(poll); error.value = j.error || 'распознавание не удалось'; }
    } catch { /* продолжаем поллинг */ }
  }, 2000);
}

function addDraft() { drafts.value.push({ title: '', description: '' }); }
function removeDraft(i) { drafts.value.splice(i, 1); }
// Перенести сегмент в описание последнего черновика (ручной разбор).
function appendSegment(text) {
  if (!drafts.value.length) drafts.value.push({ title: '', description: '' });
  const d = drafts.value[drafts.value.length - 1];
  d.description = (d.description ? `${d.description}\n` : '') + text;
}

async function createAll() {
  creating.value = true; error.value = null; created.value = [];
  try {
    for (const d of drafts.value) {
      if (!d.title.trim()) continue;
      const r = await api.post('/api/b24/tasks', { title: d.title, description: d.description });
      created.value.push(r.id || '✓');
    }
  } catch (err) { error.value = err.message; } finally { creating.value = false; }
}

onUnmounted(() => clearInterval(poll));
</script>

<template>
  <div class="video">
    <h2 class="ttl">Видео → задачи</h2>
    <p class="muted lead">Загрузи запись встречи — кокпит распознает речь и поможет собрать одну или несколько задач. Без вкладки VS Code.</p>

    <p v-if="doctorOk === false" class="err">⚠ Медиа-конвейер не готов (ffmpeg/venv/whisper). Проверь окружение сервера.</p>

    <div class="up">
      <label class="filebtn">
        <input type="file" accept="video/*,audio/*" @change="onFile" :disabled="uploading || (job && job.status === 'running')" />
        {{ uploading ? 'Загрузка…' : '📹 Выбрать видео/аудио' }}
      </label>
    </div>

    <p v-if="error" class="err">{{ error }}</p>

    <!-- Прогресс распознавания -->
    <div v-if="job && job.status === 'running'" class="progress">
      Распознавание…
      <span v-if="job.progress" class="mono">{{ job.progress.done }}/{{ job.progress.total }}</span>
      <div class="pbar"><span :style="{ width: job.progress ? (job.progress.done / job.progress.total * 100) + '%' : '10%' }"></span></div>
    </div>

    <div v-if="job && job.status === 'done'" class="result">
      <!-- Транскрипт (предпросмотр разбора) -->
      <section class="transcript">
        <h3 class="h">Транскрипт <span class="muted">· {{ segments.length }} сегм.</span></h3>
        <div class="segs">
          <div v-for="(s, i) in segments" :key="i" class="seg" @click="appendSegment(s.text)" title="в черновик задачи">
            <span class="tc mono">{{ mmss(s.start) }}</span><span class="txt">{{ s.text }}</span>
          </div>
        </div>
      </section>

      <!-- Черновики задач -->
      <section class="drafts">
        <div class="dhead">
          <h3 class="h">Задачи <span class="muted">· {{ drafts.length }}</span></h3>
          <button class="btn" @click="addDraft">+ ещё задача</button>
        </div>
        <div v-for="(d, i) in drafts" :key="i" class="draft">
          <input v-model="d.title" placeholder="Заголовок задачи" class="dtitle" />
          <textarea v-model="d.description" rows="3" placeholder="Описание (клик по сегменту транскрипта добавит текст)"></textarea>
          <button class="del" @click="removeDraft(i)" title="удалить">✕</button>
        </div>
        <div class="actions">
          <button class="btn primary" :disabled="creating || !drafts.some(d => d.title.trim())" @click="createAll">
            {{ creating ? 'Создание…' : `Создать ${drafts.filter(d => d.title.trim()).length} задач(и)` }}
          </button>
          <span v-if="created.length" class="ok">✓ создано: {{ created.length }}</span>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.video { display: flex; flex-direction: column; gap: 14px; }
.ttl { font-size: 20px; margin: 0; }
.lead { max-width: 80ch; margin: 0; font-size: 13px; }
.err { color: var(--bad); }
.filebtn { display: inline-block; background: var(--accent); color: #fff; border-radius: 10px;
  padding: 10px 16px; font-size: 14px; cursor: pointer; }
.filebtn input { display: none; }
.progress { font-size: 14px; color: var(--ink-mid); display: flex; align-items: center; gap: 10px; }
.pbar { flex: 1; height: 6px; background: var(--surface-2); border-radius: 999px; overflow: hidden; max-width: 300px; }
.pbar span { display: block; height: 100%; background: var(--accent); transition: width .3s; }
.result { display: grid; gap: 16px; grid-template-columns: 1fr; }
@media (min-width: 900px) { .result { grid-template-columns: 1fr 1fr; } }
.h { font-size: 14px; font-weight: 640; margin: 0 0 8px; }
.transcript, .drafts { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 14px; }
.segs { max-height: 460px; overflow-y: auto; display: flex; flex-direction: column; }
.seg { display: flex; gap: 10px; padding: 6px 6px; border-radius: 6px; cursor: pointer; font-size: 13.5px; }
.seg:hover { background: var(--surface-2); }
.tc { color: var(--accent); flex: none; font-size: 12px; }
.dhead { display: flex; align-items: center; justify-content: space-between; }
.draft { position: relative; display: flex; flex-direction: column; gap: 6px; padding: 10px; border: 1px solid var(--line); border-radius: 10px; margin-bottom: 10px; }
.dtitle, .draft textarea { background: var(--ground); border: 1px solid var(--line); border-radius: 8px; color: var(--ink); padding: 8px 10px; font-family: inherit; font-size: 14px; }
.draft textarea { resize: vertical; }
.del { position: absolute; top: 8px; right: 8px; background: none; border: none; color: var(--ink-mid); cursor: pointer; }
.actions { display: flex; align-items: center; gap: 12px; margin-top: 4px; }
.btn { background: var(--surface-2); border: 1px solid var(--line); color: var(--ink); border-radius: 9px; padding: 8px 13px; font-size: 13px; cursor: pointer; }
.btn.primary { background: var(--good); border-color: var(--good); color: #06210f; }
.btn:disabled { opacity: .5; cursor: default; }
.ok { color: var(--good); font-size: 13px; }
</style>
