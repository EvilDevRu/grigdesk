import { delayWithAbort } from '../../../shared/lib/delay.ts';
import { startChatPerformance } from './chatPerformance.ts';
import { acquireB24Read, b24ReadRoute, shouldLogB24Failure } from './b24ReadBackoff.ts';
import { resetApiDiagnostics, startApiDiagnostic } from './apiDiagnostics.ts';
import type { ApiDiagnostic } from './apiDiagnostics.ts';
import type { WebApiTiming } from '../../../shared/web-log/webDiagnostics.ts';

// Единый клиент к серверу GrigDesk.
//
// Граница сети: наружу отсюда уходит `unknown`. Ответ сервера — это JSON, а не
// доменная модель, и превращать одно в другое обязан декодер раздела. Пока клиент
// раздавал выведенные типы, ошибка формы всплывала в шаблоне компонента.
//
// Интерфейс обращается к своему origin: в production его отдаёт сервер,
// а в dev те же относительные пути обслуживает Vite proxy.
// База для WebSocket (терминал): тот же хост, схема http→ws / https→wss.
const WS_BASE = (typeof location !== 'undefined' ? location.origin : '').replace(
  /^http/,
  'ws',
);

// Авторизация — сессионная httpOnly-cookie, её ставит сервер на входе. Никаких секретов
// в клиентском коде: прежний VITE_GRIGDESK_TOKEN попадал в бандл открытым текстом (Vite
// подставляет env на сборке), то есть был доступен любому, кто открыл страницу.
// Сессионная cookie сопровождает все запросы к своему серверу.
const FETCH_OPTS: RequestInit = { credentials: 'include' };

/**
 * Отказ сервера с разобранным телом. Класс, а не «Error с дописанными полями»:
 * раздел различает 404 и 409 по коду, а причину берёт из `data`, и обе стороны
 * должны быть в типе, а не в надежде на то, что кто-то их присвоил.
 */
export class ApiError extends Error {
  readonly status: number;

  readonly data: unknown;

  constructor(message: string, status: number, data: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

/**
 * Текст отказа для человека. Ловушка `catch` отдаёт `unknown`, и раздел не обязан
 * знать, пришла ли туда `ApiError`, обрыв сети или брошенная строка: сообщение
 * сервера важнее всего, дальше — обычный Error, и только потом запасной текст.
 */
export function failureText(error: unknown, fallback = 'Не удалось выполнить запрос'): string {
  if (error instanceof ApiError) {
    return error.message;
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === 'string' && error) {
    return error;
  }

  return fallback;
}

export type UnauthorizedHandler = (data: unknown) => void;

// Слушатели 401: истёкшая или отозванная сессия должна сразу возвращать на экран входа,
// из какого бы места её ни поймали. Подписывается стор auth (без импорта стора сюда —
// иначе circular import).
const unauthorizedHandlers = new Set<UnauthorizedHandler>();

function onUnauthorized(handler: UnauthorizedHandler): () => void {
  unauthorizedHandlers.add(handler);

  return () => {
    unauthorizedHandlers.delete(handler);
  };
}

/**
 * Разослать всем подписчикам весть об истёкшей сессии. Слушателей может не быть
 * вовсе: клиент живёт и до подключения стора авторизации.
 */
function notifyUnauthorized(data: unknown): void {
  for (const handler of unauthorizedHandlers) {
    try {
      handler(data);
    } catch {
      /* один сломанный слушатель не мешает остальным */
    }
  }
}

function url(path: string): string {
  return path;
}

/**
 * Сообщение отказа. Сервер называет причину сам, и человеку показывают именно её;
 * HTTP-код — последний запасной вариант, когда тело пустое или чужого формата.
 */
function failureMessage(data: unknown, status: number): string {
  const body = data as { message?: unknown; error?: unknown } | null;

  if (typeof body?.message === 'string' && body.message) {
    return body.message;
  }
  if (typeof body?.error === 'string' && body.error) {
    return body.error;
  }

  return `HTTP ${status}`;
}

/**
 * Диагностика разделяет разбор каталога исполнителей, чатов и остальных JSON-ответов.
 * В журнал попадают только закрытое имя операции и число символов, без пути и тела.
 */
function startResponseParse(path: string, chars: number): () => void {
  const operation = path.startsWith('/api/chat/store/') ? 'chat.load.parse'
    : path.split(/[?#]/u, 1)[0] === '/api/providers' ? 'providers.parse' : 'api.parse';

  return startChatPerformance(operation, () => ({ chars }));
}

/**
 * Разбор ответа + единая обработка 401. Пути входа исключаем: там 401 — это «неверный
 * пароль», а не «сессия истекла», и сбрасывать состояние по нему нельзя.
 */
async function handle(res: Response, path: string, diagnostic?: ApiDiagnostic): Promise<unknown> {
  diagnostic?.received(res);

  const text = await res.text();

  diagnostic?.parsing(text.length);

  let data: unknown = null;
  const finish = startResponseParse(path, text.length);

  try {
    data = text ? JSON.parse(text) : null;
  } catch (error) {
    if (res.ok) {
      throw error;
    }
  } finally {
    finish();
  }

  diagnostic?.parsed();

  return handleData(res, path, data);
}

/**
 * Проверка статуса общая для обычного и потокового чтения.
 * Авторизация получает тот же ответ, даже если тело ошибки не было JSON.
 */
function handleData(res: Response, path: string, data: unknown): unknown {
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/api/auth/')) {
      notifyUnauthorized(data);
    }

    throw new ApiError(failureMessage(data, res.status), res.status, data);
  }

  return data;
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

type ApiLogEvent = 'api.fail' | 'api.slow' | 'api.pending' | 'api.recovered';
type ApiLogSink = (event: ApiLogEvent, data: Record<string, unknown>) => void;

let logSink: ApiLogSink | null = null;
let diagnosticEnabled: () => boolean = () => logSink !== null;
const reportedErrors = new WeakSet<object>();

/**
 * Подключаем runtime журнала к общей точке наблюдения API.
 * Сам транспорт журнала эту точку не использует.
 */
export function setApiLogSink(sink: ApiLogSink | null, enabled?: () => boolean): void {
  resetApiDiagnostics();
  logSink = sink;
  diagnosticEnabled = enabled ?? (() => logSink !== null);
}

/**
 * Ошибка уже записана журналом как api.fail. Ловушка store.error по этому
 * признаку не дублирует ту же неудачу второй, более тяжёлой записью.
 */
export function isReportedApiError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && reportedErrors.has(error);
}

/**
 * Передаём безопасную категорию сбоя или медленного ответа.
 * Ошибка журнала не меняет исход прикладного запроса.
 */
function reportApi(event: ApiLogEvent, data: Record<string, unknown>): void {
  try {
    logSink?.(event, data);
  } catch {
    /* журнал не влияет на API */
  }
}

function elapsed(start: number): number {
  return Math.max(0, performance.now() - start);
}

/**
 * Сообщаем журналу исход попытки. Путь уходит без query и hash, а шаблоном
 * его делает runtime журнала; текст ответа и тело запроса не передаются.
 */
function reportAttempt(
  method: Method,
  path: string,
  ms: number,
  attempt: number,
  error?: unknown,
  willRetry = false,
  timing: WebApiTiming = {},
): void {
  const route = path.split(/[?#]/u, 1)[0] ?? '';

  if (ms >= 1000) {
    reportApi('api.slow', {
      method,
      path: route,
      ms,
      attempt,
      ...timing,
    });
  }
  if (error === undefined) {
    if (attempt > 1) {
      reportApi('api.recovered', {
        method,
        path: route,
        ms,
        attempt,
        ...timing,
      });
    }

    return;
  }

  const status = error instanceof ApiError ? error.status : undefined;

  if (status === 401 && path.startsWith('/api/auth/')) {
    return;
  }

  const name = error instanceof Error ? error.name : 'Error';

  if (typeof error === 'object' && error !== null) {
    reportedErrors.add(error);
  }

  const b24Route = b24ReadRoute(path);

  const transient = (status === undefined && name !== 'SyntaxError')
    || (status !== undefined && [502, 503, 504].includes(status));

  if (method === 'GET' && b24Route && transient && !shouldLogB24Failure(b24Route)) {
    return;
  }

  reportApi('api.fail', {
    method,
    path: route,
    ms,
    attempt,
    willRetry,
    ...timing,
    ...(status === undefined ? { name } : { status }),
  });
}

/**
 * Оборачиваем отдельный запрос без изменения его результата.
 * Успех и ошибка получают длительность одной и той же попытки.
 */
async function observed<T>(method: Method, path: string, work: () => Promise<T>): Promise<T> {
  const start = performance.now();
  const diagnostic = observeAttempt(method, path, 1, 'request');

  try {
    const result = await work();

    reportAttempt(method, path, elapsed(start), 1, undefined, false, diagnostic?.finish(true));

    return result;
  } catch (error) {
    reportAttempt(method, path, elapsed(start), 1, error, false, diagnostic?.finish());

    throw error;
  }
}

/**
 * Все попытки, включая мутации без таймаута, имеют одно ограниченное уведомление ожидания.
 * Путь очищается от query до передачи sink, который дополнительно заменит его шаблоном.
 */
function observeAttempt(method: Method, path: string, attempt: number,
  phase: 'request' | 'headers' = 'headers'): ApiDiagnostic {
  return startApiDiagnostic({
    path,
    phase,
    enabled: () => logSink !== null && diagnosticEnabled(),
    pending: (timing) => reportApi('api.pending', {
      method,
      path: path.split(/[?#]/u, 1)[0],
      attempt,
      ...timing,
    }),
  });
}

// Настройка одной попытки. По умолчанию GET ждёт 30 с и повторяется один раз, а
// мутации ждут без таймаута и не повторяются.
export interface RequestOptions {
  headers?: Record<string, string>;
  // Таймаут попытки в миллисекундах; 0 — без таймаута.
  timeoutMs?: number;
  // Вместо общего предела ждём указанное время без заголовков или непустых байтов.
  idleTimeoutMs?: number;
  // Встроенный повтор чтения после обрыва. Опрос, который сам себе повтор, его выключает.
  retry?: boolean;
  // Отмена consumer-а сильнее таймаута и не разрешает встроенный повтор.
  signal?: AbortSignal;
}

// Таймаут чтения по умолчанию: покрывает даже медленный B24-портал.
const DEFAULT_GET_TIMEOUT_MS = 30000;

/**
 * Полная история может передаваться долго: отменяем только молчащее соединение.
 * UTF-8 декодируется по частям, без дополнительной полной копии массива байтов.
 */
async function requestWhileReceiving(
  path: string,
  opts: RequestInit,
  idleTimeoutMs: number,
  consumer?: AbortSignal,
  diagnostic?: ApiDiagnostic,
): Promise<unknown> {
  const controller = new AbortController();
  const { signal } = controller;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  const reset = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      controller.abort(new DOMException('Сервер перестал передавать данные', 'TimeoutError'));
    }, idleTimeoutMs);
  };
  const cancel = () => controller.abort(consumer?.reason);
  const cancelBody = () => {
    void reader?.cancel(signal.reason).catch(() => {});
  };

  consumer?.addEventListener('abort', cancel, { once: true });
  signal.addEventListener('abort', cancelBody, { once: true });

  try {
    reset();

    if (consumer?.aborted) {
      cancel();
    }

    const res = await fetch(url(path), { ...opts, signal });

    diagnostic?.received(res);
    reset();

    let text = '';

    if (res.body) {
      reader = res.body.getReader();

      const decoder = new TextDecoder();

      while (true) {
        const part = await reader.read();

        if (part.done) {
          break;
        }
        if (part.value.byteLength) {
          reset();
          text += decoder.decode(part.value, { stream: true });
        }
      }

      text += decoder.decode();
    }

    clearTimeout(timer);

    if (signal.aborted) {
      throw signal.reason;
    }

    let data: unknown = null;

    diagnostic?.parsing(text.length);

    const finish = startResponseParse(path, text.length);

    try {
      data = text ? JSON.parse(text) : null;
    } catch (error) {
      if (res.ok) {
        throw error;
      }
    } finally {
      finish();
    }

    diagnostic?.parsed();

    return handleData(res, path, data);
  } finally {
    clearTimeout(timer);
    consumer?.removeEventListener('abort', cancel);
    signal.removeEventListener('abort', cancelBody);
    reader?.releaseLock();
  }
}

/**
 * Один запрос к серверу: тело сериализуется JSON-ом, ответ отдаётся как `unknown`.
 * Здесь же живут таймаут и единственный повтор чтения — оба нужны из-за docker,
 * который рвёт летящие запросы при смене сети стенда.
 */
async function request(
  method: Method,
  path: string,
  body?: unknown,
  options: RequestOptions = {},
): Promise<unknown> {
  const headers: Record<string, string> = { ...options.headers };
  const opts: RequestInit = {
    ...FETCH_OPTS,
    method,
    headers,
  };

  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';

    const chatHistoryPut = method === 'PUT' && [
      '/api/chat/store/chat',
      '/api/chat/store/chat/step-reuse',
    ].includes(path.split(/[?#]/u, 1)[0] ?? '');
    const finishEncode = chatHistoryPut ? startChatPerformance('chat.put.encode', () => ({
      chars: typeof opts.body === 'string' ? opts.body.length : 0,
    })) : null;

    opts.body = JSON.stringify(body);
    finishEncode?.();

    // Chromium синхронно копирует большое строковое тело при fetch; Blob передаёт готовые байты.
    // JSON фиксируется до ожидания сети, а сервер получает прежнее UTF-8 тело с тем же Content-Type.
    if (chatHistoryPut && typeof opts.body === 'string') {
      const chars = opts.body.length;
      const finishBlob = startChatPerformance('chat.put.blob', () => ({ chars }));

      opts.body = new Blob([opts.body], { type: 'application/json' });
      finishBlob();
    }
  }

  // GET — с таймаутом: во время docker-манипуляций со стендами fetch может не
  // оборваться, а ЗАВИСНУТЬ (соединение в подвешенном состоянии) — раздел тогда
  // вечно показывает «Загрузка…». Мутации ждут без таймаута, если вызывающий
  // сам не знает, что повтор безопасен (например, приём хода по turnId).
  const isGet = method === 'GET';
  const timeoutMs = options.timeoutMs ?? (isGet ? DEFAULT_GET_TIMEOUT_MS : 0);
  const attempts = isGet && options.retry !== false ? 2 : 1;
  const b24Route = isGet ? b24ReadRoute(path) : null;
  // Consumer отмена объединяется с deadline: оба охватывают fetch и чтение body.
  // Отдельный signal не должен незаметно выключать прежний timeout GET.
  const attempt = () => {
    const deadline = timeoutMs > 0 && typeof AbortSignal?.timeout === 'function'
      ? AbortSignal.timeout(timeoutMs) : undefined;
    const signal = options.signal && deadline && typeof AbortSignal.any === 'function'
      ? AbortSignal.any([options.signal, deadline]) : options.signal ?? deadline;

    return fetch(url(path), {
      ...opts,
      ...(signal ? { signal } : {}),
    });
  };

  for (let number = 1; number <= attempts; number += 1) {
    options.signal?.throwIfAborted();

    const complete = b24Route ? await acquireB24Read(b24Route, options.signal) : null;
    const start = performance.now();
    const diagnostic = observeAttempt(method, path, number);

    try {
      const result = options.idleTimeoutMs && options.idleTimeoutMs > 0
        ? await requestWhileReceiving(path, opts, options.idleTimeoutMs, options.signal, diagnostic)
        : await handle(await attempt(), path, diagnostic);

      reportAttempt(method, path, elapsed(start), number, undefined, false, diagnostic?.finish(true));
      complete?.('success');

      return result;
    } catch (error) {
      // Сетевой обрыв (TypeError) или таймаут. В частности, docker может поднять/снести
      // сеть стенда → Chrome видит «сеть изменилась» и рубит ВСЕ
      // летящие запросы (ERR_NETWORK_CHANGED), даже на localhost. Сервер при этом
      // жив — GET безопасно повторить один раз. Мутации не повторяем: неизвестно,
      // дошла ли первая (риск дубля).
      const name = (error as { name?: string } | null)?.name;
      const transient = error instanceof TypeError || name === 'TimeoutError' || name === 'AbortError'
        || (b24Route && error instanceof ApiError && [502, 503, 504].includes(error.status));
      const cancelled = options.signal?.aborted;
      const timing = diagnostic?.finish();

      complete?.(cancelled ? 'cancelled' : transient ? 'failure' : 'success');

      if (cancelled) {
        if (typeof error === 'object' && error !== null) {
          reportedErrors.add(error);
        }

        throw error;
      }

      const willRetry =
        number < attempts &&
        !!transient;

      reportAttempt(method, path, elapsed(start), number, error, willRetry, timing);

      if (!willRetry) {
        throw error;
      }

      if (!b24Route) {
        await delayWithAbort(700, options.signal);
      }
    }
  }

  throw new Error('api_retry_exhausted');
}

export interface UploadOptions {
  timeoutMs?: number;
  signal?: AbortSignal | null;
}

/**
 * Multipart-загрузка файлов. Content-Type ставит сам браузер: собственный заголовок
 * стёр бы boundary, и сервер получил бы неразбираемое тело.
 */
async function upload(
  path: string,
  formData: FormData,
  { timeoutMs = 0, signal = null }: UploadOptions = {},
): Promise<unknown> {
  // У загрузок общий таймаут опасен: видео на гигабайты и короткая диктовка имеют
  // разные бюджеты. Вызывающий включает его явно; переданный AbortSignal сильнее.
  const timeoutSignal =
    !signal && timeoutMs > 0 && typeof AbortSignal?.timeout === 'function'
      ? AbortSignal.timeout(timeoutMs)
      : null;
  const res = await fetch(url(path), {
    ...FETCH_OPTS,
    method: 'POST',
    body: formData,
    ...(signal || timeoutSignal ? { signal: signal || timeoutSignal } : {}),
  });

  return handle(res, path);
}

// Двоичный ответ: имя файла приходит заголовком и бывает не задано вовсе.
export interface DownloadedFile {
  blob: Blob;
  filename?: string;
}

/**
 * Двоичный ответ. Отказ при этом остаётся обычным JSON-ом, поэтому неуспешный ответ
 * уходит в общий разбор — иначе 401 на выгрузке молча вернул бы пустой файл.
 */
async function download(path: string): Promise<DownloadedFile> {
  const res = await fetch(url(path), {
    ...FETCH_OPTS,
    method: 'POST',
  });

  if (!res.ok) {
    await handle(res, path);
  }

  const disposition = res.headers.get('Content-Disposition') || '';
  const filename = disposition.match(/filename="([^"]+)"/iu)?.[1];

  return { blob: await res.blob(), ...(filename ? { filename } : {}) };
}

/**
 * GET-скачивание с безопасным именем файла; прежний download остаётся POST.
 * Обработка ошибок совпадает с прочими загрузками.
 */
async function downloadGet(path: string): Promise<DownloadedFile> {
  const res = await fetch(url(path), { ...FETCH_OPTS, method: 'GET' });

  if (!res.ok) {
    await handle(res, path);
  }

  const header = res.headers.get('Content-Disposition') || '';
  const candidate = header.match(/filename="([^"]+)"/iu)?.[1] || '';
  const filename = /^[A-Za-z0-9._-]{1,100}$/u.test(candidate) ? candidate : 'web-log.ndjson';

  return { blob: await res.blob(), filename };
}

/**
 * Двоичный ответ на GET: звук или картинка, которые интерфейс воспроизводит сам.
 * Отказ и здесь приходит JSON-ом и уходит в общий разбор — иначе человек услышал
 * бы тишину вместо причины, по которой движок не ответил.
 */
async function getBlob(path: string): Promise<Blob> {
  const res = await fetch(url(path), FETCH_OPTS);

  if (!res.ok) {
    await handle(res, path);
  }

  return res.blob();
}

/**
 * JSON-запрос с двоичным ответом нужен для preview, где текст не должен быть в URL.
 * Неуспешный ответ остаётся в общем JSON-разборе и сохраняет серверную причину.
 */
async function postBlob(
  path: string,
  body: unknown,
  { signal }: { signal?: AbortSignal } = {},
): Promise<Blob> {
  const res = await fetch(url(path), {
    ...FETCH_OPTS,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });

  if (!res.ok) {
    await handle(res, path);
  }

  return res.blob();
}

// Пароль SSH уходит только как непрозрачные байты: общий JSON-клиент здесь
// использовать нельзя, иначе секрет окажется в сериализуемом объекте.
async function postBytes(
  path: string,
  body: BodyInit,
  { headers = {} }: { headers?: Record<string, string> } = {},
): Promise<unknown> {
  const res = await fetch(url(path), {
    ...FETCH_OPTS,
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', ...headers },
    body,
  });

  return handle(res, path);
}

// Транспорт GrigDesk. Все методы отдают `unknown`: форму подтверждает декодер раздела.
export interface ApiClient {
  url: (path: string) => string;
  onUnauthorized: (handler: UnauthorizedHandler) => () => void;
  wsUrl: (path: string) => string;
  eventsUrl: () => string;
  get: (path: string, options?: RequestOptions) => Promise<unknown>;
  post: (path: string, body?: unknown, options?: RequestOptions) => Promise<unknown>;
  put: (path: string, body?: unknown, options?: RequestOptions) => Promise<unknown>;
  patch: (path: string, body?: unknown) => Promise<unknown>;
  del: (path: string, body?: unknown) => Promise<unknown>;
  postBytes: typeof postBytes;
  postBlob: typeof postBlob;
  download: typeof download;
  downloadGet: typeof downloadGet;
  getBlob: typeof getBlob;
  upload: typeof upload;
}

export const api: ApiClient = {
  url,
  onUnauthorized,
  wsUrl: (path: string) => WS_BASE + path,
  eventsUrl: () => url('/api/events'),
  get: (path: string, options?: RequestOptions) => request('GET', path, undefined, options),
  post: (path: string, body?: unknown, options?: RequestOptions) => request('POST', path, body, options),
  put: (path: string, body?: unknown, options?: RequestOptions) => request('PUT', path, body, options),
  patch: (path: string, body?: unknown) => request('PATCH', path, body),
  del: (path: string, body?: unknown) => request('DELETE', path, body),
  postBytes: (path, body, opts) => observed('POST', path, () => postBytes(path, body, opts)),
  postBlob: (path, body, opts) => observed('POST', path, () => postBlob(path, body, opts)),
  download: (path) => observed('POST', path, () => download(path)),
  downloadGet: (path) => observed('GET', path, () => downloadGet(path)),
  getBlob: (path) => observed('GET', path, () => getBlob(path)),
  upload: (path, formData, opts) => observed('POST', path, () => upload(path, formData, opts)),
};
