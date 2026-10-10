import type { ChatContext, ChatModel } from '../api/contract.ts';

/**
 * Кольцо показывает заполнение подтверждённого окна или порога автоматического сжатия.
 * Неизвестные данные не превращаются в ноль; размер из непроверенного каталога не используется.
 */
export function contextDisplay(context?: ChatContext, model?: ChatModel) {
  const unavailable = !context || ['unavailable', 'legacy-unavailable', ''].includes(context.metric);
  const tokens = unavailable ? null : context.tokens;
  const window = context?.window || (model?.contextVerified ? model.context : null);
  const threshold = window && model?.autoCompact
    ? Math.min(window * 0.8, context?.compactWindow || Infinity) : window;
  const percent = tokens !== null && threshold ? tokens / threshold * 100 : null;
  const label = percent === null ? 'Контекст: нет замера'
    : `Контекст: ${context?.estimate ? 'около ' : ''}${Math.round(percent)}%`;

  return {
    tokens,
    window,
    threshold,
    percent,
    label,
  };
}
