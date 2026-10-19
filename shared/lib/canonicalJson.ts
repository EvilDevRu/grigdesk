/**
 * Ключи JSON сортируются на каждом уровне для стабильных отпечатков.
 * Порядок массивов сохраняется: он является частью переданных аргументов.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }

  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    const fields = entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`);

    return `{${fields.join(',')}}`;
  }

  const encoded = JSON.stringify(value);

  if (encoded === undefined) {
    throw new TypeError('Значение не представимо в JSON');
  }

  return encoded;
}
