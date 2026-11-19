import { cliTranslator } from './i18n.ts';
import { terminalLines } from './terminal.ts';
import type { TerminalKey, TerminalLine, TerminalSession, TerminalTone } from './terminal.ts';

export interface ScreenLine {
  text: string;
  tone?: TerminalTone;
  selected?: boolean;
  paper?: boolean;
}

export interface ScreenOptions {
  title: string;
  state?: ScreenLine;
  lines: readonly (ScreenLine | string)[] | ((width: number) => readonly (ScreenLine | string)[]);
  actions?: () => readonly ScreenLine[];
  footer?: string;
  full?: boolean;
  follow?: boolean;
  minimumWidth?: number;
  incremental?: boolean;
}

interface ScreenChoice {
  accept: string;
  cancel: string;
  letterKeys?: boolean;
}

interface ScreenState {
  options: ScreenOptions;
  offset: number;
  pageSize: number;
  total: number;
}

const screens = new WeakMap<TerminalSession, ScreenState>();

/**
 * Строки отчёта и действий переносятся по одним правилам.
 * Выделение и цвет сохраняются у всех частей перенесённой строки.
 */
function contentRows(
  entries: readonly (ScreenLine | string)[], width: number, inset: string,
): TerminalLine[] {
  const rows: TerminalLine[] = [];

  for (const entry of entries) {
    const line = typeof entry === 'string' ? { text: entry } : entry;
    const wrapped = terminalLines(line.text.replaceAll('\t', '    '), width, { words: !line.paper });

    for (const text of wrapped.length ? wrapped : ['']) {
      rows.push({
        spans: [
          { text: inset },
          {
            text,
            tone: line.tone,
            paper: line.paper,
          },
        ],
        selected: line.selected,
      });
    }
  }

  return rows;
}

/**
 * Общая рамка удерживает заголовок и управление при прокрутке длинных результатов.
 * Полный вывод применяется перед автоматическим выходом и сохраняет текст в scrollback.
 */
function renderScreen(session: TerminalSession, state: ScreenState): void {
  const { t } = cliTranslator();
  const options = state.options;
  const width = Math.max(1, Math.min(Math.max(80, options.minimumWidth ?? 0), session.columns - 1));
  const inset = width >= 24 ? '  ' : '';
  const contentWidth = Math.max(1, width - inset.length * 2);
  const row = (text: string, tone: TerminalTone = 'text'): TerminalLine => ({
    spans: [{ text: inset + text, tone }],
  });
  const rule = row('─'.repeat(contentWidth), 'rule');
  const header: TerminalLine[] = ['', row('GrigDesk', 'accent')];

  for (const text of terminalLines(options.title, contentWidth, { words: true })) {
    header.push(row(text, 'text'));
  }

  if (options.state) {
    for (const text of terminalLines(options.state.text, contentWidth, { words: true })) {
      header.push(row(text, options.state.tone));
    }
  }

  header.push(rule, '');

  const source = typeof options.lines === 'function' ? options.lines(contentWidth) : options.lines;
  const body = contentRows(source, contentWidth, inset);
  const actions = contentRows(options.actions?.() ?? [], contentWidth, inset);
  const footer: TerminalLine[] = ['', rule];

  if (options.footer) {
    for (const text of terminalLines(options.footer, contentWidth, { words: true })) {
      footer.push(row(text, 'muted'));
    }
  }

  const full = options.full || process.env.TERM === 'dumb';
  const pageSize = Math.max(1, session.rows - header.length - actions.length - footer.length - 2);
  const atEnd = state.total > 0 && state.offset >= state.total - state.pageSize;

  state.pageSize = pageSize;
  state.total = body.length;
  state.offset = options.follow || atEnd ? Math.max(0, body.length - pageSize)
    : Math.min(state.offset, Math.max(0, body.length - pageSize));

  if (!full && body.length > pageSize) {
    const position = t(actions.length ? 'screens.pagePosition' : 'screens.page', {
      first: state.offset + 1,
      last: Math.min(body.length, state.offset + pageSize),
      total: body.length,
    });

    footer.push(row(position, 'muted'));
  }

  session.draw([
    ...header,
    ...full ? body : body.slice(state.offset, state.offset + pageSize),
    ...actions,
    ...footer,
  ], () => renderScreen(session, state), {
    theme: 'dark',
    width,
    incremental: options.incremental,
  });
}

/**
 * Новый результат сбрасывает позицию просмотра, обновление выбора сохраняет её.
 * Resize заново рассчитывает доступную область из тех же данных.
 */
export function showScreen(session: TerminalSession, options: ScreenOptions): () => void {
  const state: ScreenState = {
    options,
    offset: 0,
    pageSize: 1,
    total: 0,
  };
  const redraw = () => renderScreen(session, state);

  screens.set(session, state);
  redraw();

  return redraw;
}

/**
 * Подтверждение показывает действия под отчётом и начинает с выделенного отказа.
 * Стрелки переключают выбор, клавиши страниц прокручивают только отчёт.
 * Буквенные сокращения подключаются для действий, которым достаточно одного нажатия.
 */
export async function chooseScreenAction(
  session: TerminalSession, options: ScreenOptions, choice: ScreenChoice,
): Promise<'accept' | 'cancel' | 0 | 130 | 143> {
  let accept = false;
  const redraw = showScreen(session, {
    ...options,
    actions: () => [
      { text: `${accept ? '›' : ' '} ${choice.accept}`, selected: accept },
      { text: `${accept ? ' ' : '›'} ${choice.cancel}`, selected: !accept },
    ],
  });

  for (;;) {
    const key = await session.nextKey();
    const letter = choice.letterKeys ? key.text?.toLowerCase() ?? '' : '';

    if (key.name === 'interrupt' || key.name === 'terminate') {
      return key.name === 'interrupt' ? 130 : 143;
    }

    if (key.name === 'eof') {
      return 0;
    }

    if (key.name === 'escape' || ['n', 'н'].includes(letter)) {
      return 'cancel';
    }

    if (['y', 'д'].includes(letter)) {
      return 'accept';
    }

    if (key.name === 'return') {
      return accept ? 'accept' : 'cancel';
    }

    if (['up', 'down', 'left', 'right'].includes(key.name)) {
      accept = !accept;
      redraw();
    } else {
      scrollScreen(session, key);
    }
  }
}

/**
 * Клавиши просмотра изменяют только окно результата, команды повторно не выполняются.
 * Enter, Esc и сигналы остаются в ведении вызывающего меню.
 */
export function scrollScreen(session: TerminalSession, key: TerminalKey): boolean {
  const state = screens.get(session);

  if (!state || state.options.full || process.env.TERM === 'dumb') {
    return false;
  }

  const movement: Record<string, number> = {
    up: -1,
    down: 1,
    pageup: -state.pageSize,
    pagedown: state.pageSize,
    home: -state.total,
    end: state.total,
  };
  const change = movement[key.name];

  if (change === undefined) {
    return false;
  }

  state.options = { ...state.options, follow: false };
  state.offset = Math.max(0, Math.min(state.offset + change, state.total - state.pageSize));
  renderScreen(session, state);

  return true;
}
