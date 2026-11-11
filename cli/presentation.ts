import path from 'node:path';

import { runCli } from './commands.ts';
import { cliTranslator } from './i18n.ts';
import type { CliOutput, DeviceOutput, PairingOutput } from './output.ts';
import { showScreen } from './screen.ts';
import type { ScreenLine } from './screen.ts';
import { statusHints, statusTone } from './status.ts';
import type { StatusSnapshot } from './status.ts';
import { runAttached } from './system.ts';
import { TerminalSession, terminalLines } from './terminal.ts';
import { renderTerminalQr } from './terminalQr.ts';

type Translate = ReturnType<typeof cliTranslator>['t'];

/**
 * Название показывает тип действия, не включая имя устройства, id или иные аргументы данных.
 * Неизвестная команда получает общий заголовок, а её ошибка остаётся текстом результата.
 */
function commandTitle(argv: readonly string[], t: Translate): string {
  if (argv.includes('--help') || argv.includes('-h')) {
    return t('screens.help');
  }

  if (argv.includes('--version')) {
    return t('screens.version');
  }

  const name = argv[0] ?? '';
  const key = name === 'device' ? 'devices' : name === 'artifacts-cleanup' ? 'artifactsCleanup' : name;
  const known = ['open', 'status', 'server', 'relay', 'devices', 'dev', 'deps', 'run',
    'artifactsCleanup'].includes(key);

  if (!known) {
    return t('screens.command');
  }

  const action = argv[1];
  const nested = ['server', 'relay', 'device'].includes(name)
    && ['start', 'stop', 'restart', 'logs', 'status', 'add', 'list', 'revoke'].includes(action ?? '');

  return t(key) + (nested ? ` › ${t(action!)}` : '');
}

/**
 * Подробный статус показывает компоненты и их причины отдельными читаемыми блоками.
 * Подсказки берутся из того же снимка, который используется прежним текстовым выводом.
 */
function statusLines(snapshot: StatusSnapshot, t: Translate): ScreenLine[] {
  const lines: ScreenLine[] = [];

  /**
   * Компонент получает одну строку состояния и отдельные строки подробностей.
   * Текст данных не используется как название стиля или ключ перевода.
   */
  const append = (label: string, state: string, details: string[], phrase?: string) => {
    const tone = statusTone(state);
    const marker = tone === 'error' ? '✗' : tone === 'success' ? '●' : '○';
    const extra = ['ambiguous', 'unhealthy', 'docker_unavailable', 'not_deployed', 'online',
      'connecting', 'waiting_vpn', 'offline', 'error'].includes(state);
    const word = phrase ?? t(extra ? `screens.states.${state}` : `states.${state}`);

    lines.push({ text: `${label}  ${marker} ${word}`, tone });

    for (const detail of details.filter(Boolean)) {
      lines.push({ text: '  ' + detail, tone: 'muted' });
    }

    lines.push({ text: '' });
  };

  if (snapshot.server) {
    const server = snapshot.server;

    append(t('server'), server.state, [server.reason ?? '', server.url]);
  }

  if (snapshot.window) {
    const state = snapshot.window.state;

    append(t('screens.window'), state, [],
      state === 'not_installed' ? t('screens.windowMissing') : undefined);
  }

  if (snapshot.relay) {
    const relay = snapshot.relay;

    append(t('relay'), relay.state, [relay.reason ?? '', relay.container ?? '']);

    if (relay.links?.length) {
      lines.push({ text: t('screens.links'), tone: 'accent' });

      for (const link of relay.links) {
        append(link.name, link.state, []);
      }
    }
  }

  const hints = statusHints(snapshot, t);

  if (hints.length) {
    lines.push({ text: t('screens.next'), tone: 'accent' });
    lines.push(...hints.map((text) => ({ text, tone: 'muted' as const })));
  }

  return lines;
}

/**
 * Список устройств разделяет имя и служебные поля, сохраняя весь id для действий.
 * Пустой список имеет явный результат вместо пустого экрана после успешного запроса.
 */
function deviceLines(devices: readonly DeviceOutput[], t: Translate): ScreenLine[] {
  if (!devices.length) {
    return [{ text: t('screens.noDevices'), tone: 'muted' }];
  }

  return devices.flatMap((device) => [
    { text: device.name, tone: 'accent' as const },
    { text: t('screens.deviceId', { id: device.id }), tone: 'muted' as const },
    { text: t('screens.deviceScope', { scope: device.scope }), tone: 'muted' as const },
    { text: t(device.revokedAt ? 'screens.revoked' : 'screens.active'), tone: 'muted' as const },
    { text: '' },
  ]);
}

/**
 * QR сохраняет матрицу и светлое поле без переноса модулей на соседнюю строку.
 * Если окно мало, остаётся полная строка привязки и точная подсказка нужного размера.
 */
function pairingLines(pairing: PairingOutput, width: number, rows: number, t: Translate): ScreenLine[] {
  const qr = renderTerminalQr(pairing.qr.rows, false).slice(0, -1).split('\n');
  const columns = pairing.qr.rows.length + 8;
  const requiredRows = qr.length + terminalLines(pairing.text, width).length + 14;
  const fits = columns <= width && requiredRows <= rows;
  const lines: ScreenLine[] = [{ text: t('screens.scanQr'), tone: 'muted' }, { text: '' }];

  if (fits) {
    lines.push(...qr.map((text) => ({ text, paper: true })));
  } else {
    lines.push({
      text: t('screens.qrSize', { columns: columns + 5, rows: requiredRows }),
      tone: 'warning',
    });
  }

  lines.push({ text: '' }, { text: pairing.text }, { text: t('screens.pairingExpiry'), tone: 'muted' });

  return lines;
}

/**
 * Единый экран принимает вывод команды без подмены глобальных потоков процесса.
 * История ограничена, длинные результаты меню доступны клавишами просмотра.
 */
export async function runPresentedCommand(
  root: string, argv: readonly string[], parent?: TerminalSession,
): Promise<number> {
  const session = parent ?? new TerminalSession();
  const { t } = cliTranslator();
  const title = commandTitle(argv, t);
  const lines: ScreenLine[] = [];
  const pending = { output: '', error: '' };
  let structured: ((width: number) => ScreenLine[]) | undefined;
  let dropped = 0;
  let minimumWidth = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const content = (width: number): ScreenLine[] => structured ? structured(width) : [
    ...dropped ? [{ text: t('screens.omitted', { count: dropped }), tone: 'muted' as const }] : [],
    ...lines,
    ...pending.output ? [{ text: pending.output }] : [],
    ...pending.error ? [{ text: pending.error, tone: 'muted' as const }] : [],
  ];
  const running = () => showScreen(session, {
    title,
    state: { text: t('screens.running'), tone: 'accent' },
    lines: content,
    footer: t('screens.cancel'),
    minimumWidth,
    follow: true,
  });
  const refresh = () => {
    if (!timer && process.env.TERM !== 'dumb') {
      timer = setTimeout(() => {
        timer = undefined;
        running();
      }, 40);
    }
  };

  /**
   * Потоки декодируются отдельно, поэтому неполная строка stdout не смешивается со stderr.
   * На экране управляющие последовательности очищаются общим рендером, в pipe их формат прежний.
   */
  const receive = (text: string, error = false): void => {
    const channel = error ? 'error' : 'output';
    const parts = (pending[channel] + text).split(/\r\n|\r|\n/u);

    pending[channel] = parts.pop()!.slice(-4096);

    for (const part of parts) {
      lines.push({ text: part.slice(-4096), tone: error ? 'muted' : 'text' });
    }

    if (lines.length > 5000) {
      const excess = lines.length - 5000;

      lines.splice(0, excess);
      dropped += excess;
    }

    if (process.env.TERM === 'dumb') {
      const width = Math.max(1, session.columns - 1);

      session.output.write(text.split(/\r\n|\r|\n/u)
        .flatMap((line) => terminalLines(line, width)).join('\n') + '\n');
    }

    refresh();
  };
  const output: CliOutput = {
    write: (text) => receive(text),
    error: (text) => receive(text, true),
    attached: (command, args, env) => runAttached(command, args, env, receive),
    status: (snapshot) => {
      structured = () => statusLines(snapshot, t);
      refresh();
    },
    devices: (devices) => {
      structured = () => deviceLines(devices, t);
      refresh();
    },
    pairing: (pairing) => {
      minimumWidth = pairing.qr.rows.length + 12;
      structured = (width) => pairingLines(pairing, width, session.rows, t);
      refresh();
    },
  };

  /**
   * Во время действия ввод возвращается в cooked-режим для прежнего поведения Ctrl+C.
   * Финальный экран прямой команды не ждёт клавиш и сохраняет исходный код завершения.
   */
  const action = async (): Promise<number> => {
    session.suspend();
    running();

    let code: number;

    try {
      code = ['dev', 'deps', 'run'].includes(argv[0] ?? '')
        ? await output.attached('/bin/bash', [path.join(root, 'bin/grigdesk-ctl'), ...argv])
        : await runCli(argv, output);
    } catch (error) {
      receive(error instanceof Error ? error.message : String(error), true);
      code = 1;
    } finally {
      clearTimeout(timer);
      session.resume();
    }

    const full = !parent || ['open', 'dev', 'run'].includes(argv[0] ?? '');

    showScreen(session, {
      title,
      state: {
        text: code === 0 ? t('screens.done') : t('screens.failed', { code }),
        tone: code === 0 ? 'success' : 'error',
      },
      lines: content,
      minimumWidth,
      footer: parent && !full ? t('screens.resultNavigation') : undefined,
      full,
    });

    return code;
  };

  return parent ? action() : session.run(action);
}
