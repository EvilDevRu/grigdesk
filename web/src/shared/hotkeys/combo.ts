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
  ['Ctrl+Alt+KeyS', 'открывает настройки в приложении GrigDesk'],
  ['Ctrl+KeyT', 'браузер откроет новую вкладку'],
  ['Ctrl+KeyN', 'браузер откроет новое окно'],
  ['Ctrl+KeyW', 'браузер закроет вкладку'],
  ['Ctrl+KeyR', 'перезагрузка заблокирована приложением'],
  ['Ctrl+KeyL', 'браузер перейдёт в адресную строку'],
  ['Ctrl+KeyD', 'браузер добавит закладку'],
  ['Ctrl+KeyP', 'браузер откроет печать'],
  ['Ctrl+KeyS', 'браузер сохранит страницу'],
  ['Ctrl+KeyO', 'браузер откроет файл'],
  ['Ctrl+KeyF', 'браузер откроет поиск по странице'],
  ['Ctrl+KeyH', 'браузер откроет историю'],
  ['Ctrl+KeyJ', 'браузер откроет загрузки'],
  ['Ctrl+KeyU', 'браузер покажет исходный код'],
  ['Ctrl+KeyQ', 'браузер завершит работу'],
  ['Ctrl+KeyA', 'выделение всего текста'],
  ['Ctrl+KeyC', 'копирование'],
  ['Ctrl+KeyV', 'вставка'],
  ['Ctrl+KeyX', 'вырезание'],
  ['Ctrl+KeyZ', 'отмена ввода'],
  ['Ctrl+KeyY', 'повтор ввода'],
  ['Ctrl+Minus', 'браузер уменьшит масштаб'],
  ['Ctrl+Equal', 'браузер увеличит масштаб'],
  ['Ctrl+F5', 'перезагрузка заблокирована приложением'],
  ['Ctrl+Shift+KeyT', 'браузер вернёт закрытую вкладку'],
  ['Ctrl+Shift+KeyN', 'браузер откроет приватное окно'],
  ['Ctrl+Shift+KeyW', 'браузер закроет окно'],
  ['Ctrl+Shift+KeyI', 'браузер откроет инструменты разработчика'],
  ['Ctrl+Shift+KeyJ', 'браузер откроет консоль'],
  ['Ctrl+Shift+KeyC', 'браузер откроет выбор элемента'],
  ['Ctrl+Shift+KeyP', 'браузер откроет приватное окно или командную строку'],
  ['Ctrl+Shift+KeyR', 'перезагрузка заблокирована приложением'],
  ['Ctrl+Shift+KeyQ', 'браузер завершит работу'],
  ['Ctrl+Alt+KeyT', 'рабочий стол откроет системный терминал'],
  ['Ctrl+Alt+KeyL', 'рабочий стол заблокирует экран'],
  ['Ctrl+Alt+KeyD', 'рабочий стол свернёт все окна'],
  ['Alt+Home', 'браузер откроет домашнюю страницу'],
  ['Alt+ArrowLeft', 'браузер вернётся на шаг назад'],
  ['Alt+ArrowRight', 'браузер перейдёт на шаг вперёд'],
  ['Alt+F4', 'система закроет окно'],
]);

const RESERVED_DIGIT_PREFIXES = new Map([
  ['Ctrl', 'браузер переключит вкладку по номеру'],
  ['Alt', 'браузер переключит вкладку по номеру'],
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
export function comboIssue(value: unknown): string {
  const combo = normalizeCombo(value);

  if (!combo) {
    return 'Эта клавиша не подходит для сочетания — выберите букву, цифру или F-клавишу.';
  }

  const parts = combo.split('+');
  const code = String(parts.at(-1));
  const pressed = new Set(parts.slice(0, -1));

  if (pressed.has('Meta')) {
    return 'Клавишу Win/Cmd забирает себе операционная система.';
  }

  if (!pressed.has('Ctrl') && !pressed.has('Alt')) {
    return 'Нужен Ctrl или Alt — иначе сочетание сработает при обычном наборе текста.';
  }

  const reserved = RESERVED.get(combo);

  if (reserved) {
    return `Сочетание занято: ${reserved}.`;
  }

  const digitPrefix = /^Digit[0-9]$/.test(code) && parts.length === 2
    ? RESERVED_DIGIT_PREFIXES.get(String(parts[0]))
    : null;

  if (digitPrefix) {
    return `Сочетание занято: ${digitPrefix}.`;
  }

  return '';
}
