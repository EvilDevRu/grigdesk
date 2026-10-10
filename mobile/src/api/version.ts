/**
 * Числовая версия сравнивается по компонентам, поэтому 0.10 новее 0.9.
 * Неизвестный формат не разрешает обход обязательного обновления.
 */
export function isNewer(candidate: string, installed: string) {
  const parse = (value: string) =>
    /^\d+\.\d+\.\d+$/.test(value) ? value.split('.').map(Number) : null;
  const next = parse(candidate);
  const current = parse(installed);

  if (!next || !current) {
    return true;
  }

  for (let index = 0; index < 3; index += 1) {
    if (next[index] !== current[index]) {
      return next[index]! > current[index]!;
    }
  }

  return false;
}
