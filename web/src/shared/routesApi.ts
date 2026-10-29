// Транспорт раздела «Маршруты».
//
// Каталог неизменяем; черновики хранят полный состав маршрутов, bootstrap и инструкции.
// Публикация и откат используют ожидаемый хеш, чтобы сохранить CAS-семантику current.

import { parseStageRoleCatalog } from '../../../shared/pipeline/routeStageWizardContracts.ts';

import { parseFactoryGraph } from '../../../shared/pipeline/factoryGraphContracts.ts';
import type { FactoryGraphData } from '../../../shared/pipeline/factoryGraphContracts.ts';
import {
  parseRouteDraft,
  parseRouteDraftContent,
  parseRouteDraftList,
  parseRouteEditorInfo,
  parseRouteEffectivePolicy,
  parseRouteDraftValidationReport,
  parseRouteCompareReport,
  parseRouteRevisionCompareReport,
  parseRouteRebasePreview,
  parseRoutePromptPreview,
  parseRouteSimulationStep,
  parseRouteTransferBundle,
  parseRouteTransferImportResult,
  parseRoutePublication,
  RoutesEditorContractError,
} from '../../../shared/pipeline/routesEditorContracts.ts';
import type {
  DraftOperation, RouteDraft, RouteDraftContent, RouteDraftSummary, RouteEditorInfo,
  RouteDraftValidationReport,
  RouteCompareReport,
  RouteRevisionCompareReport,
  RouteRebasePreview,
  RouteRebaseResolution,
  RoutePromptPreviewResponse,
  RouteSimulationStepRequest,
  RouteSimulationStepResponse,
  RouteTransferBundle,
  RouteTransferImportResult,
  RoutePublication,
  RouteEffectivePolicy,
} from '../../../shared/pipeline/routesEditorContracts.ts';
import {
  parseRouteGraph,
  parseRoutePublish,
  parseRouteProfiles,
  parseRouteRevisions,
} from '../../../shared/pipeline/routesContracts.ts';
import type { RoutePublishResponse, RouteRevisionList } from '../../../shared/pipeline/routesContracts.ts';
import { api } from './apiClient.ts';

function profilePath(profile: string): string {
  return `/api/routes/${encodeURIComponent(profile)}`;
}

function recordAt(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RoutesEditorContractError(label);
  }

  return value as Record<string, unknown>;
}

function hashAt(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new RoutesEditorContractError(label);
  }

  return value;
}

export type DraftCreateRequest =
  | { kind: 'empty'; title: string }
  | {
    kind: 'catalog';
    title: string;
    catalogHash: string
  }
  | {
    kind: 'draft';
    title: string;
    draftId: string
  }
  | {
    kind: 'document';
    title: string;
    baseCatalogHash: string | null;
      baseSourceRevision: number;
    document: RouteDraftContent
  };

export const routesApi = {
  /**
   * Читает отдельный публичный каталог ролей образца.
   * Старый editor-info сохраняет прежнюю закрытую форму.
   */
  async stageRoles(profile: string) {
    return parseStageRoleCatalog(await api.get(`${profilePath(profile)}/editor/stage-roles`));
  },

  async editor(profile: string): Promise<RouteEditorInfo> {
    const value: unknown = await api.get(`${profilePath(profile)}/editor`);

    return parseRouteEditorInfo(value);
  },

  /**
   * Получает фактическую политику исполнения для ключа запуска.
   * Ответ проходит проверку контракта перед передачей редактору.
   */
  async effectivePolicy(profile: string, runKey: string): Promise<RouteEffectivePolicy> {
    const value: unknown = await api.get(
      `${profilePath(profile)}/editor/policy/${encodeURIComponent(runKey)}`,
    );
    const policy = parseRouteEffectivePolicy(value);

    if (policy.runKey !== runKey) {
      throw new RoutesEditorContractError('routeEffectivePolicy.runKey');
    }

    return policy;
  },

  async switchSource(profile: string, input: {
    mode: 'profile-script' | 'editor';
    expectedSourceRevision: number;
    expectedCatalogHash: string | null
  }): Promise<RouteEditorInfo> {
    const value: unknown = await api.put(`${profilePath(profile)}/editor/source`, input);

    return parseRouteEditorInfo(value);
  },

  async draft(profile: string, draftId: string): Promise<RouteDraft> {
    const value: unknown = await api.get(
      `${profilePath(profile)}/drafts/${encodeURIComponent(draftId)}`,
    );

    return parseRouteDraft(value);
  },

  async drafts(profile: string): Promise<RouteDraftSummary[]> {
    const value: unknown = await api.get(`${profilePath(profile)}/drafts`);

    return parseRouteDraftList(value).drafts;
  },

  async createDraft(profile: string, input: DraftCreateRequest): Promise<RouteDraft> {
    const value: unknown = await api.post(`${profilePath(profile)}/drafts`, input);

    return parseRouteDraft(value);
  },

  async patchDraft(profile: string, draftId: string, expectedRevision: number,
    operations: DraftOperation[]): Promise<RouteDraft> {
    const value: unknown = await api.patch(
      `${profilePath(profile)}/drafts/${encodeURIComponent(draftId)}`,
      { expectedRevision, operations },
    );

    return parseRouteDraft(value);
  },

  async validateDraft(profile: string, draftId: string): Promise<RouteDraftValidationReport> {
    const value: unknown = await api.post(
      `${profilePath(profile)}/drafts/${encodeURIComponent(draftId)}/validate`, {},
    );

    return parseRouteDraftValidationReport(value);
  },

  async compareDraft(profile: string, draftId: string): Promise<RouteCompareReport> {
    const value: unknown = await api.get(
      `${profilePath(profile)}/drafts/${encodeURIComponent(draftId)}/compare`,
    );

    return parseRouteCompareReport(value);
  },

  async compareRevisions(profile: string, fromCatalogHash: string,
    toCatalogHash: string): Promise<RouteRevisionCompareReport> {
    const value: unknown = await api.get(`${profilePath(profile)}/editor/revisions/compare`
      + `?from=${encodeURIComponent(fromCatalogHash)}&to=${encodeURIComponent(toCatalogHash)}`);

    return parseRouteRevisionCompareReport(value);
  },

  async previewRebase(profile: string, draftId: string): Promise<RouteRebasePreview> {
    const value: unknown = await api.get(
      `${profilePath(profile)}/drafts/${encodeURIComponent(draftId)}/rebase/preview`,
    );

    return parseRouteRebasePreview(value);
  },

  async rebaseDraft(profile: string, draftId: string, input: {
    expectedDraftRevision: number;
    expectedCatalogHash: string;
    resolutions: RouteRebaseResolution[];
  }): Promise<RouteDraft> {
    const value: unknown = await api.post(
      `${profilePath(profile)}/drafts/${encodeURIComponent(draftId)}/rebase`, input,
    );

    return parseRouteDraft(value);
  },

  async previewDraft(profile: string, draftId: string, input: {
    expectedRevision: number;
    scope: 'route' | 'bootstrap';
    routeId: string | null;
    nodeId: string;
    context: Record<string, unknown>;
  }): Promise<RoutePromptPreviewResponse> {
    const value: unknown = await api.post(
      `${profilePath(profile)}/drafts/${encodeURIComponent(draftId)}/preview`, input,
    );

    return parseRoutePromptPreview(value);
  },

  async stepDraftSimulation(profile: string, draftId: string,
    input: RouteSimulationStepRequest): Promise<RouteSimulationStepResponse> {
    const value: unknown = await api.post(
      `${profilePath(profile)}/drafts/${encodeURIComponent(draftId)}/simulate/step`, input,
    );

    return parseRouteSimulationStep(value);
  },

  async exportDraftTransfer(profile: string, draftId: string,
    routeId: string | null = null): Promise<RouteTransferBundle> {
    const suffix = routeId ? `?routeId=${encodeURIComponent(routeId)}` : '';
    const value: unknown = await api.get(
      `${profilePath(profile)}/drafts/${encodeURIComponent(draftId)}/transfer${suffix}`,
    );

    return parseRouteTransferBundle(value);
  },

  async importDraftTransfer(profile: string, title: string,
    bundle: RouteTransferBundle): Promise<RouteTransferImportResult> {
    const value: unknown = await api.post(`${profilePath(profile)}/editor/import`,
      { title, bundle });

    return parseRouteTransferImportResult(value);
  },

  async addRouteTransfer(profile: string, draftId: string, input: {
    expectedRevision: number;
    bundle: RouteTransferBundle;
    collision: 'require-choice' | 'cancel' | 'replace' | 'rename';
    newRouteId?: string;
  }): Promise<RouteTransferImportResult> {
    const value: unknown = await api.post(
      `${profilePath(profile)}/drafts/${encodeURIComponent(draftId)}/import`, input,
    );

    return parseRouteTransferImportResult(value);
  },

  async publishDraft(profile: string, draftId: string, input: {
    expectedRevision: number;
    expectedCatalogHash: string | null;
    expectedSourceRevision: number;
    operationId: string;
    comment?: string;
  }): Promise<RoutePublication> {
    const value: unknown = await api.post(
      `${profilePath(profile)}/drafts/${encodeURIComponent(draftId)}/publish`, input,
    );

    return parseRoutePublication(value);
  },

  async publicationStatus(profile: string, operationId: string): Promise<RoutePublication> {
    const value: unknown = await api.get(
      `${profilePath(profile)}/publications/${encodeURIComponent(operationId)}`,
    );

    return parseRoutePublication(value);
  },

  /** Читает все route bundles опубликованного каталога, включая тексты инструкций. */
  /**
   * Загружает полный неизменяемый бандл по его хешу.
   * Ответ проходит проверку контракта перед передачей редактору.
   */
  async catalog(profile: string, catalogHash: string): Promise<RouteDraftContent> {
    hashAt(catalogHash, 'catalogHash');

    const value: unknown = await api.get(`${profilePath(profile)}/catalog/${catalogHash}`);
    const bundle = recordAt(value, 'catalogBundle');

    if (bundle.catalogHash !== catalogHash) {
      throw new RoutesEditorContractError('catalogBundle.catalogHash');
    }

    const catalog = recordAt(bundle.catalog, 'catalogBundle.catalog');

    if (catalog.schema !== 2 || catalog.profile !== profile) {
      throw new RoutesEditorContractError('catalogBundle.catalog');
    }

    const hashes = recordAt(catalog.routes, 'catalogBundle.catalog.routes');
    const routes = Object.fromEntries(await Promise.all(Object.entries(hashes).map(
      async ([routeId, unknownHash]) => {
        const routeHash = hashAt(unknownHash,
          `catalogBundle.catalog.routes.${routeId}`);
        const routeValue: unknown = await api.get(
          `${profilePath(profile)}/routes/${encodeURIComponent(routeId)}/${routeHash}`,
        );
        const routeBundle = recordAt(routeValue, `routeBundle.${routeId}`);
        const route = recordAt(routeBundle.route, `routeBundle.${routeId}.route`);

        if (routeBundle.routeHash !== routeHash || route.profile !== profile
          || route.id !== routeId) {
          throw new RoutesEditorContractError(`routeBundle.${routeId}`);
        }

        return [routeId, { route, prompts: routeBundle.prompts }];
      },
    )));

    return parseRouteDraftContent({
      routes,
      bootstrap: bundle.bootstrap,
      bootstrapPrompts: bundle.prompts,
      presentation: {},
      provenance: {},
    });
  },

  async profiles(): Promise<string[]> {
    const value: unknown = await api.get('/api/profiles');

    return parseRouteProfiles(value);
  },

  async revisions(profile: string): Promise<RouteRevisionList> {
    const value: unknown = await api.get(`${profilePath(profile)}/revisions`);

    return parseRouteRevisions(value);
  },

  /**
   * Схема опубликованного маршрута. `?c=<хеш каталога>` обязателен: когда-то схема
   * отдавалась immutable, и браузер до сих пор может держать тот старый ответ по
   * голому пути — иной query промахивается мимо его кеша.
   */
  async graph(
    profile: string,
    routeId: string,
    routeHash: string,
    catalogHash: string | null,
  ): Promise<FactoryGraphData> {
    const path = `${profilePath(profile)}/routes/${encodeURIComponent(routeId)}`
      + `/${encodeURIComponent(routeHash)}/graph?c=${encodeURIComponent(catalogHash ?? '')}`;
    const value: unknown = await api.get(path);

    return parseFactoryGraph(parseRouteGraph(value), 'routeGraph.graph');
  },

  async catalogGraph(profile: string, catalogHash: string,
    routeId: string): Promise<FactoryGraphData> {
    hashAt(catalogHash, 'catalogHash');

    const value: unknown = await api.get(`${profilePath(profile)}/catalog/${catalogHash}`
      + `/graph?route=${encodeURIComponent(routeId)}`);

    return parseFactoryGraph(parseRouteGraph(value), 'routeGraph.graph');
  },

  async publish(
    profile: string,
    mode: 'validate' | 'publish',
    expectedCatalogHash: string | null,
  ): Promise<RoutePublishResponse> {
    const body = mode === 'publish' ? { mode, expectedCatalogHash } : { mode };
    const value: unknown = await api.post(`${profilePath(profile)}/publish`, body);

    return parseRoutePublish(value);
  },

  async rollback(
    profile: string,
    desiredCatalogHash: string,
    expectedCatalogHash: string | null,
  ): Promise<void> {
    await api.put(`${profilePath(profile)}/current`, {
      desiredCatalogHash,
      expectedCatalogHash,
    });
  },
};
