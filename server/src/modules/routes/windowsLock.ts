import { lstatSync, promises as fs } from 'node:fs';
import { createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

import { sha256 } from '../../../../shared/node/hash.ts';
import { RoutesError } from './schema.ts';

// Запрашивает первый экземпляр именованного канала через libuv.
// Канал служит только замком. Входящие подключения сразу закрываются.
async function listenOnce(name: string) {
  const server = createServer({ pauseOnConnect: true }, (socket) => socket.destroy());

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ path: name, exclusive: true }, resolve);
  });

  return server;
}

// Канал привязан к физическому каталогу и живёт в процессе RoutesStore.
// Windows освобождает его при падении процесса, поэтому перехват по PID не нужен.
export async function acquireWindowsCatalogLock(catalogDir: string, timeoutMs: number) {
  const identity = await fs.lstat(catalogDir, { bigint: true });
  const isCurrentDirectory = () => {
    const current = lstatSync(catalogDir, { bigint: true });

    return current.isDirectory() && current.dev === identity.dev && current.ino === identity.ino;
  };

  if (!identity.isDirectory() || identity.ino === 0n) {
    throw new RoutesError('ROUTES_V2_LOCK_UNAVAILABLE', 'Каталогу маршрутов нужен постоянный файловый ID');
  }

  const hash = sha256(`${identity.dev}:${identity.ino}`);
  const name = `\\\\.\\pipe\\grigdesk-routes-${hash}`;
  const deadline = performance.now() + Math.max(1, timeoutMs);
  let server: Awaited<ReturnType<typeof listenOnce>>;

  for (;;) {
    try {
      server = await listenOnce(name);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') {
        throw new RoutesError('ROUTES_V2_LOCK_UNAVAILABLE', 'Замок маршрутов Windows недоступен');
      }

      const remaining = deadline - performance.now();

      if (remaining <= 0) {
        throw new RoutesError('ROUTES_V2_LOCKED', 'Другой процесс обновляет каталог');
      }

      await sleep(Math.min(50, remaining));
    }
  }

  let released = false;
  let lost = false;

  server.on('error', () => { lost = true; });
  server.unref();

  return {
    assertHeld() {
      try {
        if (!released && !lost && server.listening && isCurrentDirectory()) {
          return;
        }
      } catch {
        // Замена либо исчезновение каталога отзывают допуск.
      }

      throw new RoutesError('ROUTES_V2_LOCK_LOST', 'Каталог маршрутов изменился под замком');
    },
    async release() {
      if (released) {
        return;
      }

      released = true;
      await new Promise<void>((resolve, reject) => server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      }));
    },
  };
}
