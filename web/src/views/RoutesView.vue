<template>
  <div class="routes-page ui-workspace" data-ui-workspace :data-pane="mobilePane">
    <div class="route-pane-nav">
    <UiTabs v-model="mobilePane" data-ui-workspace-tabs label="Область маршрута">
      <UiTab value="catalog" controls="route-catalog-pane">Каталог</UiTab>
      <UiTab value="work" controls="route-work-pane">Маршрут</UiTab>
      <UiTab value="inspector" controls="route-work-pane" :disabled="!editingDraft || !selectedRoute">
        Свойства
      </UiTab>
    </UiTabs>
    </div>
    <aside id="route-catalog-pane" class="list">
      <UiPaneHeader>
        <template #title><h1>Маршруты</h1></template>
        <template #actions>
          <UiButton v-if="profile" data-test="create-draft" data-context="workspace-toolbar"
                    variant="ghost" :disabled="!pageReady"
                    :aria-label="currentHash ? 'Создать черновик из current' : 'Создать черновик'"
                    v-tooltip="currentHash ? 'Создать черновик из current' : 'Создать черновик'"
                    @click="createEditorDraft">+ Черновик</UiButton>
        </template>
      </UiPaneHeader>
      <div class="catalog-content">
        <ProjectSwitcher compact :profiles="profiles" :model-value="profile"
                         @update:model-value="switchProfile" @create="openProjectCreate" @manage="manageProject" />
        <div class="catalog-heading">
          <h2>{{ editingDraft ? 'В черновике' : 'Опубликованные' }}</h2>
          <span>{{ displayRouteList.length }}</span>
          <UiTooltip :text="helpPanel" />
        </div>
        <div v-if="loading && !revisions.length" class="pad muted"><UiSpinner decorative /> Загружаю…</div>
        <div v-else-if="error" class="pad bad" role="alert">{{ error }}</div>
        <p v-else-if="!displayRouteList.length" class="pad muted">
          {{ editingDraft ? 'В черновике пока нет маршрутов' : 'Каталог не опубликован' }}
        </p>
        <UiSelectableRow v-for="r in displayRouteList" :key="r.id" class="item"
                         data-context="workspace-catalog" :selected="r.id === selectedRoute"
                         @select="selectRoute(r.id)">
          <span class="route-item-content">
            <span class="rid">{{ r.name || r.id }}</span>
            <span v-if="r.hash" class="route-hash" v-tooltip="r.hash">{{ shortHash(r.hash) }}</span>
          </span>
        </UiSelectableRow>
        <UiButton v-if="editingDraft" variant="ghost" data-context="workspace-toolbar"
                  data-test="catalog-bootstrap" :pressed="route.query.scope === 'bootstrap'"
                  @click="selectBootstrap">Начальная разведка</UiButton>
        <RouteCatalog mode="drafts"
                      :drafts="routesStore.draftsProfile === profile ? routesStore.drafts : []"
                      :selected-draft-id="routesStore.opened?.draftId ?? null" @select="openDraft" />
      </div>
    </aside>

    <section id="route-work-pane" class="panel" @keydown="onEditorKeydown">
      <RouteEditorHeader v-if="editingDraft && routesStore.localDocument"
                         :heading="workTitle" :document="routesStore.localDocument"
                         :read-only="routesStore.opened?.readOnly ?? false"
                         :saved="!routesStore.dirty" :saving="routesStore.saving" @save="saveDraft" />
      <UiPaneHeader v-else inset="content">
        <template #title><h2>{{ workTitle }}</h2></template>
        <template #meta>
          <span v-if="published || routesStore.opened?.catalogHash" class="catalog-state">
            Опубликован <span class="route-hash" v-tooltip="routesStore.opened?.catalogHash ?? currentHash ?? ''">
              {{ shortHash(routesStore.opened?.catalogHash ?? currentHash) }}
            </span>
          </span>
          <span v-else>Нет публикации</span>
        </template>
        <template #actions>
          <UiButton v-if="canEditPublishedRoute" data-test="edit-route" data-context="workspace-toolbar"
                    tone="accent" variant="solid" :disabled="!pageReady || editEntryBusy"
                    @click="editPublishedRoute">Редактировать</UiButton>
        </template>
      </UiPaneHeader>
      <div class="panel-scroll" :class="{ 'panel-scroll--route-editor': routeWorkspaceActive }">
        <UiInlineMessage v-if="registrationDeleted" tone="warning">
          Регистрация проекта удалена. Несохранённые изменения сохранить нельзя — скопируйте нужное.
        </UiInlineMessage>
        <aside class="route-workflow-hint ui-workspace-guide" aria-label="О разделе «Маршруты»">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
               stroke-linecap="round" aria-hidden="true">
            <circle cx="12" cy="12" r="9" /><path d="M12 11v6m0-10v.01" />
          </svg>
          <div>
            <strong>Как устроен маршрут</strong>
            <p>Маршрут задаёт порядок работы: какие этапы выполнять и куда переходить после каждого результата.</p>
            <p v-if="editingDraft">
              Сейчас вы редактируете черновик. Для публикации: проверьте → сравните с опубликованным
              → подтвердите публикацию.
            </p>
          </div>
        </aside>
        <p v-if="!editingDraft && (published || routesStore.opened?.catalogHash)" class="publication-info">
          Только просмотр
          <span v-if="routesStore.editorInfo?.source.mode === 'editor'">
            · источник маршрутов — редактор
          </span>
        </p>
        <p v-if="notice" class="notice" :class="{ bad: notice.startsWith('Ошибка') }" role="status">
          {{ notice }}
        </p>
      <div v-if="editorQueryError || routesStore.error || error" class="bad" role="alert">
        {{ editorQueryError || routesStore.error || error }}
      </div>
      <div v-if="routesStore.saveError" class="bad" role="alert">{{ routesStore.saveError }}</div>
      <div v-if="routesStore.publicationError" class="bad" role="alert">
        {{ routesStore.publicationError }}
        <UiButton v-if="routesStore.publicationOutcome === 'unknown'"
                  @click="checkEditorPublication">Проверить результат</UiButton>
      </div>
      <RouteConflictPanel v-if="routesStore.conflict" @copy="copyConflictedDraft"
                          @reload="reloadConflictedDraft" />

      <template v-if="editingDraft && routesStore.localDocument">
        <div class="route-editor-actions" role="group" aria-label="Действия черновика">
          <UiIconButton data-context="workspace-toolbar" label="Отменить"
                        v-tooltip="'Отменить последнее изменение'"
                        :disabled="!routesStore.historyPast.length" @click="undoDraft">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
                 stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="m9 5-5 5 5 5M4 10h10a6 6 0 0 1 6 6v2" />
            </svg>
          </UiIconButton>
          <UiIconButton data-context="workspace-toolbar" label="Повторить"
                        v-tooltip="'Повторить отменённое изменение'"
                        :disabled="!routesStore.historyFuture.length" @click="redoDraft">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
                 stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="m15 5 5 5-5 5m5-5H10a6 6 0 0 0-6 6v2" />
            </svg>
          </UiIconButton>
          <UiButton data-context="workspace-toolbar" variant="ghost" :disabled="routesStore.saving || routesStore.conflict
                    || Boolean(routesStore.jsonBuffer?.dirty)"
                    aria-label="Проверить черновик"
                    v-tooltip="'Проверить этапы, переходы и инструкции перед публикацией'"
                    @click="validateDraft">Проверить</UiButton>
          <UiButton data-context="workspace-toolbar" variant="ghost" v-if="selectedTab !== 'json'" data-test="route-json-tab"
                    @click="openJsonTab">JSON-режим</UiButton>
          <UiButton data-context="workspace-toolbar" variant="ghost" v-else data-test="route-form-tab" @click="openFormsTab">
            Вернуться к формам
          </UiButton>
          <UiButton data-context="workspace-toolbar" variant="ghost" v-tooltip="routesStore.canPublish
                      ? 'Посмотреть изменения перед подтверждением публикации'
                      : 'Сначала проверьте черновик и исправьте найденные ошибки'"
                    :disabled="!routesStore.canPublish" @click="compareDraft">
            Сравнить с опубликованным
          </UiButton>
          <UiButton data-context="workspace-toolbar" variant="ghost" v-if="currentHash && routesStore.serverSnapshot?.baseCatalogHash !== currentHash"
                    data-test="preview-rebase"
                    v-tooltip="'Учесть новую опубликованную версию и выбрать, как объединить изменения'"
                    :disabled="routesStore.dirty || routesStore.saving || routesStore.conflict
                      || Boolean(routesStore.jsonBuffer?.dirty)
                      || routesStore.rebaseBusy" @click="previewDraftRebase">
            Обновить основу черновика
          </UiButton>

        </div>
        <details class="ui-workspace-disclosure route-disclosure route-catalog-properties" :open="!displayRouteList.length">
          <summary>Свойства маршрута и каталог</summary>
          <div class="ui-workspace-section__body">
            <RouteCatalog mode="manage" :drafts="[]" :selected-draft-id="routesStore.opened?.draftId ?? null"
                          :document="routesStore.opened?.readOnly ? null : routesStore.localDocument"
                          :selected-route-id="selectedRoute" @change="replaceEditorDocument"
                          @select-route="selectRoute" />
          </div>
        </details>
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
                         :read-only="routesStore.opened?.readOnly ?? false"
                         @update:raw="updateJsonDraftBuffer"
                         @format="formatJsonDraftBuffer"
                         @apply="applyJsonDraftBuffer" />
        <RouteBootstrapEditor v-else-if="route.query.scope === 'bootstrap'"
                              :document="routesStore.localDocument"
                              :selected-node-id="selectedNode"
                              :focused-issue="focusedProblem"
                              :capabilities="routesStore.editorInfo?.capabilities ?? null"
                              @select-node="selectCanvasNode"
                              @change="replaceEditorDocument"
                              @prompt-change="changeBootstrapPrompt"
                              @end-history-group="endHistoryGroup" @save="saveDraft" />
        <div v-else-if="selectedRoute" class="route-editor-workspace">
          <div class="route-editor-workspace__main">
            <RouteCanvas :document="routesStore.localDocument"
                         :scope="{ kind: 'route', routeId: selectedRoute }"
                         :selected-node-id="selectedNode" :focused-issue="canvasFocusedProblem"
                         @select-node="selectCanvasNode" @change="replaceEditorDocument" />
            <div class="route-editor-workspace__stages">
              <RouteStageList :document="routesStore.localDocument"
                              :scope="{ kind: 'route', routeId: selectedRoute }"
                              :selected-node-id="selectedNode"
                              @select-node="selectCanvasNode" @change="replaceEditorDocument" />
            </div>
          </div>
          <div class="route-editor-inspectors">
            <template v-if="selectedNode">
              <UiTabs :model-value="selectedTab" data-ui-workspace-tabs label="Редактор этапа"
                      @update:model-value="selectNodeTab">
                <UiTab value="graph" controls="route-node-properties">Свойства и переходы</UiTab>
                <UiTab value="prompt" controls="route-node-prompt">Инструкция</UiTab>
              </UiTabs>
              <div id="route-node-properties" v-show="selectedTab !== 'prompt'"
                   class="route-editor-inspectors__content">
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
              <div id="route-node-prompt" v-show="selectedTab === 'prompt'"
                   class="route-editor-inspectors__content">
                <RoutePromptEditor v-if="promptEditorOpened"
                                   :document="routesStore.localDocument" :route-id="selectedRoute"
                                   :node-id="selectedNode"
                                   :focus-path="focusedProblemPath"
                                   @change="changePrompt" @save="saveDraft"
                                   @end-history-group="endHistoryGroup" />
              </div>
            </template>
            <p v-else class="muted">Выберите этап на схеме или в списке.</p>
          </div>
        </div>
        <p v-else class="muted">Публикация недоступна: сначала добавьте маршрут и его инструкции.</p>
        <p v-if="routesStore.promptPreviewError" class="bad" role="alert">
          {{ routesStore.promptPreviewError }}
        </p>
        <details class="ui-workspace-disclosure route-disclosure" v-if="selectedAgentNode">
          <summary>Предпросмотр инструкции</summary>
          <div class="ui-workspace-section__body">
            <RoutePromptPreview
                              :result="selectedPromptPreview?.result ?? null"
                              :stale="selectedPromptPreview?.stale ?? false"
                              :busy="routesStore.promptPreviewBusy"
                              @request="previewSelectedPrompt" />
          </div>
        </details>
        <p v-if="routesStore.simulationError" class="bad" role="alert">
          {{ routesStore.simulationError }}
        </p>
        <details class="ui-workspace-disclosure route-disclosure" v-if="routesStore.serverSnapshot">
          <summary>Пробный сценарий</summary>
          <div class="ui-workspace-section__body">
            <RouteSimulation
                           :document="routesStore.serverSnapshot"
                           :simulation="routesStore.simulation"
                           @start="startRouteSimulation" @step="stepRouteSimulation"
                           @approve="approveRouteSimulation" />
          </div>
        </details>
        <details class="ui-workspace-disclosure route-disclosure" v-if="routesStore.serverSnapshot">
          <summary>Экспорт и импорт</summary>
          <div class="ui-workspace-section__body">
            <RouteTransferDialog
                               :document="routesStore.serverSnapshot"
                               :profiles="profiles" :dirty="routesStore.dirty || routesStore.saving
                                 || routesStore.conflict || Boolean(routesStore.jsonBuffer?.dirty)"
                               @open="openTransferredDraft" />
          </div>
        </details>
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
        <div v-if="graphLoading" class="mid muted"><UiSpinner decorative /> Схема…</div>
        <div v-else-if="graphError" class="mid bad" role="alert">{{ graphError }}</div>
        <div v-else-if="graph" class="published-canvas"><FactoryGraph :graph="graph" reference /></div>
        <details v-if="selectedRoute" class="ui-workspace-disclosure route-disclosure">
          <summary>Инструкции этапов</summary>
          <div class="ui-workspace-section__body">
            <RouteDraftPanel :document="routesStore.publishedSnapshot"
                           :route-id="selectedRoute" />
          </div>
        </details>

      </template>
      <template v-else>
      <!-- Каталог ещё не опубликован: подсказываем доступный способ публикации -->
      <div v-if="!published && !loading && !error" class="hint">
        <p>У проекта нет опубликованного каталога маршрутов.</p>
        <p v-if="routesStore.editorInfo?.source.mode === 'editor'" class="muted">
          Создайте черновик, заполните маршрут и инструкции, проверьте и опубликуйте его здесь.
        </p>
        <p v-else class="muted">Каталог можно подготовить через скрипт профиля
          <span class="mono">routes/publish.mjs</span> или создать черновик в редакторе.</p>
      </div>

      <!-- Схема выбранного маршрута — ровно та, по которой пойдёт попытка -->
      <div v-else class="published-canvas">
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
      <details v-if="!editingDraft && !routesStore.opened?.catalogHash && publishSupported
                 && routesStore.editorInfo?.source.mode !== 'editor'"
               class="ui-workspace-disclosure route-disclosure">
        <summary>Пересборка каталога из файлов профиля</summary>
        <div class="ui-workspace-section__body">
          <UiButton data-context="workspace-toolbar" variant="ghost" :loading="busy === 'validate'"
                    :disabled="!!busy && busy !== 'validate'" loading-label="Проверяю"
                    @click="run('validate')">Проверить каталог из файлов профиля</UiButton>
          <UiButton data-context="workspace-toolbar" tone="accent" variant="outline"
                    :loading="busy === 'publish'" :disabled="!!busy && busy !== 'publish'"
                    loading-label="Публикую" @click="run('publish')">
            Опубликовать каталог из файлов профиля
          </UiButton>
        </div>
      </details>
      <details v-if="revisions.length" class="ui-workspace-disclosure route-disclosure route-history" :open="!editingDraft">
        <summary>Ревизии каталога <span class="muted">{{ revisions.length }}</span></summary>
        <div class="ui-workspace-section__body">
          <RouteRevisionHistory :revisions="revisions" :busy="!!busy || !pageReady"
                                v-tooltip="helpRevisions" @view="viewRevision"
                                @create="createFromRevision" @compare="compareRevision" @rollback="rollback" />
        </div>
      </details>
      <RouteCompare v-if="historyCompareReport" :report="historyCompareReport" :can-publish="false" />
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { useRoute, useRouter, onBeforeRouteLeave, onBeforeRouteUpdate } from 'vue-router';

import type { FactoryGraphData } from '../../../shared/pipeline/factoryGraphContracts.ts';
import type { RouteRevision } from '../../../shared/pipeline/routesContracts.ts';
import type { RouteDraft, RouteRebaseResolution,
  RouteRevisionCompareReport } from '../../../shared/pipeline/routesEditorContracts.ts';
import type { RouteEditorIssue } from '../../../shared/pipeline/routesEditorContracts.ts';
import { publishSummary } from '../../../shared/pipeline/routesContracts.ts';
import { failureText } from '../shared/apiClient.ts';
import { routesApi } from '../shared/routesApi.ts';
import type { DraftCreateRequest } from '../shared/routesApi.ts';
import {
  UiButton,
  UiIconButton,
  UiInlineMessage,
  UiPaneHeader,
  UiTabs,
  UiTab,
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
  name?: string;
}

// Что сейчас делает кнопка. Пустая строка — ничего: раздел не занят.
type BusyMode = '' | 'validate' | 'publish' | 'rollback';

const PROJECT_KEY = 'grigdesk-project';
const DRAFT_ID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const CATALOG_HASH_RE = /^[a-f0-9]{64}$/;

const profiles = ref<string[]>([]);
const registrationDeleted = ref(false);
let projectsRequest = 0;
let pageGeneration = 0;
let resettingCatalog = false;
let disposed = false;
const route = useRoute();
const profile = ref(typeof route.query.profile === 'string'
  ? route.query.profile : localStorage.getItem(PROJECT_KEY) || '');
const routesStore = useRoutesStore();
const editorQueryError = ref('');
const loading = ref(true);
// Создавать черновик можно после начальной загрузки проекта: иначе она, дочитав адрес
// без черновика, закрывает документ и отбрасывает ответ только что начатого создания.
const pageReady = ref(false);
const editEntryBusy = ref(false);
const error = ref('');
const publishSupported = ref(false);
const currentHash = ref<string | null>(null);
const revisions = ref<RouteRevision[]>([]);
const historyCompareReport = ref<RouteRevisionCompareReport | null>(null);
const selectedRoute = ref('');
const mobilePane = ref(route.query.draft || route.query.catalog ? 'work' : 'catalog');
const selectedNode = ref('');
const promptEditorOpened = ref(false);
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
// принадлежит скрипту профиля, и толковать его GrigDesk не вправе.
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
    ? Object.entries(routesStore.localDocument.routes).map(([id, bundle]) => ({
      id,
      hash: '',
      name: bundle.route.title,
    }))
    : routesStore.opened?.catalogHash && routesStore.publishedSnapshot
      ? Object.entries(routesStore.publishedSnapshot.routes).map(([id, bundle]) => ({
        id,
        hash: '',
        name: bundle.route.title,
      }))
    : routeList.value
).sort((left, right) => left.id.localeCompare(right.id)));

const published = computed(() => Boolean(currentHash.value));
const editingDraft = computed(() => Boolean(
  routesStore.opened?.draftId && routesStore.localDocument && !editorQueryError.value,
));
const canEditPublishedRoute = computed(() => !editingDraft.value && !editorQueryError.value
  && !error.value && !routesStore.error && Boolean(profile.value && selectedRoute.value
    && (routesStore.opened?.catalogHash || currentHash.value))
  && displayRouteList.value.some((entry) => entry.id === selectedRoute.value));
const routeWorkspaceActive = computed(() => editingDraft.value && Boolean(selectedRoute.value)
  && selectedTab.value !== 'json' && route.query.scope !== 'bootstrap');
const canvasFocusedProblem = computed(() => focusedProblem.value?.path.includes('/prompt/')
  ? null : focusedProblem.value);
const workTitle = computed(() => {
  if (route.query.scope === 'bootstrap' && editingDraft.value) {
    return 'Начальная разведка';
  }

  const document = routesStore.localDocument ?? routesStore.publishedSnapshot;

  return document?.routes[selectedRoute.value]?.route.title
    || selectedRoute.value || profile.value || 'Маршруты';
});

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
  const generation = pageGeneration;

  graph.value = null;
  graphError.value = '';

  const catalogHash = routesStore.opened?.catalogHash ?? currentHash.value;
  const routeId = selectedRoute.value;

  if (!catalogHash || !routeId || !displayRouteList.value.some((entry) => entry.id === routeId)) {
    return;
  }

  graphLoading.value = true;

  try {
    const loaded = await routesApi.catalogGraph(profile.value, catalogHash, routeId);

    if (generation === pageGeneration) {
      graph.value = loaded;
    }
  } catch (failure) {
    if (generation === pageGeneration) {
      graphError.value = failureText(failure);
    }
  } finally {
    graphLoading.value = false;
  }
}

/**
 * Читает список профилей (один раз) и ревизии выбранного. Выбор маршрута сохраняется,
 * пока он есть в каталоге: после публикации человек ожидает остаться там же, где был.
 */
async function load(): Promise<void> {
  const generation = pageGeneration;

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

    if (generation !== pageGeneration) {
      return;
    }

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
  mobilePane.value = 'work';

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
  mobilePane.value = 'work';

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

/**
 * Переключает содержимое общей панели этапа, сохраняя выбор и схему.
 * Вкладка входит в адрес, поэтому старые ссылки на инструкцию остаются рабочими.
 */
function selectNodeTab(tab: string | number): void {
  if (!routesStore.opened?.draftId || !selectedNode.value) {
    return;
  }

  void router.push({ path: '/routes', query: {
    profile: profile.value,
    draft: routesStore.opened.draftId,
    route: selectedRoute.value,
    node: selectedNode.value,
    tab: tab === 'prompt' ? 'prompt' : 'graph',
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
  mobilePane.value = 'inspector';

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

async function openDraft(id: string, routeId?: string): Promise<void> {
  mobilePane.value = 'work';
  await router.push({ path: '/routes', query: {
    profile: profile.value,
    draft: id,
    ...(routeId ? { route: routeId } : {}),
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

/**
 * Открывает последний редактируемый черновик с показанным маршрутом либо копирует публикацию.
 * Свежий список и полные документы проверяются до создания; уход со страницы отменяет переход.
 */
async function editPublishedRoute(): Promise<void> {
  if (!pageReady.value || editEntryBusy.value || !canEditPublishedRoute.value) {
    return;
  }

  const entryProfile = profile.value;
  const entryRoute = selectedRoute.value;
  const catalogHash = routesStore.opened?.catalogHash ?? currentHash.value;

  if (!catalogHash) {
    return;
  }

  const entryQuery = route.query;
  const generation = pageGeneration;
  const contextCurrent = () => !disposed && generation === pageGeneration
    && profile.value === entryProfile && selectedRoute.value === entryRoute
    && route.query === entryQuery;

  editEntryBusy.value = true;

  try {
    const summaries = await routesApi.drafts(entryProfile);

    if (!contextCurrent()) {
      return;
    }

    const candidates = summaries.filter((draft) => draft.profile === entryProfile
      && draft.state === 'editing').sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id));
    let draftId = '';

    for (const candidate of candidates) {
      const document = await routesApi.draft(entryProfile, candidate.id);

      if (!contextCurrent()) {
        return;
      }
      if (document.profile === entryProfile && document.state === 'editing'
        && document.routes[entryRoute]) {
        draftId = document.id;

        break;
      }
    }

    if (!draftId) {
      const document = await routesApi.createDraft(entryProfile, {
        kind: 'catalog',
        title: 'Новый черновик',
        catalogHash,
      });

      if (!contextCurrent()) {
        return;
      }

      draftId = document.id;
      await loadDrafts(entryProfile);
    }

    if (contextCurrent()) {
      await openDraft(draftId, entryRoute);
    }
  } catch (failure) {
    if (contextCurrent()) {
      say(failureText(failure), true);
    }
  } finally {
    editEntryBusy.value = false;
  }
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
function manageProject(id: string): void {
  void router.push(`/projects/${id}`);
}

/**
 * Успешный каталог сбрасывает исчезнувший профиль, не выбирая соседний за человека.
 * Локальный документ остаётся только для чтения, а старые ответы теряют право записи.
 */
async function refreshProjects(): Promise<void> {
  const request = ++projectsRequest;
  let available: string[];

  try {
    available = await routesApi.profiles();
  } catch {
    return;
  }

  if (request !== projectsRequest) {
    return;
  }

  profiles.value = available;

  if (!profile.value || available.includes(profile.value)) {
    return;
  }

  registrationDeleted.value = true;
  pageGeneration += 1;
  stopWatchingRoutes();
  closeDraft({ keepDocument: routesStore.dirty || Boolean(routesStore.jsonBuffer?.dirty) });
  routesStore.draftsProfile = '';
  routesStore.drafts = [];
  profile.value = '';
  localStorage.removeItem(PROJECT_KEY);
  revisions.value = [];
  graph.value = null;
  currentHash.value = null;
  loading.value = false;
  resettingCatalog = true;

  try {
    await router.replace({ path: '/routes', query: {} });
  } finally {
    resettingCatalog = false;
  }
}

/**
 * Каталог регистраций перечитывается тем же подписчиком редактора.
 * Обычная публикация сохраняет прежнее чтение ревизий.
 */
function catalogChanged(event?: string): void {
  if (event === 'projects-changed' || event === 'hello') {
    void refreshProjects();
  } else {
    void load();
  }
}

function openProjectCreate(): void {
  void router.push({ path: '/projects', query: { create: '1' } });
}

/**
 * Проверка и публикация делает сам профиль (routes/publish.mjs) — состав маршрутов,
 * промпты и bootstrap знает только он. GrigDesk передаёт ровно два своих аргумента:
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

watch(selectedTab, (tab) => {
  if (tab === 'prompt') {
    promptEditorOpened.value = true;
    mobilePane.value = 'inspector';
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
  if (registrationDeleted.value && !query.profile) {
    return;
  }

  registrationDeleted.value = false;

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
    closeDraft();
    await load();
    await loadEditor(profile.value);
    await loadDrafts(profile.value);
  }

  await openFromQuery();

  if (profile.value) {
    watchRoutes(profile.value, catalogChanged);
  }
}

const confirmLeave = () => confirmDialog(
  'Уйти с несохранёнными правками маршрута? Неприменённый JSON-текст будет потерян.',
  { okText: 'Уйти' },
);

onBeforeRouteLeave(() => confirmDirtyRouteExit(
  routesStore.dirty || Boolean(routesStore.jsonBuffer?.dirty), true, confirmLeave));
onBeforeRouteUpdate((to, from) => resettingCatalog || confirmDirtyRouteExit(
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
    watchRoutes(profile.value, catalogChanged);
  } finally {
    pageReady.value = true;
  }
});

onUnmounted(() => {
  disposed = true;
  window.removeEventListener('beforeunload', protectBeforeUnload);
  stopWatchingRoutes();
});
</script>

<style scoped>
.routes-page {
  display: grid;
  grid-template-columns: 240px minmax(0, 1fr);
  grid-template-rows: auto minmax(0, 1fr);
  height: 100%;
  min-height: 0;
  container: routes / inline-size;
}

.routes-page > .list, .routes-page > .panel {
  grid-row: 1 / -1;
}

.list {
  min-width: 0;
  overflow: auto;
  border-right: 1px solid var(--line);
  background: var(--sidebar);
}

.catalog-content {
  display: grid;
  align-content: start;
  gap: 4px;
  padding: 12px 6px;
}

.catalog-heading {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 6px 6px;
  color: var(--ink-mid);
}

.catalog-heading h2 {
  flex: 1;
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--ink);
}

.route-item-content {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  width: 100%;
}

.rid {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}

.route-hash {
  font-family: var(--mono);
  color: var(--ink-mid);
  font-size: 11px;
  overflow-wrap: anywhere;
}

.pad {
  margin: 0;
  padding: 8px 6px;
  font-size: 12px;
}

.panel {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--surface);
  container: route-panel / inline-size;
}

.panel-scroll {
  flex: 1;
  min-height: 0;
  min-width: 0;
  overflow: auto;
  padding: 12px 20px 20px;
}

.panel-scroll > * + * {
  margin-top: 12px;
}

.catalog-state {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.route-editor-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--line);
}

.route-editor-workspace {
  display: grid;
  gap: 16px;
  min-width: 0;
}

.route-editor-workspace__main {
  display: grid;
  gap: 12px;
  min-width: 0;
}

.route-editor-inspectors {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}

.route-editor-inspectors__content {
  display: grid;
  align-content: start;
  gap: 16px;
  min-width: 0;
}

.published-canvas {
  min-height: 280px;
  overflow: auto;
  padding-block: 16px;
}

.notice {
  font-size: 12px;
  color: var(--good);
}

.publication-info {
  margin: 0;
  color: var(--ink-mid);
  font-size: 12px;
}

.hint {
  padding: 16px 0;
  font-size: 13px;
  line-height: 1.6;
}

.hint p {
  margin: 0 0 6px;
}

.mid {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 120px;
}

.report {
  padding-block: 8px;
  font-size: 12px;
}

.report summary {
  cursor: pointer;
}

.report pre {
  max-height: 220px;
  overflow: auto;
}

.bad {
  color: var(--bad);
}

.panel :deep(h3:not(header *)) {
  margin: 0 0 8px;
  font-size: 13px;
  line-height: 20px;
  font-weight: 600;
}

.panel :deep(label), .panel :deep(legend) {
  font-size: 12px;
  color: var(--workspace-label-color);
}

.panel :deep(label) {
  min-width: 0;
}

.panel :deep(fieldset) {
  min-width: 0;
  border: 1px solid var(--line);
  border-radius: var(--radius);
}

.panel :deep(p), .panel :deep(small) {
  overflow-wrap: anywhere;
}

.route-pane-nav {
  display: none;
}

@container route-panel (max-width: 660px) {

  .panel-scroll {
    padding: 12px;
  }

}

/* Высота ограничивается только в редакторе маршрута: разведка использует обычный холст. */

@container routes (width > 1000px) {

  .panel-scroll--route-editor {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .panel-scroll--route-editor > * {
    flex-shrink: 0;
    margin-top: 0;
  }

  .panel-scroll--route-editor > .route-editor-workspace {
    flex: 1 0 400px;
    min-height: 400px;
    grid-template-columns: minmax(0, 1fr) minmax(360px, 420px);
  }

  .route-editor-workspace__main {
    grid-template-rows: minmax(160px, 1fr) minmax(96px, .45fr);
    min-height: 0;
  }

  .route-editor-workspace__main :deep(.route-canvas) {
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .route-editor-workspace__main :deep(.route-canvas__toolbar) {
    flex-shrink: 0;
  }

  .route-editor-workspace__main :deep(.route-canvas__graph) {
    flex: 1;
    min-height: 0;
  }

  .route-editor-workspace__stages {
    min-width: 0;
    min-height: 0;
    overflow: auto;
  }

  .route-editor-inspectors {
    min-height: 0;
    overflow: hidden;
  }

  .route-editor-inspectors > .ui-tabs {
    flex-shrink: 0;
  }

  .route-editor-inspectors__content {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }
}

/* Узкая область сохраняет экземпляры редактора: выбор и буферы не теряются. */

@container routes (max-width: 1000px) {

  .route-pane-nav {
    display: flex;
    grid-column: 1 / -1;
    grid-row: 1;
    padding: 4px 8px;
    border-bottom: 1px solid var(--line);
    background: var(--topbar);
  }

  .routes-page > .list, .routes-page > .panel {
    grid-column: 1 / -1;
    grid-row: 2;
  }

  .list {
    border-right: 0;
  }

  [data-pane='catalog'] > .panel {
    display: none;
  }

  [data-pane='work'] > .list, [data-pane='inspector'] > .list {
    display: none;
  }

  [data-pane='work'] .route-editor-inspectors {
    display: none;
  }

  [data-pane='inspector'] .route-editor-workspace__main,
  [data-pane='inspector'] .route-workflow-hint {
    display: none;
  }
}
</style>
