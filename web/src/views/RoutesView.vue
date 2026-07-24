<script setup>
import { ref, computed, watchEffect, onMounted, onBeforeUnmount, onUnmounted } from 'vue';
import { api } from '../shared/api-client.js';
import { confirmDialog } from '../shared/ui/confirm.js';
import { useUiContextStore } from '../stores/ui-context.js';
import { layoutRoute } from '../shared/route-layout.js';
import FactoryGraph from './pipeline/FactoryGraph.vue';
import HelpTip from '../shared/ui/HelpTip.vue';
import ProjectSwitcher from '../shared/ui/ProjectSwitcher.vue';

// Конструктор маршрутов: вся правка — кликом по схеме. Клик по блоку открывает
// меню действий (вставить этап до/после, возврат, убрать); возвраты добавляются
// «связыванием»: выбрал источник → кликнул цель. Никаких дублирующих списков.
const routes = ref([]);
const agents = ref([]);
const profiles = ref([]);
const profile = ref(localStorage.getItem('cockpit-project') || '');
const loading = ref(true);
const error = ref('');
const selectedId = ref('');
const form = ref(null);   // { title, stages, returns }
const isNew = ref(false);
const saving = ref(false);
const notice = ref('');

// Состояние конструктора.
const popup = ref(null);      // { nid, x, y, mode: 'menu'|'pick', insertAt }
const linkFrom = ref('');     // источник возврата в режиме связывания
const pickFilter = ref('');
const canvasEl = ref(null);
const popupEl = ref(null);

// Репортим открытый маршрут в UI-контекст — чат с агентом знает, что открыто.
const ui = useUiContextStore();
watchEffect(() => { if (selectedId.value) ui.set('routes', { project: profile.value, route: selectedId.value }); });
onUnmounted(() => ui.clear('routes'));

const HELP_SCHEMA = 'Правка — кликом по схеме: клик по блоку открывает действия (вставить этап, возврат при провале, убрать). Схема раскладывается сама; возвраты — красные дуги.';

const agentsById = computed(() => Object.fromEntries(agents.value.map((a) => [a.id, a])));
const KIND_ICON = { agent: '🤖', human: '👤', code: '</>' };

const original = computed(() => routes.value.find((r) => r.id === selectedId.value) || null);
const dirty = computed(() => {
  if (isNew.value) return true;
  if (!form.value || !original.value) return false;
  const { id, ...orig } = original.value;
  return JSON.stringify(form.value) !== JSON.stringify(orig);
});

const previewGraph = computed(() => (form.value && form.value.stages.length
  ? layoutRoute(form.value.stages, form.value.returns, agentsById.value)
  : null));

// Кандидаты на вставку: агенты, которых ещё нет в цепочке (с фильтром по подписи).
const pickList = computed(() => {
  const used = new Set(form.value?.stages || []);
  const q = pickFilter.value.trim().toLowerCase();
  return agents.value
    .filter((a) => !used.has(a.id))
    .filter((a) => !q || (a.label || a.id).toLowerCase().includes(q) || a.id.includes(q));
});

// Возвраты, идущие ИЗ узла попапа (правятся прямо в меню).
const popupReturns = computed(() => (popup.value && form.value
  ? form.value.returns.filter((r) => r.from === popup.value.nid) : []));

async function load() {
  loading.value = true; error.value = '';
  try {
    if (!profiles.value.length) {
      profiles.value = (await api.get('/api/profiles')).profiles || [];
      if (profiles.value.length && !profiles.value.includes(profile.value)) {
        profile.value = profiles.value[0];
        localStorage.setItem('cockpit-project', profile.value);
      }
    }
    const [r, a] = await Promise.all([
      api.get(`/api/routes/${profile.value}`),
      api.get('/api/agents'),
    ]);
    routes.value = r.routes || [];
    agents.value = a.agents || [];
    if (!selectedId.value && routes.value.length) select(routes.value[0].id);
  } catch (e) { error.value = e.message; }
  finally { loading.value = false; }
}

function onProjectCreated({ id, profiles: fresh }) {
  if (fresh.length) profiles.value = fresh;
  switchProfile(id);
}

async function switchProfile(pr) {
  if (pr === profile.value) return;
  if (dirty.value && !(await confirmDialog('Есть несохранённые изменения — бросить?', { okText: 'Бросить' }))) return;
  profile.value = pr; localStorage.setItem('cockpit-project', pr);
  selectedId.value = ''; form.value = null; isNew.value = false; notice.value = '';
  closePopup(); linkFrom.value = '';
  load();
}

function closePopup() { popup.value = null; pickFilter.value = ''; }

async function select(id) {
  const r = routes.value.find((x) => x.id === id);
  if (!r) return;
  if (dirty.value && !(await confirmDialog('Есть несохранённые изменения — бросить?', { okText: 'Бросить' }))) return;
  selectedId.value = id; isNew.value = false; notice.value = '';
  closePopup(); linkFrom.value = '';
  const { id: _, ...rest } = r;
  form.value = JSON.parse(JSON.stringify(rest));
}

async function createNew() {
  if (dirty.value && !(await confirmDialog('Есть несохранённые изменения — бросить?', { okText: 'Бросить' }))) return;
  selectedId.value = ''; isNew.value = true; notice.value = '';
  closePopup(); linkFrom.value = '';
  form.value = { id: '', title: '', stages: [], returns: [] };
}

// ── Клик по узлу схемы ──
function onNode(n, ev) {
  if (linkFrom.value) {
    // Режим связывания: клик по цели создаёт возврат.
    if (n.nid !== linkFrom.value) {
      form.value.returns.push({ from: linkFrom.value, to: n.nid, label: '✗' });
    }
    linkFrom.value = '';
    return;
  }
  const rect = canvasEl.value.getBoundingClientRect();
  popup.value = {
    nid: n.nid, mode: 'menu', insertAt: 0,
    x: Math.min(ev.clientX - rect.left + canvasEl.value.scrollLeft, canvasEl.value.scrollWidth - 290),
    y: ev.clientY - rect.top + canvasEl.value.scrollTop + 10,
  };
}

// ── Действия меню ──
function startInsert(offset) {
  const i = form.value.stages.indexOf(popup.value.nid);
  popup.value = { ...popup.value, mode: 'pick', insertAt: i + offset };
}
function startInsertFirst(ev) {
  const rect = canvasEl.value.getBoundingClientRect();
  popup.value = { nid: '', mode: 'pick', insertAt: 0, x: ev.clientX - rect.left, y: ev.clientY - rect.top + 10 };
}
function pickAgent(id) {
  form.value.stages.splice(popup.value.insertAt, 0, id);
  closePopup();
}
function startLink() {
  linkFrom.value = popup.value.nid;
  closePopup();
}
function removeNode() {
  const id = popup.value.nid;
  form.value.stages = form.value.stages.filter((s) => s !== id);
  form.value.returns = form.value.returns.filter((r) => r.from !== id && r.to !== id);
  closePopup();
}
function removeReturn(r) {
  form.value.returns = form.value.returns.filter((x) => x !== r);
}

// Закрытие: клик мимо попапа, Esc — и попап, и режим связывания.
function onDocDown(e) {
  if (popup.value && popupEl.value && !popupEl.value.contains(e.target)) closePopup();
}
function onKey(e) {
  if (e.key === 'Escape') { closePopup(); linkFrom.value = ''; }
}

async function save() {
  if (!form.value) return;
  saving.value = true; notice.value = '';
  try {
    if (isNew.value) {
      const created = await api.post(`/api/routes/${profile.value}`, form.value);
      isNew.value = false; selectedId.value = created.id;
    } else {
      await api.put(`/api/routes/${profile.value}/${selectedId.value}`, form.value);
    }
    await load();
    const cur = routes.value.find((r) => r.id === selectedId.value);
    if (cur) { const { id: _, ...rest } = cur; form.value = JSON.parse(JSON.stringify(rest)); }
    notice.value = 'Сохранено';
    setTimeout(() => { notice.value = ''; }, 2000);
  } catch (e) { notice.value = `Ошибка: ${e.message}`; }
  finally { saving.value = false; }
}

async function del() {
  if (!selectedId.value || isNew.value) return;
  if (!(await confirmDialog(`Удалить маршрут «${selectedId.value}»?`, { danger: true, okText: 'Удалить' }))) return;
  try {
    await api.del(`/api/routes/${profile.value}/${selectedId.value}`);
    selectedId.value = ''; form.value = null;
    await load();
  } catch (e) { notice.value = `Ошибка: ${e.message}`; }
}

onMounted(() => {
  load();
  document.addEventListener('mousedown', onDocDown);
  document.addEventListener('keydown', onKey);
});
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocDown);
  document.removeEventListener('keydown', onKey);
});
</script>

<template>
  <div class="routes-page">
    <!-- Список маршрутов -->
    <aside class="list">
      <div class="list-head">
        <span class="ttl">Маршруты</span>
        <button class="btn accent" @click="createNew">+ Новый</button>
      </div>
      <ProjectSwitcher :profiles="profiles" :model-value="profile"
                       @update:model-value="switchProfile" @created="onProjectCreated" />
      <div v-if="loading && !routes.length" class="pad muted"><span class="spin"></span> Загружаю…</div>
      <div v-else-if="error && !routes.length" class="pad bad">{{ error }}</div>
      <button v-for="r in routes" :key="r.id" class="item" :class="{ sel: r.id === selectedId && !isNew }" @click="select(r.id)">
        <span class="rid mono">{{ r.id }}</span>
        <span class="nm muted">{{ r.title }}</span>
        <span class="chip mono">{{ r.stages.length }}</span>
      </button>
    </aside>

    <!-- Конструктор -->
    <section v-if="form" class="editor">
      <header class="ehead">
        <template v-if="isNew">
          <input v-model.trim="form.id" class="fld idfld mono" placeholder="id (напр. hotfix)" spellcheck="false" />
        </template>
        <template v-else>
          <span class="eid mono">{{ selectedId }}</span>
        </template>
        <input v-model="form.title" class="fld titlefld" placeholder="Название (необязательно)" />
        <HelpTip :text="HELP_SCHEMA" />
        <span class="grow"></span>
        <span v-if="notice" class="notice" :class="{ bad: notice.startsWith('Ошибка') }">{{ notice }}</span>
        <button v-if="!isNew" class="btn danger" @click="del">Удалить</button>
        <button class="btn accent" :disabled="saving || !dirty || (isNew && !form.id)" @click="save">
          <span v-if="saving" class="spin"></span> Сохранить
        </button>
      </header>

      <!-- Баннер режима связывания -->
      <div v-if="linkFrom" class="linkbar">
        ↩ Возврат из «{{ agentsById[linkFrom]?.label || linkFrom }}» — кликни этап, куда возвращаться при провале.
        <span class="muted">Esc — отмена</span>
      </div>

      <!-- Схема = рабочее поле -->
      <div ref="canvasEl" class="canvas" :class="{ linking: linkFrom }">
        <FactoryGraph v-if="previewGraph" :graph="previewGraph" reference interactive @node="onNode" />
        <div v-else class="empty-canvas">
          <button class="btn accent big" @click="startInsertFirst">+ Первый этап</button>
        </div>

        <!-- Попап действий узла -->
        <div v-if="popup" ref="popupEl" class="popup" :style="{ left: popup.x + 'px', top: popup.y + 'px' }">
          <template v-if="popup.mode === 'menu'">
            <div class="phead">
              <span class="pic">{{ KIND_ICON[agentsById[popup.nid]?.kind] || '🤖' }}</span>
              <span class="pname">{{ agentsById[popup.nid]?.label || popup.nid }}</span>
            </div>
            <button class="pact" @click="startInsert(0)">⇤ Вставить этап до</button>
            <button class="pact" @click="startInsert(1)">⇥ Вставить этап после</button>
            <button class="pact" @click="startLink">↩ Возврат при провале…</button>
            <div v-if="popupReturns.length" class="prets">
              <div class="plbl">Возвраты отсюда</div>
              <div v-for="r in popupReturns" :key="r.to" class="pret">
                <span class="pto">→ {{ agentsById[r.to]?.label || r.to }}</span>
                <input v-model="r.label" class="fld plabel" placeholder="подпись" />
                <button class="x" title="Убрать возврат" @click="removeReturn(r)">✕</button>
              </div>
            </div>
            <button class="pact danger" @click="removeNode">✕ Убрать этап</button>
          </template>

          <template v-else>
            <div class="phead"><span class="pname">Какой этап вставить?</span></div>
            <input v-model="pickFilter" class="fld pfilter" placeholder="поиск по базе агентов…" />
            <div class="plist">
              <button v-for="a in pickList" :key="a.id" class="pact" @click="pickAgent(a.id)">
                <span class="pic">{{ KIND_ICON[a.kind] }}</span> {{ a.label || a.id }}
              </button>
              <div v-if="!pickList.length" class="muted pempty">Все агенты уже в цепочке</div>
            </div>
          </template>
        </div>
      </div>
    </section>

    <section v-else class="editor empty">
      <p class="muted">Выбери маршрут слева или создай новый</p>
    </section>
  </div>
</template>

<style scoped>
.routes-page { height: 100%; display: grid; grid-template-columns: 290px 1fr; min-height: 0; }

/* ── Список ── */
.list { border-right: 1px solid var(--line); background: var(--sidebar); overflow-y: auto; padding: 10px; }
.list-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 2px 4px 10px; }
.ttl { font-weight: 700; font-size: 13.5px; }
.item { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; background: none;
  border: none; color: var(--ink); padding: 8px; border-radius: 8px; cursor: pointer; font-size: 13px; }
.item:hover { background: var(--surface); }
.item.sel { background: color-mix(in srgb, var(--accent) 16%, transparent); }
.item .rid { flex: none; font-weight: 700; color: var(--node-code); font-size: 12.5px; }
.item .nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.chip { flex: none; font-size: 10px; color: var(--ink-mid); background: var(--surface-2);
  border: 1px solid var(--line); border-radius: 5px; padding: 1px 6px; }
.pad { padding: 12px 8px; }

/* ── Конструктор ── */
.editor { display: flex; flex-direction: column; min-width: 0; min-height: 0; padding: 12px 16px 16px; gap: 10px; }
.editor.empty { align-items: center; justify-content: center; }
.ehead { display: flex; align-items: center; gap: 10px; }
.eid { font-size: 14px; font-weight: 700; color: var(--node-code); }
.idfld { max-width: 200px; }
.titlefld { max-width: 340px; }
.grow { flex: 1; }
.notice { font-size: 12.5px; color: var(--good); }
.notice.bad { color: var(--bad); }

.linkbar { background: color-mix(in srgb, var(--bad) 12%, var(--surface)); border: 1px solid color-mix(in srgb, var(--bad) 40%, var(--line));
  color: var(--ink); border-radius: 9px; padding: 8px 12px; font-size: 12.5px; display: flex; gap: 10px; align-items: center; }

/* Схема — рабочее поле */
.canvas { position: relative; flex: 1; min-height: 0; overflow: auto; border: 1px solid var(--line);
  border-radius: 10px; background: var(--surface); padding: 14px; }
.canvas :deep(svg.graph) { min-width: 1700px; }
.canvas.linking :deep(.ng) { cursor: crosshair; }
.empty-canvas { height: 100%; display: flex; align-items: center; justify-content: center; }

/* Попап действий */
.popup { position: absolute; z-index: 40; width: 280px; background: var(--surface-2);
  border: 1px solid var(--line-2); border-radius: 11px; box-shadow: 0 14px 40px #000b; padding: 8px; }
.phead { display: flex; align-items: center; gap: 7px; padding: 4px 6px 8px; border-bottom: 1px solid var(--line); margin-bottom: 6px; }
.pic { font-size: 12px; }
.pname { font-weight: 700; font-size: 13px; }
.pact { display: flex; align-items: center; gap: 7px; width: 100%; text-align: left; background: none; border: none;
  color: var(--ink); padding: 7px 8px; border-radius: 7px; cursor: pointer; font-size: 12.5px; }
.pact:hover { background: color-mix(in srgb, var(--accent) 14%, transparent); }
.pact.danger { color: var(--bad); }
.pact.danger:hover { background: color-mix(in srgb, var(--bad) 12%, transparent); }

.prets { border-top: 1px solid var(--line); margin-top: 6px; padding-top: 6px; }
.plbl { font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--ink-mid); padding: 2px 6px 6px; }
.pret { display: flex; align-items: center; gap: 6px; padding: 2px 6px 6px; }
.pto { font-size: 12px; flex: none; max-width: 110px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.plabel { flex: 1; min-width: 0; padding: 4px 8px; font-size: 12px; }
.x { background: none; border: none; color: var(--ink-mid); cursor: pointer; font-size: 11px; padding: 2px 4px; }
.x:hover { color: var(--bad); }

.pfilter { width: 100%; margin-bottom: 6px; }
.plist { max-height: 260px; overflow-y: auto; }
.pempty { font-size: 12px; padding: 6px 8px; }

.fld { background: var(--surface); border: 1px solid var(--line); color: var(--ink); border-radius: 8px;
  padding: 7px 10px; font-size: 13px; font-family: inherit; }
.fld:focus { outline: none; border-color: var(--line-2); }

.btn { background: var(--surface-2); border: 1px solid var(--line); color: var(--ink); border-radius: 8px;
  padding: 7px 13px; font-size: 12.5px; cursor: pointer; white-space: nowrap; }
.btn:hover { border-color: var(--line-2); }
.btn:disabled { opacity: .45; cursor: default; }
.btn.accent { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 40%, var(--line)); }
.btn.danger { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 35%, var(--line)); }
.btn.big { padding: 10px 18px; font-size: 13.5px; }
.bad { color: var(--bad); }

@media (max-width: 820px) {
  .routes-page { grid-template-columns: 1fr; grid-template-rows: auto 1fr; }
  .list { border-right: none; border-bottom: 1px solid var(--line); max-height: 32vh; }
}
</style>
