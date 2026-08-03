<script setup>
// Плагин «Код» — просмотр кода и гита проектов, как в VS Code, но только чтение:
// слева рейка режимов (код | гит), дальше панель (дерево файлов или изменения),
// справа Monaco. Смотреть можно ЛЮБОЕ дерево репозитория — основное или worktree
// (их создаёт фабрика): репозиторий и worktree выбираются одним полем «Рабочая копия».
// Пути репозиториев проекта задаются в разделе «Проекты».
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { api } from '../shared/api-client.js';
import { usePluginsStore } from '../stores/plugins.js';
import { monaco, langOf, READONLY_OPTS } from '../shared/monaco.js';
import TopbarActions from '../shared/layout/TopbarActions.vue';
import {
  buildCodeContexts,
  buildGitTree,
  encodeStoredCodeContext,
  flattenGitTree,
  gitDirectoryPaths,
  normalizeGitView,
  pickCodeContext,
  reconcileGitOpenDirs,
} from '../shared/code-tree.js';

const plugins = usePluginsStore();
const off = computed(() => plugins.loaded && !plugins.enabled('code'));

const loading = ref(true);
const contextLoading = ref(false);
const error = ref('');
const projects = ref([]);   // сводка /api/projects: [{id, repos, …}]
const project = ref('');
const repos = ref([]);      // /api/code/:project/repos: [{key, dir, trees}]
const repoKey = ref('');
const treePath = ref('');
const contextId = ref('');
const tab = ref('files');   // 'files' | 'git'

const contextModel = computed(() => buildCodeContexts(repos.value));
const contexts = computed(() => contextModel.value.contexts);
const unavailableRepos = computed(() => contextModel.value.unavailable);
const contextById = computed(() => new Map(contexts.value.map((item) => [item.id, item])));
const context = computed(() => contextById.value.get(contextId.value) || null);
const contextGroups = computed(() => {
  const groups = [];
  const byRepo = new Map();
  for (const item of contexts.value) {
    let group = byRepo.get(item.repoKey);
    if (!group) {
      group = { repoKey: item.repoKey, items: [] };
      byRepo.set(item.repoKey, group);
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups;
});
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
const gitView = ref(normalizeGitView(localStorage.getItem('cockpit-code-git-view')));
const gitOpenDirs = ref(new Set());
const gitKnownDirs = ref(new Set());
const gitDirsReady = ref(false);
const gitTree = computed(() => buildGitTree(git.value?.files || []));
const gitRows = computed(() => flattenGitTree(gitTree.value, gitOpenDirs.value));
const STLABEL = { A: 'A', M: 'M', D: 'D', R: 'R' };

// ── Monaco: оба редактора живут под v-show, но модели очищаются при смене контекста. ──
const fileHost = ref(null);
const diffHost = ref(null);
let fileEditor = null;
let diffEditor = null;
let fileModel = null;
let diffModels = [];

// Generation защищает весь контекст, request ID — конкурирующие запросы внутри него.
let contextGeneration = 0;
let reposRequestId = 0;
let fileRequestId = 0;
let gitRequestId = 0;
const dirRequestIds = new Map();

const contextStorageKey = (id) => `cockpit-code-context:${id}`;
const captureContext = () => ({
  generation: contextGeneration,
  project: project.value,
  repoKey: repoKey.value,
  treePath: treePath.value,
});
const contextIsCurrent = (snapshot) => snapshot.generation === contextGeneration
  && snapshot.project === project.value
  && snapshot.repoKey === repoKey.value
  && snapshot.treePath === treePath.value;
const projectIsCurrent = (generation, id, requestId) => generation === contextGeneration
  && id === project.value
  && requestId === reposRequestId;
const q = (snapshot) => `repo=${encodeURIComponent(snapshot.repoKey)}&root=${encodeURIComponent(snapshot.treePath)}`;

// Переходы — явными обработчиками, без каскадов watch: порядок загрузки детерминирован.
async function setProject(id) {
  const generation = ++contextGeneration;
  const requestId = ++reposRequestId;
  project.value = id;
  localStorage.setItem('cockpit-project', id); // общий выбор проекта с «Маршрутами» и «Проектами»
  repos.value = []; repoKey.value = ''; treePath.value = ''; contextId.value = '';
  resetState();
  contextLoading.value = true;
  if (!projectHasRepos.value) {
    if (projectIsCurrent(generation, id, requestId)) contextLoading.value = false;
    return;
  }
  let loadedRepos;
  try {
    loadedRepos = (await api.get(`/api/code/${encodeURIComponent(id)}/repos`)).repos || [];
  } catch (e) {
    if (projectIsCurrent(generation, id, requestId)) {
      error.value = e.message;
      contextLoading.value = false;
    }
    return;
  }
  if (!projectIsCurrent(generation, id, requestId)) return;
  repos.value = loadedRepos;
  const picked = pickCodeContext(contexts.value, localStorage.getItem(contextStorageKey(id)));
  if (!picked) {
    contextLoading.value = false;
    return;
  }
  await setContext(picked.id);
}

async function setContext(id) {
  const selected = contextById.value.get(id);
  if (!selected) return;
  const generation = ++contextGeneration;
  contextId.value = selected.id;
  repoKey.value = selected.repoKey;
  treePath.value = selected.treePath;
  resetState();
  contextLoading.value = true;
  localStorage.setItem(contextStorageKey(project.value), encodeStoredCodeContext(selected));
  const snapshot = captureContext();
  const rootLoaded = await loadDir('', snapshot);
  if (rootLoaded && contextIsCurrent(snapshot) && tab.value === 'git') await loadGit(snapshot);
  if (generation === contextGeneration && contextIsCurrent(snapshot)) contextLoading.value = false;
}

function resetState() {
  dirs.value = new Map(); openDirs.value = new Set();
  fileSel.value = ''; fileData.value = null;
  git.value = null; gitSel.value = '';
  gitOpenDirs.value = new Set(); gitKnownDirs.value = new Set(); gitDirsReady.value = false;
  fileLoading.value = false; gitLoading.value = false;
  fileRequestId += 1; gitRequestId += 1; dirRequestIds.clear();
  clearFileModel(); clearDiffModels();
  error.value = '';
}

async function setTab(t) {
  tab.value = t;
  if (t === 'git' && !git.value && treePath.value) await loadGit(captureContext());
}

function setGitView(view) {
  gitView.value = normalizeGitView(view);
  localStorage.setItem('cockpit-code-git-view', gitView.value);
}

function toggleGitDir(path) {
  const open = new Set(gitOpenDirs.value);
  if (open.has(path)) open.delete(path);
  else open.add(path);
  gitOpenDirs.value = open;
}

async function loadDir(rel, snapshot = captureContext()) {
  const requestId = (dirRequestIds.get(rel) || 0) + 1;
  dirRequestIds.set(rel, requestId);
  try {
    const { entries } = await api.get(
      `/api/code/${encodeURIComponent(snapshot.project)}/ls?${q(snapshot)}${rel ? `&dir=${encodeURIComponent(rel)}` : ''}`,
    );
    if (!contextIsCurrent(snapshot) || dirRequestIds.get(rel) !== requestId) return false;
    const next = new Map(dirs.value);
    next.set(rel, entries || []);
    dirs.value = next;
    return true;
  } catch (e) {
    if (contextIsCurrent(snapshot) && dirRequestIds.get(rel) === requestId) error.value = e.message;
    return false;
  }
}

async function toggleDir(rel) {
  const open = new Set(openDirs.value);
  if (open.has(rel)) { open.delete(rel); openDirs.value = open; return; }
  if (!dirs.value.has(rel) && !(await loadDir(rel))) return;
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
  const snapshot = captureContext();
  const requestId = ++fileRequestId;
  fileSel.value = rel;
  fileLoading.value = true;
  try {
    const data = await api.get(
      `/api/code/${encodeURIComponent(snapshot.project)}/file?${q(snapshot)}&path=${encodeURIComponent(rel)}`,
    );
    if (!contextIsCurrent(snapshot) || fileRequestId !== requestId || fileSel.value !== rel) return;
    fileData.value = data;
    await nextTick();
    if (contextIsCurrent(snapshot) && fileRequestId === requestId && fileSel.value === rel) {
      showFile(rel, data);
    }
  } catch (e) {
    if (contextIsCurrent(snapshot) && fileRequestId === requestId && fileSel.value === rel) {
      error.value = e.message;
    }
  } finally {
    if (contextIsCurrent(snapshot) && fileRequestId === requestId && fileSel.value === rel) {
      fileLoading.value = false;
    }
  }
}

async function loadGit(snapshot = captureContext()) {
  const requestId = ++gitRequestId;
  gitLoading.value = true;
  try {
    const data = await api.get(`/api/code/${encodeURIComponent(snapshot.project)}/git?${q(snapshot)}`);
    if (!contextIsCurrent(snapshot) || gitRequestId !== requestId) return;
    const nextGit = {
      ...data,
      files: Array.isArray(data?.files) ? data.files : [],
      log: Array.isArray(data?.log) ? data.log : [],
    };
    const nextDirs = gitDirectoryPaths(buildGitTree(nextGit.files));
    gitOpenDirs.value = reconcileGitOpenDirs(
      nextDirs,
      gitDirsReady.value ? gitOpenDirs.value : null,
      gitDirsReady.value ? gitKnownDirs.value : null,
    );
    gitKnownDirs.value = nextDirs;
    gitDirsReady.value = true;
    git.value = nextGit;
    if (gitSel.value && !git.value.files.some((f) => f.path === gitSel.value)) gitSel.value = '';
    if (!gitSel.value && git.value.files.length) gitSel.value = git.value.files[0].path;
    await nextTick();
    if (!contextIsCurrent(snapshot) || gitRequestId !== requestId) return;
    if (gitFile.value) showDiff(gitFile.value);
    else clearDiffModels();
  } catch (e) {
    if (contextIsCurrent(snapshot) && gitRequestId === requestId) error.value = e.message;
  } finally {
    if (contextIsCurrent(snapshot) && gitRequestId === requestId) gitLoading.value = false;
  }
}

async function selectGit(p) {
  const snapshot = captureContext();
  gitSel.value = p;
  await nextTick();
  if (contextIsCurrent(snapshot) && gitSel.value === p) showDiff(gitFile.value);
}

async function refresh() {
  if (!treePath.value) return;
  const snapshot = captureContext();
  if (tab.value === 'git') { await loadGit(snapshot); return; }
  // Файлы: перечитываем корень и раскрытые каталоги, переоткрываем текущий файл.
  const open = [...openDirs.value];
  const selected = fileSel.value;
  dirs.value = new Map();
  if (!(await loadDir('', snapshot)) || !contextIsCurrent(snapshot)) return;
  const keptOpen = new Set(open);
  for (const rel of open) {
    if (!(await loadDir(rel, snapshot))) keptOpen.delete(rel);
    if (!contextIsCurrent(snapshot)) return;
  }
  openDirs.value = keptOpen;
  if (selected) await openFile(selected);
}

function clearFileModel() {
  fileEditor?.setModel(null);
  fileModel?.dispose();
  fileModel = null;
}

function clearDiffModels() {
  diffEditor?.setModel(null);
  diffModels.forEach((model) => model.dispose());
  diffModels = [];
}

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
  clearFileModel(); clearDiffModels();
  fileEditor?.dispose(); diffEditor?.dispose();
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
      <span v-if="context" class="tlabel mono">{{ project }} · {{ context.label }}</span>
    </TopbarActions>

    <div v-if="off" class="empty">Плагин «Код» выключен. Включить — «Настройки → Плагины».</div>
    <div v-else-if="loading" class="empty">Загрузка…</div>
    <div v-else-if="!projects.length" class="empty">
      Проектов пока нет — заведи в разделе <router-link to="/projects">«Проекты»</router-link>.
    </div>

    <div v-else class="lay">
      <!-- Рейка режимов, как activity bar в VS Code -->
      <aside class="rail">
        <button type="button" class="ritem" :class="{ on: tab === 'files' }" title="Код: дерево файлов"
                aria-label="Код" @click="setTab('files')">
          <svg class="ic" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h8l4 4v14H6z M14 3v4h4" /></svg>
        </button>
        <button type="button" class="ritem" :class="{ on: tab === 'git' }"
                title="Гит: несохранённые изменения и коммиты" aria-label="Git" @click="setTab('git')">
          <svg class="ic" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3v12 M15 6a3 3 0 1 0 6 0 3 3 0 1 0-6 0 M3 18a3 3 0 1 0 6 0 3 3 0 1 0-6 0 M18 9a9 9 0 0 1-9 9" /></svg>
        </button>
      </aside>

      <!-- Панель: проект + единая рабочая копия, затем дерево файлов или изменения -->
      <aside class="panel">
        <div class="sels">
          <div class="sel-field">
            <label for="code-project">Проект</label>
            <select id="code-project" :value="project" @change="setProject($event.target.value)">
              <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.id }}</option>
            </select>
          </div>
          <div v-if="contexts.length > 1" class="sel-field">
            <label for="code-context">Рабочая копия</label>
            <select id="code-context" :value="contextId" @change="setContext($event.target.value)">
              <template v-if="contextGroups.length > 1">
                <optgroup v-for="group in contextGroups" :key="group.repoKey" :label="group.repoKey">
                  <option v-for="item in group.items" :key="item.id" :value="item.id" :title="item.treePath">
                    {{ item.label }}
                  </option>
                </optgroup>
              </template>
              <template v-else>
                <option v-for="item in contexts" :key="item.id" :value="item.id" :title="item.treePath">
                  {{ item.label }}
                </option>
              </template>
            </select>
          </div>
          <div v-else-if="context" class="context-static" :title="context.treePath">
            Рабочая копия: {{ context.label }}
          </div>
          <div v-if="contextLoading" class="context-loading">Загружаю рабочую копию…</div>
        </div>

        <div v-if="error" class="perr">{{ error }}</div>
        <div v-if="!projectHasRepos" class="pnote">
          Пути репозиториев не заданы — раздел <router-link to="/projects">«Проекты»</router-link>.
        </div>
        <div v-if="unavailableRepos.length" class="pnote context-warning">
          <span>Недоступные репозитории:</span>
          <span v-for="item in unavailableRepos" :key="item.repoKey" class="unavailable-repo mono">
            {{ item.repoKey }} — {{ item.repoDir }}
          </span>
          Проверь пути в разделе <router-link to="/projects">«Проекты»</router-link>.
        </div>

        <!-- Дерево файлов -->
        <div v-if="tab === 'files'" class="scroll">
          <template v-for="row in rows" :key="row.rel">
            <button v-if="row.dir" type="button" class="trow dir" :data-dir-path="row.rel"
                    :aria-expanded="openDirs.has(row.rel)" :style="{ paddingLeft: indent(row.depth) }"
                    @click="toggleDir(row.rel)">
              <span class="chev">{{ openDirs.has(row.rel) ? '▾' : '▸' }}</span>
              <span class="dname">{{ row.name }}</span>
            </button>
            <button v-else type="button" class="trow frow" :class="{ sel: fileSel === row.rel }"
                    :data-file-path="row.rel"
                    :style="{ paddingLeft: indent(row.depth) }" @click="openFile(row.rel)">
              <span class="nm">{{ row.name }}</span>
            </button>
          </template>
        </div>

        <!-- Гит: изменения + свежие коммиты -->
        <div v-else class="scroll">
          <div v-if="gitLoading && !git" class="pnote">Читаю гит…</div>
          <template v-if="git">
            <div class="subhead">
              <span>Не в коммите</span>
              <span v-if="git.files.length" class="cnt mono">{{ git.files.length }}</span>
              <span class="grow"></span>
              <div class="git-view-toggle" role="group" aria-label="Вид изменений">
                <button type="button" data-view="tree" title="Показать деревом" aria-label="Показать деревом"
                        :aria-pressed="gitView === 'tree'" @click="setGitView('tree')">
                  <svg aria-hidden="true" viewBox="0 0 16 16"><path d="M2 2.5h4v3H2zM6 4h3v1H6zM8 4h1v7H8zM8 7h2v1H8zM8 10h2v1H8zM10 6.5h4v3h-4zM10 9.5h4v3h-4z" /></svg>
                </button>
                <button type="button" data-view="list" title="Показать списком" aria-label="Показать списком"
                        :aria-pressed="gitView === 'list'" @click="setGitView('list')">
                  <svg aria-hidden="true" viewBox="0 0 16 16"><path d="M2 3h2v2H2zM5 3h9v2H5zM2 7h2v2H2zM5 7h9v2H5zM2 11h2v2H2zM5 11h9v2H5z" /></svg>
                </button>
              </div>
            </div>
            <div v-if="!git.files.length" class="pnote">Несохранённых изменений нет.</div>
            <template v-if="gitView === 'tree'">
              <template v-for="row in gitRows" :key="row.key">
                <button v-if="row.kind === 'dir'" type="button" class="trow dir git-row git-dir"
                        :data-path="row.path" :aria-expanded="gitOpenDirs.has(row.path)"
                        :style="{ paddingLeft: indent(row.depth) }" @click="toggleGitDir(row.path)">
                  <span class="chev">{{ gitOpenDirs.has(row.path) ? '▾' : '▸' }}</span>
                  <span class="dname" :title="row.path">{{ row.name }}</span>
                </button>
                <button v-else type="button" class="trow frow git-row git-file"
                        :class="{ sel: gitSel === row.path }" :data-path="row.path"
                        :style="{ paddingLeft: indent(row.depth) }" @click="selectGit(row.path)">
                  <span class="st" :class="row.file.status">{{ STLABEL[row.file.status] || row.file.status }}</span>
                  <span class="nm mono" :title="row.path">{{ row.name }}</span>
                  <span class="cnt mono"><i v-if="row.file.add" class="a">+{{ row.file.add }}</i><i v-if="row.file.del" class="d">−{{ row.file.del }}</i></span>
                </button>
              </template>
            </template>
            <template v-else>
              <button v-for="f in git.files" :key="`file:${f.path}`" type="button"
                      class="trow frow git-row git-file" :class="{ sel: gitSel === f.path }"
                      :data-path="f.path" @click="selectGit(f.path)">
                <span class="st" :class="f.status">{{ STLABEL[f.status] || f.status }}</span>
                <span class="nm mono" :title="f.path">{{ f.path }}</span>
                <span class="cnt mono"><i v-if="f.add" class="a">+{{ f.add }}</i><i v-if="f.del" class="d">−{{ f.del }}</i></span>
              </button>
            </template>
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
.sel-field { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.sel-field label { color: var(--ink-mid); font-size: 10.5px; font-weight: 700; letter-spacing: .03em; }
.sels select { width: 100%; padding: 5px 8px; border-radius: 8px; border: 1px solid var(--line-2);
  background: var(--surface-2); color: var(--ink); font-size: 12px; }
.sels select:focus-visible { outline: 2px solid color-mix(in srgb, var(--accent) 45%, transparent);
  outline-offset: 1px; border-color: var(--accent); }
.context-static { min-width: 0; color: var(--ink); background: var(--surface-2); border: 1px solid var(--line-2);
  border-radius: 8px; padding: 6px 8px; font-size: 12px; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; }
.context-loading { color: var(--ink-mid); font-size: 11px; padding: 1px 2px; }
.perr { color: var(--bad); font-size: 12px; padding: 8px 12px; }
.pnote { color: var(--ink-mid); font-size: 12px; padding: 8px 12px; }
.context-warning { display: flex; flex-direction: column; gap: 3px; }
.unavailable-repo { color: var(--bad); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.scroll { flex: 1; overflow-y: auto; padding: 6px 8px; }

.trow { display: flex; align-items: center; gap: 7px; width: 100%; text-align: left; background: none; border: none;
  color: var(--ink); padding: 4px 8px; border-radius: 7px; cursor: pointer; font-size: 12.5px; }
.trow:hover { background: var(--surface); }
.trow:focus-visible, .ritem:focus-visible, .git-view-toggle button:focus-visible, .act:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--accent) 55%, transparent); outline-offset: 1px; }
.trow.dir { color: var(--ink-mid); }
.chev { flex: none; width: 12px; font-size: 10px; color: var(--ink-mid); }
.dname { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.frow.sel { background: color-mix(in srgb, var(--accent) 16%, transparent); }
.nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.st { flex: none; width: 16px; text-align: center; font-family: var(--mono); font-size: 11px; font-weight: 700; border-radius: 4px; }
.st.A { color: var(--good); } .st.M { color: var(--warn); } .st.D { color: var(--bad); } .st.R { color: var(--accent); }
.cnt { flex: none; font-size: 11px; display: flex; gap: 6px; }
.cnt .a { color: var(--good); } .cnt .d { color: var(--bad); }

.subhead { font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em;
  color: var(--ink-mid); padding: 10px 8px 5px; display: flex; align-items: center; gap: 7px; }
.git-view-toggle { display: inline-flex; border: 1px solid var(--line); border-radius: 6px; overflow: hidden; }
.git-view-toggle button { display: grid; place-items: center; width: 25px; height: 23px; padding: 4px; border: 0;
  border-right: 1px solid var(--line); background: var(--surface-2); color: var(--ink-mid); cursor: pointer; }
.git-view-toggle button:last-child { border-right: 0; }
.git-view-toggle button:hover { color: var(--ink); }
.git-view-toggle button[aria-pressed="true"] { color: var(--accent);
  background: color-mix(in srgb, var(--accent) 14%, transparent); }
.git-view-toggle svg { width: 15px; height: 15px; fill: currentColor; }
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
