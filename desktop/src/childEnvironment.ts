const PACKAGED_ENV_KEYS = new Set([
  'APPDIR', 'APPIMAGE', 'ARGV0', 'OWD', 'APPIMAGE_EXTRACT_AND_RUN',
  'CHROME_DESKTOP', 'FC_FONTATIONS', 'INVOCATION_ID', 'JOURNAL_STREAM',
  'SYSTEMD_EXEC_PID', 'MANAGERPID', 'NOTIFY_SOCKET', 'LISTEN_PID', 'LISTEN_FDS',
  'LISTEN_FDNAMES', 'CLAUDECODE', 'GRIGDESK_DESKTOP_DATA_DIR',
]);
const PACKAGED_PATH_KEYS = ['PATH', 'LD_LIBRARY_PATH', 'XDG_DATA_DIRS', 'GSETTINGS_SCHEMA_DIR'];

/**
 * AppImage библиотеки и schemas не переходят в системный browser/server child.
 * Снимок копируется, а признаки окружения графического сеанса восстанавливаются.
 */
export function cleanDesktopChildEnvironment(source: NodeJS.ProcessEnv,
  appDir?: string | null,
): Record<string, string> {
  const env: Record<string, string> = Object.fromEntries(Object.entries(source)
    .filter((entry): entry is [string, string] => entry[1] !== undefined));
  const appDirs = [env.APPDIR, appDir].filter((value): value is string => Boolean(value));

  for (const key of Object.keys(env)) {
    if (PACKAGED_ENV_KEYS.has(key) || key.startsWith('ELECTRON_')) {
      delete env[key];
    }
  }

  if (appDirs.length > 0) {
    for (const key of PACKAGED_PATH_KEYS) {
      const value = env[key];

      if (value === undefined) {
        continue;
      }

      const filtered = value.split(':')
        .filter((entry) => !appDirs.some((root) => entry === root || entry.startsWith(`${root}/`)))
        .join(':');

      if (filtered) {
        env[key] = filtered;
      } else {
        delete env[key];
      }
    }
  }

  if (env.ORIGINAL_XDG_CURRENT_DESKTOP !== undefined) {
    env.XDG_CURRENT_DESKTOP = env.ORIGINAL_XDG_CURRENT_DESKTOP;
    delete env.ORIGINAL_XDG_CURRENT_DESKTOP;
  }

  return env;
}
