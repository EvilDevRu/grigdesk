<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { useRoute } from 'vue-router';
// Ядро редактора + подсветка всех базовых языков (Monarch, главный поток).
// НЕ тянем language/typescript|json (им нужны свои воркеры и они сыплют «Missing requestHandler»);
// для read-only дифа языковые сервисы не нужны — только подсветка.
import * as monaco from 'monaco-editor/editor/editor.api';
import 'monaco-editor/basic-languages/monaco.contribution';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import { api } from '../shared/api-client.js';
import TopbarActions from '../shared/layout/TopbarActions.vue';

// Раздел «Диф»: несохранённые изменения воркдира задачи (бэк+фронт) — для приёмки.
// Диф-редактор — Monaco (движок VS Code): side-by-side, подсветка, сворачивание неизменённого.

// Воркеры Monaco: для дифа достаточно editor.worker (в нём считается сравнение).
self.MonacoEnvironment = { getWorker: () => new EditorWorker() };

// Тема под палитру кокпита.
monaco.editor.defineTheme('cockpit-dark', {
  base: 'vs-dark', inherit: true, rules: [],
  colors: {
    'editor.background': '#0a0c10',
    'editorGutter.background': '#0a0c10',
    'editor.foreground': '#e7eaf0',
    'editorLineNumber.foreground': '#3a4453',
    'editorLineNumber.activeForeground': '#8a93a3',
    'diffEditor.insertedLineBackground': '#3fb95015',
    'diffEditor.removedLineBackground': '#f0564c15',
    'diffEditor.insertedTextBackground': '#3fb95028',
    'diffEditor.removedTextBackground': '#f0564c28',
    'editorWidget.background': '#151b24',
    'editorOverviewRuler.border': '#00000000',
    'scrollbarSlider.background': '#2e374288',
    'scrollbarSlider.hoverBackground': '#2e3742cc',
  },
});

// Язык по расширению файла (подсветка).
const LANG = {
  php: 'php', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript', vue: 'html', json: 'json', css: 'css', scss: 'scss',
  html: 'html', md: 'markdown', yml: 'yaml', yaml: 'yaml', sh: 'shell', bash: 'shell',
  py: 'python', sql: 'sql', xml: 'xml', env: 'ini', ini: 'ini', blade: 'html',
};
function langOf(p) { const ext = (p.split('.').pop() || '').toLowerCase(); return LANG[ext] || 'plaintext'; }
function baseName(p) { const i = p.lastIndexOf('/'); return i < 0 ? p : p.slice(i + 1); }
function dirName(p) { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i + 1); }

const route = useRoute();
const taskId = computed(() => String(route.query.task || '').replace(/[^0-9]/g, ''));
const loading = ref(false);
const error = ref('');
const repos = ref([]);
const sideBySide = ref(localStorage.getItem('cockpit-diff-side') !== '0');

// Плоский список файлов (бэк+фронт) для панели слева.
const files = computed(() => repos.value.flatMap((r) => (r.files || []).map((f) => ({ ...f, repo: r.name, branch: r.branch }))));
const selectedKey = ref('');
const selected = computed(() => files.value.find((f) => `${f.repo}:${f.path}` === selectedKey.value) || null);
function fkey(f) { return `${f.repo}:${f.path}`; }
const STLABEL = { A: 'A', M: 'M', D: 'D', R: 'R' };

// ── Monaco diff editor ──
const host = ref(null);
let diffEditor = null;
let models = [];
function disposeModels() { models.forEach((m) => m.dispose()); models = []; }

function mountEditor() {
  if (diffEditor || !host.value) return;
  diffEditor = monaco.editor.createDiffEditor(host.value, {
    theme: 'cockpit-dark', readOnly: true, automaticLayout: true,
    renderSideBySide: sideBySide.value, fontSize: 12.5, lineHeight: 18,
    minimap: { enabled: false }, scrollBeyondLastLine: false,
    renderOverviewRuler: true, ignoreTrimWhitespace: false,
    hideUnchangedRegions: { enabled: true, minimumLineCount: 3, contextLineCount: 3 },
    // Фичи, которым нужен языковой воркер (у нас только editor.worker) — выкл, чтобы не сыпать в консоль.
    links: false, occurrencesHighlight: 'off', stickyScroll: { enabled: false }, codeLens: false,
  });
}
function showFile(f) {
  if (!f) return;
  mountEditor();
  if (!diffEditor) return; // хост ещё не в DOM (идёт загрузка) — покажем после nextTick
  const lang = langOf(f.path);
  const orig = monaco.editor.createModel(f.tooBig ? '' : (f.oldContent || ''), lang);
  const mod = monaco.editor.createModel(f.tooBig ? '' : (f.newContent || ''), lang);
  const old = models;
  models = [orig, mod];
  diffEditor.setModel({ original: orig, modified: mod });
  old.forEach((m) => m.dispose()); // старые модели снимаем ПОСЛЕ переустановки (иначе варнинг Monaco)
}
watch(selected, (f) => showFile(f));
watch(sideBySide, (v) => { localStorage.setItem('cockpit-diff-side', v ? '1' : '0'); diffEditor?.updateOptions({ renderSideBySide: v }); });

async function load() {
  if (!taskId.value) { error.value = 'не указана задача'; return; }
  loading.value = true; error.value = '';
  try {
    repos.value = (await api.get(`/api/tasks/${taskId.value}/diff`)).repos || [];
    // Выбрать первый файл (или сохранить текущий, если ещё есть).
    if (!selected.value) selectedKey.value = files.value[0] ? fkey(files.value[0]) : '';
  } catch (e) { error.value = e.message; repos.value = []; }
  finally { loading.value = false; }
  // Хост редактора рендерится только после loading=false — показываем файл теперь.
  await nextTick();
  if (selected.value) showFile(selected.value);
}

onMounted(load);
watch(taskId, load);
onBeforeUnmount(() => { diffEditor?.dispose(); diffEditor = null; disposeModels(); });
</script>

<template>
  <TopbarActions>
    <span class="tlabel mono">#{{ taskId || '—' }} · диф</span>
    <button class="act" :class="{ on: sideBySide }" :title="sideBySide ? 'Рядом' : 'В строку'" @click="sideBySide = !sideBySide">
      {{ sideBySide ? '⇆ рядом' : '≡ в строку' }}
    </button>
    <button class="act" :disabled="loading" title="Обновить" @click="load">↻</button>
  </TopbarActions>

  <div class="diff-view">
    <div v-if="loading" class="state"><span class="spin big"></span><p class="muted">Считаю диф…</p></div>
    <div v-else-if="error" class="state"><p class="bad">{{ error }}</p><button class="act big" @click="load">Повторить</button></div>
    <div v-else-if="!files.length" class="state">
      <p>Несохранённых изменений нет</p>
      <p class="muted sm">Правки задачи уже закоммичены — смотри их в PR.</p>
    </div>

    <div v-else class="split">
      <!-- Список изменённых файлов -->
      <aside class="filelist">
        <template v-for="r in repos" :key="r.name">
          <div v-if="(r.files || []).length" class="grp">
            <div class="grphead">
              <span class="badge" :class="r.name">{{ r.name === 'be' ? 'Бэкенд' : 'Фронт' }}</span>
              <span class="branch mono">{{ r.branch }}</span>
            </div>
            <button v-for="f in r.files" :key="f.path" class="frow" :class="{ sel: selectedKey === `${r.name}:${f.path}` }"
                    @click="selectedKey = `${r.name}:${f.path}`">
              <span class="st" :class="f.status">{{ STLABEL[f.status] || f.status }}</span>
              <span class="nm"><b>{{ baseName(f.path) }}</b><i class="dir">{{ dirName(f.path) }}</i></span>
              <span class="cnt mono"><i v-if="f.add" class="a">+{{ f.add }}</i><i v-if="f.del" class="d">−{{ f.del }}</i></span>
            </button>
          </div>
        </template>
      </aside>

      <!-- Диф-редактор -->
      <section class="editorwrap">
        <div v-if="selected" class="ehead">
          <span class="st" :class="selected.status">{{ STLABEL[selected.status] || selected.status }}</span>
          <span class="epath mono">{{ selected.path }}</span>
          <span v-if="selected.binary" class="note">бинарный</span>
          <span v-else-if="selected.tooBig" class="note">слишком большой — превью отключено</span>
        </div>
        <div ref="host" class="editor"></div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.diff-view { height: 100%; }
.state { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; text-align: center; }
.state p { margin: 0; }
.sm { font-size: 12.5px; }
.bad { color: var(--bad); font-weight: 600; }
.spin.big { width: 24px; height: 24px; border-width: 3px; }

.split { height: 100%; display: grid; grid-template-columns: 300px 1fr; min-height: 0; }
.filelist { border-right: 1px solid var(--line); overflow-y: auto; padding: 8px; background: var(--sidebar); }
.grp { margin-bottom: 10px; }
.grphead { display: flex; align-items: center; gap: 8px; padding: 6px 6px 8px; }
.badge { font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; padding: 2px 7px; border-radius: 6px; }
.badge.be { background: color-mix(in srgb, var(--node-code) 20%, transparent); color: var(--node-code); }
.badge.fe { background: color-mix(in srgb, var(--accent) 18%, transparent); color: var(--accent); }
.branch { font-size: 11px; color: var(--ink-mid); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.frow { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; background: none; border: none;
  color: var(--ink); padding: 6px 8px; border-radius: 7px; cursor: pointer; }
.frow:hover { background: var(--surface); }
.frow.sel { background: color-mix(in srgb, var(--accent) 16%, transparent); }
.st { flex: none; width: 16px; text-align: center; font-family: var(--mono); font-size: 11px; font-weight: 700; border-radius: 4px; }
.st.A { color: var(--good); } .st.M { color: var(--warn); } .st.D { color: var(--bad); } .st.R { color: var(--accent); }
.nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; }
.nm b { font-weight: 600; }
.nm .dir { color: var(--ink-mid); font-style: normal; font-size: 11px; }
.cnt { flex: none; font-size: 11px; display: flex; gap: 6px; }
.cnt .a { color: var(--good); } .cnt .d { color: var(--bad); }

.editorwrap { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.ehead { display: flex; align-items: center; gap: 10px; padding: 8px 14px; border-bottom: 1px solid var(--line); background: var(--topbar); }
.ehead .st { width: auto; padding: 0 5px; }
.epath { font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.note { font-size: 11px; color: var(--warn); flex: none; }
.editor { flex: 1; min-height: 0; }

.act { background: var(--surface-2); border: 1px solid var(--line); color: var(--ink-mid); border-radius: 7px;
  padding: 4px 10px; font-size: 12.5px; cursor: pointer; }
.act:hover { color: var(--ink); border-color: var(--line-2); }
.act.on { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 40%, var(--line)); }
.act.big { padding: 6px 14px; }
.tlabel { font-size: 12px; color: var(--ink-mid); }
</style>
