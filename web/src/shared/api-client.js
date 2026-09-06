// Единый клиент к серверу кокпита.
// base URL из VITE_BRAIN_URL (пусто = тот же origin — так работает и в проде, где фронт
// отдаёт сам сервер, и в dev через vite-proxy). Задел «сменный мозг»: адрес — одна настройка.
const BASE = (import.meta.env?.VITE_BRAIN_URL || '').replace(/\/$/, '');
// База для WebSocket (терминал): тот же хост, схема http→ws / https→wss.
const WS_BASE = (BASE || (typeof location !== 'undefined' ? location.origin : '')).replace(/^http/, 'ws');

// Авторизация — сессионная httpOnly-cookie, её ставит сервер на входе. Никаких секретов
// в клиентском коде: прежний VITE_COCKPIT_TOKEN попадал в бандл открытым текстом (Vite
// подставляет env на сборке), то есть был доступен любому, кто открыл страницу.
// credentials: 'include' — чтобы cookie уходила и при VITE_BRAIN_URL на другом origin.
const FETCH_OPTS = { credentials: 'include' };

// Слушатели 401: истёкшая или отозванная сессия должна сразу возвращать на экран входа,
// из какого бы места её ни поймали. Подписывается стор auth (без импорта стора сюда —
// иначе circular import).
const unauthorizedHandlers = new Set();
function onUnauthorized(fn) {
  unauthorizedHandlers.add(fn);
  return () => unauthorizedHandlers.delete(fn);
}
function notifyUnauthorized(data) {
  for (const fn of unauthorizedHandlers) {
    try { fn(data); } catch { /* один сломанный слушатель не мешает остальным */ }
  }
}

function url(path) {
  return BASE + path;
}

/**
 * Разбор ответа + единая обработка 401. Пути входа исключаем: там 401 — это «неверный
 * пароль», а не «сессия истекла», и сбрасывать состояние по нему нельзя.
 */
async function handle(res, path) {
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/api/auth/')) notifyUnauthorized(data);
    const err = new Error(data?.message || data?.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function request(method, path, body) {
  const headers = {};
  const opts = { ...FETCH_OPTS, method, headers };
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
    ...(isGet && typeof AbortSignal?.timeout === 'function' ? { signal: AbortSignal.timeout(30000) } : {}),
  });
  try {
    return await handle(await attempt(), path);
  } catch (e) {
    // Сетевой обрыв (TypeError) или таймаут. В частности, docker может поднять/снести
    // сеть стенда → Chrome видит «сеть изменилась» и рубит ВСЕ
    // летящие запросы (ERR_NETWORK_CHANGED), даже на localhost. Сервер при этом
    // жив — GET безопасно повторить один раз. Мутации не повторяем: неизвестно,
    // дошла ли первая (риск дубля).
    if (isGet && (e instanceof TypeError || e?.name === 'TimeoutError' || e?.name === 'AbortError')) {
      await new Promise((r) => { setTimeout(r, 700); });
      return handle(await attempt(), path);
    }
    throw e;
  }
}

// Multipart-загрузка (файлы): Content-Type ставит сам браузер (boundary).
async function upload(path, formData, { timeoutMs = 0, signal = null } = {}) {
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

/** Получает бинарный ответ и сохраняет общую обработку JSON-ошибок и 401. */
async function download(path) {
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

// Пароль SSH уходит только как непрозрачные байты: общий JSON-клиент здесь
// использовать нельзя, иначе секрет окажется в сериализуемом объекте.
async function postBytes(path, body) {
  const res = await fetch(url(path), {
    ...FETCH_OPTS,
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body,
  });
  return handle(res, path);
}

export const api = {
  base: BASE,
  url,
  onUnauthorized,
  wsUrl: (path) => WS_BASE + path,
  eventsUrl: () => url('/api/events'),
  get: (path) => request('GET', path),
  post: (path, body) => request('POST', path, body),
  put: (path, body) => request('PUT', path, body),
  del: (path, body) => request('DELETE', path, body),
  postBytes,
  download,
  upload,
};
