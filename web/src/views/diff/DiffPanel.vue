<template>
  <section class="diff-core ui-workspace" data-ui-workspace :aria-busy="loading || undefined"
           :aria-label="t('core.diffDesignWorkspace')">
    <DiffLoading v-if="showLoading" label="Считаю диф…" :side-by-side="sideBySide" />
    <div v-else-if="error && !repos.length" class="state"
    :data-perf-error="error && !repos.length && !loading ? '' : undefined" role="status">
      <span class="state__icon" aria-hidden="true">±</span>
      <strong>{{ t('core.diffDesignLoadFailed') }}</strong>
      <p class="bad">{{ error }}</p>
      <UiButton tone="accent" @click="load">Повторить</UiButton>
    </div>
    <div v-else-if="!files.length" class="state" role="status">
      <span class="state__icon" aria-hidden="true">±</span>
      <strong>Несохранённых изменений нет</strong>
      <p>Правки задачи уже закоммичены — смотри их в PR.</p>
      <UiButton data-context="workspace-toolbar" :loading="loading" @click="load">
        {{ t('core.diffDesignRefresh') }}
      </UiButton>
    </div>

    <div v-else class="split" :class="{ 'files-collapsed': filesCollapsed }">
      <aside :id="fileListId" class="filelist" :aria-label="t('core.diffDesignChangedFiles')">
        <UiPaneHeader>
          <template #title><h3>{{ t('core.diffDesignFiles') }}</h3></template>
          <template #meta>
            <span class="diff-summary">
              <span>{{ files.length }}</span>
              <span v-if="totals.add" class="a">+{{ totals.add }}</span>
              <span v-if="totals.del" class="d">−{{ totals.del }}</span>
            </span>
          </template>
          <template #actions>
            <UiButton class="file-toggle" data-context="workspace-toolbar"
                      :aria-controls="editorId" @click="filesCollapsed = true">
              {{ t('core.diffDesignBackToDiff') }}
            </UiButton>
          </template>
        </UiPaneHeader>
        <div class="filelist__search">
          <UiSearchInput v-model="search" :placeholder="t('core.diffDesignSearchPlaceholder')"
                         :aria-label="t('core.diffDesignSearchLabel')" />
        </div>
        <div class="filelist__body">
          <section v-for="r in treeRepos" :key="r.name" class="grp">
            <div class="grphead">
              <div class="grphead__identity">
                <strong v-tooltip="repoLabel(r.name)">{{ repoLabel(r.name) }}</strong>
                <span class="repo-count">{{ r.fileCount }}</span>
              </div>
              <span class="branch" v-tooltip="r.branch || undefined">
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"
                     aria-hidden="true"><circle cx="4" cy="3" r="1.5" /><circle cx="12" cy="4" r="1.5" />
                  <circle cx="4" cy="13" r="1.5" /><path d="M4 4.5v7M12 5.5v1A3.5 3.5 0 0 1 8.5 10H4" />
                </svg>
                <span>{{ r.branch || '—' }}</span>
              </span>
            </div>
            <template v-for="row in r.rows"
                      :key="row.type === 'dir' ? 'd:' + row.key : 'f:' + r.name + ':' + row.file.path">
              <UiPressable v-if="row.type === 'dir'" class="trow dir" data-context="code-tree-row"
                           :style="{ paddingLeft: indent(row.depth) }"
                           :aria-expanded="String(search.trim() ? true : !collapsedDirs.has(row.key))"
                           :disabled="Boolean(search.trim())"
                           v-tooltip="search.trim() ? t('core.diffDesignSearchExpanded') : row.name"
                           @click="toggleDir(row.key)">
                <svg class="chev" :class="{ 'is-collapsed': !search.trim() && collapsedDirs.has(row.key) }"
                     viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"
                     aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
                <span class="dname">{{ row.name }}</span>
              </UiPressable>
              <UiPressable v-else class="trow frow" data-context="code-tree-row"
                           :data-diff-file="`${r.name}:${row.file.path}`"
                           :pressed="selectedKey === `${r.name}:${row.file.path}`"
                           :style="{ paddingLeft: indent(row.depth) }"
                           :aria-label="`${repoLabel(r.name)} · ${row.file.path}`"
                           v-tooltip="row.file.path" @click="selectFile(r.name, row.file.path)">
                <span class="st" :class="row.file.status" :aria-label="statusLabel(row.file.status)">
                  {{ STLABEL[row.file.status] || row.file.status }}
                </span>
                <span class="nm">{{ row.name }}</span>
                <span class="cnt">
                  <span v-if="row.file.add" class="a">+{{ row.file.add }}</span>
                  <span v-if="row.file.del" class="d">−{{ row.file.del }}</span>
                </span>
              </UiPressable>
            </template>
          </section>
          <div v-if="!treeRepos.length" class="diff-search-empty" role="status">
            <strong>{{ t('core.diffDesignNoMatches') }}</strong>
            <span>{{ t('core.diffDesignChangeSearch') }}</span>
            <UiButton variant="text" size="compact" @click="search = ''">
              {{ t('core.diffDesignClearSearch') }}
            </UiButton>
          </div>
        </div>
      </aside>

      <section :id="editorId" class="editorwrap" :aria-label="t('core.diffDesignFileChanges')">
        <UiPaneHeader class="ehead">
          <template #navigation>
            <UiButton class="file-toggle" data-context="workspace-toolbar"
                      :aria-expanded="!filesCollapsed" :aria-controls="fileListId"
                      @click="filesCollapsed = false">
              <template #leading>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
                     stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="m14 6-6 6 6 6" />
                </svg>
              </template>
              {{ t('core.diffDesignFileCount', { count: files.length }) }}
            </UiButton>
          </template>
          <template #title>
            <div class="diff-file-heading">
              <template v-if="selected">
                <span class="st" :class="selected.status" :aria-label="statusLabel(selected.status)">
                  {{ STLABEL[selected.status] || selected.status }}
                </span>
                <span class="epath" v-tooltip="selected.path">
                  <span class="epath__directory">
                    {{ selected.path.slice(0, selected.path.lastIndexOf('/') + 1) }}
                  </span>
                  <span>{{ selected.path.split('/').pop() }}</span>
                </span>
              </template>
            </div>
          </template>
          <template #meta>
            <span v-if="selected" class="cnt">
              <span v-if="selected.add" class="a">+{{ selected.add }}</span>
              <span v-if="selected.del" class="d">−{{ selected.del }}</span>
            </span>
          </template>
          <template #actions>
            <UiSegmentedControl v-model="layoutMode" size="compact" :options="layoutOptions"
                                :label="t('core.diffDesignLayout')" :disabled="!canPreview" />
            <UiIconButton role="embedded" data-context="workspace-toolbar"
                          :label="t('core.diffDesignRefresh')" v-tooltip="t('core.diffDesignRefresh')"
                          :loading="loading" @click="load">
              <UiRefreshIcon />
            </UiIconButton>
          </template>
        </UiPaneHeader>
        <div v-if="selected" class="diff-context">
          <span class="diff-context__repo">{{ repoLabel(selected.repo) }}</span>
          <span class="diff-context__branch" v-tooltip="selected.branch || undefined">
            {{ selected.branch || '—' }}
          </span>
          <span class="diff-context__status">{{ statusLabel(selected.status) }}</span>
        </div>
        <div class="diff-content">
          <div v-if="canPreview" class="diff-sides" :class="{ 'is-split': sideBySide }" aria-hidden="true">
            <span v-if="sideBySide">{{ t('core.diffDesignBefore') }}</span>
            <span>{{ t('core.diffDesignWorkingCopy') }}</span>
          </div>
          <div ref="host" v-show="canPreview" class="editor"></div>
          <div v-if="!canPreview" class="state state--file" role="status">
            <span class="state__icon" aria-hidden="true">{{ selected?.binary ? '▧' : '±' }}</span>
            <strong>{{ selected?.binary ? t('core.diffDesignBinary') : t('core.diffDesignTooBig') }}</strong>
            <p>{{ selected?.binary ? t('core.diffDesignBinaryHint') : t('core.diffDesignTooBigHint') }}</p>
          </div>
        </div>
      </section>
    </div>
  </section>
</template>

<script setup lang="ts">
import DiffLoading from './DiffLoading.vue';

import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick, useId } from 'vue';
import type { editor } from 'monaco-editor';

import { isRecord } from '../../../../shared/lib/objects.ts';
import { monaco, langOf, READONLY_OPTS } from '../../shared/monaco.ts';
import { api, failureText } from '../../shared/apiClient.ts';
import {
  UiRefreshIcon,
  UiButton,
  UiIconButton,
  UiPressable,
  UiPaneHeader,
  UiSearchInput,
  UiSegmentedControl,
  t,
  vTooltip,
} from '../../ui';

interface DiffFile {
  path: string;
  status: string;
  add?: number;
  del?: number;
  binary?: boolean;
  tooBig?: boolean;
  oldContent?: string;
  newContent?: string;
  hunks?: unknown[] | null;
}

interface DiffRepo {
  name: string;
  branch?: string | null;
  files?: DiffFile[] | null;
}

type SelectedFile = DiffFile & { repo: string; branch?: string | null };

type TreeNode = DirectoryNode | {
  name: string;
  dir: false;
  path: string;
  file: DiffFile;
};

interface DirectoryNode {
  name: string;
  dir: true;
  path: string;
  children: Map<string, TreeNode>;
}

type TreeRow = {
  type: 'dir';
  name: string;
  key: string;
  depth: number;
} | {
  type: 'file';
  name: string;
  file: DiffFile;
  depth: number;
};

// Ядро дифа задачи: дерево файлов и Monaco с прежним выбором файла и настройкой раскладки.
const props = defineProps({ taskId: { type: [String, Number], default: '' } });
const tid = computed(() => String(props.taskId || '').replace(/[^0-9]/g, ''));

const loading = ref(false);
const error = ref('');
const search = ref('');
const repos = ref<DiffRepo[]>([]);
const sideBySide = ref(localStorage.getItem('grigdesk-diff-side') !== '0');

// При обновлении сохраняем хост Monaco: полноэкранная загрузка нужна только до первых данных.
const showLoading = computed(() => loading.value && !repos.value.length);
const files = computed(() => repos.value.flatMap((r) => (
  (r.files || []).map((f) => ({
    ...f,
    repo: r.name,
    branch: r.branch,
  }))
)));
const selectedKey = ref('');
const filesCollapsed = ref(false);
const panelId = useId();
const fileListId = `diff-files-${panelId}`;
const editorId = `diff-editor-${panelId}`;
const selected = computed(() => files.value.find((f) => `${f.repo}:${f.path}` === selectedKey.value) || null);
const canPreview = computed(() => Boolean(
  selected.value && !selected.value.binary && !selected.value.tooBig,
));
const totals = computed(() => files.value.reduce((total, file) => ({
  add: total.add + (file.add || 0),
  del: total.del + (file.del || 0),
}), {
  add: 0,
  del: 0,
}));
const layoutMode = computed({
  get: () => sideBySide.value ? 'split' : 'inline',
  set: (mode: string) => {
    sideBySide.value = mode === 'split';
  },
});
const layoutOptions = computed(() => [
  {
    value: 'split',
    label: t('core.diffDesignSideBySide'),
  },
  {
    value: 'inline',
    label: t('core.diffDesignInline'),
  },
]);

const STLABEL: Record<string, string> = {
  A: 'A',
  M: 'M',
  D: 'D',
  R: 'R',
};
const collapsedDirs = ref(new Set<string>());
const host = ref<HTMLElement | null>(null);
let diffEditor: editor.IStandaloneDiffEditor | null = null;
let models: editor.ITextModel[] = [];

/**
 * Проверяет используемые поля файла, не обрезая неизвестные расширения ответа.
 * Содержимое и счётчики могут отсутствовать в старом снимке, но не менять тип.
 */
function isDiffFile(value: unknown): value is DiffFile {
  if (!isRecord(value) || typeof value.path !== 'string' || typeof value.status !== 'string') {
    return false;
  }

  for (const field of ['oldContent', 'newContent']) {
    if (value[field] !== undefined && typeof value[field] !== 'string') {
      return false;
    }
  }
  for (const field of ['add', 'del']) {
    if (value[field] !== undefined && (typeof value[field] !== 'number' || !Number.isFinite(value[field]))) {
      return false;
    }
  }
  for (const field of ['binary', 'tooBig']) {
    if (value[field] !== undefined && typeof value[field] !== 'boolean') {
      return false;
    }
  }

  return value.hunks == null || Array.isArray(value.hunks);
}

/**
 * Репозиторий должен содержать список проверенных файлов до публикации в редакторе.
 * Отсутствующий старый список файлов по-прежнему означает пустой репозиторий.
 */
function isDiffRepo(value: unknown): value is DiffRepo {
  return isRecord(value) && typeof value.name === 'string'
    && (value.branch == null || typeof value.branch === 'string')
    && (value.files == null || (Array.isArray(value.files) && value.files.every(isDiffFile)));
}

/**
 * Сужает сетевой контейнер до изменения реактивного состояния панели.
 * Неверный ответ использует прежний отказ с очисткой репозиториев.
 */
function parseRepos(value: unknown): DiffRepo[] {
  if (!isRecord(value)) {
    throw new Error('Сервер вернул некорректный диф');
  }
  if (value.repos == null) {
    return [];
  }
  if (!Array.isArray(value.repos) || !value.repos.every(isDiffRepo)) {
    throw new Error('Сервер вернул некорректный диф');
  }

  return value.repos;
}

/**
 * Известные короткие имена репозиториев получают привычные подписи.
 * Произвольное имя сохраняется как данные, чтобы другой репозиторий не стал «Фронтом».
 */
function repoLabel(name: string): string {
  if (['be', 'backend'].includes(name)) {
    return t('core.diffDesignBackend');
  }
  if (['fe', 'frontend'].includes(name)) {
    return t('core.diffDesignFrontend');
  }

  return name;
}

function statusLabel(status: string): string {
  return ({
    A: t('core.diffDesignAdded'),
    M: t('core.diffDesignModified'),
    D: t('core.diffDesignDeleted'),
    R: t('core.diffDesignRenamed'),
  } as Record<string, string>)[status] || status;
}

/**
 * Выбирает файл вместе с репозиторием: одинаковые пути могут быть в обеих группах.
 * На узком экране выбор сразу возвращает редактор вместо каталога.
 */
function selectFile(repo: string, path: string): void {
  selectedKey.value = `${repo}:${path}`;
  filesCollapsed.value = true;
}

function fkey(f: SelectedFile) {
  return `${f.repo}:${f.path}`;
}

/**
 * Меняет только локальное раскрытие каталога в дереве.
 * Новый Set сохраняет реактивное уведомление после переключения ключа.
 */
function toggleDir(key: string) {
  const s = new Set(collapsedDirs.value);

  s.has(key) ? s.delete(key) : s.add(key);
  collapsedDirs.value = s;
}

/**
 * Собирает иерархию из путей файлов в прежнем порядке обхода.
 * Файл не может одновременно быть родительским каталогом другого пути.
 */
function buildTree(list: DiffFile[]): DirectoryNode {
  const root: DirectoryNode = {
    name: '',
    dir: true,
    path: '',
    children: new Map(),
  };

  for (const f of list) {
    const parts = f.path.split('/');
    let node = root;

    parts.forEach((part, i) => {
      if (i === parts.length - 1) {
        node.children.set(part, {
          name: part,
          dir: false,
          path: f.path,
          file: f,
        });

        return;
      }

      let child = node.children.get(part);

      if (!child) {
        child = {
          name: part,
          dir: true,
          path: parts.slice(0, i + 1).join('/'),
          children: new Map(),
        };
        node.children.set(part, child);
      }
      if (!child.dir) {
        throw new Error('Некорректные пути файлов дифа');
      }

      node = child;
    });
  }

  return root;
}

/**
 * Схлопывает цепочки папок с единственным потомком-папкой в одну строку.
 * Путь последней папки остаётся ключом раскрытия всей цепочки.
 */
function compactDirs(node: TreeNode) {
  if (!node.dir) {
    return;
  }

  while (node.children.size === 1) {
    const only = [...node.children.values()][0]!;

    if (!only.dir) {
      break;
    }

    node.name = node.name ? `${node.name}/${only.name}` : only.name;
    node.path = only.path;
    node.children = only.children;
  }

  for (const c of node.children.values()) {
    compactDirs(c);
  }
}

/**
 * Разворачивает видимую часть дерева: каталоги прежде файлов, затем локальная сортировка.
 * Закрытые ветви сохраняются в дереве, но не создают строки панели.
 */
function flattenTree(
  node: DirectoryNode,
  repo: string,
  depth: number,
  out: TreeRow[],
  collapsed: Set<string>,
) {
  const kids = [...node.children.values()].sort((a, b) => (
    a.dir === b.dir ? a.name.localeCompare(b.name) : (a.dir ? -1 : 1)
  ));

  for (const c of kids) {
    if (c.dir) {
      const key = `${repo}:${c.path}`;

      out.push({
        type: 'dir',
        name: c.name,
        key,
        depth,
      });

      if (!collapsed.has(key)) {
        flattenTree(c, repo, depth + 1, out, collapsed);
      }
    } else {
      out.push({
        type: 'file',
        name: c.name,
        file: c.file,
        depth,
      });
    }
  }
}

const treeRepos = computed(() => repos.value.flatMap((repo) => {
  const needle = search.value.trim().toLocaleLowerCase();
  const matchingFiles = (repo.files || []).filter((file) => (
    !needle || [repoLabel(repo.name), repo.name, repo.branch, file.path]
      .join(' ').toLocaleLowerCase().includes(needle)
  ));

  if (!matchingFiles.length) {
    return [];
  }

  const root = buildTree(matchingFiles);

  for (const child of root.children.values()) {
    compactDirs(child);
  }

  const rows: TreeRow[] = [];

  flattenTree(root, repo.name, 0, rows, needle ? new Set() : collapsedDirs.value);

  return [{
    name: repo.name,
    branch: repo.branch,
    fileCount: matchingFiles.length,
    rows,
  }];
}));

function indent(depth: number) {
  return `${depth * 13 + 8}px`;
}

function disposeModels() {
  models.forEach((m) => m.dispose());
  models = [];
}

/**
 * Создаёт один diff editor при появлении хоста в DOM.
 * Переключение файла и обновление данных переиспользуют тот же экземпляр Monaco.
 */
function mountEditor() {
  if (diffEditor || !host.value) {
    return;
  }

  diffEditor = monaco.editor.createDiffEditor(host.value, {
    ...READONLY_OPTS,
    renderSideBySide: sideBySide.value,
    renderOverviewRuler: true,
    ignoreTrimWhitespace: false,
    hideUnchangedRegions: {
      enabled: true,
      minimumLineCount: 3,
      contextLineCount: 3,
    },
  });
}

/**
 * Подменяет модели выбранного файла, сохраняя прежнюю обработку больших файлов.
 * Старые модели снимаются после setModel, чтобы Monaco не потерял текущий диф.
 */
function showFile(f: SelectedFile | null) {
  if (!f) {
    return;
  }

  mountEditor();

  if (!diffEditor) {
    return;
  }

  const lang = langOf(f.path);
  const orig = monaco.editor.createModel(f.tooBig ? '' : (f.oldContent || ''), lang);
  const mod = monaco.editor.createModel(f.tooBig ? '' : (f.newContent || ''), lang);
  const old = models;

  models = [orig, mod];
  diffEditor.setModel({ original: orig, modified: mod });
  old.forEach((m) => m.dispose());
}

watch(host, (element) => {
  if (!element) {
    diffEditor?.dispose();
    diffEditor = null;
    disposeModels();

    return;
  }

  showFile(selected.value);
});

watch(selected, (f) => showFile(f));
watch(sideBySide, (v) => {
  localStorage.setItem('grigdesk-diff-side', v ? '1' : '0');
  diffEditor?.updateOptions({ renderSideBySide: v });
});

/**
 * Загружает проверенный снимок и сохраняет прежний выбор файла при обновлении.
 * Первый показ ждёт DOM после loading=false; последующие делает watch(selected).
 */
async function load() {
  if (!tid.value) {
    error.value = 'не указана задача';

    return;
  }

  loading.value = true;
  error.value = '';

  try {
    repos.value = parseRepos(await api.get(`/api/tasks/${tid.value}/diff`));

    if (!selected.value) {
      selectedKey.value = files.value[0] ? fkey(files.value[0]) : '';
    }
  } catch (e) {
    error.value = failureText(e);
    repos.value = [];
  } finally {
    loading.value = false;
  }

  await nextTick();

  const firstMount = !diffEditor;

  mountEditor();

  if (firstMount && selected.value) {
    showFile(selected.value);
  }
}

onMounted(load);
watch(tid, () => {
  selectedKey.value = '';
  search.value = '';
  filesCollapsed.value = false;
  void load();
});
onBeforeUnmount(() => {
  diffEditor?.dispose();
  diffEditor = null;
  disposeModels();
});
</script>

<style scoped>
.diff-core {
  height: 100%;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
  container: diff-panel / inline-size;
}

.split {
  display: grid;
  grid-template-columns: 288px minmax(0, 1fr);
  height: 100%;
  min-height: 0;
}

.filelist {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  border-right: 1px solid var(--line);
  background: var(--sidebar);
}

.diff-summary,
.cnt {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-family: var(--mono);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.a {
  color: var(--good);
}

.d {
  color: var(--bad);
}

.filelist__search {
  flex: none;
  padding: 10px;
  border-bottom: 1px solid var(--line);
}

.filelist__body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 0 6px 8px;
}

.grp + .grp {
  margin-top: 8px;
}

.grphead {
  position: sticky;
  top: 0;
  z-index: 1;
  display: grid;
  gap: 4px;
  min-width: 0;
  padding: 10px 6px 8px;
  border-bottom: 1px solid var(--line);
  background: var(--sidebar);
}

.grphead__identity {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}

.grphead__identity strong {
  min-width: 0;
  overflow: hidden;
  color: var(--ink);
  font-size: 12px;
  font-weight: 600;
  line-height: 17px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.repo-count {
  flex: none;
  color: var(--ink-low);
  font-size: 11px;
}

.branch {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  color: var(--ink-mid);
  font-family: var(--mono);
  font-size: 10.5px;
  line-height: 16px;
}

.branch svg {
  flex: none;
  width: 13px;
  height: 13px;
  color: var(--ink-low);
}

.branch span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.trow {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-width: 0;
  text-align: left;
}

.chev {
  flex: none;
  width: 13px;
  height: 13px;
}

.chev.is-collapsed {
  transform: rotate(-90deg);
}

.dname,
.nm {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.st {
  flex: none;
  width: 14px;
  text-align: center;
  font-family: var(--mono);
  font-size: 11px;
  font-weight: 600;
}

.st.A {
  color: var(--good);
}

.st.M {
  color: var(--warn);
}

.st.D {
  color: var(--bad);
}

.st.R {
  color: var(--accent);
}

.trow .cnt {
  flex: none;
  gap: 5px;
}

.editorwrap {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.diff-file-heading {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  max-width: 100%;
}

.epath {
  display: flex;
  min-width: 0;
  overflow: hidden;
  font-family: var(--mono);
  font-size: 12px;
  font-weight: 500;
  line-height: 18px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.epath__directory {
  min-width: 0;
  overflow: hidden;
  color: var(--ink-mid);
  text-overflow: ellipsis;
}

.epath > span:last-child {
  flex: none;
}

.diff-context {
  display: flex;
  flex: none;
  align-items: center;
  gap: 10px;
  min-width: 0;
  padding: 6px 12px;
  border-bottom: 1px solid var(--line);
  background: var(--surface);
  font-size: 11px;
  line-height: 16px;
}

.diff-context__repo {
  flex: none;
  max-width: 35%;
  overflow: hidden;
  color: var(--ink-mid);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.diff-context__branch {
  min-width: 0;
  overflow: hidden;
  color: var(--ink-low);
  font-family: var(--mono);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.diff-context__status {
  flex: none;
  margin-left: auto;
  color: var(--ink-mid);
}

.diff-content {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  container: diff-editor / inline-size;
}

.diff-sides {
  display: grid;
  flex: none;
  grid-template-columns: minmax(0, 1fr);
  padding-right: 30px;
  border-bottom: 1px solid var(--line);
  background: var(--ground);
  color: var(--ink-low);
  font-size: 10.5px;
  line-height: 16px;
}

.diff-sides.is-split {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.diff-sides > span {
  min-width: 0;
  padding: 5px 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.diff-sides.is-split > span + span {
  border-left: 1px solid var(--line);
}

.editor {
  flex: 1;
  min-width: 0;
  min-height: 0;
}

.file-toggle {
  display: none;
}

.state,
.diff-search-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  min-width: 0;
  padding: 24px;
  color: var(--ink-mid);
  text-align: center;
  font-size: 12px;
  line-height: 18px;
}

.state {
  height: 100%;
}

.state--file {
  flex: 1;
  height: auto;
}

.state strong,
.diff-search-empty strong {
  color: var(--ink);
  font-size: 13px;
  font-weight: 600;
}

.state p {
  max-width: 56ch;
  margin: 0;
  overflow-wrap: anywhere;
}

.state__icon {
  color: var(--ink-low);
  font-family: var(--mono);
  font-size: 30px;
  line-height: 40px;
}

.bad {
  color: var(--bad);
}

/* В узком редакторе Monaco показывает исходную сторону только в gutter.
   Подписи следуют той же геометрии, не отнимая ширину у изменённого текста. */
@container diff-editor (max-width: 900px) {
  .diff-sides.is-split {
    grid-template-columns: 38px minmax(0, 1fr);
  }

  .diff-sides.is-split > span:first-child {
    visibility: hidden;
  }
}

/* На узкой панели каталог и код получают всю доступную высоту по очереди.
   Переключение сохраняет поисковый запрос, раскрытие папок и экземпляр Monaco. */
@container diff-panel (max-width: 700px) {
  .split {
    display: flex;
  }

  .filelist,
  .editorwrap {
    flex: 1;
  }

  .filelist {
    border-right: 0;
  }

  .editorwrap {
    display: none;
  }

  .files-collapsed .filelist {
    display: none;
  }

  .files-collapsed .editorwrap {
    display: flex;
  }

  .file-toggle {
    display: inline-flex;
  }

  .epath__directory {
    display: none;
  }
}
</style>
