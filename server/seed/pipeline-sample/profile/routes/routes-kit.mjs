import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Предпочитает предоставленный runtime модуль схемы и публикации.
 * В исходниках находит физический корень кода без зависимости от относительной глубины профиля.
 */
function kitPath() {
  if (process.env.GRIGDESK_ROUTES_KIT) {
    const file = process.env.GRIGDESK_ROUTES_KIT;

    if (!path.isAbsolute(file)) {
      throw new Error('GRIGDESK_ROUTES_KIT должен быть абсолютным');
    }

    return file;
  }

  let root = path.dirname(fileURLToPath(import.meta.url));

  while (path.dirname(root) !== root) {
    const file = path.join(root, 'server/src/modules/routes/publishKit.ts');

    if (existsSync(path.join(root, 'VERSION')) && existsSync(file)) {
      return file;
    }

    root = path.dirname(root);
  }

  throw new Error('Задайте GRIGDESK_ROUTES_KIT из комплекта сервера');
}

export const kit = await import(pathToFileURL(kitPath()).href);
