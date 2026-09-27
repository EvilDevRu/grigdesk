import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import {
  ROUTES_EDITOR_LIMITS, RoutesEditorContractError, routeSimulationStepLimit,
} from '../../../../shared/routesEditorContracts.ts';
import type {
  RouteRebaseResolution, RouteSimulationStepRequest,
} from '../../../../shared/routesEditorContracts.ts';
import type { ProjectsPrefsPort } from '../../lib/profiles.ts';
import { loadRunnerConfig, resolveRunnerState } from '../../lib/runnerState.ts';

import { DraftStore, RoutesEditorStoreError } from './draftStore.ts';
import type { CatalogObserver } from './catalogObserver.ts';
import { RoutesEditorModelError } from './draftModel.ts';
import { RoutesEditorService } from './editorService.ts';
import {
  renderDraftPreview, stepDraftSimulation, RoutesEditorEngineError,
} from './editorEngine.ts';
import { RoutesError } from './schema.ts';
import { RoutesStore } from './store.ts';
import { validateDraft } from './validation.ts';
import { compareCatalogDocuments, comparePresentation } from './compare.ts';
import {
  decodeRouteTransfer, exportRouteTransfer, rebindRouteTransfer,
  unresolvedRouteDependencies, planSingleRouteImport,
} from './transferService.ts';
import {
  readEditorCapabilities,
  validateDraftCapabilities,
} from './editorCapabilities.ts';

type EditorRequest = FastifyRequest<{
  Params: { profile: string; draftId: string; operationId: string; runKey: string };
  Body: unknown;
}>;

export interface RoutesEditorApiOptions {
  routesStore: RoutesStore;
  authoringDir: string;
  profilesDir: string;
  prefs: ProjectsPrefsPort;
  draftStore?: DraftStore;
  observer?: CatalogObserver;
}

function bodyAt(value: unknown, required: readonly string[], optional: readonly string[] = []) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RoutesEditorStoreError('routes_bad_request', 'Ожидался JSON-объект');
  }
  const body = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(body).some((key) => !allowed.has(key))
    || required.some((key) => !Object.hasOwn(body, key))) {
    throw new RoutesEditorStoreError('routes_bad_request', 'Неверные поля запроса');
  }
  return body;
}

function createBody(value: unknown): Record<string, unknown> {
  const head = bodyAt(value, ['kind', 'title'], [
    'catalogHash', 'draftId', 'baseCatalogHash', 'baseSourceRevision', 'document',
  ]);
  const fields: Record<string, readonly string[]> = {
    empty: ['kind', 'title'],
    catalog: ['kind', 'title', 'catalogHash'],
    draft: ['kind', 'title', 'draftId'],
    document: [
      'kind', 'title', 'baseCatalogHash', 'baseSourceRevision', 'document',
    ],
  };
  const exact = fields[String(head.kind)];
  if (!exact || Object.keys(head).length !== exact.length
    || Object.keys(head).some((key) => !exact.includes(key))) {
    throw new RoutesEditorStoreError('routes_bad_request', 'Неверный вариант создания');
  }
  return head;
}

function sendError(fastify: FastifyInstance, reply: FastifyReply, error: unknown) {
  const code = (error as { code?: string } | null)?.code;
  const status = error instanceof RoutesEditorContractError ? 400
    : code === 'routes_engine_unavailable' ? 503
    : code === 'routes_payload_too_large' ? 413
      : code === 'routes_validation_failed' || code === 'routes_profile_unavailable' ? 422
      : code === 'routes_draft_not_found' || code === 'routes_project_not_found'
        || code === 'routes_operation_not_found' ? 404
      : code === 'routes_draft_conflict' || code === 'routes_draft_closed'
        || code === 'routes_source_conflict' || code === 'routes_catalog_conflict'
        || code === 'routes_operation_reused' || code === 'routes_recovery_conflict' ? 409
        : code === 'routes_bad_request' || code === 'routes_revision_required'
          || code === 'routes_operation_id_required'
          || code === 'ROUTES_V2_INVALID_HASH' || code === 'ROUTES_V2_INVALID_ID'
          || code === 'ROUTES_V2_PATH_TRAVERSAL' ? 400
          : code === 'ROUTES_V2_NOT_FOUND' ? 404 : 500;
  const known = error instanceof RoutesEditorStoreError
    || error instanceof RoutesEditorModelError
    || error instanceof RoutesEditorEngineError
    || error instanceof RoutesEditorContractError
    || error instanceof RoutesError;
  if (!known || status === 500) {
    fastify.log.error({ err: error }, 'routes editor: ошибка');
  }
  const responseCode = error instanceof RoutesEditorContractError
    ? 'routes_bad_request' : status === 503 ? 'routes_engine_unavailable' : status === 500
      ? (code === 'routes_authoring_corrupted' ? code : 'routes_authoring_unavailable')
      : code === 'ROUTES_V2_NOT_FOUND' ? 'routes_bad_request'
        : code?.startsWith('ROUTES_V2_') ? 'routes_bad_request' : code;
  const details = error instanceof RoutesEditorStoreError || error instanceof RoutesError
    ? error.details : {};
  return reply.code(status).header('cache-control', 'no-store').send({
    error: responseCode,
    message: status === 503 ? 'Движок предпросмотра временно недоступен.'
      : status === 500 ? 'Редактор маршрутов временно недоступен.'
      : status === 413 ? 'Превышен допустимый размер.'
        : status === 409 ? 'Черновик изменился или закрыт.'
          : status === 404 ? 'Документ не найден.' : 'Неверный запрос редактора.',
    ...details,
  });
}

function guarded(
  fastify: FastifyInstance,
  action: (request: EditorRequest, reply: FastifyReply) => Promise<unknown>,
) {
  return async (request: EditorRequest, reply: FastifyReply) => {
    try {
      return await action(request, reply);
    } catch (error) {
      return sendError(fastify, reply, error);
    }
  };
}

export async function registerRoutesEditorApi(
  fastify: FastifyInstance,
  options: RoutesEditorApiOptions,
): Promise<void> {
  const draftStore = options.draftStore ?? new DraftStore({
    baseDir: options.authoringDir,
    routesStore: options.routesStore,
  });
  const service = new RoutesEditorService({
    routesStore: options.routesStore,
    draftStore,
    profilesDir: options.profilesDir,
    prefs: options.prefs,
  });
  const base = '/api/routes/:profile/drafts';
  const emitDraft = (draft: { profile: string; id: string; revision: number; state: string }) => {
    fastify.sse?.broadcast?.('routes-draft-changed', {
      profile: draft.profile, draftId: draft.id, revision: draft.revision, state: draft.state,
    });
  };
  const emitCatalog = (profile: string, catalogHash: string | null, sourceRevision: number) => {
    options.observer?.note(profile, catalogHash, sourceRevision);
    fastify.sse?.broadcast?.('routes-catalog-changed', {
      profile, catalogHash, sourceRevision,
    });
  };

  fastify.get('/api/routes/:profile/editor', guarded(fastify, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const info = await service.info(request.params.profile);
    await options.observer?.register(request.params.profile);
    return info;
  }));

  fastify.get('/api/routes/:profile/editor/revisions/compare', guarded(fastify,
    async (request, reply) => {
      const query = request.query as Record<string, unknown>;
      if (!query || Object.keys(query).sort().join(',') !== 'from,to'
        || typeof query.from !== 'string' || typeof query.to !== 'string'
        || !/^[a-f0-9]{64}$/.test(query.from) || !/^[a-f0-9]{64}$/.test(query.to)) {
        throw new RoutesEditorStoreError('routes_bad_request', 'Нужны два точных хеша каталога');
      }
      await service.ensureProject(request.params.profile);
      const [before, after] = await Promise.all([
        service.fromCatalog(request.params.profile, query.from),
        service.fromCatalog(request.params.profile, query.to),
      ]);
      reply.header('cache-control', 'no-store');
      return {
        fromCatalogHash: query.from,
        toCatalogHash: query.to,
        changes: compareCatalogDocuments(before, after),
        presentationChanges: comparePresentation(before, after),
      };
    }));

  fastify.get('/api/routes/:profile/editor/policy/:runKey', guarded(fastify,
    async (request, reply) => {
      const { profile, runKey } = request.params;
      if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(runKey)) {
        throw new RoutesEditorStoreError('routes_bad_request', 'Недопустимый ключ этапа.');
      }
      await service.info(profile);
      const state = resolveRunnerState(loadRunnerConfig(options.profilesDir, profile), {}, runKey);
      reply.header('cache-control', 'no-store');
      return { runKey, primary: state.primary, failover: state.failover,
        source: state.source, models: state.models };
    }));

  fastify.get('/api/routes/:profile/publications/:operationId', guarded(fastify,
    async (request, reply) => {
      await service.ensureProject(request.params.profile);
      const receipt = await service.publication.status(request.params.profile,
        request.params.operationId);
      if (!receipt) {
        throw new RoutesEditorStoreError('routes_operation_not_found',
          'Итог операции пока неизвестен');
      }
      reply.header('cache-control', 'no-store');
      return receipt;
    },
  ));

  fastify.put('/api/routes/:profile/editor/source', guarded(fastify,
    async (request, reply) => {
      const body = bodyAt(request.body,
        ['mode', 'expectedSourceRevision', 'expectedCatalogHash']);
      if ((body.mode !== 'profile-script' && body.mode !== 'editor')
        || !Number.isSafeInteger(body.expectedSourceRevision)
        || Number(body.expectedSourceRevision) < 0
        || (body.expectedCatalogHash !== null
          && typeof body.expectedCatalogHash !== 'string')) {
        throw new RoutesEditorStoreError('routes_bad_request', 'Неверный переход источника');
      }
      reply.header('cache-control', 'no-store');
      const info = await service.switchSource(request.params.profile, {
        mode: body.mode,
        expectedSourceRevision: body.expectedSourceRevision as number,
        expectedCatalogHash: body.expectedCatalogHash as string | null,
      });
      if (info.source.revision !== body.expectedSourceRevision) {
        emitCatalog(info.profile, info.currentCatalogHash, info.source.revision);
      }
      return info;
    },
  ));

  fastify.get(base, guarded(fastify, async (request, reply) => {
    await service.ensureProject(request.params.profile);
    reply.header('cache-control', 'no-store');
    return draftStore.list(request.params.profile);
  }));

  fastify.post('/api/routes/:profile/editor/import', {
    bodyLimit: ROUTES_EDITOR_LIMITS.importBytes,
  }, guarded(fastify, async (request, reply) => {
    const body = bodyAt(request.body, ['title', 'bundle']);
    if (typeof body.title !== 'string') {
      throw new RoutesEditorStoreError('routes_bad_request', 'Нужно название импорта');
    }
    const bundle = decodeRouteTransfer(body.bundle);
    const content = rebindRouteTransfer(bundle, request.params.profile);
    const draft = await service.create(request.params.profile, {
      kind: 'document', title: body.title,
      baseCatalogHash: null, baseSourceRevision: 0,
      document: content,
    });
    const snapshot = await readEditorCapabilities(request.params.profile, {
      profilesDir: options.profilesDir,
    });
    const report = validateDraft(draft);
    emitDraft(draft);
    reply.code(201).header('cache-control', 'no-store');
    return {
      draft,
      unresolvedDependencies: unresolvedRouteDependencies(bundle, content),
      issues: [...report.issues, ...validateDraftCapabilities(draft, snapshot)],
    };
  }));

  fastify.post(base, { bodyLimit: ROUTES_EDITOR_LIMITS.draftBytes }, guarded(
    fastify,
    async (request, reply) => {
      const draft = await service.create(request.params.profile, createBody(request.body));
      emitDraft(draft);
      reply.code(201).header('cache-control', 'no-store');
      return draft;
    },
  ));

  fastify.get(`${base}/:draftId`, guarded(fastify, async (request, reply) => {
    await service.ensureProject(request.params.profile);
    reply.header('cache-control', 'no-store');
    return draftStore.read(request.params.profile, request.params.draftId);
  }));

  fastify.get(`${base}/:draftId/transfer`, guarded(fastify, async (request, reply) => {
    await service.ensureProject(request.params.profile);
    const query = request.query as Record<string, unknown>;
    if (!query || Object.keys(query).some((key) => key !== 'routeId')
      || (query.routeId !== undefined && typeof query.routeId !== 'string')) {
      throw new RoutesEditorStoreError('routes_bad_request', 'Неверный запрос экспорта');
    }
    const draft = await draftStore.read(request.params.profile, request.params.draftId);
    reply.header('cache-control', 'no-store');
    return exportRouteTransfer(draft, (query.routeId as string | undefined) ?? null);
  }));

  fastify.post(`${base}/:draftId/import`, {
    bodyLimit: ROUTES_EDITOR_LIMITS.importBytes,
  }, guarded(fastify, async (request, reply) => {
    await service.ensureProject(request.params.profile);
    const body = bodyAt(request.body,
      ['expectedRevision', 'bundle', 'collision'], ['newRouteId']);
    if (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 1
      || !['require-choice', 'cancel', 'replace', 'rename'].includes(String(body.collision))
      || (body.newRouteId !== undefined && typeof body.newRouteId !== 'string')) {
      throw new RoutesEditorStoreError('routes_bad_request', 'Неверный запрос импорта');
    }
    const bundle = decodeRouteTransfer(body.bundle);
    const draft = await draftStore.read(request.params.profile, request.params.draftId);
    if (draft.revision !== body.expectedRevision) {
      throw new RoutesEditorStoreError('routes_draft_conflict', 'Черновик изменился', {
        currentRevision: draft.revision,
      });
    }
    if (draft.state !== 'editing') {
      throw new RoutesEditorStoreError('routes_draft_closed', 'Черновик закрыт');
    }
    const plan = planSingleRouteImport(bundle, draft,
      body.collision as 'require-choice' | 'cancel' | 'replace' | 'rename',
      body.newRouteId as string | undefined);
    const changed = plan.cancelled ? draft : await draftStore.patch(
      request.params.profile, draft.id,
      { expectedRevision: draft.revision, operations: plan.operations },
    );
    if (!plan.cancelled) emitDraft(changed);
    const snapshot = await readEditorCapabilities(request.params.profile, {
      profilesDir: options.profilesDir,
    });
    const report = validateDraft(changed);
    reply.header('cache-control', 'no-store');
    return { draft: changed, cancelled: plan.cancelled,
      unresolvedDependencies: plan.unresolvedDependencies,
      issues: [...report.issues, ...validateDraftCapabilities(changed, snapshot)] };
  }));

  fastify.get(`${base}/:draftId/compare`, guarded(fastify, async (request, reply) => {
    const info = await service.info(request.params.profile);
    const draft = await draftStore.read(request.params.profile, request.params.draftId);
    const before = info.currentCatalogHash
      ? await service.fromCatalog(request.params.profile, info.currentCatalogHash) : null;
    reply.header('cache-control', 'no-store');
    return {
      draftId: draft.id,
      draftRevision: draft.revision,
      currentCatalogHash: info.currentCatalogHash,
      sourceMode: info.source.mode,
      sourceRevision: info.source.revision,
      capabilitiesHash: info.capabilitiesHash,
      changes: compareCatalogDocuments(before, draft),
      presentationChanges: comparePresentation(before, draft),
    };
  }));

  fastify.get(`${base}/:draftId/rebase/preview`, guarded(fastify,
    async (request, reply) => {
      const plan = await service.rebasePlan(request.params.profile,
        request.params.draftId, { resolutions: [] });
      reply.header('cache-control', 'no-store');
      return {
        draftId: plan.draft.id,
        draftRevision: plan.draft.revision,
        baseCatalogHash: plan.draft.baseCatalogHash,
        currentCatalogHash: plan.currentCatalogHash,
        conflicts: plan.conflicts,
      };
    }));

  fastify.post(`${base}/:draftId/rebase`, {
    bodyLimit: ROUTES_EDITOR_LIMITS.patchBytes,
  }, guarded(fastify, async (request, reply) => {
    const body = bodyAt(request.body,
      ['expectedDraftRevision', 'expectedCatalogHash', 'resolutions']);
    if (!Number.isSafeInteger(body.expectedDraftRevision)
      || Number(body.expectedDraftRevision) < 1
      || typeof body.expectedCatalogHash !== 'string'
      || !/^[a-f0-9]{64}$/.test(body.expectedCatalogHash)
      || !Array.isArray(body.resolutions)) {
      throw new RoutesEditorStoreError('routes_bad_request', 'Неверный запрос rebase');
    }
    const rebased = await service.rebase(request.params.profile,
      request.params.draftId, {
        expectedDraftRevision: body.expectedDraftRevision as number,
        expectedCatalogHash: body.expectedCatalogHash,
        resolutions: body.resolutions as RouteRebaseResolution[],
      });
    emitDraft(rebased);
    reply.header('cache-control', 'no-store');
    return rebased;
  }));

  fastify.patch(`${base}/:draftId`, {
    bodyLimit: ROUTES_EDITOR_LIMITS.patchBytes,
  }, guarded(fastify, async (request, reply) => {
    await service.ensureProject(request.params.profile);
    const body = bodyAt(request.body, ['operations'], ['expectedRevision']);
    if (!Number.isInteger(body.expectedRevision) || Number(body.expectedRevision) < 1) {
      throw new RoutesEditorStoreError('routes_revision_required', 'Нужна expectedRevision');
    }
    reply.header('cache-control', 'no-store');
    const draft = await draftStore.patch(request.params.profile, request.params.draftId, {
      expectedRevision: body.expectedRevision as number,
      operations: body.operations as never[],
    });
    if (draft.revision !== body.expectedRevision) emitDraft(draft);
    return draft;
  }));

  fastify.post(`${base}/:draftId/archive`, guarded(fastify, async (request, reply) => {
    await service.ensureProject(request.params.profile);
    const body = bodyAt(request.body, [], ['expectedRevision']);
    if (!Number.isInteger(body.expectedRevision) || Number(body.expectedRevision) < 1) {
      throw new RoutesEditorStoreError('routes_revision_required', 'Нужна expectedRevision');
    }
    reply.header('cache-control', 'no-store');
    const draft = await draftStore.archive(
      request.params.profile,
      request.params.draftId,
      body.expectedRevision as number,
    );
    if (draft.revision !== body.expectedRevision) emitDraft(draft);
    return draft;
  }));

  fastify.post(`${base}/:draftId/validate`, guarded(fastify, async (request, reply) => {
    await service.ensureProject(request.params.profile);
    const body = bodyAt(request.body, [], ['expectedRevision']);
    const draft = await draftStore.read(request.params.profile, request.params.draftId);
    if (Object.hasOwn(body, 'expectedRevision') && body.expectedRevision !== draft.revision) {
      throw new RoutesEditorStoreError('routes_draft_conflict', 'Черновик изменился', {
        currentRevision: draft.revision,
      });
    }
    reply.header('cache-control', 'no-store');
    const report = validateDraft(draft);
    const snapshot = await readEditorCapabilities(request.params.profile, {
      profilesDir: options.profilesDir,
    });
    return {
      ...report,
      capabilitiesHash: snapshot.capabilitiesHash,
      issues: [...report.issues, ...validateDraftCapabilities(draft, snapshot)],
    };
  }));

  fastify.post(`${base}/:draftId/preview`, {
    bodyLimit: ROUTES_EDITOR_LIMITS.draftBytes,
  }, guarded(fastify, async (request, reply) => {
    await service.ensureProject(request.params.profile);
    const body = bodyAt(request.body,
      ['expectedRevision', 'scope', 'routeId', 'nodeId', 'context']);
    if (!Number.isInteger(body.expectedRevision) || Number(body.expectedRevision) < 1
      || (body.scope !== 'route' && body.scope !== 'bootstrap')
      || typeof body.nodeId !== 'string'
      || (body.scope === 'route' && typeof body.routeId !== 'string')
      || (body.scope === 'bootstrap' && body.routeId !== null)
      || body.context === null || typeof body.context !== 'object'
      || Array.isArray(body.context)) {
      throw new RoutesEditorStoreError('routes_bad_request', 'Неверный запрос предпросмотра');
    }
    const draft = await draftStore.read(request.params.profile, request.params.draftId);
    if (draft.revision !== body.expectedRevision) {
      throw new RoutesEditorStoreError('routes_draft_conflict', 'Черновик изменился', {
        currentRevision: draft.revision,
      });
    }
    const result = await renderDraftPreview(draft, {
      scope: body.scope,
      routeId: body.routeId as string | null,
      nodeId: body.nodeId,
      context: body.context as Record<string, unknown>,
    });
    reply.header('cache-control', 'no-store');
    return { draftRevision: draft.revision, ...result };
  }));

  fastify.post(`${base}/:draftId/simulate/step`, {
    bodyLimit: ROUTES_EDITOR_LIMITS.draftBytes,
  }, guarded(fastify, async (request, reply) => {
    await service.ensureProject(request.params.profile);
    const body = bodyAt(request.body, [
      'expectedRevision', 'cursor', 'counters', 'outcome', 'failureOwner',
      'selectedRouteId', 'pinned', 'humanApproved', 'stepIndex',
    ], ['loopMaxRounds']);
    const loopMaxRounds = body.loopMaxRounds as number | undefined;
    if (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 1
      || (loopMaxRounds !== undefined && (!Number.isSafeInteger(loopMaxRounds)
        || loopMaxRounds < 1 || loopMaxRounds > ROUTES_EDITOR_LIMITS.loopMaxRounds))
      || !Number.isSafeInteger(body.stepIndex) || Number(body.stepIndex) < 1
      || Number(body.stepIndex) > routeSimulationStepLimit(loopMaxRounds)
      || typeof body.outcome !== 'string'
      || (body.failureOwner !== null && typeof body.failureOwner !== 'string')
      || (body.selectedRouteId !== null && typeof body.selectedRouteId !== 'string')
      || typeof body.pinned !== 'boolean' || typeof body.humanApproved !== 'boolean') {
      throw new RoutesEditorStoreError('routes_bad_request', 'Неверный шаг симуляции');
    }
    const draft = await draftStore.read(request.params.profile, request.params.draftId);
    if (draft.revision !== body.expectedRevision) {
      throw new RoutesEditorStoreError('routes_draft_conflict', 'Черновик изменился', {
        currentRevision: draft.revision,
      });
    }
    const { expectedRevision, ...stepRequest } = body as unknown as RouteSimulationStepRequest;
    void expectedRevision;
    const result = await stepDraftSimulation(draft, stepRequest);
    reply.header('cache-control', 'no-store');
    return { draftRevision: draft.revision, ...result };
  }));

  fastify.post(`${base}/:draftId/publish`, guarded(fastify, async (request, reply) => {
    const body = bodyAt(request.body, [
      'expectedRevision', 'expectedCatalogHash', 'expectedSourceRevision', 'operationId',
    ], ['comment']);
    if (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 1
      || !Number.isSafeInteger(body.expectedSourceRevision)
      || Number(body.expectedSourceRevision) < 0
      || (body.expectedCatalogHash !== null && typeof body.expectedCatalogHash !== 'string')
      || typeof body.operationId !== 'string'
      || (body.comment !== undefined && (typeof body.comment !== 'string'
        || Buffer.byteLength(body.comment, 'utf8') > 2000
        || body.comment.includes('\0')))) {
      throw new RoutesEditorStoreError('routes_bad_request', 'Неверный запрос публикации');
    }
    const receipt = await service.publish(request.params.profile, {
      draftId: request.params.draftId,
      expectedRevision: body.expectedRevision as number,
      expectedCatalogHash: body.expectedCatalogHash as string | null,
      expectedSourceRevision: body.expectedSourceRevision as number,
      operationId: body.operationId,
      ...(body.comment !== undefined ? { comment: body.comment as string } : {}),
    }, (committed) => {
      emitDraft({
        profile: request.params.profile, id: committed.draftId,
        revision: committed.draftRevision, state: 'published',
      });
      emitCatalog(request.params.profile, committed.toCatalogHash, committed.sourceRevision);
    });
    reply.header('cache-control', 'no-store');
    return receipt;
  }));
}
