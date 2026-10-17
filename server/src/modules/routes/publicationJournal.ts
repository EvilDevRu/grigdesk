import { randomUUID } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';

import { parseRoutePublication } from '../../../../shared/pipeline/routesEditorContracts.ts';
import type { RoutePublication } from '../../../../shared/pipeline/routesEditorContracts.ts';

import { RoutesEditorStoreError } from './draftStore.ts';
import { assertProfileId } from './schema.ts';
import type { RouteProfileMutation } from './store.ts';
import { RoutesStore, serializeRoutesJson } from './store.ts';

const UUID_V4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const PENDING_FILE = 'editor-pending.json';
const OPERATIONS_DIR = 'editor-operations';

export interface PublicationIntent {
  schema: 1;
  operationId: string;
  requestHash: string;
  draftId: string;
  draftRevision: number;
  fromCatalogHash: string | null;
  toCatalogHash: string;
  sourceRevision: number;
  createdAt: string;
  comment?: string;
}

function corrupt(): RoutesEditorStoreError {
  return new RoutesEditorStoreError('routes_authoring_corrupted',
    'Журнал публикации повреждён');
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readSmallJson(file: string): Promise<unknown | null> {
  let handle;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw corrupt();
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 16 * 1024) throw corrupt();
    return JSON.parse((await handle.readFile()).toString('utf8'));
  } catch {
    throw corrupt();
  } finally {
    await handle.close();
  }
}

async function atomicJson(directory: string, file: string, value: unknown): Promise<void> {
  const temporary = path.join(directory, `${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(serializeRoutesJson(value));
    await handle.sync();
    await handle.close();
    await fs.rename(temporary, file);
    await syncDirectory(directory);
  } finally {
    await handle.close().catch(() => {});
    await fs.rm(temporary, { force: true });
  }
}

/** Durable intent и receipt живут рядом с current, но вне immutable revisions. */
export class PublicationJournal {
  readonly store: RoutesStore;

  constructor(store: RoutesStore) {
    this.store = store;
  }

  catalogDir(profile: string): string {
    assertProfileId(profile);
    return path.join(this.store.baseDir, profile, 'catalog');
  }

  private operationsDir(profile: string): string {
    return path.join(this.catalogDir(profile), OPERATIONS_DIR);
  }

  async readReceipt(profile: string, operationId: string): Promise<RoutePublication | null> {
    if (!UUID_V4.test(operationId)) {
      throw new RoutesEditorStoreError('routes_operation_id_required', 'Нужен UUID v4 операции');
    }
    const directory = this.operationsDir(profile);
    const info = await fs.lstat(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw corrupt();
    });
    if (!info) return null;
    if (!info.isDirectory() || info.isSymbolicLink()) throw corrupt();
    const value = await readSmallJson(path.join(directory, `${operationId}.json`));
    if (value === null) return null;
    try {
      const receipt = parseRoutePublication(value);
      if (receipt.operationId !== operationId) throw corrupt();
      return receipt;
    } catch {
      throw corrupt();
    }
  }

  /** Ищет зафиксированную публикацию черновика независимо от нынешнего current. */
  async committedForDraft(profile: string, draftId: string): Promise<RoutePublication | null> {
    assertProfileId(profile);
    const directory = this.operationsDir(profile);
    const info = await fs.lstat(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw corrupt();
    });
    if (!info) return null;
    if (!info.isDirectory() || info.isSymbolicLink()) throw corrupt();
    const names = await fs.readdir(directory);
    let found: RoutePublication | null = null;
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const operationId = name.slice(0, -5);
      if (!UUID_V4.test(operationId)) throw corrupt();
      const receipt = await this.readReceipt(profile, operationId);
      if (receipt?.draftId !== draftId || receipt.state !== 'committed') continue;
      if (found && found.operationId !== operationId) {
        throw new RoutesEditorStoreError('routes_recovery_conflict',
          'Один черновик отмечен двумя публикациями');
      }
      found = receipt;
    }
    return found;
  }

  async readIntent(profile: string): Promise<PublicationIntent | null> {
    const value = await readSmallJson(path.join(this.catalogDir(profile), PENDING_FILE));
    if (value === null) return null;
    const required = [
      'createdAt', 'draftId', 'draftRevision', 'fromCatalogHash', 'operationId',
      'requestHash', 'schema', 'sourceRevision', 'toCatalogHash',
    ];
    if (typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some((key) => !required.includes(key) && key !== 'comment')
      || required.some((key) => !Object.hasOwn(value, key))) throw corrupt();
    const intent = value as PublicationIntent;
    if (intent.schema !== 1 || !UUID_V4.test(intent.operationId)
      || !UUID_V4.test(intent.draftId)
      || !/^[a-f0-9]{64}$/.test(intent.requestHash)
      || !/^[a-f0-9]{64}$/.test(intent.toCatalogHash)
      || (intent.fromCatalogHash !== null
        && !/^[a-f0-9]{64}$/.test(intent.fromCatalogHash))
      || !Number.isSafeInteger(intent.draftRevision) || intent.draftRevision < 1
      || !Number.isSafeInteger(intent.sourceRevision) || intent.sourceRevision < 0
      || typeof intent.createdAt !== 'string'
      || (intent.comment !== undefined && (typeof intent.comment !== 'string'
        || Buffer.byteLength(intent.comment, 'utf8') > 2000
        || intent.comment.includes('\0')))) throw corrupt();
    return intent;
  }

  async writeIntent(mutation: RouteProfileMutation, intent: PublicationIntent): Promise<void> {
    if (await this.readIntent(mutation.profile)) {
      throw new RoutesEditorStoreError('routes_recovery_conflict',
        'Предыдущая публикация ожидает восстановления');
    }
    await atomicJson(mutation.catalogDir, path.join(mutation.catalogDir, PENDING_FILE), intent);
  }

  async writeReceipt(mutation: RouteProfileMutation, receipt: RoutePublication): Promise<void> {
    const directory = this.operationsDir(mutation.profile);
    try {
      await fs.mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const info = await fs.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw corrupt();
    const existing = await this.readReceipt(mutation.profile, receipt.operationId);
    if (existing) {
      if (serializeRoutesJson(existing) !== serializeRoutesJson(receipt)) {
        throw new RoutesEditorStoreError('routes_operation_reused',
          'Для operationId уже есть другой результат');
      }
      return;
    }
    await atomicJson(directory, path.join(directory, `${receipt.operationId}.json`), receipt);
  }

  async clearIntent(mutation: RouteProfileMutation): Promise<void> {
    await fs.rm(path.join(mutation.catalogDir, PENDING_FILE), { force: true });
    await syncDirectory(mutation.catalogDir);
  }

  /** Восстанавливает единственный intent до действия следующего писателя под общим lock. */
  async recoverUnderMutation(mutation: RouteProfileMutation): Promise<RoutePublication | null> {
    const intent = await this.readIntent(mutation.profile);
    if (!intent) return null;
    const receipt = await this.readReceipt(mutation.profile, intent.operationId);
    if (receipt) {
      if (receipt.requestHash !== intent.requestHash || receipt.draftId !== intent.draftId
        || receipt.draftRevision !== intent.draftRevision
        || receipt.fromCatalogHash !== intent.fromCatalogHash
        || receipt.toCatalogHash !== intent.toCatalogHash
        || receipt.sourceRevision !== intent.sourceRevision
        || receipt.createdAt !== intent.createdAt
        || receipt.comment !== intent.comment) throw corrupt();
      if (receipt.state === 'aborted') {
        const current = await this.store._readCurrentPointer(mutation.profile);
        if ((current?.catalogHash ?? null) !== intent.fromCatalogHash) {
          throw new RoutesEditorStoreError('routes_recovery_conflict',
            'Текущий каталог изменился после прерванной публикации');
        }
      }
      await this.clearIntent(mutation);
      return receipt;
    }

    const current = await this.store._readCurrentPointer(mutation.profile);
    const currentHash = current?.catalogHash ?? null;
    let state: RoutePublication['state'];
    let currentChanged = false;
    if (intent.fromCatalogHash === intent.toCatalogHash
      && currentHash === intent.toCatalogHash) {
      state = 'committed';
    } else if (currentHash === intent.toCatalogHash) {
      state = 'committed';
      currentChanged = true;
    } else if (currentHash === intent.fromCatalogHash) {
      state = 'aborted';
    } else {
      throw new RoutesEditorStoreError('routes_recovery_conflict',
        'Текущий каталог не совпадает ни с одной стороной публикации', {
          currentCatalogHash: currentHash,
        });
    }
    const restored: RoutePublication = {
      operationId: intent.operationId,
      requestHash: intent.requestHash,
      draftId: intent.draftId,
      draftRevision: intent.draftRevision,
      fromCatalogHash: intent.fromCatalogHash,
      toCatalogHash: intent.toCatalogHash,
      sourceRevision: intent.sourceRevision,
      state,
      currentChanged,
      createdAt: intent.createdAt,
      ...(intent.comment !== undefined ? { comment: intent.comment } : {}),
    };
    await this.writeReceipt(mutation, restored);
    await this.clearIntent(mutation);
    return restored;
  }
}
