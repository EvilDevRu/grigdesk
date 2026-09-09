// Единственный ответ на «сколько контекста занято и до какой границы».
// Общий для кольца полного чата, компактного компаньона и карточки телеграм-пульта:
// две копии этой арифметики разъехались бы, а человек читает форму, а не оттенок.

// потолок: доля окна модели, дальше которой ждать нельзя
export const CTX_CEIL_RATIO = 0.8;
// жёлтое — на подходе к порогу
export const CTX_WARN_RATIO = 0.8;

export interface ChatContextInput {
  tokens?: number;
  window?: number;
  compactWindow?: number;
}

export interface ChatContextFill {
  limit: number;
  pct: number;
  tone: 'hi' | 'mid' | '';
  // Победившая граница называется поимённо: «до сжатия» и «до 80% окна» —
  // разные события, и обещать не то, которое наступит, нельзя.
  limitWhat: string;
  limitShort: string;
}

/**
 * Ближайшая практическая граница: настроенное автосжатие ЛИБО безопасный потолок окна.
 * `compactWindow === 0` означает «не вмешиваться», то есть Infinity, а не ноль:
 * выключенное автосжатие не имеет права схлопнуть шкалу в минимум.
 */
export function contextLimit(windowTokens: number, compactWindow: number): number {
  const ceil = Math.round(Math.max(1, windowTokens || 0) * CTX_CEIL_RATIO);
  const want = compactWindow > 0 ? compactWindow : Infinity;

  return Math.min(want, ceil);
}

/**
 * Заполненность считается от ТОГО ЖЕ порога, по которому выбирается цвет: иначе на
 * окне 1M цвет и дуга расходятся впятеро и предупреждению перестают верить.
 */
export function contextFill({
  tokens = 0,
  window: windowTokens = 0,
  compactWindow = 0,
}: ChatContextInput = {}): ChatContextFill {
  const limit = contextLimit(windowTokens, compactWindow);
  const used = Math.max(0, tokens || 0);
  const pct = Math.min(100, Math.round((used / Math.max(1, limit)) * 100));
  const byCompact = compactWindow > 0 && limit === compactWindow;

  return {
    limit,
    pct,
    tone: used >= limit ? 'hi' : (used >= limit * CTX_WARN_RATIO ? 'mid' : ''),
    limitWhat: byCompact ? 'до сжатия' : 'до потолка окна',
    limitShort: byCompact ? 'автосжатие' : '80% окна',
  };
}
