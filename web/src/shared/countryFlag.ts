/**
 * Преобразует двухбуквенный код страны в пару региональных индикаторов Unicode.
 * Для отсутствующей страны возвращает нейтральный флаг.
 */
export function countryFlag(code: string | null | undefined): string {
  if (!code || code.length !== 2) {
    return '🏳';
  }

  return code.toUpperCase().replace(/[A-Z]/g, (letter) =>
    String.fromCodePoint(127397 + letter.charCodeAt(0)));
}
