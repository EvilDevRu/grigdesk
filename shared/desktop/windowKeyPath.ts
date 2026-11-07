export interface WindowKeyPathInput {
  env: Record<string, string | undefined>;
  uid: number | undefined;
  port: number;
}

/**
 * Нормализует абсолютный POSIX-путь без зависимости от Node в общем слое.
 * Поведение точек и повторных слэшей совпадает у сервера и главного процесса окна.
 */
function normalizedPath(value: string): string {
  const parts: string[] = [];

  for (const part of value.split('/')) {
    if (part === '' || part === '.') {
      continue;
    }

    if (part === '..') {
      parts.pop();
    } else {
      parts.push(part);
    }
  }

  return '/' + parts.join('/');
}

/**
 * Общий путь связывает сервер и окно без чтения окружения внутри resolver.
 * Некорректное явное значение закрывает вход по ключу без перехода к default.
 */
export function windowKeyPath({ env, uid, port }: WindowKeyPathInput): string | null {
  if (typeof uid !== 'number' || !Number.isInteger(uid) || uid < 0
    || !Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }

  const override = env.GRIGDESK_WINDOW_KEY_PATH;

  if (override !== undefined) {
    const name = override.split('/').at(-1);

    return override.startsWith('/') && !override.endsWith('/') && !override.includes('\0')
      && name !== '.' && name !== '..' ? override : null;
  }

  const runtime = env.XDG_RUNTIME_DIR;

  if (runtime !== undefined && (!runtime.startsWith('/') || runtime.includes('\0'))) {
    return null;
  }

  return normalizedPath(`${runtime ?? `/run/user/${uid}`}/grigdesk/window-key-${port}`);
}

