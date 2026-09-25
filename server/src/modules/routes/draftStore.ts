import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type {
  DraftOperation,
  RouteDraft,
  RouteDraftContent,
  RouteDraftSummary,
  RoutePublication,
} from '../../../../shared/routesEditorContracts.ts';

import type { RouteProfileMutation, RoutesStore } from './store.ts';
import { applyDraftOperations, validateDraftShape } from './draftModel.ts';
import { assertProfileId } from './schema.ts';

const DRAFT_ID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

export class RoutesEditorStoreError extends Error {
  readonly code: string;

  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'RoutesEditorStoreError';
    this.code = code;
    this.details = details;
  }
}

function storeError(code: string, message: string, details: Record<string, unknown> = {}) {
  return new RoutesEditorStoreError(code, message, details);
}

function errorCode(error: unknown): unknown {
  return (error as { code?: unknown } | null)?.code;
}

export interface DraftCreateInput {
  title: string;
  baseCatalogHash: string | null;
  baseSourceRevision: number;
  document: RouteDraftContent;
}

export interface DraftPatchInput {
  expectedRevision: number;
  operations: DraftOperation[];
}

export interface DraftStoreOptions {
  baseDir: string;
  routesStore: RoutesStore;
  now?: () => string;
  uuid?: () => string;
  fsPort?: Partial<typeof fs>;
}

export class DraftStore {
  readonly baseDir: string;

  readonly routesStore: RoutesStore;

  readonly now: () => string;

  readonly uuid: () => string;

  readonly fsPort: typeof fs;

  constructor({
    baseDir,
    routesStore,
    now = () => new Date().toISOString(),
    uuid = randomUUID,
    fsPort = {},
  }: DraftStoreOptions) {
    if (typeof baseDir !== 'string' || baseDir.length === 0) {
      throw storeError('routes_bad_request', 'baseDir обязателен');
    }
    this.baseDir = path.resolve(baseDir);
    if (this.baseDir === path.parse(this.baseDir).root) {
      throw storeError('routes_bad_request', 'Корень filesystem нельзя использовать как baseDir');
    }
    this.routesStore = routesStore;
    this.now = now;
    this.uuid = uuid;
    this.fsPort = { ...fs, ...fsPort };
  }

  /**
   * Проходит каждый компонент пути через lstat и создаёт только обычные каталоги.
   * Чтение отсутствующего хранилища не создаёт его побочным эффектом.
   */
  async _draftsDirectory(profile: string, create: boolean): Promise<string | null> {
    try {
      assertProfileId(profile);
    } catch {
      throw storeError('routes_bad_request', 'Недопустимый профиль');
    }
    const parsed = path.parse(this.baseDir);
    const parts = [
      ...path.relative(parsed.root, this.baseDir).split(path.sep).filter(Boolean),
      profile,
      'drafts',
    ];
    let current = parsed.root;

    for (const part of parts) {
      current = path.join(current, part);
      let info;
      try {
        info = await this.fsPort.lstat(current);
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') {
          throw storeError('routes_authoring_unavailable', 'Не удалось открыть каталог черновиков');
        }
        if (!create) {
          return null;
        }
        try {
          await this.fsPort.mkdir(current, { mode: 0o700 });
        } catch (mkdirError) {
          if (errorCode(mkdirError) !== 'EEXIST') {
            throw storeError('routes_authoring_unavailable', 'Не удалось создать каталог черновиков');
          }
        }
        info = await this.fsPort.lstat(current);
      }
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw storeError('routes_authoring_unavailable', 'Небезопасный каталог черновиков');
      }
    }

    return current;
  }

  /**
   * Записывает один JSON через временный файл и fsync до и после rename.
   * При ошибке до rename прежний файл остаётся целым.
   */
  async _writeDraft(directory: string, draft: RouteDraft): Promise<void> {
    const destination = path.join(directory, `${draft.id}.json`);
    const temporary = path.join(directory, `${draft.id}.${process.pid}.${randomUUID()}.tmp`);
    const bytes = Buffer.from(JSON.stringify(draft));
    let handle;
    let renamed = false;

    try {
      handle = await this.fsPort.open(temporary, 'wx', 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;

      await this.fsPort.rename(temporary, destination);
      renamed = true;
      const directoryHandle = await this.fsPort.open(directory, 'r');
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch {
      if (renamed) {
        let currentRevision: number | null = null;
        try {
          currentRevision = (await this.read(draft.profile, draft.id)).revision;
        } catch {
          // Само чтение может отказать; клиенту всё равно нужно перечитать документ позже.
        }
        throw storeError('routes_authoring_unavailable', 'Исход записи черновика неопределён', {
          outcome: 'unknown',
          canReread: true,
          currentRevision,
        });
      }
      throw storeError('routes_authoring_unavailable', 'Не удалось сохранить черновик');
    } finally {
      await handle?.close();
      await this.fsPort.rm(temporary, { force: true });
    }
  }

  /**
   * Читает только обычный файл с точным UUID и проверяет весь формат.
   * Ошибка чтения не превращается в пустой черновик.
   */
  async _readRaw(profile: string, id: string): Promise<RouteDraft> {
    if (!DRAFT_ID_RE.test(id)) {
      throw storeError('routes_bad_request', 'Недопустимый ID черновика');
    }
    const directory = await this._draftsDirectory(profile, false);
    if (!directory) {
      throw storeError('routes_draft_not_found', 'Черновик не найден');
    }

    const file = path.join(directory, `${id}.json`);
    let info;
    try {
      info = await this.fsPort.lstat(file);
    } catch (cause) {
      if (errorCode(cause) === 'ENOENT') {
        throw storeError('routes_draft_not_found', 'Черновик не найден');
      }
      throw storeError('routes_authoring_unavailable', 'Не удалось прочитать черновик');
    }
    if (info.isSymbolicLink() || !info.isFile()) {
      throw storeError('routes_authoring_corrupted', 'Файл черновика подменён');
    }

    let value;
    try {
      value = JSON.parse(await this.fsPort.readFile(file, 'utf8'));
      value = validateDraftShape(value);
    } catch {
      throw storeError('routes_authoring_corrupted', 'Документ черновика повреждён');
    }
    if (value.profile !== profile || value.id !== id) {
      throw storeError('routes_authoring_corrupted', 'Адрес черновика не совпадает с документом');
    }
    return value;
  }

  async _reconcilePublishedUnderMutation(profile: string, id: string): Promise<RouteDraft> {
    const draft = await this._readRaw(profile, id);
    if (draft.state !== 'editing') return draft;
    const { PublicationJournal } = await import('./publicationJournal.ts');
    const receipt = await new PublicationJournal(this.routesStore).committedForDraft(profile, id);
    if (!receipt) return draft;
    if (draft.revision !== receipt.draftRevision || draft.publication !== null) {
      throw storeError('routes_recovery_conflict',
        'Опубликованная ревизия не совпадает с сохранённым черновиком');
    }
    const published = validateDraftShape({
      ...draft,
      state: 'published',
      publication: receipt,
      updatedAt: this.now(),
    });
    const directory = await this._draftsDirectory(profile, false);
    if (!directory) throw storeError('routes_authoring_unavailable', 'Каталог черновиков исчез');
    await this._writeDraft(directory, published);
    return published;
  }

  /** Согласует черновик с durable receipt; обычное чтение без журнала не создаёт lock. */
  async read(profile: string, id: string): Promise<RouteDraft> {
    const draft = await this._readRaw(profile, id);
    if (draft.state !== 'editing') return draft;
    if (this.routesStore.isProfileMutationActive(profile)) {
      return this._reconcilePublishedUnderMutation(profile, id);
    }
    const { PublicationJournal } = await import('./publicationJournal.ts');
    const journal = new PublicationJournal(this.routesStore);
    const [pending, committed] = await Promise.all([
      journal.readIntent(profile), journal.committedForDraft(profile, id),
    ]);
    if (!pending && !committed) return draft;
    return this.routesStore.withProfileMutation(profile,
      async () => this._reconcilePublishedUnderMutation(profile, id));
  }

  /**
   * Создаёт документ с серверными ID и датой под общим замком профиля.
   */
  async create(profile: string, input: DraftCreateInput): Promise<RouteDraft> {
    const document = input.document as unknown;
    const documentKeys = [
      'routes', 'bootstrap', 'bootstrapPrompts', 'presentation', 'provenance',
    ];
    if (document === null || typeof document !== 'object' || Array.isArray(document)) {
      throw storeError('routes_bad_request', 'document: ожидался объект');
    }
    for (const key of Object.keys(document)) {
      if (!documentKeys.includes(key)) {
        throw storeError('routes_bad_request', `document.${key}: лишнее поле`);
      }
    }
    for (const key of documentKeys) {
      if (!Object.hasOwn(document, key)) {
        throw storeError('routes_bad_request', `document.${key}: поле отсутствует`);
      }
    }

    const now = this.now();
    const draft = validateDraftShape({
      schema: 1,
      id: this.uuid(),
      profile,
      title: input.title,
      revision: 1,
      baseCatalogHash: input.baseCatalogHash,
      baseSourceRevision: input.baseSourceRevision,
      ...structuredClone(input.document),
      state: 'editing',
      createdAt: now,
      updatedAt: now,
      publication: null,
    });

    await this.routesStore.withProfileMutation(profile, async () => {
      const directory = await this._draftsDirectory(profile, true);
      if (!directory) {
        throw storeError('routes_authoring_unavailable', 'Каталог черновиков не создан');
      }
      const file = path.join(directory, `${draft.id}.json`);
      try {
        await this.fsPort.lstat(file);
        throw storeError('routes_bad_request', 'ID черновика уже занят');
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') {
          throw error;
        }
      }
      await this._writeDraft(directory, draft);
    });

    return draft;
  }

  /**
   * Отдаёт только метаданные черновиков; содержимое prompts не входит в ответ.
   */
  async list(profile: string): Promise<{ drafts: RouteDraftSummary[] }> {
    const directory = await this._draftsDirectory(profile, false);
    if (!directory) {
      return { drafts: [] };
    }
    const names = await this.fsPort.readdir(directory);
    const drafts: RouteDraftSummary[] = [];

    for (const name of names) {
      if (!name.endsWith('.json')) {
        continue;
      }
      const id = name.slice(0, -5);
      const draft = await this.read(profile, id);
      drafts.push({
        id: draft.id,
        profile: draft.profile,
        title: draft.title,
        revision: draft.revision,
        baseCatalogHash: draft.baseCatalogHash,
        state: draft.state,
        updatedAt: draft.updatedAt,
      });
    }
    drafts.sort((left, right) => (
      right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id)
    ));

    return { drafts };
  }

  /**
   * Сравнивает ревизию после захвата общего замка и записывает целый документ.
   * Никакая промежуточная команда PATCH не становится видимой отдельно.
   */
  async patch(profile: string, id: string, input: DraftPatchInput): Promise<RouteDraft> {
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) {
      throw storeError('routes_revision_required', 'Нужна expectedRevision');
    }

    return this.routesStore.withProfileMutation(profile, async () => {
      const current = await this.read(profile, id);
      if (current.state !== 'editing') {
        throw storeError('routes_draft_closed', 'Черновик закрыт');
      }
      if (current.revision !== input.expectedRevision) {
        throw storeError('routes_draft_conflict', 'Черновик изменился', {
          currentRevision: current.revision,
        });
      }

      const changed = applyDraftOperations(current, input.operations);
      if (JSON.stringify(changed) === JSON.stringify(current)) {
        return current;
      }

      changed.revision = current.revision + 1;
      changed.updatedAt = this.now();
      validateDraftShape(changed);

      const directory = await this._draftsDirectory(profile, false);
      if (!directory) {
        throw storeError('routes_authoring_unavailable', 'Каталог черновиков исчез');
      }
      await this._writeDraft(directory, changed);
      return changed;
    });
  }

  /** Записывает целый результат rebase и новое основание одной ревизией под общим lock. */
  async rebase(profile: string, id: string, input: {
    expectedRevision: number;
    expectedBaseCatalogHash: string | null;
    expectedCatalogHash: string;
    document: RouteDraftContent;
  }): Promise<RouteDraft> {
    return this.routesStore.withProfileMutation(profile, async () => {
      const current = await this.read(profile, id);
      if (current.state !== 'editing') {
        throw storeError('routes_draft_closed', 'Черновик закрыт');
      }
      if (current.revision !== input.expectedRevision
        || current.baseCatalogHash !== input.expectedBaseCatalogHash) {
        throw storeError('routes_draft_conflict', 'Черновик изменился перед переносом', {
          currentRevision: current.revision,
        });
      }
      const pointer = await this.routesStore.readCurrent(profile);
      if (pointer?.catalogHash !== input.expectedCatalogHash) {
        throw storeError('routes_catalog_conflict', 'Каталог изменился перед переносом', {
          currentCatalogHash: pointer?.catalogHash ?? null,
        });
      }
      const source = await this.routesStore.readEditorSource(profile);
      const changed = validateDraftShape({
        ...current,
        ...structuredClone(input.document),
        revision: current.revision + 1,
        baseCatalogHash: input.expectedCatalogHash,
        baseSourceRevision: source.revision,
        updatedAt: this.now(),
      });
      const directory = await this._draftsDirectory(profile, false);
      if (!directory) throw storeError('routes_authoring_unavailable', 'Каталог черновиков исчез');
      await this._writeDraft(directory, changed);
      return changed;
    });
  }

  /**
   * Закрывает редактируемый черновик под тем же замком, что и PATCH.
   * Повторная архивация с актуальной ревизией оставляет документ неизменным.
   */
  async archive(profile: string, id: string, expectedRevision: number): Promise<RouteDraft> {
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
      throw storeError('routes_revision_required', 'Нужна expectedRevision');
    }

    return this.routesStore.withProfileMutation(profile, async () => {
      const current = await this.read(profile, id);
      if (current.revision !== expectedRevision) {
        throw storeError('routes_draft_conflict', 'Черновик изменился', {
          currentRevision: current.revision,
        });
      }
      if (current.state === 'archived') {
        return current;
      }
      if (current.state === 'published') {
        throw storeError('routes_draft_closed', 'Опубликованный черновик закрыт');
      }

      const archived = validateDraftShape({
        ...current,
        state: 'archived',
        revision: current.revision + 1,
        updatedAt: this.now(),
      });
      const directory = await this._draftsDirectory(profile, false);
      if (!directory) {
        throw storeError('routes_authoring_unavailable', 'Каталог черновиков исчез');
      }
      await this._writeDraft(directory, archived);
      return archived;
    });
  }

  /** Записывает факт публикации внутри внешней транзакции профиля без повторного lock. */
  async markPublishedUnderMutation(
    profile: string,
    id: string,
    receipt: RoutePublication,
    mutation: RouteProfileMutation,
  ): Promise<RouteDraft> {
    if (mutation.profile !== profile || receipt.draftId !== id) {
      throw storeError('routes_bad_request', 'Публикация адресована другому черновику');
    }
    const current = await this._readRaw(profile, id);
    if (current.state !== 'editing' || current.revision !== receipt.draftRevision) {
      throw storeError('routes_draft_conflict', 'Черновик изменился перед закрытием', {
        currentRevision: current.revision,
      });
    }
    const published = validateDraftShape({
      ...current,
      state: 'published',
      publication: receipt,
      updatedAt: this.now(),
    });
    const directory = await this._draftsDirectory(profile, false);
    if (!directory) throw storeError('routes_authoring_unavailable', 'Каталог черновиков исчез');
    await this._writeDraft(directory, published);
    return published;
  }
}
