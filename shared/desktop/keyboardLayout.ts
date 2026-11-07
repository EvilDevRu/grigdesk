export interface KeyboardLayout {
  code: string;
  variant: string;
}

/**
 * Граница оболочки принимает только короткие обозначения системной раскладки.
 * Неизвестный или повреждённый ответ не превращается в предположение о языке ввода.
 */
export function parseKeyboardLayout(value: unknown): KeyboardLayout | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const { code, variant } = value as Partial<KeyboardLayout>;

  if (typeof code !== 'string' || !/^[a-z0-9_-]{1,16}$/i.test(code)
    || typeof variant !== 'string' || !/^[a-z0-9_()+-]{0,64}$/i.test(variant)) {
    return null;
  }

  return { code: code.toLowerCase(), variant };
}
