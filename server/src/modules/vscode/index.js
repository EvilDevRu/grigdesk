// Модуль «VS Code» — реверс-прокси на `code serve-web` + управление процессом.
// serve-web слушает 127.0.0.1 (наружу не торчит); кокпит проксирует /vscode на тот же origin,
// чтобы редактор встраивался в iframe без cross-origin и доставался с планшета через Tailscale.
import fp from 'fastify-plugin';
import httpProxy from '@fastify/http-proxy';

async function vscodeModule(fastify, opts) {
  const { vscode, config } = opts;

  // Статус serve-web (running/booting) — для экрана «Код».
  fastify.get('/api/vscode/status', async () => vscode.status());

  // Гарантировать запуск (ленивый старт по заходу в раздел). Идемпотентно.
  fastify.post('/api/vscode/ensure', async () => vscode.ensure());

  // Реверс-прокси. rewritePrefix = /vscode (НЕ срезаем): serve-web поднят с --server-base-path
  // /vscode, поэтому и его ассеты, и наши запросы живут под одним префиксом.
  await fastify.register(httpProxy, {
    upstream: `http://127.0.0.1:${config.vscodePort}`,
    prefix: config.vscodeBasePath,        // /vscode
    rewritePrefix: config.vscodeBasePath, // /vscode
    websocket: true,                      // VS Code гоняет WebSocket
    replyOptions: {
      // Отдаём как есть; ошибки апстрима (не поднят) — 502.
      onError: (reply, { error }) => { reply.code(502).send({ error: 'vscode_down', message: error?.message || 'serve-web недоступен' }); },
    },
  });
}

export default fp(vscodeModule, { name: 'module-vscode' });
