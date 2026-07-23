// Парсер реестра фабрики `tNNNN.pipeline`.
// Формат: один `KEY=VALUE` на строку, разрез по ПЕРВОМУ `=` (эталон — parse_env_file
// в factory/lib/dashboard.py). В файле встречается мусор от протёкшего многострочного
// комментария — поэтому берём только валидные ключи-идентификаторы (UPPER_SNAKE), а
// строки с пробелом в «ключе» отбрасываем.

const VALID_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Разбирает текст реестра в плоский объект { KEY: value }.
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parsePipeline(text) {
  const out = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    if (!VALID_KEY.test(key)) continue;
    out[key] = line.slice(eq + 1);
  }
  return out;
}
