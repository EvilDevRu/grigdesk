// Единый клиент к серверу кокпита.
//
// Граница сети: наружу отсюда уходит `unknown`. Ответ сервера — это JSON, а не
// доменная модель, и превращать одно в другое обязан декодер раздела. Пока клиент
// раздавал выведенные типы, ошибка формы всплывала в шаблоне компонента.
//
// base URL из VITE_BRAIN_URL (пусто = тот же origin — так работает и в проде, где фронт
// отдаёт сам сервер, и в dev через vite-proxy). Задел «сменный мозг»: адрес — одна настройка.
const BASE = (import.meta.env?.VITE_BRAIN_URL || '').replace(/\/$/, '');
// База для WebSocket (терминал): тот же хост, схема http→ws / https→wss.
const WS_BASE = (BASE || (typeof location !== 'undefined' ? location.origin : '')).replace(/^http/, 'ws');

// Авторизация — сессионная httpOnly-cookie, её ставит сервер на входе. Никаких секретов
// в клиентском коде: прежний VITE_COCKPIT_TOKEN попадал в бандл открытым текстом (Vite
// подставляет env на сборке), то есть был доступен любому, кто открыл страницу.
// credentials: 'include' — чтобы cookie уходила и при VITE_BRAIN_URL на другом origin.
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
  return BASE + path;
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
 * Разбор ответа + единая обработка 401. Пути входа исключаем: там 401 — это «неверный
 * пароль», а не «сессия истекла», и сбрасывать состояние по нему нельзя.
 */
async function handle(res: Response, path: string): Promise<unknown> {
  const text = await res.text();
  const data: unknown = text ? JSON.parse(text) : null;

  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/api/auth/')) {
      notifyUnauthorized(data);
    }

    throw new ApiError(failureMessage(data, res.status), res.status, data);
  }

  return data;
}

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

/**
 * Один запрос к серверу: тело сериализуется JSON-ом, ответ отдаётся как `unknown`.
 * Здесь же живут таймаут и единственный повтор чтения — оба нужны из-за docker,
 * который рвёт летящие запросы при смене сети стенда.
 */
async function request(method: Method, path: string, body?: unknown): Promise<unknown> {
  const headers: Record<string, string> = {};
  const opts: RequestInit = {
    ...FETCH_OPTS,
    method,
    headers,
  };

  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }

  // GET — с таймаутом: во время docker-манипуляций со стендами fetch может не
  // оборваться, а ЗАВИСНУТЬ (соединение в подвешенном состоянии) — раздел тогда
  // вечно показывает «Загрузка…». 30с покрывает даже медленный B24-портал.
  const isGet = method === 'GET';
  const attempt = () => fetch(url(path), {
    ...opts,
    ...(isGet && typeof AbortSignal?.timeout === 'function'
      ? { signal: AbortSignal.timeout(30000) }
      : {}),
  });

  try {
    return await handle(await attempt(), path);
  } catch (error) {
    // Сетевой обрыв (TypeError) или таймаут. В частности, docker может поднять/снести
    // сеть стенда → Chrome видит «сеть изменилась» и рубит ВСЕ
    // летящие запросы (ERR_NETWORK_CHANGED), даже на localhost. Сервер при этом
    // жив — GET безопасно повторить один раз. Мутации не повторяем: неизвестно,
    // дошла ли первая (риск дубля).
    const name = (error as { name?: string } | null)?.name;

    if (isGet && (error instanceof TypeError || name === 'TimeoutError' || name === 'AbortError')) {
      await new Promise((resolve) => {
        setTimeout(resolve, 700);
      });

      return handle(await attempt(), path);
    }

    throw error;
  }
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
  const timeoutSignal = !signal && timeoutMs > 0 && typeof AbortSignal?.timeout === 'function'
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
    headers: { ...headers, 'Content-Type': 'application/octet-stream' },
    body,
  });

  return handle(res, path);
}

// Транспорт кокпита. Все методы отдают `unknown`: форму подтверждает декодер раздела.
export interface ApiClient {
  base: string;
  url: (path: string) => string;
  onUnauthorized: (handler: UnauthorizedHandler) => () => void;
  wsUrl: (path: string) => string;
  eventsUrl: () => string;
  get: (path: string) => Promise<unknown>;
  post: (path: string, body?: unknown) => Promise<unknown>;
  put: (path: string, body?: unknown) => Promise<unknown>;
  del: (path: string, body?: unknown) => Promise<unknown>;
  postBytes: typeof postBytes;
  postBlob: typeof postBlob;
  download: typeof download;
  getBlob: typeof getBlob;
  upload: typeof upload;
}

export const api: ApiClient = {
  base: BASE,
  url,
  onUnauthorized,
  wsUrl: (path: string) => WS_BASE + path,
  eventsUrl: () => url('/api/events'),
  get: (path: string) => request('GET', path),
  post: (path: string, body?: unknown) => request('POST', path, body),
  put: (path: string, body?: unknown) => request('PUT', path, body),
  del: (path: string, body?: unknown) => request('DELETE', path, body),
  postBytes,
  postBlob,
  download,
  getBlob,
  upload,
};
