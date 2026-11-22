import { promises as fs } from 'node:fs';

// Синхронизирует каталог после атомарной замены файла там, где это поддерживает Node.
// На Windows файл уже синхронизирован; Node не открывает каталог для FlushFileBuffers.
export async function syncRoutesDirectory(directory: string, open: typeof fs.open = fs.open): Promise<void> {
  if (process.platform === 'win32') {
    return;
  }

  const handle = await open(directory, 'r');

  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
