// Старые имена нужны только для диагностики и явного переноса данных.
// Код продукта читает новые переменные; подстановка старых значений запрещена.
export const LEGACY = {
  envPrefix: 'COCKPIT_',
  dataHomeDir: '.cockpit',
  configDir: 'cockpit',
  profileDir: 'Кокпит',
  partition: 'cockpit-local',
  storagePrefix: 'cockpit-',
  serverUnit: 'cockpit-server.service',
  shortcut: 'cockpit.desktop',
  cliLink: 'cockpit',
  desktopInstallDir: 'cockpit/desktop',
  apkBase: 'cockpit-mobile',
} as const;

export const LEGACY_DATA_PATHS = [
  ['state/cockpit-server.log', 'state/grigdesk-server.log'],
  ['state/cockpit-update.json', 'state/grigdesk-update.json'],
  ['plugins/.cockpit-install', 'plugins/.grigdesk-install'],
] as const;

// Значения, записанные в данных до второго этапа переименования: читаются как новые,
// пишутся только новые. Убрать вместе с переносом этих данных.
export const LEGACY_VALUES = {
  workdirKind: 'cockpit',
  arbiterActor: 'cockpit-arbiter',
  routeAuthoringFormat: 'cockpit-route-authoring',
} as const;

/**
 * Старое имя корня нельзя молча проигнорировать: это выбрало бы другую папку данных.
 * В файле настроек запрещены обе формы корней, независимо от значения ключа.
 */
export function legacyRootProblem(
  env: Readonly<Record<string, string | undefined>>, fromFile = false,
): string | null {
  for (const suffix of ['HOME', 'ENV_FILE']) {
    const oldKey = `${LEGACY.envPrefix}${suffix}`;
    const newKey = `GRIGDESK_${suffix}`;
    const forbidden = fromFile ? [oldKey, newKey] : [oldKey];

    for (const key of forbidden) {
      if (Object.hasOwn(env, key)) {
        return fromFile ? `Ключ ${key} запрещён в файле настроек.`
          : `Устаревшая переменная ${key}: используйте ${newKey}.`;
      }
    }
  }

  return null;
}

/**
 * Предупреждения содержат только известные имена хоста, никогда значения настроек.
 * Ключи внешних плагинов и удалённых функций остаются без диагностики и подстановки.
 */
export function legacyEnvWarnings(env: Readonly<Record<string, string | undefined>>): string[] {
  return HOST_ENV_SUFFIXES.map((suffix) => `${LEGACY.envPrefix}${suffix}`)
    .filter((key) => Object.hasOwn(env, key))
    .map((key) => `Устаревшая переменная ${key}: запустите node tools/brandMove.mts`);
}

export const HOST_ENV_SUFFIXES: readonly string[] = [
  '3D_DIR',
  'AGENTS_DIR',
  'AGENTS_SEED_DIR',
  'ALREADY_RUNNING',
  'ANALYSIS_CONCURRENCY',
  'ANALYSIS_DIR',
  'ANALYSIS_MODEL',
  'ANALYSIS_TIMEOUT_MS',
  'ANDROID_GRADLE_HOME',
  'ANDROID_HOME',
  'ANDROID_JDK',
  'ANDROID_KEY_ALIAS',
  'ANDROID_KEY_PASSWORD',
  'ANDROID_SIGNING_DIR',
  'ANDROID_STORE_FILE',
  'ANDROID_STORE_PASSWORD',
  'ANDROID_USER_HOME',
  'ARBITER_CARDS_PATH',
  'ARTIFACTS_DIR',
  'AUTH_ACCOUNT',
  'AUTH_SESSIONS',
  'B24_BASE_URL',
  'B24_INSTALL_PAUSE',
  'CHATS_DIR',
  'CHAT_BINDINGS_DIR',
  'CHAT_KEY',
  'CHAT_STORE',
  'CHAT_TITLE',
  'CLAUDE_AUTH_PATH',
  'CLAUDE_BIN',
  'CLAUDE_OAUTH_CLIENT_ID',
  'CLAUDE_OAUTH_TOKEN_URL',
  'CLI_CGROUP_FILE',
  'CLI_TOKEN_PATH',
  'CODEX_BIN',
  'DB_AUDIT_DIR',
  'DB_PROFILES_PATH',
  'DEEPSEEK_ARTIFACT_DIR',
  'DEEPSEEK_BIN',
  'DEEPSEEK_GENERATION_ROOT',
  'DEEPSEEK_NODE_BIN',
  'DEEPSEEK_REUSE_RUNTIME',
  'DEEPSEEK_RUNTIME_HOME',
  'DEEPSEEK_RUNTIME_MODE',
  'DEEPSEEK_UPSTREAM_SEED',
  'DESKTOP_CHILD',
  'DESKTOP_DATA_DIR',
  'DIR',
  'DIR__',
  'DISCOVER_WITH_CLI_TOKEN',
  'EFFECTIVE_LOG',
  'EFFECTIVE_PORT',
  'EFFECTIVE_TOKEN_PATH',
  'ENV_FILE',
  'FACTORY_BIN',
  'FACTORY_PROFILE',
  'GITHUB_CREDS_PATH',
  'GITHUB_DIR',
  'GITHUB_WEBHOOK_BASE_URL',
  'GLM_API_MODE',
  'GLM_ROUTE_KEY',
  'GLM_RUNTIME_HOME',
  'HOME',
  'HOST',
  'INTERNAL',
  'IP_BIN',
  'KIMI_BIN',
  'KIMI_BWRAP_BIN',
  'KIMI_CA_BUNDLE',
  'KIMI_HOME',
  'KIMI_LAUNCH_MODE',
  'KIMI_RUNTIME_HOME',
  'KIMI_SYSTEMCTL_BIN',
  'KIMI_SYSTEMD_RUN_BIN',
  'LOCK_WAIT_MS',
  'LOG',
  'MEDIA_BOOTSTRAP_PYTHON',
  'MEDIA_CUDA',
  'MEDIA_DIR',
  'MEDIA_HF_DIR',
  'MEDIA_PYTHON',
  'MIN_NODE',
  'MOBILE_APK_DIR',
  'MOBILE_DEVLINK_DIR',
  'MOBILE_DEVLINK_LOG',
  'MOBILE_DEVLINK_NAME',
  'MOBILE_DEVLINK_PORT',
  'MOBILE_DIR',
  'MOBILE_DOWNLOADS',
  'MOBILE_PORT',
  'MODELS_PATH',
  'NODE_DIR',
  'NODE_ENV_ARGS',
  'PERM_URL',
  'PLUGINS_DATA_DIR',
  'PLUGINS_DIR',
  'PLUGIN_INSTALLS_STATE_PATH',
  'PORT',
  'PREFS_PATH',
  'PROVIDER_PREFS_PATH',
  'PROVIDER_USAGE_SEEN_PATH',
  'RELAY_PROJECT',
  'RELEASE_CHECK_COMMAND',
  'RELEASE_PUBLISH_CONTRACT',
  'REQUIRE_VPN',
  'ROUTES_AUTHORING_DIR',
  'ROUTES_DIR',
  'SANDBOX_DOWN_CMD',
  'SANDBOX_JOURNAL_DIR',
  'SANDBOX_MANUAL_RANGE',
  'SHA',
  'SHOWCASE_ATTEMPT',
  'SHOWCASE_AUTH_DIR',
  'SHOWCASE_BROWSER',
  'SHOWCASE_BROWSER_DIR',
  'SHOWCASE_DIR',
  'SHOWCASE_EDGE_TTS',
  'SHOWCASE_VOICE_DIR',
  'SHOWCASE_YANDEX_API_KEY',
  'SHOWCASE_YANDEX_FOLDER_ID',
  'SHUTDOWN_TIMEOUT_MS',
  'SIGNING_PASSWORD',
  'SPEECH_BENCHMARK_AUDIO',
  'SSH_AUDIT_DIR',
  'SSH_CONNECTIONS_PATH',
  'SSH_KNOWN_HOSTS_PATH',
  'TASK_FAVORITES_PATH',
  'TASK_SEEN_PATH',
  'TASK_SHELF_PATH',
  'TELEGRAM_ACCOUNT_CREDS_PATH',
  'TELEGRAM_DIR',
  'TERMINAL_PYTHON',
  'TEST_DEEPSEEK_ARTIFACT',
  'TICKETS_DIR',
  'TOKEN',
  'TRANSCRIBE_PY',
  'UI_RELEASES_DIR',
  'UPDATE_STATE_PATH',
  'UPGRADE_ROOT',
  'URL',
  'USAGE_FORECAST_PATH',
  'VERSION',
  'VPN_IFACE',
  'VPN_PROBE',
  'VPN_SYS_CLASS_NET',
  'WAIT_SEC',
  'WEB_DIST',
  'WEB_LOG_DIR',
  'WINDOW_KEY_PATH',
];
