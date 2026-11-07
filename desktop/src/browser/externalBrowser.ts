import { browserUrl } from '../../../shared/browser/browserContract.ts';

export interface ExternalBrowserPort {
  system(url: string): Promise<unknown>;
  resolve(id: string): Promise<{ command: string; args: string[] } | null>;
  spawn(command: string, args: string[]): Promise<unknown>;
}

/**
 * Явно выбранное приложение не заменяется системным молча после удаления.
 * Запуск получает массив аргументов; строка URL не становится shell-кодом.
 */
export async function openExternalBrowser(port: ExternalBrowserPort, id: string, value: unknown) {
  const url = browserUrl(value);

  if (id === 'system') {
    await port.system(url);

    return;
  }

  const application = await port.resolve(id);

  if (!application) {
    throw new Error('browser_app_missing');
  }

  await port.spawn(application.command, [...application.args, url]);
}
