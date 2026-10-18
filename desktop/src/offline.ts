import { delayWithAbort } from '../../shared/lib/delay.ts';

import { probeGrigDesk } from '../../shared/runtime/grigDeskReadiness.ts';
import type { GrigDeskProbeOptions } from '../../shared/runtime/grigDeskReadiness.ts';

export type { GrigDeskProbeOptions } from '../../shared/runtime/grigDeskReadiness.ts';

export type GrigDeskWaitOptions = GrigDeskProbeOptions & {
  intervalMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

const OFFLINE_MESSAGE = 'Окно подключится само, как только сервер ответит. ' +
  'Если ожидание затянулось, выполните в терминале <code>grigdesk-ctl status</code>.';

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character);
}

/**
 * Локальная страница объясняет ожидание сервера без скриптов и внешних ресурсов.
 * Адрес выводится как экранированный текст, даже если caller передал недоверенную строку.
 */
export function offlineHtml(origin: string): string {
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Ждём сервер GrigDesk</title>
  <style>
    body {
      margin: 0;
      background: #0b0d11;
      color: #e4e7ed;
      font: 16px/1.6 system-ui, sans-serif;
    }
    body::before {
      content: '';
      position: fixed;
      inset: 0 0 auto;
      height: max(36px, env(titlebar-area-height, 0px));
      -webkit-app-region: drag;
    }
    main {
      max-width: 640px;
      margin: 15vh auto;
      padding: 24px;
    }
    .address {
      color: #aeb8c8;
      overflow-wrap: anywhere;
    }
  </style>
</head>
<body>
  <main>
    <h1>Ждём сервер GrigDesk</h1>
    <p class="address">${escapeHtml(origin)}</p>
    <p>${OFFLINE_MESSAGE}</p>
  </main>
</body>
</html>`;
}

/**
 * Весь документ помещается в data URL с явной кодировкой UTF-8.
 * Это позволяет показать ожидание, когда сам сервер ещё не отвечает.
 */
export function offlineUrl(origin: string): string {
  return 'data:text/html;charset=utf-8;base64,' + Buffer.from(offlineHtml(origin), 'utf8').toString('base64');
}

/**
 * Ответ считается готовностью только после проверки схемы JSON auth/state.
 * Таймаут и внешняя отмена ограничивают запрос, включая чтение тела ответа.
 */
export async function grigDeskAlive(
  origin: string,
  options: GrigDeskProbeOptions = {},
): Promise<boolean> {
  return (await probeGrigDesk(origin, options)) === 'grigdesk';
}

/**
 * Выполняет единственный последовательный цикл до ответа сервера или отмены.
 * Отмена во время запроса и сна завершает ожидание без необработанных исключений.
 */
export async function waitForGrigDesk(
  origin: string,
  options: GrigDeskWaitOptions = {},
): Promise<boolean> {
  while (!options.signal?.aborted) {
    const alive = await grigDeskAlive(origin, options);

    if (options.signal?.aborted) {
      return false;
    }

    if (alive) {
      return true;
    }

    try {
      await (options.sleep ?? delayWithAbort)(options.intervalMs ?? 2000, options.signal);
    } catch {
      return false;
    }
  }

  return false;
}
