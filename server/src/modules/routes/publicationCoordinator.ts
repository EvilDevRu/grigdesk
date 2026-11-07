import { createHash } from 'node:crypto';

import type { RoutePublication } from '../../../../shared/pipeline/routesEditorContracts.ts';

import { DraftStore, RoutesEditorStoreError } from './draftStore.ts';
import { readEditorCapabilities, validateDraftCapabilities } from './editorCapabilities.ts';
import { prepareDraftCatalog } from './publicationService.ts';
import { PublicationJournal } from './publicationJournal.ts';
import type { RouteEditorSource } from './store.ts';
import { RoutesStore } from './store.ts';
import { validateDraft } from './validation.ts';

const UUID_V4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

export interface EditorPublishInput {
  draftId: string;
  expectedRevision: number;
  expectedCatalogHash: string | null;
  expectedSourceRevision: number;
  operationId: string;
  comment?: string;
}

/**
 * Общая точка source-mode для HTTP редактора и файловых писателей.
 * Активация и recovery добавляются в следующих шагах того же пакета.
 */
export class RoutesPublicationCoordinator {
  readonly store: RoutesStore;

  readonly draftStore: DraftStore | null;

  readonly profilesDir: string | null;

  readonly journal: PublicationJournal;

  constructor(store: RoutesStore, draftStore: DraftStore | null = null,
    profilesDir: string | null = null) {
    this.store = store;
    this.draftStore = draftStore;
    this.profilesDir = profilesDir;
    this.journal = new PublicationJournal(store);
  }

  async source(profile: string): Promise<RouteEditorSource> {
    return this.store.readEditorSource(profile);
  }

  async switchSource(profile: string, options: {
    mode: RouteEditorSource['mode'];
    expectedSourceRevision: number;
    expectedCatalogHash: string | null;
  }): Promise<RouteEditorSource> {
    return this.store.switchEditorSource(profile, options);
  }

  async status(profile: string, operationId: string): Promise<RoutePublication | null> {
    const existing = await this.journal.readReceipt(profile, operationId);
    if (!await this.journal.readIntent(profile)) return existing;
    return this.store.withProfileMutation(profile,
      async () => this.journal.readReceipt(profile, operationId));
  }

  /**
   * Дорогая подготовка идёт без lock. После барьера все версии читаются снова
   * под замком; более свежая правка никогда не подменяет выбранную ревизию.
   */
  async publish(profile: string, input: EditorPublishInput,
    { beforeActivation, afterIntent, afterActivation, afterReceipt, onCommitted }: {
      beforeActivation?: () => Promise<void>;
      afterIntent?: () => Promise<void>;
      afterActivation?: () => Promise<void>;
      afterReceipt?: () => Promise<void>;
      onCommitted?: (receipt: RoutePublication) => void;
    } = {},
  ): Promise<RoutePublication> {
    if (!this.draftStore || !this.profilesDir) {
      throw new RoutesEditorStoreError('routes_authoring_unavailable',
        'Сервис публикации не настроен');
    }
    if (!UUID_V4.test(input.operationId)) {
      throw new RoutesEditorStoreError('routes_operation_id_required', 'Нужен operationId UUID v4');
    }
    if (input.comment !== undefined && (typeof input.comment !== 'string'
      || Buffer.byteLength(input.comment, 'utf8') > 2000 || input.comment.includes('\0'))) {
      throw new RoutesEditorStoreError('routes_bad_request', 'Недопустимый комментарий');
    }
    const requestHash = createHash('sha256').update(JSON.stringify({ profile, ...input }))
      .digest('hex');
    let existing = await this.journal.readReceipt(profile, input.operationId);
    if (existing && existing.requestHash !== requestHash) {
      throw new RoutesEditorStoreError('routes_operation_reused',
        'OperationId уже использован с другим запросом');
    }
    if (await this.journal.readIntent(profile)) {
      existing = await this.store.withProfileMutation(profile,
        async () => this.journal.readReceipt(profile, input.operationId)) ?? existing;
    }
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new RoutesEditorStoreError('routes_operation_reused',
          'OperationId уже использован с другим запросом');
      }
      return existing;
    }
    const draft = await this.draftStore.read(profile, input.draftId);
    if (draft.state !== 'editing') {
      throw new RoutesEditorStoreError('routes_draft_closed', 'Черновик закрыт');
    }
    if (draft.revision !== input.expectedRevision) {
      throw new RoutesEditorStoreError('routes_draft_conflict', 'Черновик изменился', {
        currentRevision: draft.revision,
      });
    }
    const source = await this.source(profile);
    if (source.mode !== 'editor' || source.revision !== input.expectedSourceRevision) {
      throw new RoutesEditorStoreError('routes_source_conflict', 'Источник изменился', {
        sourceRevision: source.revision,
      });
    }
    const current = await this.store.readCurrent(profile);
    if ((current?.catalogHash ?? null) !== input.expectedCatalogHash) {
      throw new RoutesEditorStoreError('routes_catalog_conflict', 'Каталог изменился', {
        currentCatalogHash: current?.catalogHash ?? null,
      });
    }
    const capabilities = await readEditorCapabilities(profile, { profilesDir: this.profilesDir });
    if (!capabilities.capabilitiesHash) {
      throw new RoutesEditorStoreError('routes_profile_unavailable',
        'Невозможно проверить возможности профиля');
    }
    const issues = [
      ...validateDraft(draft).issues,
      ...validateDraftCapabilities(draft, capabilities),
    ].filter((item) => item.severity === 'error');
    if (issues.length) {
      throw new RoutesEditorStoreError('routes_validation_failed',
        'Черновик не готов к публикации', { issues });
    }
    const prepared = await prepareDraftCatalog(this.store, draft);
    await beforeActivation?.();

    let newlyCommitted = false;
    const result = await this.store.withProfileMutation(profile, async (mutation) => {
      const committed = await this.journal.readReceipt(profile, input.operationId);
      if (committed) {
        if (committed.requestHash !== requestHash) {
          throw new RoutesEditorStoreError('routes_operation_reused',
            'OperationId уже использован с другим запросом');
        }
        return committed;
      }
      const latest = await this.draftStore!.read(profile, input.draftId);
      if (latest.state !== 'editing' || latest.revision !== input.expectedRevision) {
        throw new RoutesEditorStoreError('routes_draft_conflict',
          'Черновик изменился после проверки', { currentRevision: latest.revision });
      }
      const latestCapabilities = await readEditorCapabilities(profile,
        { profilesDir: this.profilesDir! });
      if (latestCapabilities.capabilitiesHash !== capabilities.capabilitiesHash) {
        throw new RoutesEditorStoreError('routes_validation_failed',
          'Возможности профиля изменились после проверки');
      }
      const createdAt = new Date().toISOString();
      await this.journal.writeIntent(mutation, {
        schema: 1,
        operationId: input.operationId,
        requestHash,
        draftId: input.draftId,
        draftRevision: input.expectedRevision,
        fromCatalogHash: input.expectedCatalogHash,
        toCatalogHash: prepared.catalogHash,
        sourceRevision: input.expectedSourceRevision,
        createdAt,
        ...(input.comment !== undefined ? { comment: input.comment } : {}),
      });
      if (afterIntent) {
        try {
          await afterIntent();
        } catch (error) {
          const aborted: RoutePublication = {
            operationId: input.operationId,
            requestHash,
            draftId: input.draftId,
            draftRevision: input.expectedRevision,
            fromCatalogHash: input.expectedCatalogHash,
            toCatalogHash: prepared.catalogHash,
            sourceRevision: input.expectedSourceRevision,
            state: 'aborted',
            currentChanged: false,
            createdAt,
            ...(input.comment !== undefined ? { comment: input.comment } : {}),
          };
          await this.journal.writeReceipt(mutation, aborted);
          await this.journal.clearIntent(mutation);
          throw error;
        }
      }
      const activated = await this.store.activatePreparedUnderMutation(
        profile, prepared.catalogHash, input.expectedCatalogHash,
        { origin: 'editor', expectedSourceRevision: input.expectedSourceRevision },
      );
      await afterActivation?.();
      const receipt: RoutePublication = {
        operationId: input.operationId,
        requestHash,
        draftId: input.draftId,
        draftRevision: input.expectedRevision,
        fromCatalogHash: input.expectedCatalogHash,
        toCatalogHash: prepared.catalogHash,
        sourceRevision: input.expectedSourceRevision,
        state: 'committed',
        currentChanged: activated.changed,
        createdAt,
        ...(input.comment !== undefined ? { comment: input.comment } : {}),
      };
      await this.journal.writeReceipt(mutation, receipt);
      await afterReceipt?.();
      await this.draftStore!.markPublishedUnderMutation(profile, input.draftId, receipt, mutation);
      await this.journal.clearIntent(mutation);
      newlyCommitted = true;
      return receipt;
    });
    if (newlyCommitted) onCommitted?.(result);
    return result;
  }
}
