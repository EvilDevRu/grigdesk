export type DataHomeEnv = Readonly<Record<string, string | undefined>>;

export interface DataHomeInput {
  env: DataHomeEnv;
  home: string;
}

export const DATA_LAYOUT = {
  env: '.env',
  state: 'state',
  log: 'state/grigdesk-server.log',
  cliToken: 'state/cli-token',
  lock: 'state/server.lock',
  pluginData: 'state/plugins',
  uiReleases: 'state/ui-releases',
  mobileApk: 'state/mobile-apk',
  mediaVenv: 'state/media-venv',
  mediaHf: 'state/hf',
  mobile: 'mobile',
  chats: 'chats',
  telegram: 'telegram',
  github: 'github',
  studio3d: '3d',
  agents: 'agents',
  plugins: 'plugins',
  artifacts: 'artifacts',
  moveJournal: '.move-journal.json',
  moveLock: '.move-lock',
} as const;

export type DataLayoutKey = keyof typeof DATA_LAYOUT;

const PATH_ERROR = 'GRIGDESK_HOME должен быть абсолютным путём из латинских букв, цифр и символов '
  + '. _ + - / @ , = : — получено: ';

/**
 * Проверяет общий алфавит путей для Node, bash, systemd и писателя настроек.
 * Точки в сегментах не разрешаются даже тогда, когда их могла бы свернуть файловая система.
 */
function validPath(value: string): boolean {
  return value.startsWith('/') && value !== '/' && /^[A-Za-z0-9._+/@,=:\-]+$/.test(value)
    && !value.split('/').some((part) => part === '.' || part === '..');
}

/**
 * Вычисляет папку без чтения окружения или файловой системы.
 * Умолчание проходит ту же проверку, что явный путь, и даёт подсказку при отказе.
 */
export function dataHome({ env, home }: DataHomeInput): string {
  const override = env.GRIGDESK_HOME;
  const source = override || `${home.replace(/\/+$/, '')}/.grigdesk`;
  const result = source.replace(/\/+$/, '');

  if ((!override && (!home || !home.startsWith('/'))) || !validPath(result)) {
    throw new Error(PATH_ERROR + (override || home) + (!override ? '; задайте GRIGDESK_HOME' : ''));
  }

  return result;
}

/**
 * Переданный ребёнку путь умолчания сохраняет неявность папки.
 * Поэтому канонический экспорт сервера не отключает сторож старой раскладки у детей.
 */
export function dataHomeExplicit(input: DataHomeInput): boolean {
  const resolved = dataHome(input);

  return Boolean(input.env.GRIGDESK_HOME) && resolved !== `${input.home.replace(/\/+$/, '')}/.grigdesk`;
}

/**
 * Собирает путь только по общей раскладке, без привязки к дереву кода.
 * Вызывающий передаёт уже проверенный или канонический путь папки данных.
 */
export function dataPath(homeDir: string, key: DataLayoutKey): string {
  return `${homeDir.replace(/\/+$/, '')}/${DATA_LAYOUT[key]}`;
}

/**
 * Явный файл настроек не требует вычислять папку данных.
 * Это сохраняет ленивое разрешение путей для команд, которым папка не нужна.
 */
export function envFilePath(input: DataHomeInput): string {
  return input.env.GRIGDESK_ENV_FILE || dataPath(dataHome(input), 'env');
}

/**
 * Рабочая папка агентов и инструментов: снимки, дампы, временные стенды и отчёты проверок.
 * Явная GRIGDESK_ARTIFACTS_DIR важнее папки данных: так сторож тестов сохраняет настоящую папку.
 */
export function artifactsPath(input: DataHomeInput): string {
  return input.env.GRIGDESK_ARTIFACTS_DIR || dataPath(dataHome(input), 'artifacts');
}
