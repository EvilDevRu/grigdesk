import type { Settings } from './commands.ts';
import { readLinks, readRelay } from './relay.ts';
import type { LinkStateName, RelayStatus } from './relay.ts';
import { readServer } from './server.ts';
import type { ServerState } from './server.ts';
import { readWindow } from './window.ts';
import type { WindowStateName } from './window.ts';
import type { TerminalTone } from './terminal.ts';
import { cliTranslator } from './i18n.ts';

export interface StatusSnapshot {
  server?: ServerState & { url: string };
  window?: { state: WindowStateName };
  relay?: RelayStatus;
}

type Words = Record<string, [string, number]>;

const serverWords: Words = {
  ready: ['Работает', 32],
  starting: ['Запускается', 33],
  stopping: ['Останавливается', 33],
  unknown: ['Неизвестно', 33],
  not_responding: ['Не отвечает', 31],
  failed: ['Упал', 31],
  conflict: ['Конфликт порта', 31],
  mismatch: ['Чужая служба', 31],
  stopped: ['Остановлен', 2],
  not_installed: ['Не установлен', 2],
};
const windowWords: Words = {
  open: ['Открыто', 32],
  closed: ['Закрыто', 2],
  not_installed: ['Не установлено', 2],
  unknown: ['Неизвестно', 33],
};
const relayWords: Words = {
  ready: ['Работает', 32],
  starting: ['Запускается', 33],
  ambiguous: ['Несколько контейнеров', 33],
  unhealthy: ['Не проходит проверку', 31],
  docker_unavailable: ['Docker недоступен', 31],
  stopped: ['Остановлен', 2],
  not_deployed: ['Не развёрнут', 2],
};
const linkWords: Record<LinkStateName, string> = {
  online: 'на связи',
  connecting: 'подключается',
  waiting_vpn: 'ждёт VPN',
  offline: 'нет связи',
  error: 'ошибка',
  unknown: 'неизвестно',
};

/**
 * Меню и подробный экран одинаково различают рабочие, переходные и ошибочные состояния.
 * Остановка или отсутствие установки остаются спокойными состояниями с явным текстом.
 */
export function statusTone(state: string): TerminalTone {
  if (['ready', 'open', 'online'].includes(state)) {
    return 'success';
  }

  if (['failed', 'conflict', 'mismatch', 'not_responding', 'unhealthy', 'docker_unavailable',
    'error'].includes(state)) {
    return 'error';
  }

  return ['starting', 'stopping', 'unknown', 'ambiguous', 'connecting', 'waiting_vpn'].includes(state)
    ? 'warning' : 'muted';
}

/**
 * Причины из внешних журналов не управляют терминалом и не создают новых строк.
 * Кириллица и прочие печатные символы сохраняются в тексте и JSON.
 */
export function printable(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?');
}

/**
 * Служба, профиль окна и контейнер читаются одновременно без изменяющих действий.
 * Связи запрашиваются только после положительной проверки схемы самого сервера.
 */
export async function collectStatus(
  root: string,
  settings: Settings,
  env: NodeJS.ProcessEnv,
): Promise<StatusSnapshot> {
  const [server, window, relay] = await Promise.all([
    readServer(root, settings),
    readWindow(root, env),
    readRelay(root, settings),
  ]);

  relay.links = server.state === 'ready' ? await readLinks(settings) : null;

  return {
    server,
    window: { state: window },
    relay,
  };
}

/**
 * Одна строка сохраняет фиксированную ширину подписи и состояния без учёта ANSI.
 * Внешние причины и имена очищаются перед добавлением в терминальную строку.
 */
function row(label: string, words: [string, number], detail: string | null, color: boolean): string {
  const [word, code] = words;
  const icon = code === 2 ? '○' : code === 33 ? '◐' : '●';
  const phrase = `${icon} ${word}`;
  const plain = phrase.padEnd(Math.max(20, phrase.length + 1));
  const marker = color ? `\x1b[${code}m${plain}\x1b[0m` : plain;

  return `  ${label.padEnd(12)}${marker}${printable(detail ?? '')}`.trimEnd();
}

/**
 * Форматирует только присутствующие компоненты и их относящиеся подсказки.
 * Цвет задаётся caller явно, поэтому pipe и JSON не получают ANSI автоматически.
 */
export function renderText(snapshot: StatusSnapshot, options: { color: boolean }): string {
  const { server, window, relay } = snapshot;
  const lines: string[] = server && window && relay ? ['GrigDesk', ''] : [];
  const hints = statusHints(snapshot);

  if (server) {
    const detail = server.reason ?? (server.state === 'ready' ? server.url : '');

    lines.push(row('Сервер', serverWords[server.state]!, detail, options.color));

  }

  if (window) {
    lines.push(row('Окно', windowWords[window.state]!, null, options.color));

  }

  if (relay) {
    lines.push(row('Посредник', relayWords[relay.state]!, relay.reason ?? relay.container, options.color));

    if (relay.links) {
      const links = relay.links.map((link) => `${printable(link.name)} — ${linkWords[link.state]}`);

      lines.push('  ' + ''.padEnd(12) + 'связь: ' + links.join('; '));
    }

  }

  return lines.join('\n') + (hints.length ? '\n\n  ' + [...new Set(hints)].join('\n  ') : '') + '\n';
}

/**
 * Машинный текст и терминальный экран используют одни и те же подсказки восстановления.
 * Они вычисляются из снимка, не запрашивая состояние повторно и не меняя систему.
 */
export function statusHints(
  snapshot: StatusSnapshot, t = cliTranslator({}).t,
): string[] {
  const { server, window, relay } = snapshot;
  const hints: string[] = [];

  if (server) {
    if (['stopped', 'failed'].includes(server.state)) {
      hints.push(t('screens.hints.startServer'));
    }

    if (['not_responding', 'failed'].includes(server.state) || server.state === 'starting' && server.reason) {
      hints.push(t('screens.hints.serverLog'));
    }

    if (server.state === 'not_installed') {
      hints.push(t('screens.hints.installServer'));
    }
  }

  if (window?.state === 'not_installed') {
    hints.push(t('screens.hints.installWindow'));
  } else if (window?.state === 'closed') {
    hints.push(t('screens.hints.openWindow'));
  }

  if (relay?.state === 'stopped') {
    hints.push(t('screens.hints.startRelay'));
  } else if (relay?.state === 'unhealthy') {
    hints.push(t('screens.hints.relayLog'));
  } else if (relay?.state === 'ambiguous') {
    hints.push(t('screens.hints.selectRelay'));
  }

  return [...new Set(hints)];
}

/**
 * Один снимок становится одним JSON-документом с конечным переводом строки.
 * Поля копируются явно и очищаются, поэтому случайные внутренние данные не выводятся.
 */
export function toJson(snapshot: StatusSnapshot): string {
  const result: StatusSnapshot = {};

  if (snapshot.server) {
    const server = snapshot.server;

    result.server = {
      state: server.state,
      managed: server.managed,
      url: server.url,
      reason: server.reason === null ? null : printable(server.reason),
    };
  }

  if (snapshot.window) {
    result.window = { state: snapshot.window.state };
  }

  if (snapshot.relay) {
    const relay = snapshot.relay;

    result.relay = {
      state: relay.state,
      container: relay.container === null ? null : printable(relay.container),
      reason: relay.reason === null ? null : printable(relay.reason),
      links: relay.links?.map((link) => ({
        name: printable(link.name),
        state: link.state,
      })) ?? null,
    };
  }

  return JSON.stringify(result) + '\n';
}
