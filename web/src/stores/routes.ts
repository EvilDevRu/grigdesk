import { defineStore } from 'pinia';
import type {
  RouteDraft, RouteDraftContent, RouteDraftSummary, RouteEditorInfo, RouteEditorIssue,
  RouteCompareReport, RoutePublication, RouteRebasePreview, RoutePromptPreviewResponse,
  RouteSimulationCursor, RouteSimulationCounters, RouteSimulationStepResponse,
} from '../../../shared/pipeline/routesEditorContracts.ts';
import type { RouteHistorySnapshot } from '../actions/routes/history.ts';
import type { RouteJsonBuffer } from '../actions/routes/jsonDraftBuffer.ts';

export interface OpenedRoutesDocument {
  profile: string;
  draftId?: string;
  catalogHash?: string;
  readOnly: boolean;
}

export interface RouteSimulationObservation {
  outcome: string;
  failureOwner: string | null;
  selectedRouteId: string | null;
  humanApproved: boolean;
}

export interface RouteSimulationState {
  cursor: RouteSimulationCursor;
  counters: RouteSimulationCounters;
  draftRevision: number;
  generation: number;
  stepIndex: number;
  pinned: boolean;
  // Потолок кругов цикла для сценария маршрута с `loop`; у прочих — null.
  loopMaxRounds: number | null;
  busy: boolean;
  error: string;
  stale: boolean;
  pendingHuman: RouteSimulationObservation | null;
  last: RouteSimulationStepResponse | null;
}

interface RoutesState {
  opened: OpenedRoutesDocument | null;
  serverSnapshot: RouteDraft | null;
  localDocument: RouteDraft | null;
  publishedSnapshot: RouteDraftContent | null;
  editorInfo: RouteEditorInfo | null;
  editorLoading: boolean;
  drafts: RouteDraftSummary[];
  draftsProfile: string | null;
  loading: boolean;
  error: string;
  editGeneration: number;
  historyPast: RouteHistorySnapshot[];
  historyFuture: RouteHistorySnapshot[];
  historyGroup: string | null;
  inFlightGeneration: number | null;
  dirty: boolean;
  saving: boolean;
  saveError: string;
  conflict: boolean;
  validationIssues: RouteEditorIssue[];
  validatedRevision: number | null;
  validatedGeneration: number | null;
  validatedCapabilitiesHash: string | null;
  compareReport: RouteCompareReport | null;
  compareGeneration: number | null;
  rebasePreview: RouteRebasePreview | null;
  rebaseGeneration: number | null;
  rebaseBusy: boolean;
  rebaseError: string;
  promptPreview: { 
    result: RoutePromptPreviewResponse;
    draftRevision: number; 
    generation: number; 
    stale: boolean;
    scope: 'route' | 'bootstrap'; 
    routeId: string | null; 
    nodeId: string 
  } | null;
  promptPreviewBusy: boolean;
  promptPreviewError: string;
  simulation: RouteSimulationState | null;
  simulationError: string;
  jsonBuffer: RouteJsonBuffer | null;
  pendingOperationId: string | null;
  pendingOperations: Record<string, string>;
  receipt: RoutePublication | null;
  publicationError: string;
  publicationOutcome: 'idle' | 'pending' | 'unknown' | 'committed' | 'aborted' | 'conflict';
}

export const useRoutesStore = defineStore('routes', {
  state: (): RoutesState => ({
    opened: null,
    serverSnapshot: null,
    localDocument: null,
    publishedSnapshot: null,
    editorInfo: null,
    editorLoading: false,
    drafts: [],
    draftsProfile: null,
    loading: false,
    error: '',
    editGeneration: 0,
    historyPast: [],
    historyFuture: [],
    historyGroup: null,
    inFlightGeneration: null,
    dirty: false,
    saving: false,
    saveError: '',
    conflict: false,
    validationIssues: [],
    validatedRevision: null,
    validatedGeneration: null,
    validatedCapabilitiesHash: null,
    compareReport: null,
    compareGeneration: null,
    rebasePreview: null,
    rebaseGeneration: null,
    rebaseBusy: false,
    rebaseError: '',
    promptPreview: null,
    promptPreviewBusy: false,
    promptPreviewError: '',
    simulation: null,
    simulationError: '',
    jsonBuffer: null,
    pendingOperationId: null,
    pendingOperations: {},
    receipt: null,
    publicationError: '',
    publicationOutcome: 'idle',
  }),
  getters: {
    canPublish(state): boolean {
      return Boolean(state.opened?.draftId && !state.opened.readOnly
        && state.serverSnapshot && !state.dirty && !state.saving && !state.conflict
        && !state.jsonBuffer?.dirty
        && state.validatedRevision === state.serverSnapshot.revision
        && state.validatedGeneration === state.editGeneration
        && state.validatedCapabilitiesHash !== null
        && !state.validationIssues.some((issue) => issue.severity === 'error'));
    },
    canConfirmPublish(state): boolean {
      const draft = state.serverSnapshot;
      const report = state.compareReport;

      return Boolean(state.opened?.draftId && draft && report
        && !state.opened.readOnly && !state.dirty && !state.saving && !state.conflict
        && !state.jsonBuffer?.dirty
        && state.validatedRevision === draft.revision
        && state.validatedGeneration === state.editGeneration
        && state.validatedCapabilitiesHash !== null
        && state.validatedCapabilitiesHash === report.capabilitiesHash
        && !state.validationIssues.some((issue) => issue.severity === 'error')
        && state.compareGeneration === state.editGeneration
        && report.draftId === state.opened.draftId
        && report.draftRevision === draft.revision && report.sourceMode === 'editor');
    },
  },
});
