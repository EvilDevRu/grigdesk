import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { desktopCommand } from './desktopEntry.ts';
import { desktopText } from './locale.ts';

interface IntegrationOptions {
  isPortable: boolean;
  windowPath: string;
  userData: string;
  home: string;
  env: NodeJS.ProcessEnv;
  shown: Promise<unknown>;
  ask(): Promise<boolean>;
  reportError(error: unknown): void;
  fs?: typeof fs;
}

/**
 * Отказ и согласие запоминаются один раз в профиле окна после показа главного документа.
 * Только свой новый пользовательский ярлык создаётся эксклюзивно, чужой файл остаётся целым.
 */
export async function offerPortableIntegration(options: IntegrationOptions): Promise<void> {
  if (!options.isPortable) {
    return;
  }

  const files = options.fs ?? fs;
  const marker = path.join(options.userData, 'portable-menu.json');
  let temporary: string | undefined;

  try {
    await options.shown;

    if (await files.stat(marker).catch(() => null)) {
      return;
    }

    const accepted = await options.ask();

    await files.mkdir(options.userData, { recursive: true, mode: 0o700 });
    temporary = `${marker}.${randomUUID()}.tmp`;
    await files.writeFile(temporary, JSON.stringify({ accepted }) + '\n', { mode: 0o600, flag: 'wx' });
    await files.rename(temporary, marker);

    if (!accepted) {
      return;
    }

    if (!path.isAbsolute(options.windowPath) || /[\r\n\0]/u.test(options.windowPath)) {
      throw new Error(desktopText('desktop.desktopNekorrektnyyPutOknaDlya'));
    }

    const xdg = options.env.XDG_DATA_HOME;
    const directory = path.join(xdg && path.isAbsolute(xdg)
      ? xdg : path.join(options.home, '.local/share'), 'applications');

    await files.mkdir(directory, { recursive: true, mode: 0o755 });
    await files.writeFile(path.join(directory, 'grigdesk-portable.desktop'), [
      '[Desktop Entry]',
      'Type=Application',
      'Name=GrigDesk',
      `Exec=${desktopCommand(options.windowPath)}`,
      'Terminal=false',
      'Categories=Development;',
      '',
    ].join('\n'), { mode: 0o644, flag: 'wx' });
  } catch (error) {
    options.reportError(error);
  } finally {
    if (temporary) {
      await files.rm(temporary, { force: true });
    }
  }
}
