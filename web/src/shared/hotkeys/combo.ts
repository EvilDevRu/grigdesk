import { localeTranslator, type LocaleSource } from '../../../../shared/i18n/catalogs.ts';

// Сочетание описывается физической клавишей (event.code), а не символом: раскладок у
// человека две, и заданное в латинице сочетание обязано срабатывать и в русской.
// Здесь же живёт единственный список того, что GrigDesk забирать не вправе, — иначе
// настройка тихо отняла бы у браузера вкладку, а у системы терминал.

export const MODIFIERS = ['Ctrl', 'Alt', 'Shift', 'Meta'];

const MODIFIER_CODES = new Set([
  'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'AltGraph',
  'ShiftLeft', 'ShiftRight', 'MetaLeft', 'MetaRight', 'OSLeft', 'OSRight',
]);

// Системный переключатель раскладки забирает себе ВТОРУЮ клавишу пары модификаторов:
// при `grp:alt_shift_toggle` нажатый вторым Shift приезжает в браузер как GroupNext и
// свой модификатор не выставляет. Значит пары Alt+Shift на такой машине не существует —
// страница видит только Alt+клавишу либо Shift+клавишу. Отличить этот случай важно:
// человеку надо сказать, что клавиша не дошла, а не молчать.
const LAYOUT_SWITCH_KEYS = new Set([
  'GroupNext', 'GroupPrevious', 'GroupFirst', 'GroupLast', 'ModeChange',
]);

// Пунктуация и навигация, которые физически есть на любой клавиатуре. Всё остальное
// (Escape, Tab, Enter, пробел, Backspace) принадлежит интерфейсу и вводу текста.
const NAMED_KEYS = new Map([
  ['Backquote', '`'],
  ['Minus', '-'],
  ['Equal', '='],
  ['BracketLeft', '['],
  ['BracketRight', ']'],
  ['Backslash', '\\'],
  ['Semicolon', ';'],
  ['Quote', "'"],
  ['Comma', ','],
  ['Period', '.'],
  ['Slash', '/'],
  ['ArrowUp', '↑'],
  ['ArrowDown', '↓'],
  ['ArrowLeft', '←'],
  ['ArrowRight', '→'],
  ['Home', 'Home'],
  ['End', 'End'],
  ['PageUp', 'PageUp'],
  ['PageDown', 'PageDown'],
  ['Insert', 'Insert'],
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
function isBaseKey(code: string): boolean {
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

  return NAMED_KEYS.has(code);
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
 * Нажатие, которое перехватил системный переключатель раскладки, а не сам GrigDesk.
 * Такое событие приходит без второй клавиши пары — записывать его как сочетание нельзя.
 */
export function isLayoutSwitch(event: KeyboardEvent | null | undefined): boolean {
  return LAYOUT_SWITCH_KEYS.has(String(event?.key || ''));
}

/**
 * Сочетание из живого события. Пока нажаты только модификаторы, сочетания ещё нет:
 * запись ждёт основную клавишу и возвращает пустую строку.
 */
export function comboFromEvent(event: KeyboardEvent | null | undefined): string {
  const code = String(event?.code || '');

  if (!code || MODIFIER_CODES.has(code) || !isBaseKey(code)) {
    return '';
  }

  const pressed = [
    event?.ctrlKey ? 'Ctrl' : '',
    event?.altKey ? 'Alt' : '',
    event?.shiftKey ? 'Shift' : '',
    event?.metaKey ? 'Meta' : '',
  ].filter(Boolean);

  return [...pressed, code].join('+');
}

/**
 * Подпись одной клавиши для человека: физический код превращается в то, что написано
 * на клавише. Неизвестный код показываем как есть — это честнее пустого места.
 */
function keyLabel(code: string): string {
  if (/^Key[A-Z]$/.test(code)) {
    return code.slice(3);
  }

  if (/^Digit[0-9]$/.test(code)) {
    return code.slice(5);
  }

  if (/^Numpad[0-9]$/.test(code)) {
    return `Num ${code.slice(6)}`;
  }

  return NAMED_KEYS.get(code) || code;
}

/**
 * Человеческая подпись сочетания. Одна на весь GrigDesk: подсказка рейки и поле
 * настройки обязаны показывать одно и то же, иначе человек не узнаёт своё сочетание.
 */
export function formatCombo(value: unknown): string {
  const combo = normalizeCombo(value);

  if (!combo) {
    return '';
  }

  const parts = combo.split('+');

  return [...parts.slice(0, -1), keyLabel(String(parts.at(-1)))].join(' + ');
}

/**
 * Причина, по которой сочетание нельзя назначить: без Ctrl/Alt оно сработало бы при
 * наборе текста, с Win/Cmd его забирает система, а перечисленные комбинации до
 * страницы вообще не доходят. Возврат — готовый текст для человека либо пустая строка.
 */
export function comboIssue(value: unknown, locale: LocaleSource = 'ru'): string {
  const t = localeTranslator(locale);

  const combo = normalizeCombo(value);

  if (!combo) {
    return t('settings.comboInvalidKey');
  }

  const parts = combo.split('+');
  const code = String(parts.at(-1));
  const pressed = new Set(parts.slice(0, -1));

  if (pressed.has('Meta')) {
    return t('settings.comboMetaReserved');
  }

  if (!pressed.has('Ctrl') && !pressed.has('Alt')) {
    return t('settings.comboNeedsModifier');
  }

  const reserved = RESERVED.get(combo);

  if (reserved) {
    return t('settings.comboReserved', { reason: t(reserved) });
  }

  const digitPrefix = /^Digit[0-9]$/.test(code) && parts.length === 2
    ? RESERVED_DIGIT_PREFIXES.get(String(parts[0]))
    : null;

  if (digitPrefix) {
    return t('settings.comboReserved', { reason: t(digitPrefix) });
  }

  return '';
}
