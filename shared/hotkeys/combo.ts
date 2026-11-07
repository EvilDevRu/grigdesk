// Чистый контракт сочетаний: физические code и ограничения доступны серверу и окну.
// Перевод причин, подписи клавиш и KeyboardEvent остаются в браузерной обёртке.

export const MODIFIERS: readonly string[] = Object.freeze(['Ctrl', 'Alt', 'Shift', 'Meta']);

const NAMED_KEY_CODES = new Set([
  'Backquote',
  'Minus',
  'Equal',
  'BracketLeft',
  'BracketRight',
  'Backslash',
  'Semicolon',
  'Quote',
  'Comma',
  'Period',
  'Slash',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Insert',
]);

// Сочетания, которые перехватывает браузер или рабочий стол. Клавишу до GrigDesk они
// просто не доведут, поэтому настройка обязана отказать сразу, а не молча не работать.
const RESERVED = new Map([
  ['Ctrl+Alt+KeyS', 'settings.reservedShortcut1'],
  ['Ctrl+KeyT', 'settings.reservedShortcut2'],
  ['Ctrl+KeyN', 'settings.reservedShortcut3'],
  ['Ctrl+KeyW', 'settings.reservedShortcut4'],
  ['Ctrl+KeyR', 'settings.reservedShortcut5'],
  ['Ctrl+KeyL', 'settings.reservedShortcut6'],
  ['Ctrl+KeyD', 'settings.reservedShortcut7'],
  ['Ctrl+KeyP', 'settings.reservedShortcut8'],
  ['Ctrl+KeyS', 'settings.reservedShortcut9'],
  ['Ctrl+KeyO', 'settings.reservedShortcut10'],
  ['Ctrl+KeyF', 'settings.reservedShortcut11'],
  ['Ctrl+KeyH', 'settings.reservedShortcut12'],
  ['Ctrl+KeyJ', 'settings.reservedShortcut13'],
  ['Ctrl+KeyU', 'settings.reservedShortcut14'],
  ['Ctrl+KeyQ', 'settings.reservedShortcut15'],
  ['Ctrl+KeyA', 'settings.reservedShortcut16'],
  ['Ctrl+KeyC', 'settings.reservedShortcut17'],
  ['Ctrl+KeyV', 'settings.reservedShortcut18'],
  ['Ctrl+KeyX', 'settings.reservedShortcut19'],
  ['Ctrl+KeyZ', 'settings.reservedShortcut20'],
  ['Ctrl+KeyY', 'settings.reservedShortcut21'],
  ['Ctrl+Minus', 'settings.reservedShortcut22'],
  ['Ctrl+Equal', 'settings.reservedShortcut23'],
  ['Ctrl+F5', 'settings.reservedShortcut5'],
  ['Ctrl+Shift+KeyT', 'settings.reservedShortcut24'],
  ['Ctrl+Shift+KeyN', 'settings.reservedShortcut25'],
  ['Ctrl+Shift+KeyW', 'settings.reservedShortcut26'],
  ['Ctrl+Shift+KeyI', 'settings.reservedShortcut27'],
  ['Ctrl+Shift+KeyJ', 'settings.reservedShortcut28'],
  ['Ctrl+Shift+KeyC', 'settings.reservedShortcut29'],
  ['Ctrl+Shift+KeyP', 'settings.reservedShortcut30'],
  ['Ctrl+Shift+KeyR', 'settings.reservedShortcut5'],
  ['Ctrl+Shift+KeyQ', 'settings.reservedShortcut15'],
  ['Ctrl+Alt+KeyT', 'settings.reservedShortcut31'],
  ['Ctrl+Alt+KeyL', 'settings.reservedShortcut32'],
  ['Ctrl+Alt+KeyD', 'settings.reservedShortcut33'],
  ['Alt+Home', 'settings.reservedShortcut34'],
  ['Alt+ArrowLeft', 'settings.reservedShortcut35'],
  ['Alt+ArrowRight', 'settings.reservedShortcut36'],
  ['Alt+F4', 'settings.reservedShortcut37'],
]);

const RESERVED_DIGIT_PREFIXES = new Map([
  ['Ctrl', 'settings.reservedShortcut38'],
  ['Alt', 'settings.reservedShortcut38'],
]);

/**
 * Годится ли клавиша как ОСНОВНАЯ в сочетании. Проверяется физический `code`, а не
 * `key`: на второй раскладке буква приезжает другой, а код клавиши остаётся тем же.
 */
export function isBaseKey(code: string): boolean {
  if (/^Key[A-Z]$/.test(code)) {
    return true;
  }

  if (/^Digit[0-9]$/.test(code)) {
    return true;
  }

  if (/^Numpad[0-9]$/.test(code)) {
    return true;
  }

  if (/^F([1-9]|1[0-2])$/.test(code)) {
    return true;
  }

  return NAMED_KEY_CODES.has(code);
}

/**
 * Канонический вид сочетания: модификаторы всегда в одном порядке, основная клавиша
 * последняя. Нужен, чтобы сравнение с настройкой и поиск дубля были строковыми,
 * без разбора объекта на каждое нажатие.
 */
export function normalizeCombo(value: unknown): string {
  const parts = String(value || '').split('+').map((part) => part.trim()).filter(Boolean);

  if (!parts.length) {
    return '';
  }

  const code = String(parts.at(-1));

  if (!isBaseKey(code)) {
    return '';
  }

  const pressed = new Set(parts.slice(0, -1));

  // Повтор модификатора — не сочетание, а мусор: множество короче списка частей.
  if (pressed.size !== parts.length - 1) {
    return '';
  }

  if ([...pressed].some((part) => !MODIFIERS.includes(part))) {
    return '';
  }

  return [...MODIFIERS.filter((name) => pressed.has(name)), code].join('+');
}

/**
 * Возвращает ключ причины без зависимости от каталога переводов или окружения.
 * ReservedShortcut — причина системного резерва; пустая строка означает допустимую комбинацию.
 */
export function comboIssueKey(value: unknown): string {
  const combo = normalizeCombo(value);

  if (!combo) {
    return 'settings.comboInvalidKey';
  }

  const parts = combo.split('+');
  const code = String(parts.at(-1));
  const pressed = new Set(parts.slice(0, -1));

  if (pressed.has('Meta')) {
    return 'settings.comboMetaReserved';
  }

  if (!pressed.has('Ctrl') && !pressed.has('Alt')) {
    return 'settings.comboNeedsModifier';
  }

  const reserved = RESERVED.get(combo);

  if (reserved) {
    return reserved;
  }

  const digitPrefix = /^Digit[0-9]$/.test(code) && parts.length === 2
    ? RESERVED_DIGIT_PREFIXES.get(String(parts[0]))
    : null;

  if (digitPrefix) {
    return digitPrefix;
  }

  return '';
}

/**
 * Манифест принимает только непустой канонический вид допустимого сочетания.
 * Device overrides могут нормализоваться отдельно, но декларация пакета не исправляется молча.
 */
export function isCanonicalPanelHotkey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64
    && value === normalizeCombo(value) && comboIssueKey(value) === '';
}
