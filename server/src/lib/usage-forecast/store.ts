// Хранилище рядов прогноза: один JSON в `.state`, запись через временный файл и
// rename. Повреждённый файл — не повод падать: ряды накопятся заново за пару часов,
// поэтому чтение возвращает пустое состояние и отдаёт причину наверх для журнала.
import fs from 'node:fs';
import path from 'node:path';

import { emptyForecastState, type ForecastState } from './forecast.ts';

export interface ReadForecastResult {
  state: ForecastState;
  warning: string | null;
}

// Форма на диске проверяется по минимуму: версия и два массива. Содержимое рядов
// сверять не с чем — его писали мы сами, а чужой файл сюда никто не кладёт.
function isForecastState(value: unknown): value is ForecastState {
  const raw = value as Partial<ForecastState> | null;

  return !!raw && typeof raw === 'object'
    && raw.version === 1
    && Array.isArray(raw.series)
    && Array.isArray(raw.resets);
}

/**
 * Чтение при старте. Отсутствие файла — штатный первый запуск; всё остальное
 * (кривой JSON, чужая версия) даёт пустое состояние и текст предупреждения.
 */
export function readForecastState(filePath: string): ReadForecastResult {
  let source: string;

  try {
    source = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;

    return {
      state: emptyForecastState(),
      warning: code === 'ENOENT' ? null : `Файл прогноза лимитов не прочитан: ${(error as Error)?.message}`,
    };
  }

  try {
    const parsed: unknown = JSON.parse(source);

    if (!isForecastState(parsed)) {
      return { state: emptyForecastState(), warning: 'Файл прогноза лимитов другой версии, начинаем заново' };
    }

    return { state: parsed, warning: null };
  } catch (error) {
    return {
      state: emptyForecastState(),
      warning: `Файл прогноза лимитов повреждён, начинаем заново: ${(error as Error)?.message}`,
    };
  }
}

let writeSeq = 0;

/**
 * Атомарная запись: сосед-процесс или обрыв на полпути не оставят полуфайла.
 * Права 0600 — как у прочих файлов `.state`: там нет секретов, но и читать их
 * снаружи некому.
 */
export function writeForecastState(filePath: string, state: ForecastState): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  writeSeq += 1;
  const temporary = `${filePath}.${process.pid}.${writeSeq}.tmp`;

  try {
    fs.writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(temporary, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // временный файл мог не создаться
    }
    throw error;
  }
}
