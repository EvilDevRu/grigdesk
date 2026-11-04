export type ChatSpeed = 'standard' | 'fast' | 'ultrafast';

export interface ChatSpeedCapability {
  modes: readonly ChatSpeed[];
}

/**
 * Пустой выбор сохраняет прежнее наследование настроек исполнителя.
 * Произвольные значения не превращаются ни в Fast, ни в строку командной строки.
 */
export function isChatSpeed(value: unknown): value is ChatSpeed | null | undefined {
  return value == null || value === 'standard' || value === 'fast' || value === 'ultrafast';
}

/**
 * Окно показывает пересечение возможностей адаптера и конкретной модели.
 * Standard остаётся путём выключения, когда metadata ускорения исчезли.
 */
export function chatSpeedModes(
  capability: ChatSpeedCapability | null | undefined,
  model: { chatSpeedModes?: readonly string[] } | null | undefined,
): ChatSpeed[] {
  if (!capability) {
    return [];
  }

  return capability.modes.filter((mode) => mode === 'standard'
    || model?.chatSpeedModes?.includes(mode));
}
