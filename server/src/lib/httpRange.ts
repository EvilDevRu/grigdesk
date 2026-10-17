// Единственный разбор HTTP Range используется видео и файлами 3D.
// Поведение прежней media ручки сохраняется, включая null для неизвестной формы.

/**
 * Возвращает один диапазон в границах файла либо invalid для невыполнимого.
 * Suffix и открытый конец имеют прежнюю семантику видео, multipart ranges не поддержаны.
 */
export function parseByteRange(
  header: unknown,
  size: number,
): { start: number; end: number } | 'invalid' | null {
  if (typeof header !== 'string' || !size) {
    return null;
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());

  if (!match) {
    return null;
  }

  const [, rawStart, rawEnd] = match;

  if (!rawStart && !rawEnd) {
    return null;
  }

  let start: number;
  let end: number;

  if (!rawStart) {
    const suffix = Number(rawEnd);

    if (!suffix) {
      return 'invalid';
    }

    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd ? Number(rawEnd) : size - 1;
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return 'invalid';
  }

  if (start > end || start >= size) {
    return 'invalid';
  }

  return { start, end: Math.min(end, size - 1) };
}
