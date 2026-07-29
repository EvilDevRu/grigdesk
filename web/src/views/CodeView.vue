<script setup>
// Плагин «Код» — просмотр кода и гита проектов, как в VS Code, но только чтение:
// слева рейка режимов (код | гит), дальше панель (дерево файлов или изменения),
// справа Monaco. Смотреть можно ЛЮБОЕ дерево репозитория — основное или worktree
// (их создаёт фабрика под задачи и слоты): выбор — селектором, по умолчанию основное.
// Пути репозиториев проекта задаются в разделе «Проекты».
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { api } from '../shared/api-client.js';
import { usePluginsStore } from '../stores/plugins.js';
import { monaco, langOf, READONLY_OPTS } from '../shared/monaco.js';
import TopbarActions from '../shared/layout/TopbarActions.vue';

const plugins = usePluginsStore();
const off = computed(() => plugins.loaded && !plugins.enabled('code'));

const loading = ref(true);
const error = ref('');
const projects = ref([]);   // сводка /api/projects: [{id, repos, …}]
const project = ref('');
const repos = ref([]);      // /api/code/:project/repos: [{key, dir, trees}]
const repoKey = ref('');
const treePath = ref('');
const tab = ref('files');   // 'files' | 'git'

const repo = computed(() => repos.value.find((r) => r.key === repoKey.value) || null);
const trees = computed(() => repo.value?.trees || []);
const tree = computed(() => trees.value.find((t) => t.path === treePath.value) || null);
const projectHasRepos = computed(() => (projects.value.find((p) => p.id === project.value)?.repos || []).length > 0);

// ── Дерево файлов (ленивое: каталог читается при раскрытии) ──
const dirs = ref(new Map());     // rel ('' = корень) → entries [{name, dir}]
const openDirs = ref(new Set());
const fileSel = ref('');
const fileData = ref(null);      // { content, binary, tooBig, size }
const fileLoading = ref(false);

// ── Гит ──
const git = ref(null);           // { branch, files, log }
const gitLoading = ref(false);
const gitSel = ref('');
const gitFile = computed(() => git.value?.files.find((f) => f.path === gitSel.value) || null);
const side = ref(localStorage.getItem('cockpit-diff-side') !== '0');
const STLABEL = { A: 'A', M: 'M', D: 'D', R: 'R' };

const q = () => `repo=${encodeURIComponent(repoKey.value)}&root=${encodeURIComponent(treePath.value)}`;

// Переходы — явными обработчиками, без каскадов watch: порядок загрузки детерминирован.
async function setProject(id) {
  project.value = id;
  localStorage.setItem('cockpit-project', id); // общий выбор проекта с «Маршрутами» и «Проектами»
  repos.value = []; repoKey.value = ''; treePath.value = '';
  resetState();
  if (!projectHasRepos.value) return;
  try { repos.value = (await api.get(`/api/code/${id}/repos`)).repos || []; }
  catch (e) { error.value = e.message; return; }
  const first = repos.value.find((r) => r.trees.length) || repos.value[0];
  if (first) await setRepo(first.key);
}

async function setRepo(key) {
  repoKey.value = key;
  await setTree((repos.value.find((r) => r.key === key)?.trees || [])[0]?.path || '');
}

async function setTree(p) {
  treePath.value = p;
  resetState();
  if (!p) return;
  await loadDir('');
  if (tab.value === 'git') await loadGit();
}

function resetState() {
  dirs.value = new Map(); openDirs.value = new Set();
  fileSel.value = ''; fileData.value = null;
  git.value = null; gitSel.value = '';
  error.value = '';
}

async function setTab(t) {
  tab.value = t;
  if (t === 'git' && !git.value && treePath.value) await loadGit();
}

async function loadDir(rel) {
  const { entries } = await api.get(`/api/code/${project.value}/ls?${q()}${rel ? `&dir=${encodeURIComponent(rel)}` : ''}`);
  const m = new Map(dirs.value); m.set(rel, entries); dirs.value = m;
}

async function toggleDir(rel) {
  const open = new Set(openDirs.value);
  if (open.has(rel)) { open.delete(rel); openDirs.value = open; return; }
  if (!dirs.value.has(rel)) {
    try { await loadDir(rel); } catch (e) { error.value = e.message; return; }
  }
  open.add(rel); openDirs.value = open;
}

// Плоские строки видимой части дерева — из раскрытых каталогов.
const rows = computed(() => {
  const out = [];
  const walk = (rel, depth) => {
    for (const e of dirs.value.get(rel) || []) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      out.push({ name: e.name, dir: e.dir, rel: p, depth });
      if (e.dir && openDirs.value.has(p)) walk(p, depth + 1);
    }
  };
  walk('', 0);
  return out;
});
function indent(depth) { return `${depth * 13 + 8}px`; }

async function openFile(rel) {
  fileSel.value = rel; fileLoading.value = true;
  try {
    fileData.value = await api.get(`/api/code/${project.value}/file?${q()}&path=${encodeURIComponent(rel)}`);
    await nextTick();
    showFile(rel, fileData.value);
  } catch (e) { error.value = e.message; }
  finally { fileLoading.value = false; }
}

async function loadGit() {
  gitLoading.value = true;
  try {
    git.value = await api.get(`/api/code/${project.value}/git?${q()}`);
    if (gitSel.value && !git.value.files.some((f) => f.path === gitSel.value)) gitSel.value = '';
    if (!gitSel.value && git.value.files.length) gitSel.value = git.value.files[0].path;
    await nextTick();
    showDiff(gitFile.value);
  } catch (e) { error.value = e.message; }
  finally { gitLoading.value = false; }
}

async function selectGit(p) {
  gitSel.value = p;
  await nextTick();
  showDiff(gitFile.value);
}

async function refresh() {
  if (!treePath.value) return;
  if (tab.value === 'git') { await loadGit(); return; }
  // Файлы: перечитываем корень и раскрытые каталоги, переоткрываем текущий файл.
  const open = [...openDirs.value];
  dirs.value = new Map();
  try {
    await loadDir('');
    for (const rel of open) await loadDir(rel).catch(() => openDirs.value.delete(rel));
  } catch (e) { error.value = e.message; }
  if (fileSel.value) await openFile(fileSel.value);
}

// ── Monaco: обычный редактор для файла, диф-редактор для гита. Оба живут в своих
// хостах под v-show — инстансы не пересоздаются при переключении режима. ──
const fileHost = ref(null);
const diffHost = ref(null);
let fileEditor = null;
let diffEditor = null;
let fileModel = null;
let diffModels = [];

function showFile(rel, data) {
  if (!fileHost.value || !data) return;
  if (!fileEditor) fileEditor = monaco.editor.create(fileHost.value, { ...READONLY_OPTS, renderLineHighlight: 'none' });
  const model = monaco.editor.createModel(data.binary || data.tooBig ? '' : data.content, langOf(rel));
  fileEditor.setModel(model);
  fileModel?.dispose(); // старую модель снимаем ПОСЛЕ переустановки (иначе варнинг Monaco)
  fileModel = model;
}

function showDiff(f) {
  if (!f || !diffHost.value) return;
  if (!diffEditor) {
    diffEditor = monaco.editor.createDiffEditor(diffHost.value, {
      ...READONLY_OPTS,
      renderSideBySide: side.value,
      renderOverviewRuler: true, ignoreTrimWhitespace: false,
      hideUnchangedRegions: { enabled: true, minimumLineCount: 3, contextLineCount: 3 },
    });
  }
  const lang = langOf(f.path);
  const orig = monaco.editor.createModel(f.tooBig ? '' : (f.oldContent || ''), lang);
  const mod = monaco.editor.createModel(f.tooBig ? '' : (f.newContent || ''), lang);
  const old = diffModels;
  diffModels = [orig, mod];
  diffEditor.setModel({ original: orig, modified: mod });
  old.forEach((m) => m.dispose());
}

watch(side, (v) => { localStorage.setItem('cockpit-diff-side', v ? '1' : '0'); diffEditor?.updateOptions({ renderSideBySide: v }); });
onBeforeUnmount(() => {
  fileEditor?.dispose(); diffEditor?.dispose();
  fileModel?.dispose(); diffModels.forEach((m) => m.dispose());
});

onMounted(async () => {
  if (!plugins.loaded) await plugins.load();
  try {
    projects.value = (await api.get('/api/projects')).projects || [];
    const withRepos = projects.value.filter((p) => p.repos.length);
    const saved = localStorage.getItem('cockpit-project') || '';
    const pick = withRepos.find((p) => p.id === saved) || withRepos[0] || projects.value[0];
    if (pick) await setProject(pick.id);
  } catch (e) { error.value = e.message; }
  finally { loading.value = false; }
});
</script>

<template>
  <div class="page">
    <TopbarActions>
      <span v-if="tree" class="tlabel mono">{{ project }} · {{ repoKey }} · {{ tree.branch }}</span>
    </TopbarActions>

    <div v-if="off" class="empty">Плагин «Код» выключен. Включить — «Настройки → Плагины».</div>
    <div v-else-if="loading" class="empty">Загрузка…</div>
    <div v-else-if="!projects.length" class="empty">
      Проектов пока нет — заведи в разделе <router-link to="/projects">«Проекты»</router-link>.
    </div>

    <div v-else class="lay">
      <!-- Рейка режимов, как activity bar в VS Code -->
      <aside class="rail">
        <button class="ritem" :class="{ on: tab === 'files' }" title="Код: дерево файлов" @click="setTab('files')">
          <svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h8l4 4v14H6z M14 3v4h4" /></svg>
        </button>
        <button class="ritem" :class="{ on: tab === 'git' }" title="Гит: несохранённые изменения и коммиты" @click="setTab('git')">
          <svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3v12 M15 6a3 3 0 1 0 6 0 3 3 0 1 0-6 0 M3 18a3 3 0 1 0 6 0 3 3 0 1 0-6 0 M18 9a9 9 0 0 1-9 9" /></svg>
        </button>
      </aside>

      <!-- Панель: выбор проекта/репозитория/дерева + дерево файлов или изменения -->
      <aside class="panel">
        <div class="sels">
          <select :value="project" @change="setProject($event.target.value)">
            <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.id }}</option>
          </select>
          <select v-if="repos.length > 1" :value="repoKey" @change="setRepo($event.target.value)">
            <option v-for="r in repos" :key="r.key" :value="r.key">{{ r.key }} — {{ r.dir }}</option>
          </select>
          <!-- Дерево: основной репозиторий или worktree (задача/слот) -->
          <select v-if="trees.length" :value="treePath" @change="setTree($event.target.value)">
            <option v-for="t in trees" :key="t.path" :value="t.path">
              {{ t.name }}{{ t.task ? ` · ${t.task}` : '' }} · {{ t.branch }}
            </option>
          </select>
        </div>

        <div v-if="error" class="perr">{{ error }}</div>
        <div v-if="!projectHasRepos" class="pnote">
          Пути репозиториев не заданы — раздел <router-link to="/projects">«Проекты»</router-link>.
        </div>
        <div v-else-if="repo && !trees.length" class="pnote">{{ repo.dir }}: не git-репозиторий или недоступен.</div>

        <!-- Дерево файлов -->
        <div v-if="tab === 'files'" class="scroll">
          <template v-for="row in rows" :key="row.rel">
            <div v-if="row.dir" class="trow dir" :style="{ paddingLeft: indent(row.depth) }" @click="toggleDir(row.rel)">
              <span class="chev">{{ openDirs.has(row.rel) ? '▾' : '▸' }}</span>
              <span class="dname">{{ row.name }}</span>
            </div>
            <button v-else class="trow frow" :class="{ sel: fileSel === row.rel }"
                    :style="{ paddingLeft: indent(row.depth) }" @click="openFile(row.rel)">
              <span class="nm">{{ row.name }}</span>
            </button>
          </template>
        </div>

        <!-- Гит: изменения + свежие коммиты -->
        <div v-else class="scroll">
          <div v-if="gitLoading && !git" class="pnote">Читаю гит…</div>
          <template v-if="git">
            <div class="subhead">Не в коммите <span v-if="git.files.length" class="cnt mono">{{ git.files.length }}</span></div>
            <div v-if="!git.files.length" class="pnote">Несохранённых изменений нет.</div>
            <button v-for="f in git.files" :key="f.path" class="trow frow" :class="{ sel: gitSel === f.path }" @click="selectGit(f.path)">
              <span class="st" :class="f.status">{{ STLABEL[f.status] || f.status }}</span>
              <span class="nm mono" :title="f.path">{{ f.path }}</span>
              <span class="cnt mono"><i v-if="f.add" class="a">+{{ f.add }}</i><i v-if="f.del" class="d">−{{ f.del }}</i></span>
            </button>
            <div class="subhead">Коммиты</div>
            <div v-for="c in git.log" :key="c.hash" class="commit" :title="c.when">
              <span class="hash mono">{{ c.hash }}</span>
              <span class="subj">{{ c.subject }}</span>
            </div>
          </template>
        </div>
      </aside>

      <!-- Просмотр: файл или диф -->
      <section class="editorwrap">
        <div class="ehead">
          <template v-if="tab === 'files' && fileSel">
            <span class="epath mono">{{ fileSel }}</span>
            <span v-if="fileData?.binary" class="note">бинарный</span>
            <span v-else-if="fileData?.tooBig" class="note">слишком большой — превью отключено</span>
            <span v-if="fileLoading" class="note">читаю…</span>
          </template>
          <template v-else-if="tab === 'git' && gitFile">
            <span class="st" :class="gitFile.status">{{ STLABEL[gitFile.status] || gitFile.status }}</span>
            <span class="epath mono">{{ gitFile.path }}</span>
            <span v-if="gitFile.binary" class="note">бинарный</span>
            <span v-else-if="gitFile.tooBig" class="note">слишком большой — превью отключено</span>
          </template>
          <span class="grow"></span>
          <button v-if="tab === 'git'" class="act" :class="{ on: side }" :title="side ? 'Рядом' : 'В строку'" @click="side = !side">
            {{ side ? '⇆ рядом' : '≡ в строку' }}
          </button>
          <button class="act" :disabled="gitLoading || fileLoading" title="Обновить" @click="refresh">↻</button>
        </div>
        <div class="ebody">
          <div v-show="tab === 'files'" ref="fileHost" class="editor"></div>
          <div v-show="tab === 'git'" ref="diffHost" class="editor"></div>
          <div v-if="tab === 'files' && !fileSel" class="overlay">Выбери файл слева</div>
          <div v-else-if="tab === 'git' && git && !git.files.length" class="overlay">Несохранённых изменений нет — рабочее дерево чистое</div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.page { height: 100%; display: flex; flex-direction: column; min-height: 0; }
.tlabel { font-size: 12px; color: var(--ink-mid); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.empty { color: var(--ink-mid); padding: 40px 0; text-align: center; }
.empty a, .pnote a { color: var(--accent); }

.lay { flex: 1; min-height: 0; display: grid; grid-template-columns: 44px 300px 1fr;
  border: 1px solid var(--line); border-radius: 12px; overflow: hidden; background: var(--surface); }

/* Рейка режимов */
.rail { display: flex; flex-direction: column; gap: 2px; padding: 8px 0; align-items: center;
  background: var(--sidebar); border-right: 1px solid var(--line); }
.ritem { background: none; border: none; color: var(--ink-mid); width: 34px; height: 34px; border-radius: 8px;
  display: grid; place-items: center; cursor: pointer; }
.ritem:hover { background: var(--surface); color: var(--ink); }
.ritem.on { color: var(--accent); background: color-mix(in srgb, var(--accent) 14%, transparent); }
.ic { width: 19px; height: 19px; }

/* Панель */
.panel { display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--line); background: var(--sidebar); }
.sels { display: flex; flex-direction: column; gap: 6px; padding: 10px 10px 8px; border-bottom: 1px solid var(--line); }
.sels select { width: 100%; padding: 5px 8px; border-radius: 8px; border: 1px solid var(--line-2);
  background: var(--surface-2); color: var(--ink); font-size: 12px; }
.sels select:focus { outline: none; border-color: var(--accent); }
.perr { color: var(--bad); font-size: 12px; padding: 8px 12px; }
.pnote { color: var(--ink-mid); font-size: 12px; padding: 8px 12px; }
.scroll { flex: 1; overflow-y: auto; padding: 6px 8px; }

.trow { display: flex; align-items: center; gap: 7px; width: 100%; text-align: left; background: none; border: none;
  color: var(--ink); padding: 4px 8px; border-radius: 7px; cursor: pointer; font-size: 12.5px; }
.trow:hover { background: var(--surface); }
.trow.dir { color: var(--ink-mid); }
.chev { flex: none; width: 12px; font-size: 10px; color: var(--ink-mid); }
.dname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.frow.sel { background: color-mix(in srgb, var(--accent) 16%, transparent); }
.nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.st { flex: none; width: 16px; text-align: center; font-family: var(--mono); font-size: 11px; font-weight: 700; border-radius: 4px; }
.st.A { color: var(--good); } .st.M { color: var(--warn); } .st.D { color: var(--bad); } .st.R { color: var(--accent); }
.cnt { flex: none; font-size: 11px; display: flex; gap: 6px; }
.cnt .a { color: var(--good); } .cnt .d { color: var(--bad); }

.subhead { font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em;
  color: var(--ink-mid); padding: 10px 8px 5px; display: flex; align-items: center; gap: 7px; }
.commit { display: flex; align-items: baseline; gap: 8px; padding: 3px 8px; font-size: 12px; min-width: 0; }
.hash { flex: none; color: var(--accent); font-size: 11px; }
.subj { color: var(--ink-mid); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* Просмотр */
.editorwrap { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.ehead { display: flex; align-items: center; gap: 10px; padding: 7px 12px; border-bottom: 1px solid var(--line); background: var(--topbar); min-height: 37px; }
.ehead .st { width: auto; padding: 0 5px; }
.epath { font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.note { font-size: 11px; color: var(--warn); flex: none; }
.grow { flex: 1; }
.ebody { flex: 1; min-height: 0; position: relative; }
.editor { position: absolute; inset: 0; }
.overlay { position: absolute; inset: 0; display: grid; place-items: center; color: var(--ink-mid);
  font-size: 13px; background: #0a0c10; }

.act { background: var(--surface-2); border: 1px solid var(--line); color: var(--ink-mid); border-radius: 7px;
  padding: 4px 10px; font-size: 12.5px; cursor: pointer; flex: none; }
.act:hover { color: var(--ink); border-color: var(--line-2); }
.act.on { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 40%, var(--line)); }
.act:disabled { opacity: .5; cursor: default; }

/* Узкое окно: панель уже, рейка остаётся */
@media (max-width: 900px) { .lay { grid-template-columns: 44px 230px 1fr; } }
</style>
