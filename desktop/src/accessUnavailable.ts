const UNAVAILABLE_MESSAGE = 'Не удалось войти по локальному ключу. Окно повторяет попытку само.';

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
 * Локальная страница отказа объясняет повтор без скриптов и внешних ресурсов.
 * Адрес выводится экранированным текстом, даже если caller передал недоверенную строку.
 */
export function accessUnavailableHtml(origin: string): string {
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Нет входа в GrigDesk</title>
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
    <h1>Нет входа в GrigDesk</h1>
    <p class="address">${escapeHtml(origin)}</p>
    <p>${UNAVAILABLE_MESSAGE}</p>
  </main>
</body>
</html>`;
}

/**
 * Весь документ помещается в data URL с явной кодировкой UTF-8: страницу отказа
 * показывают и тогда, когда сервер отвечает, но сессию выдать не может.
 */
export function accessUnavailableUrl(origin: string): string {
  return 'data:text/html;charset=utf-8;base64,'
    + Buffer.from(accessUnavailableHtml(origin), 'utf8').toString('base64');
}
