<template>
  <div class="routes-page">
    <!-- Состав опубликованного каталога -->
    <aside class="list">
      <div class="list-head">
        <span class="ttl">Маршруты</span>
        <UiTooltip :text="helpPanel" />
      </div>
      <ProjectSwitcher :profiles="profiles" :model-value="profile"
                       @update:model-value="switchProfile" @created="onProjectCreated" />
      <div v-if="loading && !revisions.length" class="pad muted"><UiSpinner decorative /> Загружаю…</div>
      <div v-else-if="error" class="pad bad">{{ error }}</div>
      <div v-else-if="!published" class="pad muted">Каталог не опубликован</div>
      <UiSelectableRow v-for="r in routeList" :key="r.id" class="item"
                       :selected="r.id === selectedRoute" @select="selectRoute(r.id)">
        <span class="route-item-content">
          <span class="rid mono">{{ r.id }}</span>
          <span class="chip mono" :title="r.hash">{{ shortHash(r.hash) }}</span>
        </span>
      </UiSelectableRow>
    </aside>

    <section class="panel">
      <header class="phead">
        <span class="ttl">{{ profile || '—' }}</span>
        <span v-if="published" class="hash mono" :title="currentHash ?? undefined">current {{ shortHash(currentHash) }}</span>
        <span v-else class="muted">маршрутов ещё нет</span>
        <span class="grow"></span>
        <span v-if="notice" class="notice" :class="{ bad: notice.startsWith('Ошибка') }">{{ notice }}</span>
        <template v-if="publishSupported">
          <UiButton class="btn" :loading="busy === 'validate'" :disabled="!!busy && busy !== 'validate'"
                    loading-label="Проверяю" @click="run('validate')">Проверить</UiButton>
          <UiButton class="btn accent" tone="accent" :loading="busy === 'publish'"
                    :disabled="!!busy && busy !== 'publish'" loading-label="Публикую"
                    @click="run('publish')">Опубликовать</UiButton>
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
        <div v-if="graphLoading" class="mid muted"><UiSpinner decorative /> Схема…</div>
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
          <UiTooltip :text="helpRevisions" />
          <span class="muted rcount">{{ revisions.length }}</span>
        </div>
        <div class="rrow" v-for="rev in revisions" :key="rev.catalogHash" :class="{ cur: rev.isCurrent }">
          <span class="rhash mono" :title="rev.catalogHash">{{ shortHash(rev.catalogHash) }}</span>
          <span class="rwhen muted">{{ fmtWhen(rev.createdAt) }}</span>
          <span v-if="rev.integrity !== 'ok'" class="rbad bad" :title="rev.integrity">повреждена</span>
          <span v-else class="rroutes muted">{{ Object.keys(rev.routes || {}).join(', ') }}</span>
          <span class="grow"></span>
          <span v-if="rev.isCurrent" class="rcur">current</span>
          <UiButton v-else class="btn" :disabled="!!busy || rev.integrity !== 'ok'" @click="rollback(rev)">
            Откатить
          </UiButton>
        </div>
      </section>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';

import type { FactoryGraphData } from '../../../shared/factoryGraphContracts.ts';
import type { RouteRevision } from '../../../shared/routesContracts.ts';
import { publishSummary } from '../../../shared/routesContracts.ts';
import { failureText } from '../shared/apiClient.ts';
import { routesApi } from '../shared/routesApi.ts';
import {
  UiButton,
  UiSelectableRow,
  UiSpinner,
  UiTooltip,
  confirmDialog,
} from '../ui';
import { useUiContextSource } from '../composables/useUiContextSource.ts';
import ProjectSwitcher from '../features/projects/ProjectSwitcher.vue';
import FactoryGraph from './pipeline/FactoryGraph.vue';

// Маршруты проекта — ОПУБЛИКОВАННЫЙ каталог, а не редактируемая копия.
// Правится маршрут в самом профиле (routes/), кокпит даёт две кнопки —
// «Проверить» и «Опубликовать» — и список ревизий с откатом указателя.
// Редактора здесь нет намеренно: схема попытки закреплена хешем, и правка
// «на лету» означала бы, что бегущая задача идёт по одному, а показывается
// другое.

// Строка списка маршрутов: id и хеш его ревизии из состава каталога.
interface RouteEntry {
  id: string;
  hash: string;
}

// Что сейчас делает кнопка. Пустая строка — ничего: раздел не занят.
type BusyMode = '' | 'validate' | 'publish' | 'rollback';

const PROJECT_KEY = 'cockpit-project';

const profiles = ref<string[]>([]);
const profile = ref(localStorage.getItem(PROJECT_KEY) || '');
const loading = ref(true);
const error = ref('');
const publishSupported = ref(false);
const currentHash = ref<string | null>(null);
const revisions = ref<RouteRevision[]>([]);
const selectedRoute = ref('');
const graph = ref<FactoryGraphData | null>(null);
const graphError = ref('');
const graphLoading = ref(false);
const busy = ref<BusyMode>('');
const notice = ref('');
// Сырой ответ публикатора — его показывают в «подробностях» как есть: формат
// принадлежит скрипту профиля, и толковать его кокпит не вправе.
const report = ref<Record<string, unknown> | null>(null);

const helpPanel = 'Опубликованный маршрут неизменяем: попытка закрепляет хеш каталога'
  + ' и идёт по нему до конца, поэтому публикация не трогает то, что уже бежит, — она'
  + ' лишь добавляет ревизию и переводит указатель для новых попыток. Правка схемы —'
  + ' в профиле проекта (routes/), здесь только проверка, публикация и откат.';
const helpRevisions = 'Ревизия — слепок каталога, адресуемый хешем его содержимого.'
  + ' Откат переводит указатель current на выбранную ревизию: новые попытки пойдут'
  + ' по ней, уже бегущие останутся на своей.';

const routesContext = useUiContextSource('routes', { layer: 'page', active: false });

watch([profile, selectedRoute], ([project, route], previous) => {
  // Первый вызов с `immediate` приходит без прошлых значений: смена проекта тогда
  // ещё не «смена», и фокус контекста забирается заново, а не обновляется.
  const previousProject = previous?.[0];

  if (!project) {
    routesContext.blur();

    return;
  }

  const next = { details: { project, route: route || null } };

  if (project !== previousProject) {
    routesContext.focus(next);
  } else {
    routesContext.update(next);
  }
}, { immediate: true });

const currentRevision = computed(() => (
  revisions.value.find((revision) => revision.isCurrent) || null
));

// Состав каталога: id маршрута → хеш его ревизии (пины каталога).
const routeList = computed<RouteEntry[]>(() => Object.entries(currentRevision.value?.routes || {})
  .map(([id, hash]) => ({ id, hash }))
  .sort((left, right) => left.id.localeCompare(right.id)));

const selected = computed(() => (
  routeList.value.find((route) => route.id === selectedRoute.value) || null
));

const published = computed(() => Boolean(currentHash.value));

function shortHash(hash: string | null | undefined): string {
  return hash ? String(hash).slice(0, 12) : '—';
}

/** Дата ревизии человеку. Непонятная строка показывается прочерком, а не «Invalid Date». */
function fmtWhen(iso: string): string {
  const date = new Date(iso);

  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Короткое сообщение в шапке. Оно гасится само, но только если его не сменили: иначе
 * старый таймер стёр бы уже другое, более свежее сообщение.
 */
function say(text: string, bad = false): void {
  notice.value = bad ? `Ошибка: ${text}` : text;
  setTimeout(() => {
    if (notice.value.includes(text)) {
      notice.value = '';
    }
  }, bad ? 8000 : 3000);
}

/**
 * Схема выбранного маршрута. Отдельный отказ: недоступная схема не должна выглядеть
 * как недоступный раздел — список ревизий при этом остаётся рабочим.
 */
async function loadGraph(): Promise<void> {
  graph.value = null;
  graphError.value = '';

  const route = selected.value;

  if (!route) {
    return;
  }

  graphLoading.value = true;

  try {
    graph.value = await routesApi.graph(profile.value, route.id, route.hash, currentHash.value);
  } catch (failure) {
    graphError.value = failureText(failure);
  } finally {
    graphLoading.value = false;
  }
}

/**
 * Читает список профилей (один раз) и ревизии выбранного. Выбор маршрута сохраняется,
 * пока он есть в каталоге: после публикации человек ожидает остаться там же, где был.
 */
async function load(): Promise<void> {
  loading.value = true;
  error.value = '';

  try {
    if (!profiles.value.length) {
      profiles.value = await routesApi.profiles();

      const first = profiles.value[0];

      if (first && !profiles.value.includes(profile.value)) {
        profile.value = first;
        localStorage.setItem(PROJECT_KEY, first);
      }
    }
    if (!profile.value) {
      return;
    }

    const data = await routesApi.revisions(profile.value);

    publishSupported.value = data.publishSupported;
    currentHash.value = data.currentCatalogHash;
    revisions.value = data.revisions;

    if (!routeList.value.some((route) => route.id === selectedRoute.value)) {
      selectedRoute.value = routeList.value[0]?.id || '';
    }

    await loadGraph();
  } catch (failure) {
    error.value = failureText(failure);
  } finally {
    loading.value = false;
  }
}

function selectRoute(id: string): void {
  if (id === selectedRoute.value) {
    return;
  }

  selectedRoute.value = id;
  loadGraph();
}

/**
 * Смена проекта сбрасывает ВСЁ показанное. Чужая схема, чужой отчёт публикации и
 * чужой хеш каталога рядом с новым именем читаются как свои — и человек принимает
 * решение по данным другого проекта.
 */
function switchProfile(next: string): void {
  if (next === profile.value) {
    return;
  }

  profile.value = next;
  localStorage.setItem(PROJECT_KEY, next);
  selectedRoute.value = '';
  graph.value = null;
  report.value = null;
  notice.value = '';
  revisions.value = [];
  currentHash.value = null;
  load();
}

function onProjectCreated({ id, profiles: fresh }: { id: string; profiles: string[] }): void {
  if (fresh.length) {
    profiles.value = fresh;
  }

  switchProfile(id);
}

/**
 * Проверка и публикация делает сам профиль (routes/publish.mjs) — состав маршрутов,
 * промпты и bootstrap знает только он. Кокпит передаёт ровно два своих аргумента:
 * куда публиковать и поверх какой ревизии.
 */
async function run(mode: 'validate' | 'publish'): Promise<void> {
  if (busy.value) {
    return;
  }
  if (mode === 'publish') {
    const confirmed = await confirmDialog(
      `Опубликовать каталог «${profile.value}»? Новые попытки пойдут по новой ревизии;`
      + ' уже бегущие останутся на своей.',
      { okText: 'Опубликовать' },
    );

    if (!confirmed) {
      return;
    }
  }

  busy.value = mode;
  notice.value = '';
  report.value = null;

  try {
    const response = await routesApi.publish(profile.value, mode, currentHash.value);

    report.value = response.result;

    if (mode === 'publish') {
      const summary = publishSummary(response.result);

      await load();
      say(summary.catalogCreated === false
        ? 'Ревизия не изменилась — публиковать было нечего'
        : `Опубликовано: ${shortHash(summary.catalogHash)}`);
    } else {
      say('Проверка прошла');
    }
  } catch (failure) {
    say(failureText(failure), true);
  } finally {
    busy.value = '';
  }
}

/**
 * Откат — тот же CAS, что и публикация: указатель двигается, только если он сейчас
 * там, где мы думаем. Иначе кто-то опубликовал параллельно, и мы бы молча затёрли
 * его ревизию. После отказа список перечитывается: он уже другой.
 */
async function rollback(revision: RouteRevision): Promise<void> {
  if (busy.value || revision.isCurrent) {
    return;
  }

  const confirmed = await confirmDialog(
    `Перевести current на ревизию ${shortHash(revision.catalogHash)}`
    + ` от ${fmtWhen(revision.createdAt)}?`,
    { okText: 'Откатить' },
  );

  if (!confirmed) {
    return;
  }

  busy.value = 'rollback';
  notice.value = '';

  try {
    await routesApi.rollback(profile.value, revision.catalogHash, currentHash.value);
    await load();
    say(`Текущая ревизия — ${shortHash(revision.catalogHash)}`);
  } catch (failure) {
    say(failureText(failure), true);
    await load();
  } finally {
    busy.value = '';
  }
}

onMounted(load);
</script>

<style scoped>
.routes-page { height: 100%; display: grid; grid-template-columns: 290px 1fr; min-height: 0; }

/* ── Состав каталога ── */
.list { border-right: 1px solid var(--line); background: var(--sidebar); overflow-y: auto; padding: 10px; }
.list-head { display: flex; align-items: center; gap: 8px; padding: 2px 4px 10px; }
.ttl { font-weight: 700; font-size: 13.5px; }
.item { width: 100%; margin-bottom: 4px; }
.route-item-content { display: flex; align-items: center; gap: 8px; width: 100%; min-width: 0; }
.route-item-content .rid { flex: 1; min-width: 0; font-weight: 700; color: var(--node-code); font-size: 12.5px;
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

.bad { color: var(--bad); }

@media (max-width: 820px) {
  .routes-page { grid-template-columns: 1fr; grid-template-rows: auto 1fr; }
  .list { border-right: none; border-bottom: 1px solid var(--line); max-height: 32vh; }
}
</style>
