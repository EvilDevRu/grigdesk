// HTTP-клиент Tripo API v3 для раздела «3D»: создание задач, опрос, загрузка файлов,
// баланс и история трат. Создание задачи никогда не повторяется само: если связь
// оборвалась после отправки, исход неизвестен и решается по истории трат.

import { openAsBlob } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

import { setTimeout as pause } from 'node:timers/promises';

import { tripoAccess } from './account.ts';
import { parseTripoTask, parseUsage, tripoRequestError } from './catalog.ts';
import { ProviderFailure } from '../studio3d/provider.ts';
import { openVerified } from '../studio3d/safePath.ts';
import type {
  AccountSnapshot,
  Balance,
  ProviderError,
  RemoteTask,
  UsageRecord,
} from '../studio3d/provider.ts';

export const UPLOAD_MAX_BYTES = 150 * 1024 * 1024;
const IMAGE_MAX_BYTES = 20 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const MODEL_EXTENSIONS = new Set(['.glb', '.fbx', '.obj', '.stl']);
const JSON_MAX_BYTES = 4 * 1024 * 1024;

export interface TripoClientDeps {
  env?: NodeJS.ProcessEnv;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  uploadTimeoutMs?: number;
}

interface SendOptions {
  snapshot: AccountSnapshot;
  method: 'GET' | 'POST';
  path: string;
  json?: unknown;
  form?: FormData;
  create?: boolean;
  timeoutMs?: number;
}

export interface TripoClient {
  cancelReads(): void;
  snapshot(): AccountSnapshot;
  isCurrent(snapshot: AccountSnapshot): boolean;
  available(): boolean;
  createTask(endpoint: string, body: Record<string, unknown>, snapshot?: AccountSnapshot): Promise<string>;
  getTask(taskId: string, snapshot?: AccountSnapshot): Promise<RemoteTask>;
  listTasks(
    taskIds: readonly string[],
    snapshot?: AccountSnapshot,
  ): Promise<{ tasks: RemoteTask[]; missed: string[] }>;
  upload(filePath: string, snapshot?: AccountSnapshot, root?: string): Promise<string>;
  usage(snapshot?: AccountSnapshot): Promise<UsageRecord[]>;
  balance(snapshot?: AccountSnapshot): Promise<Balance | null>;
}

/**
 * Ошибка сети или таймаута. При создании задачи исход неизвестен: Tripo мог принять
 * заказ до обрыва. Для чтений это обычный повторяемый сбой.
 */
function networkFailure(created: boolean, timeout: boolean): ProviderFailure {
  const error: ProviderError = {
    kind: 'network',
    code: null,
    message: timeout ? 'Tripo не ответил вовремя.' : 'Нет связи с Tripo.',
    detail: null,
    retryAfterMs: null,
  };

  return new ProviderFailure(error, created ? null : false);
}

/**
 * Срок повтора из Retry-After (секунды) или X-RateLimit-Reset (unix-секунды).
 * Слишком далёкий или прошедший срок не принимается.
 */
function retryAfter(headers: Headers): number | null {
  const seconds = Number(headers.get('Retry-After') ?? '');

  if (Number.isFinite(seconds) && seconds > 0 && seconds <= 3600) {
    return seconds * 1000;
  }

  const reset = Number(headers.get('X-RateLimit-Reset') ?? '') * 1000 - Date.now();

  return Number.isFinite(reset) && reset > 0 && reset <= 3_600_000 ? reset : null;
}

/**
 * Создаёт клиент. Ключ и регион читаются из окружения на каждом вызове, поэтому
 * окно «Ключи доступа» действует без перезапуска. baseUrl нужен только тестам.
 */
export function createTripoClient(deps: TripoClientDeps = {}): TripoClient {
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? pause;
  const timeoutMs = deps.timeoutMs ?? 30_000;
  const reads = new Set<AbortController>();
  let cancelled = 0;

  /**
   * Снимок фиксирует ключ и API до первого await. Отпечаток пригоден для журнала,
   * а сам доступ остаётся непрозрачным внутренним значением и не выходит в DTO.
   */
  const snapshot = (): AccountSnapshot => {
    const access = Object.freeze(tripoAccess(env));
    const accountKey = createHash('sha256').update(`${access.api}\0${access.key}`).digest('hex');

    return Object.freeze({
      accountKey,
      credentials: access,
      billingUrl: access.billing
    });
  };

  /**
   * Одна попытка запроса со сроком. Ответ разбирается как конверт {code, data}:
   * code 0 — успех, иначе ошибка с русским текстом и кодом Tripo.
   */
  const attempt = async (options: SendOptions): Promise<unknown> => {
    const access = options.snapshot.credentials as ReturnType<typeof tripoAccess>;

    if (!access.key) {
      throw new ProviderFailure(tripoRequestError(401, null, null), false);
    }

    const controller = new AbortController();
    let onAbort: () => void = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(networkFailure(options.create === true, true));

      controller.signal.addEventListener('abort', onAbort, { once: true });
    });

    if (!options.create) {
      reads.add(controller);
    }

    let timer: ReturnType<typeof setTimeout>;
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(networkFailure(options.create === true, true));
      }, options.timeoutMs ?? timeoutMs);
    });

    try {
      const response = await Promise.race([fetchImpl(`${deps.baseUrl ?? access.api}${options.path}`, {
        method: options.method,
        redirect: 'error',
        headers: {
          Authorization: `Bearer ${access.key}`,
          ...(options.json === undefined ? {} : { 'Content-Type': 'application/json' })
        },
        body: options.form ?? (options.json === undefined ? undefined : JSON.stringify(options.json)),
        signal: controller.signal,
      }), expired, aborted]);

      return await Promise.race([
        readEnvelope(response, options.create === true, controller.signal),
        expired,
        aborted,
      ]);
    } catch (error) {
      if (error instanceof ProviderFailure) {
        throw error;
      }

      throw networkFailure(options.create === true, controller.signal.aborted);
    } finally {
      clearTimeout(timer!);
      controller.signal.removeEventListener('abort', onAbort);
      reads.delete(controller);
    }
  };

  /**
   * Чтения повторяются при сбое сети, ответе 5xx и ограничении частоты — до трёх раз
   * с паузой. Создание задачи не повторяется никогда: второй заказ стоил бы денег.
   */
  const send = async (options: SendOptions): Promise<unknown> => {
    const generation = cancelled;

    for (let index = 0; ; index += 1) {
      if (!options.create && generation !== cancelled) {
        throw networkFailure(false, true);
      }

      try {
        return await attempt(options);
      } catch (error) {
        const failure = error instanceof ProviderFailure
          ? error
          : networkFailure(options.create === true, false);
        const retryable = ['network', 'server', 'rate'].includes(failure.error.kind);

        if (options.create || !retryable || index >= 2 || generation !== cancelled) {
          throw failure;
        }

        await sleep(Math.min(failure.error.retryAfterMs ?? 1000 * 2 ** index, 10_000));
      }
    }
  };

  return {
    /**
     * Закрытие worker отменяет лишь бесплатные чтения/загрузки этого клиента.
     * Платный POST не переотправляется и его неизвестный исход остаётся журналу.
     */
    cancelReads() {
      cancelled += 1;

      for (const controller of reads) {
        controller.abort();
      }
    },
    snapshot,
    isCurrent: (previous) => snapshot().accountKey === previous.accountKey,
    available: () => Boolean(tripoAccess(env).key),
    /**
     * Создаёт задачу один раз. Ответ без номера задачи — неизвестный исход: Tripo мог
     * принять заказ, поэтому повтора нет и номер ищут в истории трат.
     */
    async createTask(endpoint, body, account = snapshot()) {
      const data = await send({
        snapshot: account,
        method: 'POST',
        path: endpoint,
        json: body,
        create: true
      });
      const taskId = (data as Record<string, unknown> | null)?.task_id;

      if (typeof taskId !== 'string' || !taskId) {
        throw new ProviderFailure(tripoRequestError(200, null, 'нет task_id в ответе'), null);
      }

      return taskId;
    },
    /**
     * Одна задача целиком: статус, прогресс, свежие ссылки на файлы. Нужна, когда
     * подписанная ссылка протухла посреди скачивания.
     */
    async getTask(taskId, account = snapshot()) {
      const data = await send({
        snapshot: account,
        method: 'GET',
        path: `/v3/tasks/${encodeURIComponent(taskId)}`
      });
      const task = parseTripoTask(data);

      if (!task) {
        throw new ProviderFailure(tripoRequestError(200, null, 'непонятный ответ о задаче'), false);
      }

      return task;
    },
    /**
     * Пакетный опрос по сто номеров за запрос. Номера, которых Tripo не знает или
     * не отдал, попадают в missed: так раздел видит чужой ключ или регион.
     */
    async listTasks(taskIds, account = snapshot()) {
      const tasks: RemoteTask[] = [];
      const missed: string[] = [];

      for (let start = 0; start < taskIds.length; start += 100) {
        const chunk = taskIds.slice(start, start + 100);
        const data = await send({
          snapshot: account,
          method: 'POST',
          path: '/v3/tasks/list',
          json: { task_ids: chunk }
        });
        const parsed = parseTaskList(data, chunk);

        tasks.push(...parsed.tasks);
        missed.push(...parsed.missed);
      }

      return {
        tasks,
        missed
      };
    },
    /**
     * Загружает файл и возвращает file_token. Тип и размер проверяются до сети:
     * отказ Tripo по этим причинам предсказуем и не стоит запроса.
     */
    async upload(filePath, account = snapshot(), root = path.dirname(filePath)) {
      const opened = await openVerified(root, filePath);

      try {
        const form = new FormData();
        const pinnedPath = `/proc/self/fd/${opened.handle.fd}`;

        form.append('file', await uploadBlob(filePath, pinnedPath, opened.size), path.basename(filePath));
        await opened.verify();

        const data = await send({
          snapshot: account,
          method: 'POST',
          path: '/v3/files',
          form,
          timeoutMs: deps.uploadTimeoutMs ?? 600_000
        });

        await opened.verify();

        const token = (data as Record<string, unknown> | null)?.file_token;

        if (typeof token !== 'string' || !token) {
          throw new ProviderFailure(tripoRequestError(200, null, 'нет file_token в ответе'), false);
        }

        return token;
      } finally {
        await opened.handle.close();
      }
    },
    async usage(account = snapshot()) {
      return parseUsage(await send({
        snapshot: account,
        method: 'GET',
        path: '/v3/account/usage'
      }));
    },
    /**
     * Доступные кредиты и резерв идущих заказов. Непонятный ответ — null, а не
     * ноль: раздел покажет «баланс неизвестен», а не «денег нет».
     */
    async balance(account = snapshot()) {
      const data = await send({
        snapshot: account,
        method: 'GET',
        path: '/v3/account/balance'
      }) as Record<string, unknown> | null;
      const available = data?.balance;
      const reserved = data?.frozen;

      if (typeof available !== 'number' || typeof reserved !== 'number' || !Number.isFinite(available)
        || !Number.isFinite(reserved) || available < 0 || reserved < 0) {
        return null;
      }

      return {
        available,
        reserved
      };
    },
  };
}

/**
 * Читает ограниченный конверт. Только документированный явный отказ разрешает
 * повтор: повреждённый 2xx, неизвестный код и 5xx после POST сохраняют unknown.
 */
async function readEnvelope(response: Response, create: boolean, signal: AbortSignal): Promise<unknown> {
  let payload: Record<string, unknown> | null = null;

  try {
    const parsed: unknown = JSON.parse(await boundedText(response, signal));

    payload = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    if (signal.aborted) {
      throw networkFailure(create, true);
    }

    payload = null;
  }

  const code = Number.isSafeInteger(payload?.code) ? payload!.code as number : null;

  if (response.ok && code === 0) {
    return payload?.data ?? null;
  }

  const status = response.ok && code === null ? 502 : response.status;
  const error = tripoRequestError(status, code, null, retryAfter(response.headers));
  const rejectedCodes = new Set([
    1002, 1003, 1004, 1005, 1007, 2000, 2002, 2003, 2004, 2005, 2006,
    2007, 2008, 2009, 2010, 2011, 2012, 2015, 2016, 2017, 2019, 2020, 2021, 2022,
  ]);
  const rejected = response.status === 401
    || ((response.ok || (response.status >= 400 && response.status < 500))
      && code !== null && rejectedCodes.has(code))
    || (response.status === 403 && code !== null && [1000, 1001].includes(code));

  throw new ProviderFailure(error, create && !rejected ? null : false);
}

/**
 * Считает байты до JSON.parse и отменяет reader при пределе/abort. Обещание abort
 * завершает даже поддельный или сломанный body, который сам игнорирует сигнал fetch.
 */
async function boundedText(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) {
    return '';
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error('body_aborted'));

    signal.addEventListener('abort', onAbort, { once: true });
  });

  try {
    while (true) {
      if (signal.aborted) {
        throw new Error('body_aborted');
      }

      const item = await Promise.race([reader.read(), aborted]);

      if (item.done) {
        break;
      }

      size += item.value.byteLength;

      if (size > JSON_MAX_BYTES) {
        throw new Error('body_too_large');
      }

      chunks.push(item.value);
    }

    return Buffer.concat(chunks, size).toString('utf8');
  } finally {
    signal.removeEventListener('abort', onAbort);
    void reader.cancel().catch(() => {});
  }
}

/**
 * Ответ пакетного опроса: по документации — массив, по факту — словарь задач по
 * номеру и missed. Принимаются оба вида; задача без ответа считается пропавшей.
 */
function parseTaskList(data: unknown, asked: readonly string[]): { tasks: RemoteTask[]; missed: string[] } {
  const record = data && typeof data === 'object' ? data as Record<string, unknown> : {};
  const raw = Array.isArray(data)
    ? data
    : Object.entries(record.tasks && typeof record.tasks === 'object' ? record.tasks : {})
      .map(([id, task]) => ({
        task_id: id,
        ...(task as Record<string, unknown>)
      }));
  const tasks = raw.map(parseTripoTask).filter((task): task is RemoteTask => task !== null);
  const seen = new Set(tasks.map((task) => task.id));
  const missed = Array.isArray(record.missed) ? record.missed.map(String) : [];

  for (const id of asked) {
    if (!seen.has(id) && !missed.includes(id)) {
      missed.push(id);
    }
  }

  return {
    tasks,
    missed
  };
}

/**
 * Файл для загрузки без чтения в память. Tripo принимает картинки до 20 МБ и модели
 * GLB, FBX, OBJ, STL до 150 МБ; .gltf ссылается на соседние файлы и не загружается.
 */
async function uploadBlob(filePath: string, pinnedPath: string, size: number): Promise<Blob> {
  const ext = path.extname(filePath).toLowerCase();
  const image = IMAGE_EXTENSIONS.has(ext);
  const reject = (message: string) => new ProviderFailure({
    kind: 'input',
    code: null,
    message,
    detail: null,
    retryAfterMs: null
  }, false);

  if (!image && !MODEL_EXTENSIONS.has(ext)) {
    const gltf = 'Tripo не принимает .gltf: сохраните модель в .glb.';

    throw reject(ext === '.gltf' ? gltf : 'Tripo не принимает этот тип файла.');
  }

  if (size > (image ? IMAGE_MAX_BYTES : UPLOAD_MAX_BYTES)) {
    throw reject(image ? 'Tripo принимает картинки до 20 МБ.' : 'Tripo принимает модели до 150 МБ.');
  }

  return openAsBlob(pinnedPath);
}
