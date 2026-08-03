<script setup>
import { ref, computed, watchEffect, onMounted, onUnmounted } from 'vue';
import { api } from '../shared/api-client.js';
import { confirmDialog } from '../shared/ui/confirm.js';
import { useUiContextStore } from '../stores/ui-context.js';
import FactoryGraph from './pipeline/FactoryGraph.vue';
import HelpTip from '../shared/ui/HelpTip.vue';
import ProjectSwitcher from '../shared/ui/ProjectSwitcher.vue';

// Маршруты проекта — ОПУБЛИКОВАННЫЙ каталог, а не редактируемая копия.
// Правится маршрут в самом профиле (routes/), кокпит даёт две кнопки —
// «Проверить» и «Опубликовать» — и список ревизий с откатом указателя.
// Редактора здесь нет намеренно: схема попытки закреплена хешем, и правка
// «на лету» означала бы, что бегущая задача идёт по одному, а показывается
// другое.
const profiles = ref([]);
const profile = ref(localStorage.getItem('cockpit-project') || '');
const loading = ref(true);
const error = ref('');
const publishSupported = ref(false);
const currentHash = ref(null);
const revisions = ref([]);
const selectedRoute = ref('');
const graph = ref(null);
const graphError = ref('');
const graphLoading = ref(false);
const busy = ref('');            // 'validate' | 'publish' | 'rollback'
const notice = ref('');
const report = ref(null);        // сырой ответ публикатора — в «подробностях»

const HELP_PANEL = 'Опубликованный маршрут неизменяем: попытка закрепляет хеш каталога и идёт по нему до конца, поэтому публикация не трогает то, что уже бежит, — она лишь добавляет ревизию и переводит указатель для новых попыток. Правка схемы — в профиле проекта (routes/), здесь только проверка, публикация и откат.';
const HELP_REVISIONS = 'Ревизия — слепок каталога, адресуемый хешем его содержимого. Откат переводит указатель current на выбранную ревизию: новые попытки пойдут по ней, уже бегущие останутся на своей.';

const ui = useUiContextStore();
watchEffect(() => { if (profile.value) ui.set('routes', { project: profile.value, route: selectedRoute.value || null }); });
onUnmounted(() => ui.clear('routes'));

const currentRevision = computed(() => revisions.value.find((r) => r.isCurrent) || null);
// Состав каталога: id маршрута → хеш его ревизии (пины каталога).
const routeList = computed(() => Object.entries(currentRevision.value?.routes || {})
  .map(([id, hash]) => ({ id, hash }))
  .sort((a, b) => a.id.localeCompare(b.id)));
const selected = computed(() => routeList.value.find((r) => r.id === selectedRoute.value) || null);
const published = computed(() => Boolean(currentHash.value));

function shortHash(hash) { return hash ? String(hash).slice(0, 12) : '—'; }
function fmtWhen(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}
function say(text, bad = false) {
  notice.value = bad ? `Ошибка: ${text}` : text;
  setTimeout(() => { if (notice.value.includes(text)) notice.value = ''; }, bad ? 8000 : 3000);
}

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
    if (!profile.value) return;
    const data = await api.get(`/api/routes/${profile.value}/revisions`);
    publishSupported.value = !!data.publishSupported;
    currentHash.value = data.currentCatalogHash;
    revisions.value = data.revisions || [];
    if (!routeList.value.some((r) => r.id === selectedRoute.value)) {
      selectedRoute.value = routeList.value[0]?.id || '';
    }
    await loadGraph();
  } catch (e) { error.value = e.message; }
  finally { loading.value = false; }
}

async function loadGraph() {
  graph.value = null; graphError.value = '';
  if (!selected.value) return;
  graphLoading.value = true;
  try {
    const { id, hash } = selected.value;
    // ?c=<catalogHash> в URL обязателен: когда-то схема отдавалась с immutable, и браузер
    // до сих пор может держать тот старый ответ по голому пути — иной query = промах кеша.
    graph.value = (await api.get(`/api/routes/${profile.value}/routes/${id}/${hash}/graph?c=${currentHash.value}`)).graph;
  } catch (e) { graphError.value = e.message; }
  finally { graphLoading.value = false; }
}

function selectRoute(id) {
  if (id === selectedRoute.value) return;
  selectedRoute.value = id;
  loadGraph();
}

function switchProfile(next) {
  if (next === profile.value) return;
  profile.value = next; localStorage.setItem('cockpit-project', next);
  selectedRoute.value = ''; graph.value = null; report.value = null; notice.value = '';
  revisions.value = []; currentHash.value = null;
  load();
}

function onProjectCreated({ id, profiles: fresh }) {
  if (fresh.length) profiles.value = fresh;
  switchProfile(id);
}

// Проверка и публикация делает сам профиль (routes/publish.mjs) — состав
// маршрутов, промпты и bootstrap знает только он. Кокпит передаёт ровно два
// своих аргумента: куда публиковать и поверх какой ревизии.
async function run(mode) {
  if (busy.value) return;
  if (mode === 'publish' && !(await confirmDialog(
    `Опубликовать каталог «${profile.value}»? Новые попытки пойдут по новой ревизии; уже бегущие останутся на своей.`,
    { okText: 'Опубликовать' },
  ))) return;
  busy.value = mode; notice.value = ''; report.value = null;
  try {
    const body = mode === 'publish'
      ? { mode, expectedCatalogHash: currentHash.value }
      : { mode };
    const res = await api.post(`/api/routes/${profile.value}/publish`, body);
    report.value = res.result;
    if (mode === 'publish') {
      await load();
      say(res.result?.catalogCreated === false
        ? 'Ревизия не изменилась — публиковать было нечего'
        : `Опубликовано: ${shortHash(res.result?.catalogHash)}`);
    } else {
      say('Проверка прошла');
    }
  } catch (e) { say(e.message, true); }
  finally { busy.value = ''; }
}

// Откат — тот же CAS, что и публикация: указатель двигается, только если он
// сейчас там, где мы думаем. Иначе кто-то опубликовал параллельно, и мы бы
// молча затёрли его ревизию.
async function rollback(rev) {
  if (busy.value || rev.isCurrent) return;
  if (!(await confirmDialog(
    `Перевести current на ревизию ${shortHash(rev.catalogHash)} от ${fmtWhen(rev.createdAt)}?`,
    { okText: 'Откатить' },
  ))) return;
  busy.value = 'rollback'; notice.value = '';
  try {
    await api.put(`/api/routes/${profile.value}/current`, {
      desiredCatalogHash: rev.catalogHash,
      expectedCatalogHash: currentHash.value,
    });
    await load();
    say(`Текущая ревизия — ${shortHash(rev.catalogHash)}`);
  } catch (e) { say(e.message, true); await load(); }
  finally { busy.value = ''; }
}

onMounted(load);
</script>

<template>
  <div class="routes-page">
    <!-- Состав опубликованного каталога -->
    <aside class="list">
      <div class="list-head">
        <span class="ttl">Маршруты</span>
        <HelpTip :text="HELP_PANEL" />
      </div>
      <ProjectSwitcher :profiles="profiles" :model-value="profile"
                       @update:model-value="switchProfile" @created="onProjectCreated" />
      <div v-if="loading && !revisions.length" class="pad muted"><span class="spin"></span> Загружаю…</div>
      <div v-else-if="error" class="pad bad">{{ error }}</div>
      <div v-else-if="!published" class="pad muted">Каталог не опубликован</div>
      <button v-for="r in routeList" :key="r.id" class="item" :class="{ sel: r.id === selectedRoute }"
              @click="selectRoute(r.id)">
        <span class="rid mono">{{ r.id }}</span>
        <span class="chip mono" :title="r.hash">{{ shortHash(r.hash) }}</span>
      </button>
    </aside>

    <section class="panel">
      <header class="phead">
        <span class="ttl">{{ profile || '—' }}</span>
        <span v-if="published" class="hash mono" :title="currentHash">current {{ shortHash(currentHash) }}</span>
        <span v-else class="muted">маршрутов ещё нет</span>
        <span class="grow"></span>
        <span v-if="notice" class="notice" :class="{ bad: notice.startsWith('Ошибка') }">{{ notice }}</span>
        <template v-if="publishSupported">
          <button class="btn" :disabled="!!busy" @click="run('validate')">
            <span v-if="busy === 'validate'" class="spin"></span> Проверить
          </button>
          <button class="btn accent" :disabled="!!busy" @click="run('publish')">
            <span v-if="busy === 'publish'" class="spin"></span> Опубликовать
          </button>
        </template>
        <span v-else class="muted nopub" title="Публикацию собирает сам профиль: profiles/&lt;проект&gt;/routes/publish.mjs">
          нет скрипта публикации
        </span>
      </header>

      <!-- Каталог ещё не опубликован: честно говорим, чего не хватает -->
      <div v-if="!published && !loading" class="hint">
        <p>У проекта нет опубликованного каталога маршрутов.</p>
        <p class="muted">Каталог собирает сам профиль: <span class="mono">routes/publish.mjs</span>.
          Как только он появится, здесь заработают проверка, публикация и откат.</p>
      </div>

      <!-- Схема выбранного маршрута — ровно та, по которой пойдёт попытка -->
      <div v-else class="canvas">
        <div v-if="graphLoading" class="mid muted"><span class="spin"></span> Схема…</div>
        <div v-else-if="graphError" class="mid bad">{{ graphError }}</div>
        <FactoryGraph v-else-if="graph" :graph="graph" reference />
        <div v-else class="mid muted">Выбери маршрут слева</div>
      </div>

      <!-- Ответ публикатора: показываем как есть, формат — его дело -->
      <details v-if="report" class="report">
        <summary>Отчёт публикатора</summary>
        <pre class="mono">{{ JSON.stringify(report, null, 2) }}</pre>
      </details>

      <!-- Ревизии и откат -->
      <section v-if="revisions.length" class="revs">
        <div class="revs-head">
          <span class="ttl">Ревизии каталога</span>
          <HelpTip :text="HELP_REVISIONS" />
          <span class="muted rcount">{{ revisions.length }}</span>
        </div>
        <div class="rrow" v-for="rev in revisions" :key="rev.catalogHash" :class="{ cur: rev.isCurrent }">
          <span class="rhash mono" :title="rev.catalogHash">{{ shortHash(rev.catalogHash) }}</span>
          <span class="rwhen muted">{{ fmtWhen(rev.createdAt) }}</span>
          <span v-if="rev.integrity !== 'ok'" class="rbad bad" :title="rev.integrity">повреждена</span>
          <span v-else class="rroutes muted">{{ Object.keys(rev.routes || {}).join(', ') }}</span>
          <span class="grow"></span>
          <span v-if="rev.isCurrent" class="rcur">current</span>
          <button v-else class="btn small" :disabled="!!busy || rev.integrity !== 'ok'" @click="rollback(rev)">
            Откатить
          </button>
        </div>
      </section>
    </section>
  </div>
</template>

<style scoped>
.routes-page { height: 100%; display: grid; grid-template-columns: 290px 1fr; min-height: 0; }

/* ── Состав каталога ── */
.list { border-right: 1px solid var(--line); background: var(--sidebar); overflow-y: auto; padding: 10px; }
.list-head { display: flex; align-items: center; gap: 8px; padding: 2px 4px 10px; }
.ttl { font-weight: 700; font-size: 13.5px; }
.item { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; background: none;
  border: none; color: var(--ink); padding: 8px; border-radius: 8px; cursor: pointer; font-size: 13px; }
.item:hover { background: var(--surface); }
.item.sel { background: color-mix(in srgb, var(--accent) 16%, transparent); }
.item .rid { flex: 1; min-width: 0; font-weight: 700; color: var(--node-code); font-size: 12.5px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chip { flex: none; font-size: 10px; color: var(--ink-mid); background: var(--surface-2);
  border: 1px solid var(--line); border-radius: 5px; padding: 1px 6px; }
.pad { padding: 12px 8px; }

/* ── Панель ── */
.panel { display: flex; flex-direction: column; min-width: 0; min-height: 0; padding: 12px 16px 16px; gap: 10px; }
.phead { display: flex; align-items: center; gap: 10px; }
.hash { font-size: 12px; color: var(--ink-mid); background: var(--surface-2); border: 1px solid var(--line);
  border-radius: 6px; padding: 3px 8px; }
.grow { flex: 1; }
.notice { font-size: 12.5px; color: var(--good); }
.notice.bad { color: var(--bad); }
.nopub { font-size: 12px; cursor: help; }

.hint { border: 1px solid var(--line); background: var(--surface); border-radius: 10px;
  padding: 14px 16px; font-size: 13px; line-height: 1.6; }
.hint p { margin: 0 0 6px; }
.hint p:last-child { margin: 0; }

.canvas { position: relative; flex: 1; min-height: 0; overflow: auto; border: 1px solid var(--line);
  border-radius: 10px; background: var(--surface); padding: 14px; }
.canvas :deep(svg.graph) { min-width: 1700px; }
.mid { height: 100%; display: flex; align-items: center; justify-content: center; gap: 8px; font-size: 13px; }

.report { border: 1px solid var(--line); border-radius: 10px; background: var(--surface); padding: 8px 12px; }
.report summary { cursor: pointer; font-size: 12.5px; }
.report pre { margin: 8px 0 4px; max-height: 220px; overflow: auto; font-size: 11.5px; line-height: 1.5;
  color: var(--ink-mid); }

/* ── Ревизии ── */
.revs { border: 1px solid var(--line); border-radius: 10px; background: var(--surface); padding: 10px 12px;
  max-height: 30vh; overflow-y: auto; flex: none; }
.revs-head { display: flex; align-items: center; gap: 8px; padding: 0 2px 8px; }
.rcount { font-size: 11.5px; }
.rrow { display: flex; align-items: center; gap: 10px; padding: 6px 4px; border-top: 1px solid var(--line);
  font-size: 12.5px; }
.rrow.cur { background: color-mix(in srgb, var(--good) 8%, transparent); }
.rhash { flex: none; color: var(--node-code); }
.rwhen { flex: none; font-size: 12px; }
.rroutes { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.rcur { font-size: 11.5px; color: var(--good); }
.rbad { font-size: 12px; }

.btn { background: var(--surface-2); border: 1px solid var(--line); color: var(--ink); border-radius: 8px;
  padding: 7px 13px; font-size: 12.5px; cursor: pointer; white-space: nowrap; }
.btn:hover { border-color: var(--line-2); }
.btn:disabled { opacity: .45; cursor: default; }
.btn.accent { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 40%, var(--line)); }
.btn.small { padding: 4px 10px; font-size: 12px; }
.bad { color: var(--bad); }

@media (max-width: 820px) {
  .routes-page { grid-template-columns: 1fr; grid-template-rows: auto 1fr; }
  .list { border-right: none; border-bottom: 1px solid var(--line); max-height: 32vh; }
}
</style>
