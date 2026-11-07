import type { UsageSummaryItem } from '../../features/providers/providerUsageSummary.ts';

// Что из сведений справа в строке хода видно при данной ширине блока и что уходит во
// всплывашку «+N». Одно правило на оба вопроса: счётчик и список всплывашки всегда
// совпадают с тем, что действительно спрятано, — CSS-пороги этого не гарантировали бы.

export interface StatusSummaryLayout {
  model: boolean;
  kind: boolean;
  cwd: boolean;
  labels: boolean;
  windows: number;
}

// Что по факту замера не влезло целиком: пороги ширины зависят от шрифта устройства.
export interface StatusSummarySqueeze {
  cwd?: boolean;
  model?: boolean;
  windows?: number;
}

export interface StatusSummaryFacts {
  modelKind: string;
  modelLabel: string;
  cwd: string;
  extraDirs: string[];
  usageItems: UsageSummaryItem[];
}

export interface StatusOverflowEntry {
  key: string;
  label: string;
  value: string;
}

const CWD_MIN_WIDTH = 260;
const MODEL_MIN_WIDTH = 150;
const LABELS_MIN_WIDTH = 90;
const KIND_MIN_WIDTH = 380;
const SECOND_WINDOW_MIN_WIDTH = 480;
const WIDE_WINDOWS_MIN = 2;

/**
 * Пороги — по ширине самого блока сведений, а не всей строки: индикатор слева на
 * планшете занимает больше половины ряда. Первыми уходят окна лимитов сверх двух, затем
 * папка, затем модель (только при лимитах — иначе блок опустел бы), последними — второе
 * окно и подписи окон. Неизмеренная ширина (Infinity) показывает всё: лучше на кадр
 * длиннее, чем ложный «+N». Пороги — верхняя граница: что при пройденном пороге всё же
 * обрезалось (squeeze), тоже уходит целиком; squeeze.windows — сколько окон снято замером.
 */
export function statusSummaryLayout(
  width: number,
  usageCount: number,
  squeeze: StatusSummarySqueeze = {},
): StatusSummaryLayout {
  const hasUsage = usageCount > 0;
  const wideWindows = Math.max(WIDE_WINDOWS_MIN, usageCount - (squeeze.windows || 0));

  return {
    model: !hasUsage || (width > MODEL_MIN_WIDTH && !squeeze.model),
    kind: width >= KIND_MIN_WIDTH,
    cwd: width > CWD_MIN_WIDTH && !squeeze.cwd,
    labels: width > LABELS_MIN_WIDTH,
    windows: width >= SECOND_WINDOW_MIN_WIDTH ? wideWindows : 1,
  };
}

/**
 * Список того, что не поместилось в строку, — в порядке строки: модель, папка,
 * дополнительные каталоги (в строку не входят никогда), окна лимитов. Окно, у которого
 * в строке спрятана подпись, тоже попадает сюда: голое «96%» без подписи непонятно.
 * Пометка вида модели («выбр.») отдельной записью не считается — она есть в шапке.
 */
export function statusOverflow(
  layout: StatusSummaryLayout,
  facts: StatusSummaryFacts,
): StatusOverflowEntry[] {
  const entries: StatusOverflowEntry[] = [];

  if (!layout.model) {
    entries.push({
      key: 'model',
      label: 'Модель',
      value: `${facts.modelKind} ${facts.modelLabel}`.trim(),
    });
  }

  if (!layout.cwd && facts.cwd) {
    entries.push({
      key: 'cwd',
      label: 'Папка',
      value: facts.cwd,
    });
  }

  if (facts.extraDirs.length) {
    entries.push({
      key: 'extra-dirs',
      label: 'Доп. каталоги',
      value: facts.extraDirs.join(', '),
    });
  }

  facts.usageItems.forEach((item, index) => {
    if (index >= layout.windows || !layout.labels) {
      entries.push({
        key: `usage:${item.key}`,
        label: item.label,
        value: item.value,
      });
    }
  });

  return entries;
}
