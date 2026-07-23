// Единый клиент к серверу кокпита.
// base URL из VITE_BRAIN_URL (пусто = тот же origin — так работает и в проде, где фронт
// отдаёт сам сервер, и в dev через vite-proxy). Задел «сменный мозг»: адрес — одна настройка.
const BASE = (import.meta.env.VITE_BRAIN_URL || '').replace(/\/$/, '');
const TOKEN = import.meta.env.VITE_COCKPIT_TOKEN || '';

function url(path) {
  return BASE + path;
}

async function request(method, path, body) {
  const headers = {};
  const opts = { method, headers };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  // Токен — только на мутации (не читаем его в GET, чтобы не светить в кэше).
  if (method !== 'GET' && TOKEN) headers['X-Cockpit-Token'] = TOKEN;

  const res = await fetch(url(path), opts);
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error(data?.message || data?.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const api = {
  base: BASE,
  eventsUrl: () => url('/api/events'),
  get: (path) => request('GET', path),
  post: (path, body) => request('POST', path, body),
  put: (path, body) => request('PUT', path, body),
  del: (path) => request('DELETE', path),
};
