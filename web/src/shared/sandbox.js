// Адреса живых стендов: обычные HTTP-серверы на прямых портах машины.
// Хост берётся из окна Cockpit; отдельная настройка адреса не нужна.

/**
 * Стенды и Cockpit работают на одной машине, поэтому используют один hostname.
 * Без браузерного location ссылки сохраняют прежний fallback localhost.
 */
function brainHostname() {
  return typeof location !== 'undefined' ? location.hostname || 'localhost' : 'localhost';
}

/**
 * Порт живого стенда открывается отдельной вкладкой по HTTP.
 * Пустой порт означает, что адреса ещё нет; завершающий слеш сохраняется.
 */
export function sandboxUrl(port) {
  if (!port) {
    return null;
  }

  return `http://${brainHostname()}:${port}/`;
}
