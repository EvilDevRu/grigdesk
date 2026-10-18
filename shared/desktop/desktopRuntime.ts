export type RuntimeDescriptor = {
  version: 1;
  root: string;
  node: string;
} | {
  version: 2;
  root: string;
  node: string;
  home: string;
};

export type EnvMap = Record<string, string | undefined>;

/**
 * Выбирает путь описания установки из переданного окружения.
 * Домашний каталог задаёт вызывающий код, общий слой не читает окружение процесса.
 */
export function desktopRuntimePath(input: { env: EnvMap; home: string }): string {
  const dataHome = input.env.XDG_DATA_HOME;
  const base = dataHome?.startsWith('/') ? dataHome : `${input.home}/.local/share`;

  return `${base}/grigdesk/desktop/runtime.json`;
}

/**
 * Разбирает только описание установки известной версии и формы.
 * Непригодные данные возвращаются как отсутствие runtime, без побочных эффектов.
 */
export function parseRuntimeDescriptor(text: string): RuntimeDescriptor | null {
  let value: unknown;

  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }

  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const descriptor = value as Record<string, unknown>;

  const version = descriptor.version;
  const validVersion = version === 1 || version === 2;

  if (!validVersion || Object.keys(descriptor).length !== (version === 2 ? 4 : 3)
    || typeof descriptor.root !== 'string' || typeof descriptor.node !== 'string'
    || !descriptor.root.startsWith('/') || !descriptor.node.startsWith('/')
    || descriptor.root.includes('\0') || descriptor.node.includes('\0')) {
    return null;
  }

  if (version === 2) {
    if (typeof descriptor.home !== 'string' || !descriptor.home.startsWith('/')
      || descriptor.home.includes('\0')) {
      return null;
    }

    return {
      version,
      root: descriptor.root,
      node: descriptor.node,
      home: descriptor.home
    };
  }

  return {
    version: 1,
    root: descriptor.root,
    node: descriptor.node
  };
}

/**
 * Наличие ключа в окружении важнее значения в файле конфигурации.
 * Пустая строка и undefined не подменяются значением файла.
 */
export function effectiveValue(env: EnvMap, file: Record<string, string>, key: string): string | undefined {
  return Object.hasOwn(env, key) ? env[key] : file[key];
}

/**
 * Вычисляет порт по тем же правилам, что и настройки CLI.
 * Отсутствующее или нечисловое значение выбирает стандартный порт.
 */
export function effectivePort(env: EnvMap, file: Record<string, string>): number {
  return Number(effectiveValue(env, file, 'GRIGDESK_PORT')) || 8140;
}

/**
 * Даёт координатору сервера время на слив и дополнительный запас.
 * Даже короткий настроенный срок не уменьшает ожидание ниже 45 секунд.
 */
export function stopGraceMs(env: EnvMap, file: Record<string, string>): number {
  const configured = Number(effectiveValue(env, file, 'GRIGDESK_SHUTDOWN_TIMEOUT_MS')) || 30_000;

  return Math.max(45_000, configured + 15_000);
}
