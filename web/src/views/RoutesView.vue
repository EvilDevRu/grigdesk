<template>
  <div class="routes-page">
    <!-- Черновики и состав опубликованного каталога -->
    <aside class="list">
      <div class="list-head">
        <span class="ttl">Маршруты</span>
        <UiTooltip :text="helpPanel" />
      </div>
      <ProjectSwitcher :profiles="profiles" :model-value="profile"
                       @update:model-value="switchProfile" @create="openProjectCreate" />
      <UiButton v-if="profile" class="btn" :disabled="!pageReady" @click="createEditorDraft">
        {{ currentHash ? 'Создать черновик из current' : 'Создать черновик' }}
      </UiButton>
      <RouteCatalog :drafts="routesStore.draftsProfile === profile ? routesStore.drafts : []"
                    :selected-draft-id="routesStore.opened?.draftId ?? null"
                    :document="routesStore.opened?.draftId && !routesStore.opened.readOnly
                      ? routesStore.localDocument : null"
                    :selected-route-id="selectedRoute"
                    @select="openDraft" @change="replaceEditorDocument"
                    @select-route="selectRoute" @select-bootstrap="selectBootstrap" />
      <div v-if="loading && !revisions.length" class="pad muted"><UiSpinner decorative /> Загружаю…</div>
      <div v-else-if="error" class="pad bad">{{ error }}</div>
      <div v-else-if="!published" class="pad muted">Каталог не опубликован</div>
      <UiSelectableRow v-for="r in displayRouteList" :key="r.id" class="item"
                       :selected="r.id === selectedRoute" @select="selectRoute(r.id)">
        <span class="route-item-content">
          <span class="rid mono">{{ r.id }}</span>
          <span v-if="r.hash" class="chip mono" v-tooltip="r.hash">{{ shortHash(r.hash) }}</span>
        </span>
      </UiSelectableRow>
    </aside>

    <section class="panel" @keydown="onEditorKeydown">
      <div v-if="editorQueryError || routesStore.error" class="bad" role="alert">
        {{ editorQueryError || routesStore.error }}
      </div>
      <div v-if="routesStore.saveError" class="bad" role="alert">{{ routesStore.saveError }}</div>
      <div v-if="routesStore.publicationError" class="bad" role="alert">
        {{ routesStore.publicationError }}
        <UiButton v-if="routesStore.publicationOutcome === 'unknown'"
                  @click="checkEditorPublication">Проверить результат</UiButton>
      </div>
      <RouteConflictPanel v-if="routesStore.conflict" @copy="copyConflictedDraft"
                          @reload="reloadConflictedDraft" />
      <template v-if="routesStore.opened?.draftId && routesStore.localDocument && !editorQueryError">
        <RouteEditorHeader :document="routesStore.localDocument"
                           :read-only="routesStore.opened.readOnly"
                           :saved="!routesStore.dirty" :saving="routesStore.saving"
                           @save="saveDraft" />
        <div class="route-editor-actions">
          <UiButton :disabled="!routesStore.historyPast.length" @click="undoDraft">Отменить</UiButton>
          <UiButton :disabled="!routesStore.historyFuture.length" @click="redoDraft">Повторить</UiButton>
          <UiButton :disabled="routesStore.saving || routesStore.conflict
                    || Boolean(routesStore.jsonBuffer?.dirty)"
                    @click="validateDraft">Проверить черновик</UiButton>
          <UiButton v-if="selectedTab !== 'json'" data-test="route-json-tab"
                    @click="openJsonTab">JSON-режим</UiButton>
          <UiButton v-else data-test="route-form-tab" @click="openFormsTab">
            Вернуться к формам
          </UiButton>
          <UiButton :disabled="!routesStore.canPublish" @click="compareDraft">
            Сравнить с current
          </UiButton>
          <UiButton v-if="currentHash && routesStore.serverSnapshot?.baseCatalogHash !== currentHash"
                    data-test="preview-rebase"
                    :disabled="routesStore.dirty || routesStore.saving || routesStore.conflict
                      || Boolean(routesStore.jsonBuffer?.dirty)
                      || routesStore.rebaseBusy" @click="previewDraftRebase">
            Перенести на current
          </UiButton>
        </div>
        <p v-if="routesStore.rebaseError" class="bad" role="alert">{{ routesStore.rebaseError }}</p>
        <RouteRebaseDialog v-if="routesStore.rebasePreview"
                           :preview="routesStore.rebasePreview"
                           :busy="routesStore.rebaseBusy"
                           @confirm="confirmDraftRebase" @cancel="cancelDraftRebase" />
        <RouteProblems v-if="routesStore.validatedRevision !== null"
                       :issues="routesStore.validationIssues"
                       :stale="routesStore.validatedGeneration !== routesStore.editGeneration
                         || routesStore.validatedRevision !== routesStore.serverSnapshot?.revision"
                       @focus="focusProblem" />
        <RouteJsonEditor v-if="selectedTab === 'json' && routesStore.jsonBuffer"
                         :buffer="routesStore.jsonBuffer"
                         :issues="routesStore.validationIssues"
                         :read-only="routesStore.opened.readOnly"
                         @update:raw="updateJsonDraftBuffer"
                         @format="formatJsonDraftBuffer"
                         @apply="applyJsonDraftBuffer" />
        <RouteBootstrapEditor v-else-if="route.query.scope === 'bootstrap'"
                              :document="routesStore.localDocument"
                              :selected-node-id="selectedNode"
                              :focused-issue="focusedProblem"
                              :capabilities="routesStore.editorInfo?.capabilities ?? null"
                              :templates="templates"
                              @select-node="selectCanvasNode"
                              @change="replaceEditorDocument"
                              @prompt-change="changeBootstrapPrompt"
                              @end-history-group="endHistoryGroup" @save="saveDraft" />
        <RoutePromptEditor v-else-if="selectedTab === 'prompt' && selectedRoute && selectedNode"
                           :document="routesStore.localDocument" :route-id="selectedRoute"
                           :node-id="selectedNode" :templates="templates"
                           :focus-path="focusedProblemPath"
                           @change="changePrompt" @save="saveDraft"
                           @end-history-group="endHistoryGroup" />
        <div v-else-if="selectedRoute" class="route-editor-workspace">
          <RouteCanvas :document="routesStore.localDocument"
                       :scope="{ kind: 'route', routeId: selectedRoute }"
                       :selected-node-id="selectedNode" :focused-issue="focusedProblem"
                       @select-node="selectCanvasNode" @change="replaceEditorDocument" />
          <div class="route-editor-workspace__sidebar">
            <RouteStageList :document="routesStore.localDocument"
                            :scope="{ kind: 'route', routeId: selectedRoute }"
                            :selected-node-id="selectedNode"
                            @select-node="selectCanvasNode" @change="replaceEditorDocument" />
          <div v-if="selectedNode" class="route-editor-inspectors">
            <RouteNodeInspector :document="routesStore.localDocument"
                                :scope="{ kind: 'route', routeId: selectedRoute }"
                                :node-id="selectedNode"
                                :capabilities="routesStore.editorInfo?.capabilities ?? null"
                                @change="replaceEditorDocument"
                                @select-node="selectCanvasNode" />
            <RouteTransitionInspector :document="routesStore.localDocument"
                                      :scope="{ kind: 'route', routeId: selectedRoute }"
                                      :node-id="selectedNode"
                                      @change="replaceEditorDocument" />
          </div>
          </div>
          <RouteDraftPanel :document="routesStore.localDocument" :route-id="selectedRoute"
                           @select-node="openPrompt" />
        </div>
        <p v-else class="muted">Публикация недоступна: сначала добавьте маршрут и его инструкции.</p>
        <p v-if="routesStore.promptPreviewError" class="bad" role="alert">
          {{ routesStore.promptPreviewError }}
        </p>
        <RoutePromptPreview v-if="selectedAgentNode"
                            :result="selectedPromptPreview?.result ?? null"
                            :stale="selectedPromptPreview?.stale ?? false"
                            :busy="routesStore.promptPreviewBusy"
                            @request="previewSelectedPrompt" />
        <p v-if="routesStore.simulationError" class="bad" role="alert">
          {{ routesStore.simulationError }}
        </p>
        <RouteSimulation v-if="routesStore.serverSnapshot"
                         :document="routesStore.serverSnapshot"
                         :simulation="routesStore.simulation"
                         @start="startRouteSimulation" @step="stepRouteSimulation"
                         @approve="approveRouteSimulation" />
        <RouteTransferDialog v-if="routesStore.serverSnapshot"
                             :document="routesStore.serverSnapshot"
                             :profiles="profiles" :dirty="routesStore.dirty || routesStore.saving
                               || routesStore.conflict || Boolean(routesStore.jsonBuffer?.dirty)"
                             @open="openTransferredDraft" />
        <template v-if="routesStore.compareReport
          && routesStore.compareGeneration === routesStore.editGeneration">
          <UiButton v-if="routesStore.compareReport.sourceMode === 'profile-script'"
                    @click="switchToEditorSource">Сделать редактор источником маршрутов</UiButton>
          <RouteCompare :report="routesStore.compareReport"
                        :can-publish="routesStore.canConfirmPublish"
                        @publish="publishDialogOpen = true" />
        </template>
        <RoutePublishDialog v-if="publishDialogOpen && routesStore.compareReport"
                            :report="routesStore.compareReport"
                            :can-publish="routesStore.canConfirmPublish"
                            :busy="routesStore.publicationOutcome === 'pending'"
                            @confirm="confirmEditorPublish"
                            @cancel="publishDialogOpen = false" />
      </template>
      <template v-else-if="routesStore.opened?.catalogHash && routesStore.publishedSnapshot && !editorQueryError">
        <header class="route-readonly-head">
          <strong>Опубликованный каталог {{ shortHash(routesStore.opened.catalogHash) }}</strong>
          <span class="muted">Только просмотр</span>
          <span v-if="routesStore.editorInfo?.source.mode === 'editor'" class="muted">
            источник маршрутов — редактор
          </span>
        </header>
        <div v-if="graphLoading" class="mid muted"><UiSpinner decorative /> Схема…</div>
        <div v-else-if="graphError" class="mid bad" role="alert">{{ graphError }}</div>
        <FactoryGraph v-else-if="graph" :graph="graph" reference />
        <RouteDraftPanel v-if="selectedRoute" :document="routesStore.publishedSnapshot"
                         :route-id="selectedRoute" />
      </template>
      <template v-else>
      <header class="phead">
        <span class="ttl">{{ profile || '—' }}</span>
        <span v-if="published" class="hash mono" v-tooltip="currentHash ?? undefined">current {{ shortHash(currentHash) }}</span>
        <span v-else class="muted">маршрутов ещё нет</span>
        <span class="grow"></span>
        <span v-if="notice" class="notice" :class="{ bad: notice.startsWith('Ошибка') }">{{ notice }}</span>
        <template v-if="publishSupported && routesStore.editorInfo?.source.mode !== 'editor'">
          <UiButton class="btn" :loading="busy === 'validate'" :disabled="!!busy && busy !== 'validate'"
                    loading-label="Проверяю" @click="run('validate')">Проверить</UiButton>
          <UiButton class="btn accent" tone="accent" :loading="busy === 'publish'"
                    :disabled="!!busy && busy !== 'publish'" loading-label="Публикую"
                    @click="run('publish')">Опубликовать</UiButton>
        </template>

        <span v-else-if="routesStore.editorInfo?.source.mode === 'editor'" class="muted nopub">
          источник маршрутов — редактор
        </span>
        <span v-else class="muted nopub" v-tooltip="'Публикацию собирает сам профиль: profiles/&lt;проект&gt;/routes/publish.mjs'">
          нет скрипта публикации
        </span>
      </header>

      <!-- Каталог ещё не опубликован: подсказываем доступный способ публикации -->
      <div v-if="!published && !loading" class="hint">
        <p>У проекта нет опубликованного каталога маршрутов.</p>
        <p v-if="routesStore.editorInfo?.source.mode === 'editor'" class="muted">
          Создайте черновик, заполните маршрут и инструкции, проверьте и опубликуйте его здесь.
        </p>
        <p v-else class="muted">Каталог можно подготовить через скрипт профиля
          <span class="mono">routes/publish.mjs</span> или создать черновик в редакторе.</p>
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
      </template>

      <RouteRevisionHistory v-if="revisions.length" :revisions="revisions" :busy="!!busy || !pageReady"
                            v-tooltip="helpRevisions" @view="viewRevision"
                            @create="createFromRevision" @compare="compareRevision"
                            @rollback="rollback" />
      <RouteCompare v-if="historyCompareReport" :report="historyCompareReport"
                    :can-publish="false" />
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { useRoute, useRouter, onBeforeRouteLeave, onBeforeRouteUpdate } from 'vue-router';

import type { FactoryGraphData } from '../../../shared/factoryGraphContracts.ts';
import type { RouteRevision } from '../../../shared/routesContracts.ts';
import type { AgentCard } from '../../../shared/agentsContracts.ts';
import type { RouteDraft, RouteRebaseResolution,
  RouteRevisionCompareReport } from '../../../shared/routesEditorContracts.ts';
import type { RouteEditorIssue } from '../../../shared/routesEditorContracts.ts';
import { publishSummary } from '../../../shared/routesContracts.ts';
import { failureText } from '../shared/apiClient.ts';
import { routesApi } from '../shared/routesApi.ts';
import type { DraftCreateRequest } from '../shared/routesApi.ts';
import { agentsApi } from '../shared/agentsApi.ts';
import {
  UiButton,
  UiSelectableRow,
  UiSpinner,
  UiTooltip,
  confirmDialog,
  vTooltip,
} from '../ui';
import { useUiContextSource } from '../composables/useUiContextSource.ts';
import ProjectSwitcher from '../features/projects/ProjectSwitcher.vue';
import FactoryGraph from './pipeline/FactoryGraph.vue';
import RouteCatalog from './routes/RouteCatalog.vue';
import RouteBootstrapEditor from './routes/RouteBootstrapEditor.vue';
import RouteDraftPanel from './routes/RouteDraftPanel.vue';
import RouteEditorHeader from './routes/RouteEditorHeader.vue';
import RouteConflictPanel from './routes/RouteConflictPanel.vue';
import RoutePromptEditor from './routes/RoutePromptEditor.vue';
import RouteProblems from './routes/RouteProblems.vue';
import RouteCompare from './routes/RouteCompare.vue';
import RouteRevisionHistory from './routes/RouteRevisionHistory.vue';
import RouteRebaseDialog from './routes/RouteRebaseDialog.vue';
import RoutePromptPreview from './routes/RoutePromptPreview.vue';
import RouteSimulation from './routes/RouteSimulation.vue';
import RouteTransferDialog from './routes/RouteTransferDialog.vue';
import RouteJsonEditor from './routes/RouteJsonEditor.vue';
import RoutePublishDialog from './routes/RoutePublishDialog.vue';
import RouteCanvas from './routes/RouteCanvas.vue';
import RouteStageList from './routes/RouteStageList.vue';
import RouteNodeInspector from './routes/RouteNodeInspector.vue';
import RouteTransitionInspector from './routes/RouteTransitionInspector.vue';
import type { RouteCommandScope } from './routes/routeCommands.ts';
import { historyShortcut } from '../actions/routes/history.ts';
import {
  useRoutesStore,
  loadDraft as loadEditorDraft,
  loadCatalog,
  loadDrafts,
  loadEditor,
  createDraft as createEditorDocument,
  closeDraft,
  saveDraft,
  saveConflictCopy,
  reloadConflict,
  watchRoutes,
  stopWatchingRoutes,
  applyLocalChange,
  undoDraft,
  redoDraft,
  endHistoryGroup,
  confirmDirtyRouteExit,
  validateDraft,
  compareDraft,
  enableEditorSource,
  publishComparedDraft,
  checkPublicationOutcome,
  previewDraftRebase,
  applyDraftRebase,
  cancelDraftRebase,
  previewRoutePrompt,
  startRouteSimulation,
  stepRouteSimulation,
  approveRouteSimulation,
  openJsonDraftBuffer,
  updateJsonDraftBuffer,
  formatJsonDraftBuffer,
  applyJsonDraftBuffer,
} from '../actions/routes';

// Редактор меняет полный черновик каталога; опубликованные бандлы остаются
// неизменяемыми. Попытки закрепляют точный хеш каталога при запуске.

// Строка списка маршрутов: id и хеш его ревизии из состава каталога.
interface RouteEntry {
  id: string;
  hash: string;
}

// Что сейчас делает кнопка. Пустая строка — ничего: раздел не занят.
type BusyMode = '' | 'validate' | 'publish' | 'rollback';

const PROJECT_KEY = 'cockpit-project';
const DRAFT_ID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const CATALOG_HASH_RE = /^[a-f0-9]{64}$/;

const profiles = ref<string[]>([]);
const route = useRoute();
const profile = ref(typeof route.query.profile === 'string'
  ? route.query.profile : localStorage.getItem(PROJECT_KEY) || '');
const routesStore = useRoutesStore();
const editorQueryError = ref('');
const loading = ref(true);
// Создавать черновик можно после начальной загрузки проекта: иначе она, дочитав адрес
// без черновика, закрывает документ и отбрасывает ответ только что начатого создания.
const pageReady = ref(false);
const error = ref('');
const publishSupported = ref(false);
const currentHash = ref<string | null>(null);
const revisions = ref<RouteRevision[]>([]);
const historyCompareReport = ref<RouteRevisionCompareReport | null>(null);
const selectedRoute = ref('');
const selectedNode = ref('');
const templates = ref<AgentCard[]>([]);
const templatesLoaded = ref(false);
const selectedTab = computed(() => route.query.tab === 'prompt' ? 'prompt'
  : route.query.tab === 'json' ? 'json' : 'graph');
const selectedAgentNode = computed(() => {
  const document = routesStore.localDocument;

  if (!document || !selectedNode.value) {
    return false;
  }

  const machine = route.query.scope === 'bootstrap' ? document.bootstrap
    : document.routes[selectedRoute.value]?.route;

  return machine?.nodes.some((node) => node.id === selectedNode.value
    && node.executor === 'agent') ?? false;
});
const selectedPromptPreview = computed(() => {
  const preview = routesStore.promptPreview;
  const bootstrap = route.query.scope === 'bootstrap';

  if (!preview || preview.scope !== (bootstrap ? 'bootstrap' : 'route')
    || preview.routeId !== (bootstrap ? null : selectedRoute.value)
    || preview.nodeId !== selectedNode.value) {
    return null;
  }

  return preview;
});
const publishDialogOpen = ref(false);
const focusedProblemPath = ref('');
const focusedProblem = ref<RouteEditorIssue | null>(null);
const graph = ref<FactoryGraphData | null>(null);
const graphError = ref('');
const graphLoading = ref(false);
const busy = ref<BusyMode>('');
const notice = ref('');
// Сырой ответ публикатора — его показывают в «подробностях» как есть: формат
// принадлежит скрипту профиля, и толковать его кокпит не вправе.
const report = ref<Record<string, unknown> | null>(null);

const helpPanel = 'Черновик можно редактировать и проверять до публикации.'
  + ' Опубликованный каталог неизменяем: попытка закрепляет его хеш и идёт по нему'
  + ' до конца. Публикация добавляет ревизию для новых попыток.';
const helpRevisions = 'Ревизия — слепок каталога, адресуемый хешем его содержимого.'
  + ' Откат переводит указатель current на выбранную ревизию: новые попытки пойдут'
  + ' по ней, уже бегущие останутся на своей.';

const router = useRouter();
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

const displayRouteList = computed<RouteEntry[]>(() => (
  routesStore.opened?.draftId && routesStore.localDocument
    ? Object.keys(routesStore.localDocument.routes).map((id) => ({ id, hash: '' }))
    : routesStore.opened?.catalogHash && routesStore.publishedSnapshot
      ? Object.keys(routesStore.publishedSnapshot.routes).map((id) => ({ id, hash: '' }))
    : routeList.value
).sort((left, right) => left.id.localeCompare(right.id)));

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

  const catalogHash = routesStore.opened?.catalogHash ?? currentHash.value;
  const routeId = selectedRoute.value;

  if (!catalogHash || !routeId || !displayRouteList.value.some((entry) => entry.id === routeId)) {
    return;
  }

  graphLoading.value = true;

  try {
    graph.value = await routesApi.catalogGraph(profile.value, catalogHash, routeId);
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

      if (typeof route.query.profile === 'string'
        && !profiles.value.includes(route.query.profile)) {
        throw new Error(`Проект «${route.query.profile}» не найден.`);
      }
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

    if (currentHash.value !== data.currentCatalogHash) {
      historyCompareReport.value = null;
    }

    currentHash.value = data.currentCatalogHash;
    revisions.value = data.revisions;

    if (!displayRouteList.value.some((entry) => entry.id === selectedRoute.value)) {
      selectedRoute.value = displayRouteList.value[0]?.id || '';
    }

    if (typeof route.query.catalog !== 'string'
      || routesStore.opened?.catalogHash === route.query.catalog) {
      await loadGraph();
    }
  } catch (failure) {
    error.value = failureText(failure);
  } finally {
    loading.value = false;
  }
}

/**
 * Выбирает маршрут и отражает выбор в адресной строке.
 * Действие синхронизирует выбор в интерфейсе с открытым снимком редактора.
 */
function selectRoute(id: string): void {
  if (id === selectedRoute.value && route.query.scope !== 'bootstrap') {
    return;
  }

  selectedRoute.value = id;

  if (routesStore.opened?.draftId) {
    void router.replace({ path: '/routes', query: {
      profile: profile.value,
      draft: routesStore.opened.draftId,
      ...(id ? { route: id } : {}),
      tab: 'graph',
    } });

    return;
  }
  if (routesStore.opened?.catalogHash) {
    void router.replace({ path: '/routes', query: {
      profile: profile.value,
      catalog: routesStore.opened.catalogHash,
      route: id,
      tab: 'graph',
    } });

    return;
  }

  loadGraph();
}

/**
 * Открывает начальную разведку как отдельный редактируемый граф.
 * Действие синхронизирует выбор в интерфейсе с открытым снимком редактора.
 */
function selectBootstrap(): void {
  if (!routesStore.opened?.draftId || !routesStore.localDocument) {
    return;
  }

  const node = routesStore.localDocument.bootstrap.entry
    || routesStore.localDocument.bootstrap.nodes[0]?.id;

  void router.push({ path: '/routes', query: {
    profile: profile.value,
    draft: routesStore.opened.draftId,
    scope: 'bootstrap',
    ...(node ? { node } : {}),
    tab: 'graph',
  } });
}

/**
 * Восстанавливает черновик, каталог и выбор из параметров адреса.
 * Действие синхронизирует выбор в интерфейсе с открытым снимком редактора.
 */
async function openFromQuery(): Promise<void> {
  editorQueryError.value = '';

  const draft = route.query.draft;
  const catalog = route.query.catalog;
  const requestedRoute = route.query.route;
  const requestedNode = route.query.node;
  const requestedScope = route.query.scope;

  if (draft !== undefined && catalog !== undefined) {
    editorQueryError.value = 'Адрес должен указывать либо черновик, либо опубликованный каталог.';
    closeDraft();

    return;
  }
  if (draft !== undefined && (typeof draft !== 'string' || !DRAFT_ID_RE.test(draft))) {
    editorQueryError.value = 'Некорректный ID черновика в адресе.';
    closeDraft();

    return;
  }
  if (catalog !== undefined && (typeof catalog !== 'string'
    || !CATALOG_HASH_RE.test(catalog))) {
    editorQueryError.value = 'Некорректный хеш каталога в адресе.';
    closeDraft();

    return;
  }
  if (requestedRoute !== undefined && (typeof requestedRoute !== 'string' || !requestedRoute)) {
    editorQueryError.value = 'Некорректный маршрут в адресе.';
    closeDraft();

    return;
  }
  if (requestedNode !== undefined && (typeof requestedNode !== 'string' || !requestedNode)) {
    editorQueryError.value = 'Некорректный этап в адресе.';

    return;
  }
  if (requestedScope !== undefined && requestedScope !== 'bootstrap') {
    editorQueryError.value = 'Некорректная область маршрутов в адресе.';

    return;
  }
  if (typeof draft === 'string') {
    const requestedProfile = profile.value;

    if (routesStore.opened?.draftId !== draft || routesStore.opened.profile !== requestedProfile
      || !routesStore.localDocument) {
      await loadEditorDraft(requestedProfile, draft);
    }
    if (route.query.profile !== requestedProfile || route.query.draft !== draft) {
      return;
    }
    if (routesStore.error || !routesStore.localDocument
      || routesStore.opened?.draftId !== draft) {
      editorQueryError.value = routesStore.error || 'Черновик не найден.';
      selectedRoute.value = '';
      closeDraft();

      return;
    }

    const ids = Object.keys(routesStore.localDocument.routes);

    if (requestedScope === 'bootstrap') {
      if (requestedRoute) {
        editorQueryError.value = 'Для начальной разведки не нужен ID маршрута.';

        return;
      }

      selectedRoute.value = '';

      const nodes = routesStore.localDocument.bootstrap.nodes;

      if (requestedNode && !nodes.some((node) => node.id === requestedNode)) {
        editorQueryError.value = `Этап «${requestedNode}» отсутствует в начальной разведке.`;

        return;
      }

      selectedNode.value = requestedNode || routesStore.localDocument.bootstrap.entry
        || nodes[0]?.id || '';

      if (!templatesLoaded.value) {
        templatesLoaded.value = true;

        try { templates.value = await agentsApi.list(); } catch { templates.value = []; }
      }

      return;
    }
    if (requestedRoute && !ids.includes(requestedRoute)) {
      editorQueryError.value = `Маршрут «${requestedRoute}» отсутствует в черновике.`;
      selectedRoute.value = '';

      return;
    }

    selectedRoute.value = requestedRoute || ids[0] || '';

    const nodes = routesStore.localDocument.routes[selectedRoute.value]?.route.nodes ?? [];

    if (requestedNode && !nodes.some((node) => node.id === requestedNode)) {
      editorQueryError.value = `Этап «${requestedNode}» отсутствует в маршруте.`;
      selectedNode.value = '';

      return;
    }

    selectedNode.value = requestedNode || nodes.find((node) => node.prompt)?.id || '';

    if (selectedTab.value === 'prompt' && !templatesLoaded.value) {
      templatesLoaded.value = true;

      try { templates.value = await agentsApi.list(); } catch { templates.value = []; }
    }
  } else if (typeof catalog === 'string') {
    const requestedProfile = profile.value;

    if (routesStore.opened?.catalogHash !== catalog || routesStore.opened.profile !== requestedProfile
      || !routesStore.publishedSnapshot) {
      await loadCatalog(requestedProfile, catalog);
    }
    if (route.query.profile !== requestedProfile || route.query.catalog !== catalog) {
      return;
    }
    if (routesStore.error || !routesStore.publishedSnapshot
      || routesStore.opened?.catalogHash !== catalog) {
      editorQueryError.value = routesStore.error || 'Каталог не найден.';
      selectedRoute.value = '';
      closeDraft();

      return;
    }

    const ids = Object.keys(routesStore.publishedSnapshot.routes);

    if (requestedRoute && !ids.includes(requestedRoute)) {
      editorQueryError.value = `Маршрут «${requestedRoute}» отсутствует в каталоге.`;
      selectedRoute.value = '';

      return;
    }

    selectedRoute.value = requestedRoute || ids[0] || '';
    await loadGraph();
  } else {
    closeDraft();
  }
}

function openPrompt(nodeId: string): void {
  if (!routesStore.opened?.draftId) {
    return;
  }

  void router.push({ path: '/routes', query: {
    profile: profile.value,
    draft: routesStore.opened.draftId,
    route: selectedRoute.value,
    node: nodeId,
    tab: 'prompt',
  } });
}

function changePrompt(value: {
  routeId: string;
  bundle: RouteDraft['routes'][string];
  historyGroup?: string
}): void {
  applyLocalChange((draft) => {
     draft.routes[value.routeId] = JSON.parse(JSON.stringify(value.bundle));
  },
    { historyGroup: value.historyGroup });
}

function changeBootstrapPrompt(value: {
  bootstrap: RouteDraft['bootstrap'];
  prompts: RouteDraft['bootstrapPrompts'];
  historyGroup?: string
}): void {
  applyLocalChange((draft) => {
    draft.bootstrap = JSON.parse(JSON.stringify(value.bootstrap));
    draft.bootstrapPrompts = JSON.parse(JSON.stringify(value.prompts));
  }, { historyGroup: value.historyGroup });
}

/**
 * Передаёт клавиатурные команды отмены и повтора редактору.
 * Действие синхронизирует выбор в интерфейсе с открытым снимком редактора.
 */
function onEditorKeydown(event: KeyboardEvent): void {
  if (!routesStore.opened?.draftId || routesStore.opened.readOnly) {
    return;
  }

  const action = historyShortcut(event);

  if (!action) {
    return;
  }

  event.preventDefault();

  if (action === 'undo') {
    undoDraft();
  }
  else {
    redoDraft();
  }
}

function replaceEditorDocument(next: RouteDraft): void {
  applyLocalChange((draft) => {
    draft.routes = next.routes;
    draft.bootstrap = next.bootstrap;
    draft.bootstrapPrompts = next.bootstrapPrompts;
    draft.presentation = next.presentation;
    draft.provenance = next.provenance;
  });
}

/**
 * Согласует выбор узла холста с инспектором.
 * Действие синхронизирует выбор в интерфейсе с открытым снимком редактора.
 */
function selectCanvasNode(value: { scope: RouteCommandScope; nodeId: string }): void {
  if (!routesStore.opened?.draftId) {
    return;
  }
  if (value.scope.kind === 'bootstrap') {
    void router.push({ path: '/routes', query: {
      profile: profile.value,
      draft: routesStore.opened.draftId,
      scope: 'bootstrap',
      ...(value.nodeId ? { node: value.nodeId } : {}),
      tab: 'graph',
    } });

    return;
  }
  if (value.scope.routeId !== selectedRoute.value) {
    return;
  }

  void router.push({ path: '/routes', query: {
    profile: profile.value,
    draft: routesStore.opened.draftId,
    route: selectedRoute.value,
    node: value.nodeId,
    tab: 'graph',
  } });
}

async function openDraft(id: string): Promise<void> {
  await router.push({ path: '/routes', query: {
    profile: profile.value,
    draft: id,
    tab: 'graph'
  } });
}

async function openJsonTab(): Promise<void> {
  await router.push({ path: '/routes', query: { ...route.query, tab: 'json' } });
}

async function openFormsTab(): Promise<void> {
  await router.push({ path: '/routes', query: { ...route.query, tab: 'graph' } });
}

async function openTransferredDraft(targetProfile: string, draftId: string,
  routeId: string | null): Promise<void> {
  await router.push({ path: '/routes', query: {
    profile: targetProfile,
    draft: draftId,
    tab: 'graph',
    ...(routeId ? { route: routeId } : {}),
  } });
}

/**
 * Создаёт черновик и переходит к нему по адресу. ID запоминается сразу после создания:
 * пока грузится список черновиков, открытый документ может смениться, а адрес — нет.
 */
async function createAndOpenDraft(input: DraftCreateRequest): Promise<void> {
  if (!pageReady.value) {
    return;
  }

  await createEditorDocument(profile.value, input);

  const draftId = routesStore.opened?.draftId;

  if (routesStore.error || !draftId) {
    return;
  }

  await loadDrafts(profile.value);
  await openDraft(draftId);
}

/**
 * Создаёт и открывает новый черновик текущего профиля.
 * Действие синхронизирует выбор в интерфейсе с открытым снимком редактора.
 */
async function createEditorDraft(): Promise<void> {
  const input = currentHash.value
    ? {
      kind: 'catalog' as const,
      title: 'Новый черновик',
      catalogHash: currentHash.value
    }
    : { kind: 'empty' as const, title: 'Новый черновик' };

  await createAndOpenDraft(input);
}

async function confirmDraftRebase(resolutions: RouteRebaseResolution[]): Promise<void> {
  await applyDraftRebase(resolutions);

  if (!routesStore.rebaseError) {
    await loadDrafts(profile.value);
  }
}

/**
 * Открывает итоговый промпт выбранного узла.
 * Действие синхронизирует выбор в интерфейсе с открытым снимком редактора.
 */
async function previewSelectedPrompt(context: Record<string, unknown>): Promise<void> {
  if (!selectedAgentNode.value || !selectedNode.value) {
    return;
  }

  const bootstrap = route.query.scope === 'bootstrap';

  await previewRoutePrompt({
    scope: bootstrap ? 'bootstrap' : 'route',
    routeId: bootstrap ? null : selectedRoute.value,
    nodeId: selectedNode.value,
    context,
  });
}

async function viewRevision(catalogHash: string): Promise<void> {
  await router.push({ path: '/routes', query: {
    profile: profile.value,
    catalog: catalogHash,
    tab: 'graph',
  } });
}

/**
 * Создаёт черновик на основе выбранной опубликованной ревизии.
 * Действие синхронизирует выбор в интерфейсе с открытым снимком редактора.
 */
async function createFromRevision(catalogHash: string): Promise<void> {
  await createAndOpenDraft({
    kind: 'catalog',
    title: `Черновик из ${shortHash(catalogHash)}`,
    catalogHash,
  });
}

/**
 * Показывает разницу двух опубликованных ревизий.
 * Действие синхронизирует выбор в интерфейсе с открытым снимком редактора.
 */
async function compareRevision(fromCatalogHash: string,
  toCatalogHash: string): Promise<void> {
  const comparingProfile = profile.value;

  historyCompareReport.value = null;

  if (fromCatalogHash === toCatalogHash) {
    return;
  }

  try {
    const compared = await routesApi.compareRevisions(
      comparingProfile, fromCatalogHash, toCatalogHash,
    );

    if (profile.value !== comparingProfile) {
      return;
    }

    historyCompareReport.value = compared;
  } catch (failure) {
    say(failureText(failure), true);
  }
}

/**
 * Сохраняет локальную версию конфликтующего черновика отдельно.
 * Действие синхронизирует выбор в интерфейсе с открытым снимком редактора.
 */
async function copyConflictedDraft(): Promise<void> {
  const previous = routesStore.opened?.draftId;

  await saveConflictCopy();

  const next = routesStore.opened?.draftId;

  if (!routesStore.error && next && next !== previous) {
    await loadDrafts(profile.value);
    await openDraft(next);
  }
}

async function reloadConflictedDraft(): Promise<void> {
  await reloadConflict(() => confirmDialog(
    'Заменить локальные правки версией сервера? Несохранённый JSON-текст тоже будет потерян.',
    { okText: 'Перечитать' },
  ));
}

/**
 * Переводит фокус к месту ошибки проверки черновика.
 * Действие синхронизирует выбор в интерфейсе с открытым снимком редактора.
 */
function focusProblem(issue: RouteEditorIssue): void {
  if (!routesStore.opened?.draftId) {
    return;
  }

  focusedProblemPath.value = issue.path;
  focusedProblem.value = issue;

  if (issue.scope === 'bootstrap') {
    void router.push({ path: '/routes', query: {
      profile: profile.value,
      draft: routesStore.opened.draftId,
      scope: 'bootstrap',
      ...(issue.nodeId ? { node: issue.nodeId } : {}),
      tab: 'graph',
    } });

    return;
  }
  if (!issue.routeId) {
    return;
  }

  const promptIssue = issue.path.includes('/prompt/');

  void router.push({ path: '/routes', query: {
    profile: profile.value,
    draft: routesStore.opened.draftId,
    route: issue.routeId,
    ...(issue.nodeId ? { node: issue.nodeId } : {}),
    tab: promptIssue ? 'prompt' : 'graph',
  } });
}

async function switchToEditorSource(): Promise<void> {
  await enableEditorSource(() => confirmDialog(
    'Сделать редактор источником маршрутов этого проекта? Профильный скрипт больше не сможет '
    + 'активировать каталог, пока источник не переключат обратно.',
    { okText: 'Переключить источник' },
  ));
}

/**
 * Открывает опубликованный каталог из результата операции.
 * Действие синхронизирует выбор в интерфейсе с открытым снимком редактора.
 */
async function openPublishedReceipt(): Promise<void> {
  const receipt = routesStore.receipt;

  if (!receipt || receipt.state !== 'committed') {
    return;
  }

  publishDialogOpen.value = false;
  await loadEditor(profile.value);
  await load();
  await router.push({ path: '/routes', query: {
    profile: profile.value,
    catalog: receipt.toCatalogHash,
    ...(selectedRoute.value ? { route: selectedRoute.value } : {}),
    tab: 'graph',
  } });
}

async function confirmEditorPublish(comment: string): Promise<void> {
  await publishComparedDraft(comment);
  await openPublishedReceipt();
}

async function checkEditorPublication(): Promise<void> {
  await checkPublicationOutcome();
  await openPublishedReceipt();
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

  void router.push({ path: '/routes', query: { profile: next } });
}

/**
 * Новый проект заводится общей формой раздела «Проекты»: здесь только переход.
 * Список проектов после возврата перечитает сама страница раздела.
 */
function openProjectCreate(): void {
  void router.push({ path: '/projects', query: { create: '1' } });
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
  if (busy.value || revision.isCurrent || revision.integrity !== 'ok') {
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
    await router.push({ path: '/routes', query: {
      profile: profile.value,
      catalog: revision.catalogHash,
      tab: 'graph',
      ...(selectedRoute.value ? { route: selectedRoute.value } : {}),
    } });
    say(`Текущая ревизия — ${shortHash(revision.catalogHash)}`);
  } catch (failure) {
    say(failureText(failure), true);
    await load();
  } finally {
    busy.value = '';
  }
}

watch([selectedTab, () => routesStore.localDocument], () => {
  if (selectedTab.value === 'json' && routesStore.localDocument) {
    openJsonDraftBuffer();
  }
}, { immediate: true });

watch(() => route.query, async (query, previous) => {
  if (query === previous) {
    return;
  }

  const switching = typeof query.profile === 'string' && query.profile !== profile.value;

  if (switching) {
    pageReady.value = false;
  }

  try {
    await syncQuery(query);
  } finally {
    if (switching) {
      pageReady.value = true;
    }
  }
}, { deep: true });

/**
 * Приводит страницу к адресу: смена проекта перечитывает его каталог, черновики и
 * возможности редактора, затем открывается документ, названный в адресе.
 */
async function syncQuery(query: typeof route.query): Promise<void> {
  if (typeof query.profile === 'string' && query.profile !== profile.value) {
    localStorage.setItem(PROJECT_KEY, query.profile);
    profile.value = query.profile;
    selectedRoute.value = '';
    selectedNode.value = '';
    graph.value = null;
    report.value = null;
    notice.value = '';
    revisions.value = [];
    historyCompareReport.value = null;
    currentHash.value = null;
    templates.value = [];
    templatesLoaded.value = false;
    closeDraft();
    await load();
    await loadEditor(profile.value);
    await loadDrafts(profile.value);
  }

  await openFromQuery();

  if (profile.value) {
    watchRoutes(profile.value, () => {
       void load();
    });
  }
}

const confirmLeave = () => confirmDialog(
  'Уйти с несохранёнными правками маршрута? Неприменённый JSON-текст будет потерян.',
  { okText: 'Уйти' },
);

onBeforeRouteLeave(() => confirmDirtyRouteExit(
  routesStore.dirty || Boolean(routesStore.jsonBuffer?.dirty), true, confirmLeave));
onBeforeRouteUpdate((to, from) => confirmDirtyRouteExit(
  routesStore.dirty || Boolean(routesStore.jsonBuffer?.dirty),
  to.query.profile !== from.query.profile || to.query.draft !== from.query.draft
    || to.query.catalog !== from.query.catalog, confirmLeave));

function protectBeforeUnload(event: BeforeUnloadEvent): void {
  if (!routesStore.dirty && !routesStore.jsonBuffer?.dirty) {
    return;
  }

  event.preventDefault();
  event.returnValue = '';
}

onMounted(async () => {
  window.addEventListener('beforeunload', protectBeforeUnload);

  try {
    await load();

    if (!profile.value || error.value) {
      return;
    }

    await loadEditor(profile.value);
    await loadDrafts(profile.value);
    await openFromQuery();
    watchRoutes(profile.value, () => {
       void load();
    });
  } finally {
    pageReady.value = true;
  }
});

onUnmounted(() => {
  window.removeEventListener('beforeunload', protectBeforeUnload);
  stopWatchingRoutes();
});
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
.panel { display: flex; flex-direction: column; min-width: 0; min-height: 0; overflow-y: auto;
  padding: 12px 16px 16px; gap: 10px; }
.phead { display: flex; align-items: center; gap: 10px; }
.route-editor-actions { display: flex; flex-wrap: wrap; gap: 8px; }
/* Схема идёт во всю ширину: на натуральном масштабе, где текст читается, ей нужен простор.
   Под ней — список этапов и инспекторы выбранного этапа. */
.route-editor-workspace { display: grid; grid-template-columns: minmax(0, 1fr);
  align-items: start; gap: 10px; min-width: 0; }
.route-editor-workspace__sidebar { display: grid; grid-template-columns: minmax(0, 1fr) minmax(300px, 420px);
  align-items: start; gap: 10px; min-width: 0; }
.route-editor-inspectors { display: grid; gap: 10px; min-width: 0; }
.route-editor-workspace .route-draft-panel { grid-column: 1 / -1; }
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
  .route-editor-workspace__sidebar { grid-template-columns: 1fr; }
}
</style>
