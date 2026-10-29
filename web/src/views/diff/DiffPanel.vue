<template>
  <div class="diff-core">
    <DiffLoading v-if="showLoading" label="Считаю диф…"  :side-by-side="sideBySide" />
    <div v-else-if="error && !repos.length" class="state"><p class="bad">{{ error }}</p><UiButton variant="solid" tone="accent" @click="load">Повторить</UiButton></div>
    <div v-else-if="!files.length" class="state">
      <p>Несохранённых изменений нет</p>
      <p class="muted sm">Правки задачи уже закоммичены — смотри их в PR.</p>
    </div>

    <div v-else class="split" :class="{ 'files-collapsed': filesCollapsed }">
      <!-- Дерево изменённых файлов (иерархия папок, как в VS Code) -->
      <aside :id="fileListId" class="filelist">
        <div v-for="r in treeRepos" :key="r.name" class="grp">
          <div class="grphead">
            <span class="badge" :class="r.name">{{ r.name === 'be' ? 'Бэкенд' : 'Фронт' }}</span>
            <span class="branch mono">{{ r.branch }}</span>
          </div>
          <template v-for="row in r.rows" :key="(row.type === 'dir' ? 'd:' + row.key : 'f:' + r.name + ':' + row.file.path)">
            <UiPressable v-if="row.type === 'dir'" class="trow dir"
                         :style="{ paddingLeft: indent(row.depth) }"
                         :aria-expanded="String(!collapsedDirs.has(row.key))"
                         @click="toggleDir(row.key)">
              <span class="chev">{{ collapsedDirs.has(row.key) ? '▸' : '▾' }}</span>
              <span class="dname">{{ row.name }}</span>
            </UiPressable>
            <UiPressable v-else class="trow frow" :class="{ sel: selectedKey === `${r.name}:${row.file.path}` }"
                         :pressed="selectedKey === `${r.name}:${row.file.path}`"
                         :style="{ paddingLeft: indent(row.depth) }" @click="selectedKey = `${r.name}:${row.file.path}`; filesCollapsed = true">
              <span class="st" :class="row.file.status">{{ STLABEL[row.file.status] || row.file.status }}</span>
              <span class="nm">{{ row.name }}</span>
              <span class="cnt mono"><i v-if="row.file.add" class="a">+{{ row.file.add }}</i><i v-if="row.file.del" class="d">−{{ row.file.del }}</i></span>
            </UiPressable>
          </template>
        </div>
      </aside>

      <!-- Диф-редактор -->
      <section class="editorwrap">
        <div class="ehead">
          <UiButton class="file-toggle" variant="text" :aria-expanded="!filesCollapsed"
                    :aria-controls="fileListId" @click="filesCollapsed = !filesCollapsed">
            Файлы · {{ files.length }}
          </UiButton>
          <template v-if="selected">
            <span class="st" :class="selected.status">{{ STLABEL[selected.status] || selected.status }}</span>
            <span class="epath mono">{{ selected.path }}</span>
            <span v-if="selected.binary" class="note">бинарный</span>
            <span v-else-if="selected.tooBig" class="note">слишком большой — превью отключено</span>
          </template>
          <span class="grow"></span>
          <UiToggleButton v-model="sideBySide" class="layout-toggle"
                          v-tooltip="sideBySide ? 'Рядом' : 'В строку'">
            {{ sideBySide ? '⇆ рядом' : '≡ в строку' }}
          </UiToggleButton>
          <UiIconButton role="embedded" label="Обновить" v-tooltip="'Обновить'"
                        :loading="loading" @click="load">↻</UiIconButton>
        </div>
        <div ref="host" class="editor"></div>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import DiffLoading from './DiffLoading.vue';

import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick, useId } from 'vue';
import type { editor } from 'monaco-editor';

import { isRecord } from '../../../../shared/lib/objects.ts';
import { monaco, langOf, READONLY_OPTS } from '../../shared/monaco.ts';
import { api, failureText } from '../../shared/apiClient.ts';
import {
  UiButton,
  UiIconButton,
  UiPressable,
  UiToggleButton,
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
const fileListId = `diff-files-${useId()}`;
const selected = computed(() => files.value.find((f) => `${f.repo}:${f.path}` === selectedKey.value) || null);
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

const treeRepos = computed(() => repos.value.filter((r) => (r.files || []).length).map((r) => {
  const root = buildTree(r.files || []);

  for (const c of root.children.values()) {
    compactDirs(c);
  }

  const rows: TreeRow[] = [];

  flattenTree(root, r.name, 0, rows, collapsedDirs.value);

  return {
    name: r.name,
    branch: r.branch,
    rows,
  };
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
  load();
});
onBeforeUnmount(() => {
  diffEditor?.dispose();
  diffEditor = null;
  disposeModels();
});
</script>

<style scoped>
.diff-core { height: 100%; min-height: 0; min-width: 0; container: diff-panel / inline-size; }
.state { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; text-align: center; }
.state p { margin: 0; }
.sm { font-size: 12.5px; }
.bad { color: var(--bad); font-weight: 600; }

.split { height: 100%; display: grid; grid-template-columns: 300px minmax(0, 1fr); min-height: 0; }
.filelist { min-width: 0; min-height: 0; border-right: 1px solid var(--line); overflow-y: auto; padding: 8px; background: var(--sidebar); }
.grp { margin-bottom: 10px; }
.grphead { display: flex; align-items: center; gap: 8px; padding: 6px 6px 8px; }
.badge { font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; padding: 2px 7px; border-radius: 6px; }
.badge.be { background: color-mix(in srgb, var(--node-code) 20%, transparent); color: var(--node-code); }
.badge.fe { background: color-mix(in srgb, var(--accent) 18%, transparent); color: var(--accent); }
.branch { font-size: 11px; color: var(--ink-mid); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.trow { display: flex; align-items: center; gap: 7px; width: 100%; text-align: left; background: none; border: none;
  color: var(--ink); padding: 5px 8px; border-radius: 7px; cursor: pointer; font-size: 12.5px; }
.trow:hover { background: var(--surface); }
.trow.dir { color: var(--ink-mid); }
.chev { flex: none; width: 12px; font-size: 10px; color: var(--ink-mid); }
.dname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.frow.sel { background: color-mix(in srgb, var(--accent) 16%, transparent); }
.st { flex: none; width: 16px; text-align: center; font-family: var(--mono); font-size: 11px; font-weight: 700; border-radius: 4px; }
.st.A { color: var(--good); } .st.M { color: var(--warn); } .st.D { color: var(--bad); } .st.R { color: var(--accent); }
.nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cnt { flex: none; font-size: 11px; display: flex; gap: 6px; }
.cnt .a { color: var(--good); } .cnt .d { color: var(--bad); }

.editorwrap { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.ehead { display: flex; align-items: center; gap: 10px; padding: 7px 12px; border-bottom: 1px solid var(--line); background: var(--topbar); }
.ehead .st { width: auto; padding: 0 5px; }
.epath { font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.note { font-size: 11px; color: var(--warn); flex: none; }
.grow { flex: 1; }
.editor { flex: 1; min-height: 0; }

.layout-toggle { flex: none; }
.file-toggle { display: none; }

/* Узкая панель отдаёт всю ширину коду, а дерево остаётся доступным над ним.
   Контейнер учитывает и страницу, и диалог независимо от ширины всего окна. */
@container diff-panel (max-width: 700px) {
  .split {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto minmax(0, 1fr);
  }
  .filelist { max-height: min(160px, 30dvh); border-right: 0; border-bottom: 1px solid var(--line); }
  .file-toggle { display: inline-flex; }
  .files-collapsed { grid-template-rows: minmax(0, 1fr); }
  .files-collapsed .filelist { display: none; }
  .ehead { flex-wrap: wrap; gap: 8px; }
  .epath { flex: 1; min-width: 0; }
  .ehead .grow { display: none; }
}
</style>
