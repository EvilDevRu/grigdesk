import { randomUUID } from 'node:crypto';

import type { RouteDraft, RouteDraftContent, RoutePublication,
  RouteRebaseResolution } from '../../../../shared/pipeline/routesEditorContracts.ts';
import { listProjects } from '../../lib/profiles.ts';
import type { ProjectsPrefsPort } from '../../lib/profiles.ts';

import { DraftStore, RoutesEditorStoreError } from './draftStore.ts';
import { draftFromCatalog } from './draftModel.ts';
import { readEditorCapabilities } from './editorCapabilities.ts';
import { assertProfileId } from './schema.ts';
import { RoutesStore } from './store.ts';
import { RoutesPublicationCoordinator } from './publicationCoordinator.ts';
import type { EditorPublishInput } from './publicationCoordinator.ts';
import { planDraftRebase } from './rebaseService.ts';

export interface RoutesEditorServiceOptions {
  routesStore: RoutesStore;
  draftStore: DraftStore;
  profilesDir: string;
  prefs: ProjectsPrefsPort;
}

export class RoutesEditorService {
  readonly routesStore: RoutesStore;

  readonly draftStore: DraftStore;

  readonly profilesDir: string;

  readonly prefs: ProjectsPrefsPort;

  readonly publication: RoutesPublicationCoordinator;

  constructor({ routesStore, draftStore, profilesDir, prefs }: RoutesEditorServiceOptions) {
    this.routesStore = routesStore;
    this.draftStore = draftStore;
    this.profilesDir = profilesDir;
    this.prefs = prefs;
    this.publication = new RoutesPublicationCoordinator(routesStore, draftStore, profilesDir);
  }

  /**
   * Проверяет существование проекта в общем реестре фабрики и Cockpit.
   * Чтение маршрутов не создаёт паспорт или каталог профиля.
   */
  async ensureProject(profile: string): Promise<void> {
    try {
      assertProfileId(profile);
    } catch {
      throw new RoutesEditorStoreError('routes_bad_request', 'Недопустимый профиль');
    }
    const projects = await listProjects({ profilesDir: this.profilesDir }, this.prefs);
    if (!projects.includes(profile)) {
      throw new RoutesEditorStoreError('routes_project_not_found', 'Проект не найден');
    }
  }

  /**
   * Отдаёт декларативные возможности профиля без исполнения его shell.
   * Источник управления и текущий каталог дополняются в D2.
   */
  async info(profile: string) {
    await this.ensureProject(profile);
    const snapshot = await readEditorCapabilities(profile, { profilesDir: this.profilesDir });
    const current = await this.routesStore.readCurrent(profile);
    const source = await this.publication.source(profile);
    return {
      profile,
      source,
      currentCatalogHash: current?.catalogHash ?? null,
      capabilitiesHash: snapshot.capabilitiesHash,
      capabilities: snapshot.capabilities,
      issues: snapshot.issues,
    };
  }

  /** Изменение writer-а сверяет обе версии под общим замком профиля. */
  async switchSource(profile: string, options: {
    mode: 'profile-script' | 'editor';
    expectedSourceRevision: number;
    expectedCatalogHash: string | null;
  }) {
    await this.ensureProject(profile);
    await this.publication.switchSource(profile, options);
    return this.info(profile);
  }

  async publish(profile: string, input: EditorPublishInput,
    onCommitted?: (receipt: RoutePublication) => void) {
    await this.ensureProject(profile);
    return this.publication.publish(profile, input, { onCommitted });
  }

  /**
   * Загружает полную точную ревизию: исходником являются immutable route bundles,
   * а не просмотровая проекция графа.
   */
  async fromCatalog(profile: string, catalogHash: string): Promise<RouteDraftContent> {
    const catalog = await this.routesStore.readCatalog(profile, catalogHash);
    const routes = Object.fromEntries(await Promise.all(
      Object.entries(catalog.catalog.routes).map(async ([routeId, hash]) => [
        routeId,
        await this.routesStore.readRoute(profile, routeId, hash),
      ]),
    ));
    const copied = draftFromCatalog({ catalog, routes }, {
      id: randomUUID(),
      title: '',
      baseSourceRevision: 0,
      createdAt: new Date().toISOString(),
    });
    return {
      routes: copied.routes,
      bootstrap: copied.bootstrap,
      bootstrapPrompts: copied.bootstrapPrompts,
      presentation: copied.presentation,
      provenance: copied.provenance,
    };
  }

  /** Загружает сохранённое основание, мой черновик и точный current для rebase. */
  async rebasePlan(profile: string, id: string, input: {
    expectedDraftRevision?: number;
    expectedCatalogHash?: string;
    resolutions: RouteRebaseResolution[];
  }) {
    await this.ensureProject(profile);
    const draft = await this.draftStore.read(profile, id);
    if (draft.state !== 'editing') {
      throw new RoutesEditorStoreError('routes_draft_closed', 'Черновик закрыт');
    }
    if (input.expectedDraftRevision !== undefined
      && draft.revision !== input.expectedDraftRevision) {
      throw new RoutesEditorStoreError('routes_draft_conflict', 'Черновик изменился', {
        currentRevision: draft.revision,
      });
    }
    const pointer = await this.routesStore.readCurrent(profile);
    const currentCatalogHash = pointer?.catalogHash ?? null;
    if (!currentCatalogHash || (input.expectedCatalogHash !== undefined
      && input.expectedCatalogHash !== currentCatalogHash)) {
      throw new RoutesEditorStoreError('routes_catalog_conflict', 'Каталог изменился', {
        currentCatalogHash,
      });
    }
    const [base, current] = await Promise.all([
      draft.baseCatalogHash ? this.fromCatalog(profile, draft.baseCatalogHash) : null,
      this.fromCatalog(profile, currentCatalogHash),
    ]);
    const plan = planDraftRebase(base, draft, current, input.resolutions);
    return { draft, currentCatalogHash, ...plan };
  }

  /** После compare подтверждает обе версии под lock и пишет одну новую revision. */
  async rebase(profile: string, id: string, input: {
    expectedDraftRevision: number;
    expectedCatalogHash: string;
    resolutions: RouteRebaseResolution[];
  }): Promise<RouteDraft> {
    const plan = await this.rebasePlan(profile, id, input);
    if (plan.conflicts.length) {
      throw new RoutesEditorStoreError('routes_draft_conflict',
        'Нужно разрешить пересекающиеся изменения', { conflicts: plan.conflicts });
    }
    return this.draftStore.rebase(profile, id, {
      expectedRevision: input.expectedDraftRevision,
      expectedBaseCatalogHash: plan.draft.baseCatalogHash,
      expectedCatalogHash: input.expectedCatalogHash,
      document: plan.document,
    });
  }

  /**
   * Создаёт независимый полный черновик одним из четырёх закрытых вариантов.
   */
  async create(profile: string, body: Record<string, unknown>): Promise<RouteDraft> {
    await this.ensureProject(profile);
    const { kind, title } = body;
    if (typeof title !== 'string') {
      throw new RoutesEditorStoreError('routes_bad_request', 'Нужно название черновика');
    }

    if (kind === 'empty') {
      return this.draftStore.create(profile, {
        title,
        baseCatalogHash: null,
        baseSourceRevision: 0,
        document: {
          routes: {},
          bootstrap: {
            schema: 2,
            kind: 'bootstrap',
            profile,
            id: 'scout',
            entry: null,
            sequence: { bootstrap: [] },
            nodes: [],
            escalation: [],
          },
          bootstrapPrompts: {},
          presentation: {},
          provenance: {},
        },
      });
    }
    if (kind === 'catalog') {
      if (typeof body.catalogHash !== 'string') {
        throw new RoutesEditorStoreError('routes_bad_request', 'Нужен catalogHash');
      }
      return this.draftStore.create(profile, {
        title,
        baseCatalogHash: body.catalogHash,
        baseSourceRevision: 0,
        document: await this.fromCatalog(profile, body.catalogHash),
      });
    }
    if (kind === 'draft') {
      if (typeof body.draftId !== 'string') {
        throw new RoutesEditorStoreError('routes_bad_request', 'Нужен draftId');
      }
      const source = await this.draftStore.read(profile, body.draftId);
      return this.draftStore.create(profile, {
        title,
        baseCatalogHash: source.baseCatalogHash,
        baseSourceRevision: source.baseSourceRevision,
        document: {
          routes: source.routes,
          bootstrap: source.bootstrap,
          bootstrapPrompts: source.bootstrapPrompts,
          presentation: source.presentation,
          provenance: source.provenance,
        },
      });
    }
    if (kind === 'document') {
      if (body.baseCatalogHash !== null && typeof body.baseCatalogHash !== 'string') {
        throw new RoutesEditorStoreError('routes_bad_request', 'Недопустимый baseCatalogHash');
      }
      if (!Number.isInteger(body.baseSourceRevision) || Number(body.baseSourceRevision) < 0) {
        throw new RoutesEditorStoreError('routes_bad_request', 'Недопустимая baseSourceRevision');
      }
      if (body.baseCatalogHash !== null) {
        await this.routesStore.readCatalog(profile, body.baseCatalogHash as string);
      }
      return this.draftStore.create(profile, {
        title,
        baseCatalogHash: body.baseCatalogHash as string | null,
        baseSourceRevision: body.baseSourceRevision as number,
        document: body.document as RouteDraftContent,
      });
    }
    throw new RoutesEditorStoreError('routes_bad_request', 'Неизвестный способ создания');
  }
}
