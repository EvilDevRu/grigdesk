import path from 'node:path';

/**
 * Источник интерфейса выбирается до проверки manifest и запуска локальной трубы.
 * Тестовая подмена предназначена только для dev Electron, готовый пакет автономен.
 */
export function clientUiDirectory(options: {
  packaged: boolean;
  resources: string;
  source: string;
  override?: string;
}): string {
  const directory = options.packaged ? options.resources : options.source;

  return (!options.packaged && options.override) || path.join(directory, 'ui');
}
