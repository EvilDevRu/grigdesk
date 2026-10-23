import { emitKeypressEvents } from 'node:readline';
import { stripVTControlCharacters } from 'node:util';
import type { ReadStream, WriteStream } from 'node:tty';

export interface TerminalKey {
  name: string;
  text: string;
}

interface ReadlineKey {
  name?: string;
  ctrl?: boolean;
  sequence?: string;
}

/**
 * Внешние строки очищаются только при показе, исходные байты журнала не меняются.
 * Ограничение по символам предотвращает перенос строки за правый край терминала.
 */
export function terminalText(value: string, columns: number): string {
  const clean = stripVTControlCharacters(value).replace(/[\x00-\x1f\x7f-\x9f]/g, '');

  return [...clean].slice(0, Math.max(1, columns)).join('');
}

export class TerminalSession {
  input: ReadStream;
  output: WriteStream;
  private queue: TerminalKey[] = [];
  private reader: ((key: TerminalKey) => void) | undefined;
  private raw = false;
  private paused = true;
  private active = false;
  private onResize: (() => void) | undefined;

  constructor(options: { input?: ReadStream; output?: WriteStream } = {}) {
    this.input = options.input ?? process.stdin;
    this.output = options.output ?? process.stdout;
  }

  get columns(): number {
    return Math.max(1, this.output.columns || 80);
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
  private resize = (): void => this.onResize?.();

  /**
   * Одна сессия владеет raw mode и своими listeners до завершения callback.
   * Любой исход восстанавливает исходное состояние ввода и видимый курсор.
   */
  async run<T>(action: () => Promise<T>): Promise<T> {
    this.raw = Boolean(this.input.isRaw);
    this.paused = this.input.readableFlowing !== true;
    emitKeypressEvents(this.input);
    this.input.on('keypress', this.keypress);
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
      this.input.setRawMode?.(this.raw);
      this.input.removeListener('keypress', this.keypress);
      this.input.removeListener('end', this.end);
      this.output.removeListener('resize', this.resize);
      process.removeListener('SIGINT', this.interrupt);
      process.removeListener('SIGTERM', this.terminate);
      this.output.write('\x1b[?25h');

      if (this.paused) {
        this.input.pause();
      }
    }
  }

  suspend(): void {
    this.input.setRawMode?.(this.raw);
    this.input.pause();
    this.output.write('\x1b[?25h');
  }

  /**
   * Возобновление возвращает только ввод меню после завершения обычной команды.
   * Скрытие курсора не применяется к терминалам без управления позиционированием.
   */
  resume(): void {
    if (this.active) {
      this.input.setRawMode?.(true);
      this.input.resume();

      if (process.env.TERM !== 'dumb') {
        this.output.write('\x1b[?25l');
      }
    }
  }

  nextKey(): Promise<TerminalKey> {
    const key = this.queue.shift();

    return key ? Promise.resolve(key) : new Promise((resolve) => {
      this.reader = resolve;
    });
  }

  /**
   * Экран ограничивает каждую строку текущей шириной и обновляется после resize.
   * Dumb получает последовательные простые строки без позиционирования курсора.
   */
  draw(lines: readonly string[], redraw?: () => void): void {
    this.onResize = redraw;

    if (process.env.TERM !== 'dumb') {
      this.output.write('\x1b[H\x1b[J');
    }

    const color = !process.env.NO_COLOR && process.env.TERM !== 'dumb';
    const rendered = lines.map((line) => {
      const text = terminalText(line, this.columns);

      if (color && /^(?:✗|│ ✗)/.test(text)) {
        return `\x1b[31m${text}\x1b[0m`;
      }

      return color && text.startsWith('│ ›') ? `\x1b[2m${text}\x1b[0m` : text;
    });

    this.output.write(rendered.join('\n') + '\n');
  }
}
