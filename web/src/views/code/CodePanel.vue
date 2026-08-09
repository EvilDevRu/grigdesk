<script setup>
// Плагин «Код» — просмотр кода и гита проектов, как в VS Code, но только чтение:
// слева рейка режимов (код | гит), дальше панель (дерево файлов или изменения),
// справа Monaco. Смотреть можно ЛЮБОЕ дерево репозитория — основное или worktree
// (их создаёт фабрика): репозиторий и worktree выбираются одним полем «Рабочая копия».
// Пути репозиториев проекта задаются в разделе «Проекты».
import { ref, computed, watch, onBeforeUnmount, nextTick } from 'vue';
import { api } from '../../shared/api-client.js';
import { monaco, langOf, READONLY_OPTS } from '../../shared/monaco.js';
import {
  buildCodeContexts,
  buildGitTree,
  encodeStoredCodeContext,
  flattenGitTree,
  gitDirectoryPaths,
  normalizeGitView,
  pickCodeContext,
  reconcileGitOpenDirs,
} from '../../shared/code-tree.js';

const props = defineProps({
  active: { type: Boolean, default: true },
  compact: { type: Boolean, default: false },
  presentation: { type: String, default: 'page' },
  intents: { type: Array, default: () => [] },
});
const emit = defineEmits(['consume-intent', 'context']);

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
// Для добавленного/удалённого файла одна сторона дифа заведомо пуста. В режиме
// «рядом» она съедала половину редактора (особенно заметно в развёрнутом доке),
// поэтому такие изменения всегда показываем одной колонкой.
const oneSidedDiff = computed(() => ['A', 'D'].includes(gitFile.value?.status));
const fullSide = ref(localStorage.getItem('cockpit-diff-side') !== '0');
const compactSide = ref(localStorage.getItem('cockpit-dock-diff-side') === '1');
const side = computed({
  get: () => (props.compact ? compactSide.value : fullSide.value),
  set: (value) => {
    if (props.compact) {
      compactSide.value = !!value;
      localStorage.setItem('cockpit-dock-diff-side', value ? '1' : '0');
    } else {
      fullSide.value = !!value;
      localStorage.setItem('cockpit-diff-side', value ? '1' : '0');
    }
  },
});
const renderSideBySide = computed(() => side.value && !oneSidedDiff.value);
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
const panelHeader = ref(null);
const layHost = ref(null);
let fileEditor = null;
let diffEditor = null;
let fileModel = null;
let diffModels = [];

// Generation защищает весь контекст, request ID — конкурирующие запросы внутри него.
let contextGeneration = 0;
let reposRequestId = 0;
let fileRequestId = 0;
let gitRequestId = 0;
let fileLoadingRequestId = 0;
let gitLoadingRequestId = 0;
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
const activationIsCurrent = (id) => id == null || id === activationId;
const q = (snapshot) => `repo=${encodeURIComponent(snapshot.repoKey)}&root=${encodeURIComponent(snapshot.treePath)}`;

const NAVIGATOR_MIN_WIDTH = 140;
const NAVIGATOR_MAX_WIDTH = 420;
const navigatorMaxWidth = ref(NAVIGATOR_MAX_WIDTH);
const clampNavigatorWidth = (value, max = navigatorMaxWidth.value) => {
  const parsed = value === null || value === '' ? NaN : Number(value);
  return Math.min(
    Math.max(NAVIGATOR_MIN_WIDTH, max),
    Math.max(NAVIGATOR_MIN_WIDTH, Number.isFinite(parsed) ? parsed : 260),
  );
};
// Храним желаемую ширину отдельно от текущего viewport-clamp. При временном
// сужении дока дерево ужимается, а после разворачивания возвращается к выбору
// человека, если он сам не двигал разделитель в узком состоянии.
const navigatorPreferredWidth = ref(clampNavigatorWidth(
  localStorage.getItem('cockpit-code-dock-nav-width'),
  NAVIGATOR_MAX_WIDTH,
));
const navigatorWidth = computed(() => clampNavigatorWidth(navigatorPreferredWidth.value));
const navigatorCollapsed = ref(false);
const compactStyle = computed(() => ({ '--code-nav-width': `${navigatorWidth.value}px` }));
let navigatorPointer = null;
let navigatorObserver = null;

function measureNavigatorWidth() {
  const width = layHost.value?.getBoundingClientRect?.().width;
  if (!(width > 0)) return;
  const nextMax = Math.min(
    NAVIGATOR_MAX_WIDTH,
    Math.max(NAVIGATOR_MIN_WIDTH, Math.floor(width * 0.42)),
  );
  if (nextMax === navigatorMaxWidth.value) return;
  navigatorMaxWidth.value = nextMax;
  layoutEditors();
}

function updateNavigatorWidth(clientX) {
  const rect = layHost.value?.getBoundingClientRect?.();
  if (!rect?.width) return;
  navigatorPreferredWidth.value = clampNavigatorWidth(clientX - rect.left - 44);
  layoutEditors();
}
function startNavigatorResize(event) {
  if (event.button !== undefined && event.button !== 0) return;
  navigatorPointer = event.pointerId;
  event.currentTarget?.setPointerCapture?.(event.pointerId);
  updateNavigatorWidth(event.clientX);
}
function moveNavigatorResize(event) {
  if (navigatorPointer !== event.pointerId) return;
  updateNavigatorWidth(event.clientX);
}
function finishNavigatorResize(event) {
  if (navigatorPointer !== event.pointerId) return;
  navigatorPointer = null;
  event.currentTarget?.releasePointerCapture?.(event.pointerId);
  localStorage.setItem('cockpit-code-dock-nav-width', String(Math.round(navigatorWidth.value)));
}
function navigatorResizeKey(event) {
  const step = event.shiftKey ? 64 : 16;
  if (event.key === 'ArrowLeft') navigatorPreferredWidth.value = clampNavigatorWidth(navigatorWidth.value - step);
  else if (event.key === 'ArrowRight') navigatorPreferredWidth.value = clampNavigatorWidth(navigatorWidth.value + step);
  else if (event.key === 'Home') navigatorPreferredWidth.value = NAVIGATOR_MIN_WIDTH;
  else if (event.key === 'End') navigatorPreferredWidth.value = navigatorMaxWidth.value;
  else return;
  event.preventDefault();
  localStorage.setItem('cockpit-code-dock-nav-width', String(navigatorWidth.value));
  nextTick(layoutEditors);
}

function layoutEditors() {
  fileEditor?.layout?.();
  diffEditor?.layout?.();
}

watch(layHost, (host) => {
  navigatorObserver?.disconnect?.();
  navigatorObserver = null;
  if (!host) return;
  if (typeof ResizeObserver !== 'undefined') {
    navigatorObserver = new ResizeObserver(measureNavigatorWidth);
    navigatorObserver.observe(host);
  }
  nextTick(measureNavigatorWidth);
}, { flush: 'post' });

function focusPanel() { panelHeader.value?.focus?.(); }
defineExpose({ focus: focusPanel });

// Переходы — явными обработчиками, без каскадов watch: порядок загрузки детерминирован.
async function setProject(id, { activation = null } = {}) {
  if (!activationIsCurrent(activation)) return;
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
    if (activationIsCurrent(activation) && projectIsCurrent(generation, id, requestId)) {
      error.value = e.message;
      contextLoading.value = false;
    }
    return;
  }
  if (!activationIsCurrent(activation) || !projectIsCurrent(generation, id, requestId)) return;
  repos.value = loadedRepos;
  const picked = pickCodeContext(contexts.value, localStorage.getItem(contextStorageKey(id)));
  if (!picked) {
    contextLoading.value = false;
    return;
  }
  await setContext(picked.id, { activation });
}

async function setContext(id, { activation = null } = {}) {
  if (!activationIsCurrent(activation)) return;
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
  const rootLoaded = await loadDir('', snapshot, { activation });
  if (rootLoaded && activationIsCurrent(activation)
      && contextIsCurrent(snapshot) && tab.value === 'git') {
    await loadGit(snapshot, { activation });
  }
  if (activationIsCurrent(activation)
      && generation === contextGeneration && contextIsCurrent(snapshot)) {
    contextLoading.value = false;
  }
}

function resetState() {
  dirs.value = new Map(); openDirs.value = new Set();
  fileSel.value = ''; fileData.value = null;
  git.value = null; gitSel.value = '';
  gitOpenDirs.value = new Set(); gitKnownDirs.value = new Set(); gitDirsReady.value = false;
  fileLoading.value = false; gitLoading.value = false;
  fileLoadingRequestId = 0; gitLoadingRequestId = 0;
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

function toggleDiffLayout() {
  if (!oneSidedDiff.value) side.value = !side.value;
}

function toggleGitDir(path) {
  const open = new Set(gitOpenDirs.value);
  if (open.has(path)) open.delete(path);
  else open.add(path);
  gitOpenDirs.value = open;
}

async function loadDir(rel, snapshot = captureContext(), { activation = null } = {}) {
  const requestId = (dirRequestIds.get(rel) || 0) + 1;
  dirRequestIds.set(rel, requestId);
  try {
    const { entries } = await api.get(
      `/api/code/${encodeURIComponent(snapshot.project)}/ls?${q(snapshot)}${rel ? `&dir=${encodeURIComponent(rel)}` : ''}`,
    );
    if (!activationIsCurrent(activation)
        || !contextIsCurrent(snapshot) || dirRequestIds.get(rel) !== requestId) return false;
    const next = new Map(dirs.value);
    next.set(rel, entries || []);
    dirs.value = next;
    return true;
  } catch (e) {
    if (activationIsCurrent(activation)
        && contextIsCurrent(snapshot) && dirRequestIds.get(rel) === requestId) {
      error.value = e.message;
    }
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

async function openFile(rel, { silent = false, activation = null } = {}) {
  if (!activationIsCurrent(activation)) return;
  const snapshot = captureContext();
  const requestId = ++fileRequestId;
  fileSel.value = rel;
  if (!silent) {
    fileLoadingRequestId = requestId;
    fileLoading.value = true;
  }
  try {
    const data = await api.get(
      `/api/code/${encodeURIComponent(snapshot.project)}/file?${q(snapshot)}&path=${encodeURIComponent(rel)}`,
    );
    if (!activationIsCurrent(activation)
        || !contextIsCurrent(snapshot) || fileRequestId !== requestId || fileSel.value !== rel) return;
    fileData.value = data;
    await nextTick();
    if (activationIsCurrent(activation)
        && contextIsCurrent(snapshot) && fileRequestId === requestId && fileSel.value === rel) {
      showFile(rel, data);
    }
    return true;
  } catch (e) {
    const current = activationIsCurrent(activation)
      && contextIsCurrent(snapshot) && fileRequestId === requestId && fileSel.value === rel;
    if (!current) return;
    error.value = e.message;
    // Только 404 подтверждает, что прежний файл больше нельзя показывать. При
    // сетевой/серверной ошибке последний валидный снимок остаётся на месте.
    return e?.status === 404 ? false : null;
  } finally {
    // Владелец индикатора отделён от latest request: тихая revalidation может
    // вытеснить запрос по id, но не должна навсегда оставить «читаю…».
    if (!silent && fileLoadingRequestId === requestId) {
      fileLoadingRequestId = 0;
      fileLoading.value = false;
    }
  }
}

async function loadGit(snapshot = captureContext(), { silent = false, activation = null } = {}) {
  if (!activationIsCurrent(activation)) return;
  const requestId = ++gitRequestId;
  if (!silent) {
    gitLoadingRequestId = requestId;
    gitLoading.value = true;
  }
  try {
    const data = await api.get(`/api/code/${encodeURIComponent(snapshot.project)}/git?${q(snapshot)}`);
    if (!activationIsCurrent(activation)
        || !contextIsCurrent(snapshot) || gitRequestId !== requestId) return;
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
    if (!activationIsCurrent(activation)
        || !contextIsCurrent(snapshot) || gitRequestId !== requestId) return;
    if (gitFile.value) showDiff(gitFile.value);
    else clearDiffModels();
  } catch (e) {
    if (activationIsCurrent(activation)
        && contextIsCurrent(snapshot) && gitRequestId === requestId) error.value = e.message;
  } finally {
    if (!silent && gitLoadingRequestId === requestId) {
      gitLoadingRequestId = 0;
      gitLoading.value = false;
    }
  }
}

async function selectGit(p) {
  const snapshot = captureContext();
  gitSel.value = p;
  await nextTick();
  if (contextIsCurrent(snapshot) && gitSel.value === p) showDiff(gitFile.value);
}

async function refresh({ silent = false, activation = null } = {}) {
  if (!treePath.value) return;
  const snapshot = captureContext();
  if (tab.value === 'git') {
    if (!silent || !gitLoading.value) await loadGit(snapshot, { silent, activation });
    return;
  }
  // Файлы перечитываем поверх последнего валидного снимка. Очищение до ответа
  // давало заметный белый кадр при повторном открытии панели.
  const open = [...openDirs.value];
  const selected = fileSel.value;
  if (!(await loadDir('', snapshot, { activation }))
      || !activationIsCurrent(activation) || !contextIsCurrent(snapshot)) return;
  for (const rel of open) {
    await loadDir(rel, snapshot, { activation });
    if (!activationIsCurrent(activation) || !contextIsCurrent(snapshot)) return;
  }
  if (silent && fileLoading.value) return;
  const fileResult = selected && fileSel.value === selected
    ? await openFile(selected, { silent, activation })
    : undefined;
  if (fileResult === false && activationIsCurrent(activation)
      && contextIsCurrent(snapshot) && fileSel.value === selected) {
    fileSel.value = '';
    fileData.value = null;
    clearFileModel();
  }
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
      renderSideBySide: renderSideBySide.value,
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

watch(renderSideBySide, async (value) => {
  diffEditor?.updateOptions?.({ renderSideBySide: value });
  await nextTick();
  layoutEditors();
});
watch(() => props.compact, async () => {
  await nextTick();
  diffEditor?.updateOptions?.({ renderSideBySide: renderSideBySide.value });
  layoutEditors();
});

let initialized = false;
let activationId = 0;
let processingIntents = false;
const handledIntentIds = new Set();

function unhandledIntents() {
  const current = new Set(props.intents.map((intent) => intent.id));
  for (const id of handledIntentIds) {
    if (!current.has(id)) handledIntentIds.delete(id);
  }
  return props.intents.filter((intent) => !handledIntentIds.has(intent.id));
}

async function revalidateProject(previous, own) {
  const generation = contextGeneration;
  const id = project.value;
  const requestId = ++reposRequestId;
  error.value = '';

  // Список проектов уже перечитан и подтвердил, что у текущего проекта больше
  // нет репозиториев. Только здесь старый снимок действительно стал невалиден.
  if (!projectHasRepos.value) {
    if (own === activationId && projectIsCurrent(generation, id, requestId)) {
      contextGeneration += 1;
      repos.value = [];
      repoKey.value = '';
      treePath.value = '';
      contextId.value = '';
      resetState();
      contextLoading.value = false;
    }
    return;
  }

  let loadedRepos;
  try {
    loadedRepos = (await api.get(`/api/code/${encodeURIComponent(id)}/repos`)).repos || [];
  } catch (e) {
    if (own === activationId && projectIsCurrent(generation, id, requestId)) {
      error.value = e.message;
      contextLoading.value = false;
    }
    return;
  }
  if (own !== activationId || !projectIsCurrent(generation, id, requestId)) return;

  const nextContexts = buildCodeContexts(loadedRepos).contexts;
  const picked = nextContexts.find((item) => item.id === previous.contextId)
    || pickCodeContext(nextContexts, localStorage.getItem(contextStorageKey(id)));
  repos.value = loadedRepos;

  if (!picked) {
    contextGeneration += 1;
    repoKey.value = '';
    treePath.value = '';
    contextId.value = '';
    resetState();
    contextLoading.value = false;
    return;
  }
  if (picked.id !== previous.contextId || contextId.value !== previous.contextId) {
    await setContext(picked.id, { activation: own });
    return;
  }

  // Тот же контекст обновляется без resetState(): дерево, выбранный файл и
  // Monaco остаются на экране до атомарной подмены свежими ответами.
  await refresh({ silent: true, activation: own });
  if (own === activationId && projectIsCurrent(generation, id, requestId)) {
    contextLoading.value = false;
  }
}

async function activate({ preserve = false } = {}) {
  const own = ++activationId;
  const previous = preserve ? {
    generation: contextGeneration,
    project: project.value,
    contextId: contextId.value,
    tab: tab.value,
    file: fileSel.value,
    gitFile: gitSel.value,
  } : null;
  if (!initialized) loading.value = true;
  try {
    const loaded = (await api.get('/api/projects')).projects || [];
    if (own !== activationId) return;
    // Пока фоновый запрос летел, человек мог выбрать другой проект/worktree.
    // Такой ответ больше не имеет права возвращать интерфейс к старому снимку.
    if (previous && (previous.generation !== contextGeneration
        || previous.project !== project.value || previous.contextId !== contextId.value)) return;
    projects.value = loaded;
    const withRepos = projects.value.filter((item) => (item.repos || []).length);
    const wanted = previous?.project || localStorage.getItem('cockpit-project') || '';
    const pick = withRepos.find((item) => item.id === wanted) || withRepos[0] || projects.value[0];
    let revalidatedInPlace = false;
    if (pick && preserve && previous?.project === pick.id && project.value === pick.id) {
      revalidatedInPlace = true;
      await revalidateProject(previous, own);
    } else if (pick) {
      await setProject(pick.id, { activation: own });
    } else {
      contextGeneration += 1;
      project.value = '';
      repos.value = [];
      repoKey.value = '';
      treePath.value = '';
      contextId.value = '';
      resetState();
    }
    if (own !== activationId) return;
    // Файл/диф относится к точной рабочей копии. Если project или context исчез,
    // не переносим старый путь в случайный fallback-репозиторий.
    const sameContext = !revalidatedInPlace && previous?.project === project.value
      && previous?.contextId === contextId.value;
    if (sameContext && previous.tab === 'git') {
      await setTab('git');
      if (previous.gitFile && git.value?.files.some((item) => item.path === previous.gitFile)) {
        await selectGit(previous.gitFile);
      }
    } else if (sameContext && previous?.file) {
      // Повторное открытие проверяет файл сервером. Если он исчез, старое превью
      // не остаётся висеть под новым деревом.
      if ((await openFile(previous.file, { activation: own })) === false) {
        fileSel.value = '';
        fileData.value = null;
        clearFileModel();
      }
    }
    initialized = true;
  } catch (e) {
    if (own === activationId) error.value = e.message;
  } finally {
    if (own === activationId) loading.value = false;
  }
  await processIntents();
  await nextTick();
  layoutEditors();
}

async function processIntents() {
  const pending = unhandledIntents();
  if (!props.active || !initialized || loading.value || processingIntents || !pending.length) return;
  processingIntents = true;
  try {
    for (const intent of pending) {
      if (intent.type === 'project' && intent.project && project.value !== intent.project) {
        const target = projects.value.find((item) => item.id === intent.project);
        if (target) await setProject(target.id);
      }
      handledIntentIds.add(intent.id);
      emit('consume-intent', intent.id);
    }
  } finally {
    processingIntents = false;
    // Intent мог приехать, пока выполнялся предыдущий setProject. Его watcher уже
    // сработал и увидел processing=true, поэтому явно продолжаем очередь.
    if (props.active && unhandledIntents().length) queueMicrotask(processIntents);
  }
}

watch(() => props.active, (active, wasActive) => {
  if (active) activate({ preserve: initialized && wasActive === false });
  else activationId += 1;
}, { immediate: true });
watch(() => props.intents, processIntents, { deep: true });
watch(
  [() => props.active, () => props.presentation, project, contextId, tab, fileSel],
  ([active, presentation]) => emit('context', active ? {
    id: 'code',
    presentation,
    ...(project.value ? { project: project.value } : {}),
    ...(context.value?.label ? { context: context.value.label } : {}),
    tab: tab.value,
    ...(fileSel.value ? { file: fileSel.value } : {}),
  } : null),
  { immediate: true },
);
onBeforeUnmount(() => {
  activationId += 1;
  navigatorObserver?.disconnect?.();
  emit('context', null);
  clearFileModel(); clearDiffModels();
  fileEditor?.dispose(); diffEditor?.dispose();
});
</script>

<template>
  <div class="code-panel" :class="{ compact }" :aria-busy="loading ? 'true' : undefined">
    <header ref="panelHeader" class="code-head" tabindex="-1">
      <strong>Код</strong>
      <span v-if="context" class="tlabel mono">{{ project }} · {{ context.label }}</span>
      <span class="grow"></span>
      <button v-if="compact" type="button" class="act navigator-toggle"
              :class="{ on: !navigatorCollapsed }"
              :aria-expanded="!navigatorCollapsed"
              :title="navigatorCollapsed ? 'Показать дерево' : 'Скрыть дерево'"
              @click="navigatorCollapsed = !navigatorCollapsed">
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"
             stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="2.5" y="3" width="15" height="14" rx="2" />
          <path d="M7 3v14" />
        </svg>
        <span>Дерево</span>
      </button>
    </header>

    <!-- Холодный запуск сразу занимает финальную сетку. Без этого сначала был
         короткий пустой экран «Загрузка…», а затем вся рабочая область прыгала. -->
    <div v-if="loading" ref="layHost" class="lay code-loading"
         :class="{ compact, 'navigator-collapsed': navigatorCollapsed }"
         :style="compactStyle">
      <aside class="rail" aria-hidden="true">
        <span class="loading-rail-item"></span>
        <span class="loading-rail-item"></span>
      </aside>
      <aside class="panel loading-panel" aria-hidden="true">
        <div class="loading-selects">
          <span class="loading-caption"></span><span class="loading-field"></span>
          <span class="loading-caption short"></span><span class="loading-field"></span>
        </div>
        <div class="loading-tree">
          <span v-for="index in 7" :key="index" class="loading-row"
                :style="{ '--loading-row': `${48 + ((index * 17) % 38)}%` }"></span>
        </div>
      </aside>
      <div v-if="compact && !navigatorCollapsed" class="code-split loading-split" aria-hidden="true">
        <span></span>
      </div>
      <section class="editorwrap loading-editor" aria-hidden="true">
        <div class="ehead"><span class="loading-path"></span></div>
        <div class="ebody"><span class="loading-status">Загрузка кода…</span></div>
      </section>
    </div>
    <div v-else-if="!projects.length" class="empty">
      Проектов пока нет — заведи в разделе <router-link to="/projects">«Проекты»</router-link>.
    </div>

    <div v-else ref="layHost" class="lay" :class="{ compact, 'navigator-collapsed': navigatorCollapsed }"
         :style="compactStyle">
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

      <div v-if="compact && !navigatorCollapsed" class="code-split" role="separator"
           aria-orientation="vertical" tabindex="0"
           :aria-valuemin="NAVIGATOR_MIN_WIDTH" :aria-valuemax="Math.round(navigatorMaxWidth)"
           :aria-valuenow="Math.round(navigatorWidth)"
           @pointerdown.prevent="startNavigatorResize" @pointermove.prevent="moveNavigatorResize"
           @pointerup.prevent="finishNavigatorResize" @pointercancel.prevent="finishNavigatorResize"
           @keydown="navigatorResizeKey">
        <span aria-hidden="true"></span>
      </div>

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
          <button v-if="tab === 'git'" class="act" :class="{ on: renderSideBySide }"
                  :aria-disabled="oneSidedDiff"
                  :title="oneSidedDiff ? 'Новый или удалённый файл показывается одной колонкой' : (renderSideBySide ? 'Показать в одну колонку' : 'Показать рядом')"
                  @click="toggleDiffLayout">
            {{ oneSidedDiff ? '≡ одна колонка' : (renderSideBySide ? '⇆ рядом' : '≡ в строку') }}
          </button>
          <button class="act" :disabled="gitLoading || fileLoading" title="Обновить" @click="refresh">↻</button>
        </div>
        <div class="ebody" data-escape-owner="monaco">
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
.code-panel { height: 100%; min-width: 0; display: flex; flex-direction: column; min-height: 0; }
.code-head {
  min-width: 0; min-height: 36px; display: flex; align-items: center; gap: 10px;
  padding: 0 4px 8px; color: var(--ink); outline: none;
}
.code-head strong { flex: none; font-size: 13px; font-weight: 650; }
.code-head:focus-visible { outline: 2px solid color-mix(in srgb, var(--accent) 45%, transparent); outline-offset: 2px; }
.tlabel { font-size: 12px; color: var(--ink-mid); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.empty { color: var(--ink-mid); padding: 40px 0; text-align: center; }
.empty a, .pnote a { color: var(--accent); }

.lay { flex: 1; min-width: 0; min-height: 0; display: grid; grid-template-columns: 44px 300px minmax(0, 1fr);
  border: 1px solid var(--line); border-radius: 12px; overflow: hidden; background: var(--surface); }

/* В доке и на route-only планшете дерево остаётся слева, как на полной странице.
   Верхняя граница clamp не отдаёт навигатору больше 42% узкой рабочей области. */
.lay.compact {
  grid-template-columns: 44px minmax(0, min(var(--code-nav-width, 260px), 42%)) 8px minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr);
  border: 0; border-radius: 0;
}
.lay.compact .rail { grid-column: 1; grid-row: 1; }
.lay.compact .panel {
  grid-column: 2; grid-row: 1; min-width: 0; border-right: 0;
}
.lay.compact .editorwrap { grid-column: 4; grid-row: 1; }
.lay.compact.navigator-collapsed { grid-template-columns: 44px 0 0 minmax(0, 1fr); }
.lay.compact.navigator-collapsed .panel { display: none; }
.code-loading { user-select: none; }
.loading-rail-item { width: 34px; height: 34px; border-radius: 8px; background: var(--surface-2); }
.loading-panel { gap: 0; }
.loading-selects { display: grid; gap: 5px; padding: 11px 10px 10px; border-bottom: 1px solid var(--line); }
.loading-caption { width: 38%; height: 7px; border-radius: 999px; background: var(--line); }
.loading-caption.short { width: 30%; margin-top: 3px; }
.loading-field { width: 100%; height: 29px; border-radius: 8px; background: var(--surface-2);
  border: 1px solid var(--line); }
.loading-tree { display: flex; flex-direction: column; gap: 11px; padding: 15px 17px; }
.loading-row { width: var(--loading-row); height: 8px; border-radius: 999px; background: var(--line); opacity: .78; }
.loading-editor .ehead { min-height: 37px; }
.loading-path { width: min(42%, 260px); height: 8px; border-radius: 999px; background: var(--line); }
.loading-editor .ebody { display: grid; place-items: center; background: #0a0c10; }
.loading-status { color: var(--ink-mid); font-size: 12px; }
.loading-split { pointer-events: none; }
.code-split {
  grid-column: 3; grid-row: 1; position: relative; cursor: col-resize; touch-action: none;
  display: grid; place-items: center; background: var(--sidebar); border-right: 1px solid var(--line);
}
.code-split span { width: 2px; height: 34px; border-radius: 999px; background: var(--line-2); }
.code-split:hover span, .code-split:focus-visible span { background: var(--accent); }
.code-split:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.navigator-toggle {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  height: var(--tool-dock-action-size, 30px);
  padding-block: 0; padding-inline: 8px; line-height: 1;
}
.navigator-toggle svg { width: 14px; height: 14px; }
.code-panel.compact .code-head {
  min-height: 40px;
  padding: var(--tool-dock-action-top, 4px) var(--tool-dock-actions-space, 4px) 5px 11px;
  border-bottom: 1px solid var(--line); background: var(--topbar);
}
.code-panel.compact .code-head strong { font-size: 12.5px; letter-spacing: .01em; }

/* Рейка режимов */
.rail { display: flex; flex-direction: column; gap: 2px; padding: 8px 0; align-items: center;
  background: var(--sidebar); border-right: 1px solid var(--line); }
.ritem { background: none; border: none; color: var(--ink-mid); width: 34px; height: 34px; border-radius: 8px;
  display: grid; place-items: center; cursor: pointer; }
.ritem:hover { background: var(--surface); color: var(--ink); }
.ritem.on { color: var(--accent); background: color-mix(in srgb, var(--accent) 14%, transparent); }
.ic { width: 19px; height: 19px; }

/* Панель */
.panel { display: flex; flex-direction: column; min-width: 0; min-height: 0; border-right: 1px solid var(--line); background: var(--sidebar); }
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
.scroll { flex: 1; min-width: 0; overflow: auto; padding: 6px 8px; }

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
.act[aria-disabled="true"] { opacity: .65; cursor: default; color: var(--ink-mid); }

/* Full-page на небольшом десктопе: компактный режим задаёт ToolHost явно. */
@media (min-width: 900px) and (max-width: 1099px) {
  .lay:not(.compact) { grid-template-columns: 44px 250px minmax(0, 1fr); }
}
</style>
