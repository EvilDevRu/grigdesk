import { localeTranslator, type LocaleSource } from '../../../../shared/i18n/catalogs.ts';
import { comboIssueKey, isBaseKey, normalizeCombo } from '../../../../shared/hotkeys/combo.ts';

export { MODIFIERS, normalizeCombo } from '../../../../shared/hotkeys/combo.ts';

// Сочетание описывается физической клавишей (event.code), а не символом: раскладок у
// человека две, и заданное в латинице сочетание обязано срабатывать и в русской.
// Общий список ограничений принадлежит shared/hotkeys; окно добавляет события и подписи.

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
 * Общая чистая политика отдаёт ключ, а окно переводит причину текущим языком.
 * Прежняя строковая форма comboIssue сохраняется для настроек и записи клавиши.
 */
export function comboIssue(value: unknown, locale: LocaleSource = 'ru'): string {
  const issue = comboIssueKey(value);

  if (!issue) {
    return '';
  }

  const t = localeTranslator(locale);

  return issue.startsWith('settings.reservedShortcut')
    ? t('settings.comboReserved', { reason: t(issue) }) : t(issue);
}
