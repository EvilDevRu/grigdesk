import { isRecord } from '../../../shared/lib/objects.ts';
import type { PluginWebModule } from '../../../shared/plugins/pluginsContracts.ts';

/**
 * Каталог может прийти от старого или повреждённого сервера.
 * До любых сетевых эффектов разрешаем только ресурсы собственного модуля.
 */
export function isPluginModuleDescriptor(id: string, value: unknown): value is PluginWebModule {
  if (!isRecord(value) || typeof value.entry !== 'string' || !Array.isArray(value.css)
    || !isRecord(value.locales)
    || Object.hasOwn(value, 'startOnLogin') && typeof value.startOnLogin !== 'boolean') {
    return false;
  }

  const prefix = `/api/ext/${encodeURIComponent(id)}/module/`;
  const urls = [value.entry, ...value.css, ...Object.values(value.locales)];

  return Object.keys(value.locales).every((language) => ['ru', 'en'].includes(language))
    && urls.every((url) => ownResourceUrl(url, prefix));
}

/**
 * Проверяем и исходную, и декодированную форму, чтобы URL не сменил каталог.
 * Относительные и внешние адреса не принадлежат публичному DTO модуля.
 */
function ownResourceUrl(value: unknown, prefix: string): boolean {
  if (typeof value !== 'string' || !value.startsWith(prefix) || /[\\?#\s]/u.test(value)) {
    return false;
  }

  try {
    return value.slice(prefix.length).split('/').every((part) => {
      const decoded = decodeURIComponent(part);

      return !!decoded && !decoded.startsWith('.') && !/[\\/\x00-\x1f\x7f]/u.test(decoded);
    });
  } catch {
    return false;
  }
}
