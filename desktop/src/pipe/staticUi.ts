import { createReadStream } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { verifyUiRelease } from '../uiRelease.ts';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

/**
 * Доверяем только целому пакету, проверенному по полному manifest при запуске.
 * Неизвестный маршрут не превращается в SPA-fallback и не уходит к машине.
 */
export async function staticUi(directory: string) {
  const release = await verifyUiRelease(directory);
  const files = new Map(release.files.map((file) => [`/${file.path}`, file]));

  return (req: IncomingMessage, res: ServerResponse) => {
    const pathname = new URL(req.url || '/', 'http://pipe').pathname;
    const file = files.get(pathname === '/' ? '/index.html' : pathname);

    if (!file || !['GET', 'HEAD'].includes(req.method || '')) {
      res.writeHead(404).end();

      return;
    }

    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file.path)] || 'application/octet-stream',
      'Content-Length': file.size,
      'Cache-Control': file.path === 'index.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    });

    if (req.method === 'HEAD') {
      res.end();
    } else {
      createReadStream(path.join(directory, file.path)).on('error', () => res.destroy()).pipe(res);
    }
  };
}
