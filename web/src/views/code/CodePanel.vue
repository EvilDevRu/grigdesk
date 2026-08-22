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
  buildGitGroups,
  encodeStoredCodeContext,
  gitGroupDirectoryPaths,
  gitRef,
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
const git = ref(null);           // { branch, files, staged, log }
const gitLoading = ref(false);
// Выбор адресуется парой «группа:путь»: один и тот же файл законно лежит и в индексе,
// и в рабочем дереве, и дифы у них разные.
const gitSel = ref('');
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
// Группы изменений, как Source Control в VS Code: индекс и рабочее дерево. Пустая
// группа не рисуется, поэтому при чистом индексе панель выглядит ровно как раньше.
const gitGroups = computed(() => buildGitGroups(git.value, gitOpenDirs.value));
const gitEntries = computed(() => {
  const map = new Map();
  for (const group of gitGroups.value) {
    for (const file of group.files) map.set(gitRef(group.id, file.path), { file, group });
  }
  return map;
});
const gitEntry = computed(() => gitEntries.value.get(gitSel.value) || null);
const gitFile = computed(() => gitEntry.value?.file || null);
const STLABEL = { A: 'A', M: 'M', D: 'D', R: 'R' };
// Шаг лесенки дерева задаётся в CSS (`--tree-step`), сюда приезжает только глубина:
// иначе два числа — px в скрипте и отступ шеврона в стилях — разъезжаются при правке.
function rowDepth(depth) { return { '--depth': depth }; }

/** Первый файл первой непустой группы: индекс важнее рабочего дерева. */
function firstGitRef() {
  for (const group of gitGroups.value) {
    if (group.files.length) return gitRef(group.id, group.files[0].path);
  }
  return '';
}

// Чей это диф, показываем только когда групп больше одной: при пустом индексе
// вариант ровно один, и подпись была бы шумом.
const gitScopeBadge = computed(() => {
  if (gitGroups.value.length < 2 || !gitEntry.value) return null;
  return gitEntry.value.group.id === 'staged'
    ? { label: 'в индексе', hint: 'слева HEAD, справа индекс — это уедет в коммит' }
    : { label: 'в рабочем дереве', hint: 'слева индекс, справа рабочее дерево — в коммит пока не попадёт' };
});

// ── Monaco: оба редактора живут под v-show, но модели очищаются при смене контекста. ──
const fileHost = ref(null);
const diffHost = ref(null);
const panelHeader = ref(null);
const layHost = ref(null);
let fileEditor = null;
let diffEditor = null;
let fileModel = null;
let diffModels = [];
// Строка, на которую надо встать, когда модель уже создана: intent приходит раньше
// ответа сервера, а Monaco умеет прокручивать только существующую модель.
let pendingReveal = null;

// Generation защищает весь контекст, request ID — конкурирующие запросы внутри него.
let contextGeneration = 0;
let reposRequestId = 0;
let fileRequestId = 0;
let gitRequestId = 0;
let fileLoadingRequestId = 0;
let gitLoadingRequestId = 0;
const dirRequestIds = new Map();

// Растровые картинки показываются предпросмотром вместо пустого Monaco: сырые байты
// отдаёт `/api/code/:project/raw`. Набор обязан совпадать с RAW_IMAGE_TYPES сервера
// (сторож — tests/server/code-raw.test.js); SVG исключён намеренно, как у документов.
const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp|bmp|ico)$/i;
const isImagePath = (rel) => IMAGE_EXT.test(String(rel || ''));
const imageSrc = computed(() => (fileSel.value && isImagePath(fileSel.value) && context.value
  ? api.url(`/api/code/${encodeURIComponent(project.value)}/raw?${q(captureContext())}&path=${encodeURIComponent(fileSel.value)}`)
  : ''));
const imageError = ref('');
// Бинарность у картинки — норма, а не диагноз: пометку «бинарный» показываем только
// тем файлам, которые действительно нечем показать.
const showsImage = computed(() => !!imageSrc.value && !imageError.value);

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
  fileSel.value = ''; fileData.value = null; imageError.value = '';
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

function toggleGitDir(ref) {
  const open = new Set(gitOpenDirs.value);
  if (open.has(ref)) open.delete(ref);
  else open.add(ref);
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

async function openFile(rel, { silent = false, activation = null } = {}) {
  if (!activationIsCurrent(activation)) return;
  const snapshot = captureContext();
  const requestId = ++fileRequestId;
  fileSel.value = rel;
  imageError.value = '';
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
      staged: Array.isArray(data?.staged) ? data.staged : [],
      log: Array.isArray(data?.log) ? data.log : [],
    };
    const nextDirs = gitGroupDirectoryPaths(nextGit);
    gitOpenDirs.value = reconcileGitOpenDirs(
      nextDirs,
      gitDirsReady.value ? gitOpenDirs.value : null,
      gitDirsReady.value ? gitKnownDirs.value : null,
    );
    gitKnownDirs.value = nextDirs;
    gitDirsReady.value = true;
    git.value = nextGit;
    if (gitSel.value && !gitEntries.value.has(gitSel.value)) gitSel.value = '';
    if (!gitSel.value) gitSel.value = firstGitRef();
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

async function selectGit(ref) {
  const snapshot = captureContext();
  gitSel.value = ref;
  await nextTick();
  if (contextIsCurrent(snapshot) && gitSel.value === ref) showDiff(gitFile.value);
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
  // Картинку показывает <img>, а не редактор: пустая модель Monaco под ней только
  // мигала бы курсором и держала ресурсы.
  if (isImagePath(rel)) { clearFileModel(); return; }
  if (!fileHost.value || !data) return;
  if (!fileEditor) fileEditor = monaco.editor.create(fileHost.value, { ...READONLY_OPTS, renderLineHighlight: 'none' });
  const model = monaco.editor.createModel(data.binary || data.tooBig ? '' : data.content, langOf(rel));
  fileEditor.setModel(model);
  fileModel?.dispose(); // старую модель снимаем ПОСЛЕ переустановки (иначе варнинг Monaco)
  fileModel = model;
  if (pendingReveal && pendingReveal.path === rel) {
    revealLine(pendingReveal.line);
    pendingReveal = null;
  }
}

/** Ссылка вида `file.js:120` открывает файл на нужной строке и подсвечивает её. */
function revealLine(line) {
  if (!fileEditor || !(line > 0)) return;
  fileEditor.revealLineInCenter(line);
  fileEditor.setPosition({ lineNumber: line, column: 1 });
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
      if (previous.gitFile && gitEntries.value.has(previous.gitFile)) {
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

/**
 * Открывает точный файл по intent из чата или deep-link: проект → рабочая копия →
 * раскрытие каталогов пути → сам файл. Цель адресуется репозиторием и корнем дерева,
 * а не «текущим выбором»: ссылка на worktree задачи не должна открыть одноимённый
 * файл основного дерева.
 */
async function openIntentFile(intent) {
  const wantRepo = String(intent.repo || '');
  const wantRoot = String(intent.root || '');
  const rel = String(intent.path || '');
  if (!wantRepo || !wantRoot || !rel) return;

  if (intent.project && project.value !== intent.project) {
    if (!projects.value.some((item) => item.id === intent.project)) {
      error.value = `Проект «${intent.project}» недоступен в разделе «Код»`;
      return;
    }
    await setProject(intent.project);
    if (project.value !== intent.project) return;
  }
  const target = contexts.value.find((item) => item.repoKey === wantRepo && item.treePath === wantRoot);
  if (!target) {
    error.value = `Рабочая копия ${wantRoot} недоступна — проверь пути в разделе «Проекты»`;
    return;
  }
  if (contextId.value !== target.id) {
    await setContext(target.id);
    if (contextId.value !== target.id) return;
  }
  if (tab.value !== 'files') tab.value = 'files';

  // Каталоги раскрываем по одному сверху вниз: дерево ленивое, и без этого файл
  // открылся бы в редакторе, но не подсветился бы в навигаторе.
  const snapshot = captureContext();
  const segments = rel.split('/').slice(0, -1);
  let prefix = '';
  const open = new Set(openDirs.value);
  for (const segment of segments) {
    prefix = prefix ? `${prefix}/${segment}` : segment;
    if (!dirs.value.has(prefix) && !(await loadDir(prefix, snapshot))) break;
    if (!contextIsCurrent(snapshot)) return;
    open.add(prefix);
  }
  openDirs.value = open;
  pendingReveal = intent.line > 0 ? { path: rel, line: Number(intent.line) } : null;
  if ((await openFile(rel)) === false) {
    pendingReveal = null;
    error.value = `${rel}: файл не найден в этой рабочей копии`;
  }
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
      } else if (intent.type === 'open-file') {
        await openIntentFile(intent);
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

        <!-- Дерево файлов. Место под шеврон занято и у файла (пустой .chev): без него
             имя файла уезжало влево на ширину стрелки и вставало вровень с каталогом
             уровнем выше — лесенка читалась рваной. -->
        <div v-if="tab === 'files'" class="scroll tree">
          <template v-for="row in rows" :key="row.rel">
            <button v-if="row.dir" type="button" class="trow dir" :data-dir-path="row.rel"
                    :data-depth="row.depth"
                    :aria-expanded="openDirs.has(row.rel)" :style="rowDepth(row.depth)"
                    @click="toggleDir(row.rel)">
              <span class="chev">{{ openDirs.has(row.rel) ? '▾' : '▸' }}</span>
              <span class="dname">{{ row.name }}</span>
            </button>
            <button v-else type="button" class="trow frow" :class="{ sel: fileSel === row.rel }"
                    :data-file-path="row.rel" :data-depth="row.depth"
                    :style="rowDepth(row.depth)" @click="openFile(row.rel)">
              <span class="chev" aria-hidden="true"></span>
              <span class="nm">{{ row.name }}</span>
            </button>
          </template>
        </div>

        <!-- Гит: изменения группами (индекс, рабочее дерево) + свежие коммиты.
             Группа с пустым индексом не рисуется вовсе, поэтому обычный прогон
             фабрики выглядит как раньше — одним списком «Не в коммите». -->
        <div v-else class="scroll tree">
          <div v-if="gitLoading && !git" class="pnote">Читаю гит…</div>
          <template v-if="git">
            <template v-for="(group, groupIndex) in gitGroups" :key="group.id">
              <div class="subhead" :data-group="group.id">
                <span :title="group.hint">{{ group.title }}</span>
                <span v-if="group.files.length" class="cnt mono">{{ group.files.length }}</span>
                <span class="grow"></span>
                <!-- Переключатель вида один на панель: он про способ показа, а не про группу. -->
                <div v-if="groupIndex === 0" class="git-view-toggle" role="group" aria-label="Вид изменений">
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
              <div v-if="!group.files.length" class="pnote">Несохранённых изменений нет.</div>
              <template v-else-if="gitView === 'tree'">
                <template v-for="row in group.rows" :key="row.key">
                  <button v-if="row.kind === 'dir'" type="button" class="trow dir git-row git-dir"
                          :data-path="row.path" :data-group="group.id" :data-depth="row.depth"
                          :aria-expanded="gitOpenDirs.has(row.ref)"
                          :style="rowDepth(row.depth)" @click="toggleGitDir(row.ref)">
                    <span class="chev">{{ gitOpenDirs.has(row.ref) ? '▾' : '▸' }}</span>
                    <span class="dname" :title="row.path">{{ row.name }}</span>
                  </button>
                  <button v-else type="button" class="trow frow git-row git-file"
                          :class="{ sel: gitSel === row.ref }" :data-path="row.path"
                          :data-group="group.id" :data-depth="row.depth"
                          :style="rowDepth(row.depth)" @click="selectGit(row.ref)">
                    <span class="chev" aria-hidden="true"></span>
                    <span class="st" :class="row.file.status">{{ STLABEL[row.file.status] || row.file.status }}</span>
                    <span class="nm mono" :title="row.path">{{ row.name }}</span>
                    <span class="cnt mono"><i v-if="row.file.add" class="a">+{{ row.file.add }}</i><i v-if="row.file.del" class="d">−{{ row.file.del }}</i></span>
                  </button>
                </template>
              </template>
              <template v-else>
                <button v-for="f in group.files" :key="`${group.id}:file:${f.path}`" type="button"
                        class="trow frow git-row git-file" :class="{ sel: gitSel === gitRef(group.id, f.path) }"
                        :data-path="f.path" :data-group="group.id"
                        @click="selectGit(gitRef(group.id, f.path))">
                  <span class="st" :class="f.status">{{ STLABEL[f.status] || f.status }}</span>
                  <span class="nm mono" :title="f.path">{{ f.path }}</span>
                  <span class="cnt mono"><i v-if="f.add" class="a">+{{ f.add }}</i><i v-if="f.del" class="d">−{{ f.del }}</i></span>
                </button>
              </template>
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
            <span v-if="showsImage" class="note img-note">изображение</span>
            <span v-else-if="fileData?.binary" class="note">бинарный</span>
            <span v-else-if="fileData?.tooBig" class="note">слишком большой — превью отключено</span>
            <span v-if="fileLoading" class="note">читаю…</span>
          </template>
          <template v-else-if="tab === 'git' && gitFile">
            <span class="st" :class="gitFile.status">{{ STLABEL[gitFile.status] || gitFile.status }}</span>
            <span class="epath mono">{{ gitFile.path }}</span>
            <!-- Пока индекс пуст, называть группу нечего: диф в панели ровно один. -->
            <span v-if="gitScopeBadge" class="scope" :title="gitScopeBadge.hint">{{ gitScopeBadge.label }}</span>
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
          <div v-show="tab === 'files' && !imageSrc" ref="fileHost" class="editor"></div>
          <div v-show="tab === 'git'" ref="diffHost" class="editor"></div>
          <!-- Картинка вместо пустого редактора: сырые байты отдаёт raw-роут «Кода». -->
          <div v-if="tab === 'files' && imageSrc" class="imgwrap">
            <img v-if="!imageError" :src="imageSrc" :alt="fileSel" @error="imageError = 'Не удалось загрузить изображение'">
            <div v-else class="imgerr">
              {{ imageError }}<br>
              <span class="muted">Возможно, файл больше 10 МБ или его формат не поддерживается предпросмотром.</span>
            </div>
          </div>
          <div v-if="tab === 'files' && !fileSel" class="overlay">Выбери файл слева</div>
          <!-- Пусто = нет изменений НИ В ОДНОЙ группе: при чистом рабочем дереве, но
               непустом индексе, диф выбранного файла существует и закрывать его нечем. -->
          <div v-else-if="tab === 'git' && git && !gitEntries.size" class="overlay">Несохранённых изменений нет — рабочее дерево чистое</div>
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
/* Лесенка дерева: шаг задан ОДИН раз здесь, скрипт присылает строке только --depth.
   Держать шаг числом в JS нельзя — он должен сходиться с положением направляющей. */
.tree { --tree-step: 14px; --tree-lead: 8px; --tree-guide: color-mix(in srgb, var(--line) 80%, transparent); }

.trow { display: flex; align-items: center; gap: 7px; width: 100%; text-align: left; background: none; border: none;
  color: var(--ink); padding: 4px 8px; border-radius: 7px; cursor: pointer; font-size: 12.5px; }
/* Фон меняем ТОЛЬКО background-color: shorthand `background` стирает направляющие. */
.trow:hover { background-color: var(--surface); }
.trow:focus-visible, .ritem:focus-visible, .git-view-toggle button:focus-visible, .act:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--accent) 55%, transparent); outline-offset: 1px; }
.trow.dir { color: var(--ink-mid); }
/* Направляющие линии предков — по одной на уровень, ровно под шевроном родителя. */
.tree .trow {
  padding-left: calc(var(--tree-lead) + var(--depth, 0) * var(--tree-step));
  background-image: repeating-linear-gradient(to right, var(--tree-guide) 0 1px, transparent 1px var(--tree-step));
  background-repeat: no-repeat;
  /* 5.5px = половина шеврона минус половина линии: направляющая идёт ровно по его центру. */
  background-position: calc(var(--tree-lead) + 5.5px) 0;
  background-size: calc(var(--depth, 0) * var(--tree-step)) 100%;
}
.chev { flex: none; width: 12px; font-size: 10px; color: var(--ink-mid); }
.dname { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.frow.sel { background-color: color-mix(in srgb, var(--accent) 16%, transparent); }
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
.scope { flex: none; font-size: 11px; color: var(--ink-mid); border: 1px solid var(--line);
  border-radius: 5px; padding: 1px 6px; white-space: nowrap; }
.note { font-size: 11px; color: var(--warn); flex: none; }
.grow { flex: 1; }
.ebody { flex: 1; min-height: 0; position: relative; }
.editor { position: absolute; inset: 0; }
.overlay { position: absolute; inset: 0; display: grid; place-items: center; color: var(--ink-mid);
  font-size: 13px; background: #0a0c10; }

/* Предпросмотр картинки: вписываем целиком, «шахматка» показывает прозрачность. */
.imgwrap {
  position: absolute; inset: 0; display: grid; place-items: center; overflow: auto; padding: 16px;
  background: #0a0c10;
  background-image:
    linear-gradient(45deg, #14181f 25%, transparent 25%, transparent 75%, #14181f 75%),
    linear-gradient(45deg, #14181f 25%, transparent 25%, transparent 75%, #14181f 75%);
  background-size: 18px 18px; background-position: 0 0, 9px 9px;
}
.imgwrap img { max-width: 100%; max-height: 100%; object-fit: contain;
  border-radius: 6px; box-shadow: 0 2px 18px rgba(0, 0, 0, .45); }
.imgerr { color: var(--bad); font-size: 13px; text-align: center; line-height: 1.6; }
.imgerr .muted { color: var(--ink-mid); font-size: 12px; }
.note.img-note { color: var(--ink-mid); }

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
