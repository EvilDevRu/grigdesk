import net from 'node:net';
import { lstat, mkdir, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';

/**
 * Проверка listener не посылает application request и не предъявляет чужой token.
 * Только ECONNREFUSED доказывает stale socket; timeout/permission остаются отказом.
 */
function listening(file: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(file);
    const timer = setTimeout(() => socket.destroy(new Error('browser_socket_busy')), 300);

    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ECONNREFUSED') {
        resolve(false);
      } else {
        reject(new Error('browser_socket_busy'));
      }
    });
    socket.once('close', () => clearTimeout(timer));
  });
}

/**
 * Socket живёт в private физическом каталоге текущего UID, не в рабочем дереве.
 * Живой listener, symlink и чужой inode не удаляются ради старта нового сервера.
 */
export async function prepareBrowserSocket(file: string): Promise<void> {
  const directory = path.dirname(file);

  if (!path.isAbsolute(file) || Buffer.byteLength(file) > 100 || path.basename(file) !== 'relay.sock') {
    throw new Error('browser_socket_invalid');
  }

  await mkdir(directory, { recursive: true, mode: 0o700 });

  const parent = await lstat(directory);

  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) !== 0
    || (process.getuid && parent.uid !== process.getuid()) || await realpath(directory) !== directory) {
    throw new Error('browser_socket_invalid');
  }

  const before = await lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') {
      throw error;
    }

    return null;
  });

  if (!before) {
    return;
  }

  if (!before.isSocket() || before.isSymbolicLink() || (process.getuid && before.uid !== process.getuid())
    || await listening(file)) {
    throw new Error('browser_socket_busy');
  }

  const after = await lstat(file);

  if (before.ino !== after.ino || before.dev !== after.dev) {
    throw new Error('browser_socket_busy');
  }

  await unlink(file);
}
