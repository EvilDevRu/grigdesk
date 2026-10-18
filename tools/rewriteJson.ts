export interface PathRewrite {
  source: string;
  target: string;
}

/**
 * Переписывает только целое абсолютное значение с границей сегмента.
 * Самый вложенный источник выигрывает при прямом и обратном переносе.
 */
export function rewritePath(value: string, entries: PathRewrite[], reverse: boolean): string {
  const pairs = entries.map((entry) => reverse
    ? [entry.target, entry.source] as const : [entry.source, entry.target] as const)
    .sort((left, right) => right[0].length - left[0].length);

  for (const [source, target] of pairs) {
    if (value === source || value.startsWith(source + '/')) {
      return target + value.slice(source.length);
    }
  }

  return value;
}

/**
 * Меняет только строковые значения JSON, сохраняя форматирование и ключи.
 * Невалидный документ отклоняется до каких-либо записей.
 */
export function rewriteJson(content: Buffer, entries: PathRewrite[], reverse: boolean): {
  text: string;
  count: number;
} {
  const text = content.toString('utf8');

  try {
    JSON.parse(text);
  } catch {
    throw new Error('Документ JSON не разбирается.');
  }

  let count = 0;
  const next = text.replace(/"(?:\\.|[^"\\])*"/g, (token: string, offset: number) => {
    if (text.slice(offset + token.length).trimStart().startsWith(':')) {
      return token;
    }

    const value = JSON.parse(token) as string;
    const replaced = rewritePath(value, entries, reverse);

    if (replaced === value) {
      return token;
    }

    count += 1;

    return JSON.stringify(replaced);
  });

  return { text: next, count };
}

