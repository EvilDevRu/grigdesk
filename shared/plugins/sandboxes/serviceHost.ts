/**
 * Хост стенда не содержит схему, порт, путь или учётные данные.
 * Проверка общая для чтения профиля на сервере и построения ссылки в браузере.
 */
export function normalizeServiceHost(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const host = value.trim();
  const domain = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/i;
  const ipv6 = /^\[[a-f0-9:]+\]$/i;

  if (!domain.test(host) && !ipv6.test(host)) {
    return null;
  }

  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return null;
  }
}
