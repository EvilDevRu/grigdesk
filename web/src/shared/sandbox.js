// Адреса живых стендов (песочниц) задач.
//
// Хост берём у МОЗГА — из api.base (если фронт настроен на внешний мозг через VITE_BRAIN_URL)
// либо из текущего origin. Подставлять localhost нельзя: окно кокпита открывают с планшета и
// рабочего компа, где localhost — это само устройство-окно, а не машина со стендами.
//
// Схему всегда форсим http: стенды — обычные dev-серверы без TLS. Это безопасно даже когда сам
// кокпит отдаётся по https (Tailscale Serve): переход по ссылке в новую вкладку — top-level
// navigation, под блокировку смешанного контента он не попадает (в отличие от iframe).
import { api } from './api-client.js';

/**
 * Хост машины, на которой живут стенды (= машина мозга).
 */
function brainHostname() {
  const base = api.base || (typeof location !== 'undefined' ? location.origin : '');
  try {
    return new URL(base).hostname || 'localhost';
  } catch {
    return 'localhost';
  }
}

/**
 * Адрес стенда по номеру порта. Пустой порт → null (стенд не поднят).
 */
export function sandboxUrl(port) {
  if (!port) return null;
  return `http://${brainHostname()}:${port}/`;
}
