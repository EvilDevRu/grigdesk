import type { cliTranslator } from './i18n.ts';
import { statusTone } from './status.ts';
import { terminalLines, terminalText } from './terminal.ts';
import type { TerminalLine, TerminalRow, TerminalSpan, TerminalTone } from './terminal.ts';

interface MenuViewItem {
  label: string;
  description: string;
  children?: readonly unknown[];
}

interface MenuViewLevel {
  title: string;
  items: readonly MenuViewItem[];
  selected: number;
}

interface MenuViewOptions {
  width: number;
  rows: number;
  version: string;
  installation: string;
  server: string;
  window: string;
  levels: readonly MenuViewLevel[];
  t: ReturnType<typeof cliTranslator>['t'];
}

/**
 * Экран ограничен восемьюдесятью столбцами и хранит только описание текущего выбора.
 * Узкий или низкий терминал теряет пустые отступы, сохраняя состояния и команды.
 */
export function menuLines(options: MenuViewOptions): TerminalLine[] {
  const { width, t } = options;
  const level = options.levels.at(-1)!;
  const root = options.levels.length === 1;
  const inset = width >= 24 ? '  ' : '';
  const contentWidth = Math.max(1, width - inset.length * 2);
  const row = (text: string, tone: TerminalTone = 'text'): TerminalRow => ({
    spans: [{ text, tone }],
  });
  const rule = row(inset + '─'.repeat(contentWidth), 'rule');
  const version = terminalText(options.version, contentWidth);
  const brand = `${inset}GrigDesk ${version}`.trimEnd();
  const installation = t(options.installation);
  const gap = width - [...brand].length - [...installation].length - inset.length;
  const header: TerminalSpan[] = [
    { text: `${inset}GrigDesk`, tone: 'accent' },
    { text: version ? ` ${version}` : '', tone: 'muted' },
  ];
  const lines: TerminalLine[] = ['', { spans: header }];

  if (gap >= 2) {
    header.push({ text: ' '.repeat(gap) + installation, tone: 'muted' });
  } else {
    lines.push(row(inset + installation, 'muted'));
  }

  const statuses = [
    ['menuServerState', options.server],
    ['menuWindowState', options.window],
  ].map(([key, state]) => {
    const tone = statusTone(state!);
    const marker = tone === 'error' ? '✗' : tone === 'success' ? '●' : '○';

    return {
      text: t(key!, { marker, state: t(`states.${state}`) }),
      tone,
    };
  });

  if (statuses.reduce((length, span) => length + [...span.text].length, 3) <= contentWidth) {
    lines.push({ spans: [{ text: inset }, statuses[0]!, { text: '   ' }, statuses[1]!] });
  } else {
    for (const status of statuses) {
      for (const text of terminalLines(status.text, contentWidth)) {
        lines.push(row(inset + text, status.tone));
      }
    }
  }

  lines.push(rule, '');

  if (!root) {
    const trail = options.levels.slice(1).map((parent) => t(parent.title)).join(' › ');

    lines.push(row(inset + trail, 'accent'));
  }

  let group = '';

  for (const [index, item] of level.items.entries()) {
    if (root && item.label !== 'exit') {
      const section = ['build', 'development'].includes(item.label) ? 'developer' : 'application';

      if (section !== group) {
        if (group) {
          lines.push('');
        }

        lines.push(row(inset + t(`menuGroups.${section}`), 'muted'));
        group = section;
      }
    } else if (item.label === 'exit') {
      lines.push('');
    }

    const selected = index === level.selected;
    const prefix = inset + (selected ? '› ' : '  ');
    const suffix = (item.children ? '›' : selected ? '↵' : ' ') + inset;
    const titleWidth = Math.max(0, width - prefix.length - suffix.length - 1);
    const title = terminalText(t(item.label), titleWidth);
    const padding = Math.max(0, width - [...prefix + title + suffix].length);

    lines.push({
      selected,
      spans: [
        { text: prefix + title, tone: item.label === 'exit' ? 'muted' : 'text' },
        { text: ' '.repeat(padding) + suffix, tone: 'muted' },
      ],
    });
  }

  const description = t(level.items[level.selected]!.description);
  const fullNavigation = t(root ? 'rootNavigation' : 'navigation');
  const navigation = [...fullNavigation].length <= contentWidth
    ? fullNavigation : t(root ? 'compactRootNavigation' : 'compactNavigation');

  lines.push('');

  for (const text of terminalLines(description, contentWidth)) {
    lines.push(row(inset + text, 'muted'));
  }

  lines.push(rule);

  for (const text of terminalLines(navigation, contentWidth)) {
    lines.push(row(inset + text, 'muted'));
  }

  lines.push('');

  while (lines.length >= options.rows && lines.includes('')) {
    lines.splice(lines.indexOf(''), 1);
  }

  return lines;
}
