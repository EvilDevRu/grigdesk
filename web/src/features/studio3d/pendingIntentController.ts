import { parseStudio3d } from '../../../../shared/studio3d/studio3dContracts.ts';
import { Studio3dApiError } from './studio3dApi.ts';
import type { StudioRunInput, studio3dApi } from './studio3dApi.ts';
import type { PendingStudioIntent, PendingStudioStorage } from './pendingIntentTypes.ts';

type PendingApi = Pick<typeof studio3dApi, 'run' | 'retry' | 'batchRun' | 'job'>;
export type PendingSendResult = Awaited<ReturnType<PendingApi['run']>>
  | Awaited<ReturnType<PendingApi['batchRun']>>;

export interface PendingSession {
  owner: string;
  libraryId: string;
  generation: number;
  started: boolean;
  libraryOk: boolean;
}

export interface PendingIntentPorts {
  storage: PendingStudioStorage;
  api: PendingApi;
  fingerprint(value: unknown): string;
  now(): number;
  uuid(): string;
  session(): PendingSession;
  pending: {
    list(): PendingStudioIntent[];
    add(record: PendingStudioIntent): void;
    replace(record: PendingStudioIntent): void;
    remove(key: string): void;
    reset(records: PendingStudioIntent[]): void;
  };
  busy: {
    begin(): void;
    end(generation: number): void;
  };
  onSent(result: PendingSendResult, generation: number): void;
  onError(cause: unknown, generation: number): void;
  onDropped(record: PendingStudioIntent, text: string): void;
}

// Сохранённое нажатие живёт десять минут: дольше оно превратилось бы в оплату,
// о которой человек уже не помнит и которую не видит в окне.
const PENDING_TTL_MS = 10 * 60 * 1000;

/**
 * Контроллер сохраняет нажатие до POST и повторяет только прежний durable снимок.
 * Порты оставляют Pinia владельцем сессии, pending, busy и внешних обновлений.
 */
export function createPendingIntentController(ports: PendingIntentPorts) {
  const sending = new Map<string, Promise<unknown>>();

  /**
   * Цена и library marker проверяются сервером; клиент хранит полный immutable request.
   * Ответ после stop не меняет UI, принятый UUID остаётся в серверном durable журнале.
   */
  const sendPending = async (record: PendingStudioIntent): Promise<unknown> => {
    const generation = ports.session().generation;
    
    if (!ports.session().started || record.owner !== ports.session().owner
      || record.libraryId !== ports.session().libraryId || record.blocked) {
      throw new Error(record.blocked || 'Библиотека или сессия изменилась. Намерение сохранено.');
    }
    
    const result = record.kind === 'batch' ? await ports.api.batchRun(structuredClone(record.request))
      : record.kind === 'retry' ? await ports.api.retry(
        record.modelId, record.versionId, structuredClone(record.request))
        : await ports.api.run(structuredClone(record.request));
    
    await ports.storage.remove(record.key);
    ports.pending.remove(record.key);
    
    if (generation === ports.session().generation && result.libraryId === ports.session().libraryId) {
      ports.onSent(result, generation);
    }
    
    return result;
  };

  /**
   * Двойное нажатие coalesces до первой записи IndexedDB и не создаёт второй UUID.
   * Сеть оставляет запись для повтора; доказанный отказ помечается требующим нового решения.
   */
  const submit = (kind: PendingStudioIntent['kind'], input: StudioRunInput | Record<string, unknown>,
    key?: string,
    modelId?: string, versionId?: string): Promise<unknown> => {
    const snapshot = JSON.parse(JSON.stringify({ ...input,
      libraryId: ports.session().libraryId })) as Record<string, unknown>;
    const fingerprint = ports.fingerprint({
      owner: ports.session().owner,
      kind,
      modelId,
      versionId,
      request: snapshot
    });
    const existing = sending.get(fingerprint);
    
    if (existing) {
      return existing;
    }
    
    const work = (async () => {
      const generation = ports.session().generation;
      const identity = ports.session().owner;
      
      if (!ports.session().libraryOk || !ports.session().started) {
        throw new Error('Библиотека 3D недоступна.');
      }
      
      const saved = ports.pending.list().find((record) => record.fingerprint === fingerprint
        && !record.blocked);
      const draft = saved ? structuredClone(saved) : {
        key: key ?? ports.uuid(),
        owner: ports.session().owner,
        libraryId: ports.session().libraryId,
        kind,
        fingerprint,
        request: {},
        modelId,
        versionId,
        at: ports.now()
      };
      const previous = ports.pending.list().find((item) => item.key === draft.key);
      
      if (previous && previous.fingerprint !== fingerprint) {
        throw new Error('Снимок этого намерения уже другой.');
      }
      
      const record = {
        ...draft,
        request: { ...snapshot, idempotencyKey: draft.key }
      } as PendingStudioIntent;

      await ports.storage.put(record);
      
      if (generation !== ports.session().generation || ports.session().owner !== identity
        || !ports.session().started) {
        throw new Error('Сессия изменилась. Намерение сохранено без отправки.');
      }
      if (!ports.pending.list().some((item) => item.key === record.key)) {
        ports.pending.add(record);
      }
      
      ports.busy.begin();
      
      try {
        return await sendPending(record);
      } catch (cause) {
        if (cause instanceof Studio3dApiError && cause.status >= 400 && cause.status < 500) {
          record.blocked = cause.message;
          await ports.storage.put(record);
          ports.pending.replace(record);
          
          if (cause.code === 'price_changed' && cause.body.quote) {
            return { priceChanged: parseStudio3d.price(cause.body.quote) };
          }
        }
        if (generation === ports.session().generation) {
          ports.onError(cause, generation);
        }
        
        throw cause;
      } finally {
        if (generation === ports.session().generation) {
          ports.busy.end(generation);
        }
      }
    })();
    
    sending.set(fingerprint, work);
    void work.finally(() => sending.delete(fingerprint)).catch(() => {});
    
    return work;
  };

  /**
   * Запись снимается с объяснением: устаревший или отвергнутый заказ
   * не отправляется молча и не остаётся в очереди навсегда.
   */
  const dropPending = async (record: PendingStudioIntent, reason: string) => {
    const name = record.kind === 'run' && typeof record.request.name === 'string' && record.request.name
      ? record.request.name : '3D';

    await ports.storage.remove(record.key);
    ports.pending.remove(record.key);
    ports.onDropped(record, `Заказ «${name}» не отправлен: ${reason}`);
  };

  /**
   * Reload сначала читает server UUID; 404 разрешает повтор ровно прежнего снимка.
   * Stale root, чужой owner и blocked intent никогда не отправляются автоматически.
   */
  const recoverPending = async () => {
    const generation = ports.session().generation;
    const records = await ports.storage.list(ports.session().owner);

    if (generation !== ports.session().generation || !ports.session().started) {
      return;
    }

    ports.pending.reset(records);

    for (const record of records) {
      if (generation !== ports.session().generation || !ports.session().started) {
        return;
      }
      if (record.libraryId !== ports.session().libraryId || record.blocked) {
        continue;
      }

      try {
        await ports.api.job(record.key, record.libraryId);
        await ports.storage.remove(record.key);
        ports.pending.remove(record.key);
      } catch (cause) {
        if (generation !== ports.session().generation || !ports.session().started) {
          return;
        }
        if (cause instanceof Studio3dApiError && cause.status === 404) {
          // Нажатию человека больше десяти минут: повторная отправка оплаты
          // без ведома человека недопустима, запись снимается с объяснением.
          if (ports.now() - record.at > PENDING_TTL_MS) {
            await dropPending(record, 'связь оборвалась. Повторите вручную.');
          } else {
            try {
              await sendPending(record);
            } catch (error) {
              if (generation !== ports.session().generation || !ports.session().started) {
                return;
              }

              if (error instanceof Studio3dApiError && error.status >= 400 && error.status < 500) {
                await dropPending(record, error.message);
              } else {
                ports.onError(error, generation);
              }
            }
          }
        } else if (cause instanceof Studio3dApiError && cause.status >= 400 && cause.status < 500) {
          await dropPending(record, cause.message);
        } else {
          ports.onError(cause, generation);
        }
      }
    }
  };

  return {
    sendPending,
    submit,
    dropPending,
    recoverPending,
  };
}
