export interface PluginServerEntry {
  serverEntry: 'server.js' | 'server.ts' | null;
  serverError: string | null;
  hasServer: boolean;
}

/**
 * Скан и установщик выбирают один серверный вход по одинаковому правилу.
 * Наличие двух файлов требует исправления пакета, а не выбора по приоритету.
 */
export function selectPluginServerEntry(jsPresent: boolean, tsPresent: boolean): PluginServerEntry {
  if (jsPresent && tsPresent) {
    return {
      serverEntry: null,
      serverError: 'У плагина есть server.js и server.ts. Оставьте один серверный файл.',
      hasServer: true,
    };
  }

  return {
    serverEntry: jsPresent ? 'server.js' : tsPresent ? 'server.ts' : null,
    serverError: null,
    hasServer: jsPresent || tsPresent,
  };
}
