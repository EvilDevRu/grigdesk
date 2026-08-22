// Единственный ответ на «сколько контекста занято и до какой границы».
// Общий для кольца полного чата и компактного компаньона: две копии этой
// арифметики разъехались бы, а человек читает форму, а не оттенок.

export const CTX_CEIL_RATIO = 0.8; // потолок: доля окна модели, дальше которой ждать нельзя
export const CTX_WARN_RATIO = 0.8; // жёлтое — на подходе к порогу

/**
 * Ближайшая практическая граница: настроенное автосжатие ЛИБО безопасный потолок окна.
 * `compactWindow === 0` означает «не вмешиваться», то есть Infinity, а не ноль:
 * выключенное автосжатие не имеет права схлопнуть шкалу в минимум.
 */
export function contextLimit(windowTokens, compactWindow) {
  const ceil = Math.round(Math.max(1, windowTokens || 0) * CTX_CEIL_RATIO);
  const want = compactWindow > 0 ? compactWindow : Infinity;
  return Math.min(want, ceil);
}

/**
 * Заполненность считается от ТОГО ЖЕ порога, по которому выбирается цвет: иначе на
 * окне 1M цвет и дуга расходятся впятеро и предупреждению перестают верить.
 */
export function contextFill({ tokens = 0, window: windowTokens = 0, compactWindow = 0 } = {}) {
  const limit = contextLimit(windowTokens, compactWindow);
  const used = Math.max(0, tokens || 0);
  const pct = Math.min(100, Math.round((used / Math.max(1, limit)) * 100));
  const byCompact = compactWindow > 0 && limit === compactWindow;
  return {
    limit,
    pct,
    tone: used >= limit ? 'hi' : (used >= limit * CTX_WARN_RATIO ? 'mid' : ''),
    // Победившая граница называется поимённо: «до сжатия» и «до 80% окна» —
    // разные события, и обещать не то, которое наступит, нельзя.
    limitWhat: byCompact ? 'до сжатия' : 'до потолка окна',
    limitShort: byCompact ? 'автосжатие' : '80% окна',
  };
}
