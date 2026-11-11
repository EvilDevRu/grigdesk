import { emitKeypressEvents } from 'node:readline';
import { stripVTControlCharacters } from 'node:util';
import type { ReadStream, WriteStream } from 'node:tty';

export interface TerminalKey {
  name: string;
  text: string;
}

export type TerminalTone = 'text' | 'accent' | 'muted' | 'rule' | 'success' | 'warning' | 'error';

export interface TerminalSpan {
  text: string;
  tone?: TerminalTone;
  paper?: boolean;
}

export interface TerminalRow {
  spans: readonly TerminalSpan[];
  selected?: boolean;
}

export type TerminalLine = string | TerminalRow;

interface TerminalDrawing {
  theme?: 'dark';
  width?: number;
  incremental?: boolean;
}

interface TerminalFrame {
  lines: string[];
  columns: number;
  rows: number;
}

interface ReadlineKey {
  name?: string;
  ctrl?: boolean;
  sequence?: string;
}

const darkBackground = '\x1b[48;2;27;31;38m';
const selectedBackground = '\x1b[48;2;41;59;67m';
const tones: Record<TerminalTone, string> = {
  text: '\x1b[38;2;224;229;237m',
  accent: '\x1b[38;2;140;206;206m',
  muted: '\x1b[38;2;154;165;181m',
  rule: '\x1b[38;2;83;97;116m',
  success: '\x1b[38;2;142;203;167m',
  warning: '\x1b[38;2;226;190;121m',
  error: '\x1b[38;2;239;144;144m',
};

/**
 * Внешние строки очищаются только при показе, исходные байты журнала не меняются.
 * Ограничение по символам предотвращает перенос строки за правый край терминала.
 */
export function terminalText(value: string, columns: number): string {
  const clean = stripVTControlCharacters(value).replace(/[\x00-\x1f\x7f-\x9f]/g, '');

  return [...clean].slice(0, Math.max(1, columns)).join('');
}

/**
 * Длинный текст сохраняется целиком в пределах доступной ширины каждой строки.
 * Очистка до переноса не позволяет внешним escape-последовательностям менять экран.
 */
export function terminalLines(value: string, columns: number, options: { words?: boolean } = {}): string[] {
  const characters = [...terminalText(value, Number.MAX_SAFE_INTEGER)];
  const width = Math.max(1, columns);
  const lines: string[] = [];

  for (let index = 0; index < characters.length;) {
    const end = Math.min(characters.length, index + width);
    let boundary = end;

    if (options.words && end < characters.length) {
      let space = end;

      while (space > index && characters[space] !== ' ') {
        space--;
      }

      if (space - index > width / 2) {
        boundary = space;
      }
    }

    lines.push(characters.slice(index, boundary).join(''));
    index = boundary + (boundary < end ? 1 : 0);
  }

  return lines;
}

/**
 * Стили принадлежат рендеру: каждый фрагмент сначала очищается и обрезается.
 * Подсветка заполняет строку, а завершающий reset не окрашивает следующую команду.
 */
function darkLine(line: TerminalLine, columns: number): string {
  const row: TerminalRow = typeof line === 'string' ? { spans: [{ text: line }] } : line;
  const background = row.selected ? selectedBackground : darkBackground;
  const base = '\x1b[0m' + background;
  let remaining = columns;
  let rendered = base;

  for (const span of row.spans) {
    if (remaining <= 0) {
      break;
    }

    const text = terminalText(span.text, remaining);
    const tone = row.selected ? 'accent' : span.tone ?? 'text';
    const bold = row.selected || span.tone === 'accent' ? '\x1b[1m' : '';

    const foreground = span.paper ? '\x1b[47m\x1b[30m' : tones[tone];

    rendered += base + foreground + bold + text;
    remaining -= [...text].length;
  }

  return rendered + base + ' '.repeat(remaining) + '\x1b[0m';
}

/**
 * Сигнальные ключи приходят от сигналов процесса и конца stdin, а не от клавиш
 * вложенного мастера. Их доставка после suspend/resume и есть отмена, поэтому
 * при очистке очереди они сохраняются, а реплей настоящих нажатий отбрасывается.
 */
function signalKeysOnly(queue: TerminalKey[]): TerminalKey[] {
  return queue.filter((key) => ['interrupt', 'terminate', 'eof'].includes(key.name));
}

export class TerminalSession {
  input: ReadStream;
  output: WriteStream;
  private queue: TerminalKey[] = [];
  private reader: ((key: TerminalKey) => void) | undefined;
  private raw = false;
  private paused = true;
  private active = false;
  private attached = false;
  private onResize: (() => void) | undefined;
  private previousFrame: TerminalFrame | undefined;

  constructor(options: { input?: ReadStream; output?: WriteStream } = {}) {
    this.input = options.input ?? process.stdin;
    this.output = options.output ?? process.stdout;
  }

  get columns(): number {
    return Math.max(1, this.output.columns || 80);
  }

  get rows(): number {
    return Math.max(1, this.output.rows || 24);
  }

  private receive = (key: TerminalKey): void => {
    if (this.reader) {
      const resolve = this.reader;

      this.reader = undefined;
      resolve(key);
    } else {
      this.queue.push(key);
    }
  };

  /**
   * Readline объединяет быстрые повторные Esc в одну meta-последовательность.
   * Каждый такой байт остаётся отдельным переходом назад, стрелки сохраняют своё имя.
   */
  private keypress = (text: string, key: ReadlineKey): void => {
    if (key.name === 'escape' && /^\x1b+$/.test(key.sequence ?? '')) {
      for (const _escape of key.sequence!) {
        this.receive({ name: 'escape', text: '' });
      }

      return;
    }

    this.receive({ name: key.ctrl && key.name === 'c' ? 'interrupt' : key.name ?? '', text });
  };

  private end = (): void => this.receive({ name: 'eof', text: '' });
  private interrupt = (): void => this.receive({ name: 'interrupt', text: '' });
  private terminate = (): void => this.receive({ name: 'terminate', text: '' });
  private resize = (): void => {
    this.previousFrame = undefined;
    this.onResize?.();
  };

  /**
   * Одна сессия владеет raw mode и своими listeners до завершения callback.
   * Любой исход восстанавливает исходное состояние ввода и видимый курсор.
   */
  async run<T>(action: () => Promise<T>): Promise<T> {
    this.raw = Boolean(this.input.isRaw);
    this.paused = this.input.readableFlowing !== true;
    emitKeypressEvents(this.input);
    this.input.on('keypress', this.keypress);
    this.attached = true;
    this.input.on('end', this.end);
    this.output.on('resize', this.resize);
    process.on('SIGINT', this.interrupt);
    process.on('SIGTERM', this.terminate);
    this.active = true;
    this.resume();

    try {
      return await action();
    } finally {
      this.active = false;
      this.attached = false;
      this.input.setRawMode?.(this.raw);
      this.input.removeListener('keypress', this.keypress);
      this.input.removeListener('end', this.end);
      this.output.removeListener('resize', this.resize);
      process.removeListener('SIGINT', this.interrupt);
      process.removeListener('SIGTERM', this.terminate);

      if (process.env.TERM !== 'dumb') {
        this.output.write('\x1b[?25h');
      }

      if (this.paused) {
        this.input.pause();
      }
    }
  }

  /**
   * Внешняя команда получает обычный ввод и видимый курсор.
   * Слушатель клавиш снимается: вложенный мастер не должен делить нажатия с меню.
   * Нажатия отбрасываются, сигналы отмены сохраняются для доставки после возврата.
   * После её вывода сохранённые позиции строк больше не считаются достоверными.
   */
  suspend(): void {
    this.previousFrame = undefined;
    const pending = this.reader;

    this.reader = undefined;
    pending?.({ name: '', text: '' });
    this.queue = signalKeysOnly(this.queue);
    this.input.removeListener('keypress', this.keypress);
    this.attached = false;
    this.input.setRawMode?.(this.raw);
    this.input.pause();

    if (process.env.TERM !== 'dumb') {
      this.output.write('\x1b[?25h');
    }
  }

  /**
   * Возобновление возвращает только ввод меню после завершения обычной команды.
   * Очередь нажатий внешней команды отбрасывается: реплей клавиш недопустим.
   * Сохраняются только сигнальные ключи: отмена дошла и без участия пользователя.
   * Скрытие курсора не применяется к терминалам без управления позиционированием.
   */
  resume(): void {
    if (this.active) {
      // Слушатель добавляется один раз: повторный add дублировал бы каждое нажатие.
      if (!this.attached) {
        this.queue = signalKeysOnly(this.queue);
        this.input.addListener('keypress', this.keypress);
        this.attached = true;
      }

      this.input.setRawMode?.(true);
      this.input.resume();

      if (process.env.TERM !== 'dumb') {
        this.output.write('\x1b[?25l');
      }
    }
  }

  /**
   * Освобождает подвешенного читателя без потери будущего SIGINT.
   * Пустое имя не выполняет никаких веток и только закрывает осиротевший промис.
   */
  cancelReader(): void {
    const pending = this.reader;

    this.reader = undefined;
    pending?.({ name: '', text: '' });
  }

  nextKey(): Promise<TerminalKey> {
    const key = this.queue.shift();

    return key ? Promise.resolve(key) : new Promise((resolve) => {
      this.reader = resolve;
    });
  }

  /**
   * Кадр пишется целиком; частое обновление меняет только отличающиеся строки без очистки экрана.
   * Resize и внешний вывод сбрасывают снимок, dumb сохраняет простые последовательные строки.
   */
  draw(lines: readonly TerminalLine[], redraw?: () => void, options: TerminalDrawing = {}): void {
    this.onResize = redraw;

    const color = !process.env.NO_COLOR && process.env.TERM !== 'dumb';
    const dark = color && options.theme === 'dark';
    const columns = Math.max(1, Math.min(this.columns, options.width ?? this.columns));

    const rendered = lines.map((line) => {
      if (dark) {
        return darkLine(line, columns);
      }

      const value = typeof line === 'string' ? line : line.spans.map((span) => span.text).join('');
      const text = terminalText(value, columns);

      if (color && /^(?:✗|│ ✗)/.test(text)) {
        return `\x1b[31m${text}\x1b[0m`;
      }

      return color && text.startsWith('│ ›') ? `\x1b[2m${text}\x1b[0m` : text;
    });

    const positioned = process.env.TERM !== 'dumb';
    const cacheable = positioned && options.incremental && columns < this.columns
      && rendered.length < this.rows;
    const previous = cacheable ? this.previousFrame : undefined;
    const eraseStyle = dark ? darkBackground : '';
    const resetStyle = dark ? '\x1b[0m' : '';
    let frame = '';

    if (previous && previous.columns === this.columns && previous.rows === this.rows) {
      for (let index = 0; index < rendered.length; index++) {
        if (rendered[index] !== previous.lines[index]) {
          frame += `\x1b[${index + 1};1H${rendered[index]}${eraseStyle}\x1b[K${resetStyle}`;
        }
      }

      if (rendered.length < previous.lines.length) {
        frame += `\x1b[${rendered.length + 1};1H${eraseStyle}\x1b[J${resetStyle}`;
      }

      if (frame) {
        frame += `\x1b[${rendered.length + 1};1H`;
      }
    } else {
      frame = (positioned ? (dark ? darkBackground : '') + '\x1b[H\x1b[J' : '')
        + rendered.join('\n') + (dark ? '\x1b[0m' : '') + '\n';
    }

    this.previousFrame = cacheable ? {
      lines: rendered,
      columns: this.columns,
      rows: this.rows,
    } : undefined;

    if (frame) {
      this.output.write(frame);
    }
  }
}
