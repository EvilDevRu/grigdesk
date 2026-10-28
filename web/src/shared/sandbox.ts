// Адреса живых стендов: обычные HTTP-серверы на прямых портах машины.
// Профиль задаёт хост явно; без него используется хост окна GrigDesk.
import { normalizeServiceHost } from '../../../shared/plugins/sandboxes/serviceHost.ts';

/**
 * На локальной машине localhost сохраняет локальную авторизацию приложений.
 * Удалённый hostname окна остаётся прежним, чтобы ссылка не вела на машину клиента.
 */
function brainHostname() {
  const host = typeof location !== 'undefined' ? location.hostname || 'localhost' : 'localhost';

  return ['127.0.0.1', '[::1]'].includes(host) ? 'localhost' : host;
}

/**
 * Порт живого стенда открывается отдельной вкладкой по HTTP.
 * Явный хост профиля важнее origin окна; старый сервер может его не передать.
 */
export function sandboxUrl(port: unknown, serviceHost?: unknown): string | null {
  if (!port) {
    return null;
  }

  const host = normalizeServiceHost(serviceHost) ?? brainHostname();

  return `http://${host}:${port}/`;
}
