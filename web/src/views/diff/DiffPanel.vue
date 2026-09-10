<template>
  <div class="diff-core">
    <div v-if="showLoading" class="state"><UiSpinner role="large" label="Считаю диф" /><p class="muted">Считаю диф…</p></div>
    <div v-else-if="error && !repos.length" class="state"><p class="bad">{{ error }}</p><UiButton variant="solid" tone="accent" @click="load">Повторить</UiButton></div>
    <div v-else-if="!files.length" class="state">
      <p>Несохранённых изменений нет</p>
      <p class="muted sm">Правки задачи уже закоммичены — смотри их в PR.</p>
    </div>

    <div v-else class="split">
      <!-- Дерево изменённых файлов (иерархия папок, как в VS Code) -->
      <aside class="filelist">
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
                         :style="{ paddingLeft: indent(row.depth) }" @click="selectedKey = `${r.name}:${row.file.path}`">
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
          <template v-if="selected">
            <span class="st" :class="selected.status">{{ STLABEL[selected.status] || selected.status }}</span>
            <span class="epath mono">{{ selected.path }}</span>
            <span v-if="selected.binary" class="note">бинарный</span>
            <span v-else-if="selected.tooBig" class="note">слишком большой — превью отключено</span>
          </template>
          <span class="grow"></span>
          <UiToggleButton v-model="sideBySide" class="layout-toggle"
                          :title="sideBySide ? 'Рядом' : 'В строку'">
            {{ sideBySide ? '⇆ рядом' : '≡ в строку' }}
          </UiToggleButton>
          <UiIconButton role="embedded" label="Обновить" title="Обновить"
                        :loading="loading" @click="load">↻</UiIconButton>
        </div>
        <div ref="host" class="editor"></div>
      </section>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { monaco, langOf, READONLY_OPTS } from '../../shared/monaco.ts';
import { api } from '../../shared/apiClient.ts';
import {
  UiButton, UiIconButton, UiPressable, UiSpinner, UiToggleButton,
} from '../../ui';

// Ядро дифа задачи (дерево файлов + Monaco). Переиспользуется на роуте /diff и в модале.
// Обвязка Monaco (воркер, тема, языки) — общая с плагином «Код»: shared/monaco.ts.
const props = defineProps({ taskId: { type: [String, Number], default: '' } });
const tid = computed(() => String(props.taskId || '').replace(/[^0-9]/g, ''));

const loading = ref(false);
const error = ref('');
const repos = ref([]);
const sideBySide = ref(localStorage.getItem('cockpit-diff-side') !== '0');
// Полноэкранная загрузка — только когда данных ещё нет. При рефреше редактор НЕ прячем
// (иначе размонтируется хост Monaco и редактор гаснет).
const showLoading = computed(() => loading.value && !repos.value.length);

// Плоский список файлов (для выбора первого).
const files = computed(() => repos.value.flatMap((r) => (r.files || []).map((f) => ({ ...f, repo: r.name, branch: r.branch }))));
const selectedKey = ref('');
const selected = computed(() => files.value.find((f) => `${f.repo}:${f.path}` === selectedKey.value) || null);
function fkey(f) { return `${f.repo}:${f.path}`; }
const STLABEL = { A: 'A', M: 'M', D: 'D', R: 'R' };

// ── Дерево файлов (иерархия папок, как в Explorer VS Code) ──
const collapsedDirs = ref(new Set());
function toggleDir(key) { const s = new Set(collapsedDirs.value); s.has(key) ? s.delete(key) : s.add(key); collapsedDirs.value = s; }

function buildTree(list) {
  const root = { name: '', dir: true, path: '', children: new Map() };
  for (const f of list) {
    const parts = f.path.split('/');
    let node = root;
    parts.forEach((part, i) => {
      if (i === parts.length - 1) { node.children.set(part, { name: part, dir: false, path: f.path, file: f }); return; }
      if (!node.children.has(part)) node.children.set(part, { name: part, dir: true, path: parts.slice(0, i + 1).join('/'), children: new Map() });
      node = node.children.get(part);
    });
  }
  return root;
}
// Схлопывание цепочек папок с единственным потомком-папкой (app/Domains/Projects → одна строка).
function compactDirs(node) {
  if (!node.dir) return;
  while (node.children.size === 1) {
    const only = [...node.children.values()][0];
    if (!only.dir) break;
    node.name = node.name ? `${node.name}/${only.name}` : only.name;
    node.path = only.path; node.children = only.children;
  }
  for (const c of node.children.values()) compactDirs(c);
}
function flattenTree(node, repo, depth, out, collapsed) {
  const kids = [...node.children.values()].sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : (a.dir ? -1 : 1)));
  for (const c of kids) {
    if (c.dir) {
      const key = `${repo}:${c.path}`;
      out.push({ type: 'dir', name: c.name, key, depth });
      if (!collapsed.has(key)) flattenTree(c, repo, depth + 1, out, collapsed);
    } else {
      out.push({ type: 'file', name: c.name, file: c.file, depth });
    }
  }
}
const treeRepos = computed(() => repos.value.filter((r) => (r.files || []).length).map((r) => {
  const root = buildTree(r.files || []);
  for (const c of root.children.values()) compactDirs(c);
  const rows = [];
  flattenTree(root, r.name, 0, rows, collapsedDirs.value);
  return { name: r.name, branch: r.branch, rows };
}));
function indent(depth) { return `${depth * 13 + 8}px`; }

// ── Monaco diff editor ──
const host = ref(null);
let diffEditor = null;
let models = [];
function disposeModels() { models.forEach((m) => m.dispose()); models = []; }

function mountEditor() {
  if (diffEditor || !host.value) return;
  diffEditor = monaco.editor.createDiffEditor(host.value, {
    ...READONLY_OPTS,
    renderSideBySide: sideBySide.value,
    renderOverviewRuler: true, ignoreTrimWhitespace: false,
    hideUnchangedRegions: { enabled: true, minimumLineCount: 3, contextLineCount: 3 },
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
  if (!tid.value) { error.value = 'не указана задача'; return; }
  loading.value = true; error.value = '';
  try {
    repos.value = (await api.get(`/api/tasks/${tid.value}/diff`)).repos || [];
    if (!selected.value) selectedKey.value = files.value[0] ? fkey(files.value[0]) : '';
  } catch (e) { error.value = e.message; repos.value = []; }
  finally { loading.value = false; }
  // Хост рендерится только после loading=false. Явно показываем только при ПЕРВОМ монтировании;
  // на рефреше перерисовку делает watch(selected) — иначе двойной showFile дёргает модели
  // в момент вычисления дифа («no diff result available»).
  await nextTick();
  const firstMount = !diffEditor;
  mountEditor();
  if (firstMount && selected.value) showFile(selected.value);
}

onMounted(load);
watch(tid, () => { selectedKey.value = ''; load(); });
onBeforeUnmount(() => { diffEditor?.dispose(); diffEditor = null; disposeModels(); });
</script>

<style scoped>
.diff-core { height: 100%; min-height: 0; }
.state { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; text-align: center; }
.state p { margin: 0; }
.sm { font-size: 12.5px; }
.bad { color: var(--bad); font-weight: 600; }

.split { height: 100%; display: grid; grid-template-columns: 300px 1fr; min-height: 0; }
.filelist { border-right: 1px solid var(--line); overflow-y: auto; padding: 8px; background: var(--sidebar); }
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
</style>
