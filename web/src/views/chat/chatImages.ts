// Адрес картинки из ответа агента. Путь на диске превращается в маршрут сервера,
// который отдаёт файл из рабочей папки разговора; остальное проходит как есть.
const RASTER_PATH = /\.(?:png|jpe?g|gif|webp)$/i;

/**
 * Внешний URL, собственный /api кокпита, якорь и запрос проходят без изменений.
 * Растровый путь на диске (абсолютный, относительный или file://) уходит в
 * /api/chat/:id/image; прочее даёт пустую строку — рендерер покажет подпись.
 */
export function chatImageHref(href: string, chatId: string): string {
  const raw = String(href || '').trim();
  const scheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^file:/i.test(raw);

  if (!raw || scheme || raw.startsWith('//') || raw.startsWith('#') || raw.startsWith('?')
      || raw.startsWith('/api/')) {
    return raw;
  }

  let filePath: string;

  try {
    let encodedPath = raw;

    if (/^file:/i.test(raw)) {
      const url = new URL(raw);

      if ((url.hostname && url.hostname !== 'localhost') || url.username || url.password ||
          url.search || url.hash) {
        return '';
      }

      encodedPath = url.pathname;
    }

    filePath = decodeURIComponent(encodedPath);
  } catch {
    return '';
  }

  if (!chatId || !RASTER_PATH.test(filePath)) {
    return '';
  }

  return `/api/chat/${encodeURIComponent(chatId)}/image?path=${encodeURIComponent(filePath)}`;
}
