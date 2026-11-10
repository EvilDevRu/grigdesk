// Единая конфигурация сервера GrigDesk.
// Всё, что зависит от машины/окружения, — только здесь (задел «сменный мозг»).
import os from 'node:os';
import { pipelineSampleDirectory } from './lib/pipelineSample.ts';
import { dataHome as resolveDataHome, dataPath, envFilePath } from '../../shared/runtime/dataHome.ts';
import path from 'node:path';
import { deepSeekDistributionMode } from './lib/deepseek/distribution.ts';
import { readClientConfig } from './lib/clientAccess/config.ts';
import { factoryProfilesRoot, factoryRuntimePaths } from './lib/factoryRuntime.ts';
import { profilesDirFor } from './lib/runtimeLayout.ts';
import {
  runtimeInstallationBin, runtimeKind, runtimeMode, runtimeRoot,
} from './lib/runtimePaths.ts';

const home = os.homedir();
const dataHome = resolveDataHome({ env: process.env, home });
const dataStateDir = dataPath(dataHome, 'state');
const rootDir = runtimeRoot();
const installationBin = runtimeInstallationBin();
// Одиночный ELF не зависит от checkout: движок поставки и физические профили D.
// Source и прежний SEA-комплект сохраняют переопределения и умолчания байт в байт.
const singleBinary = runtimeMode() === 'payload';
const factoryRuntime = factoryRuntimePaths({
  kind: singleBinary ? 'packaged' : 'source',
  root: rootDir,
  env: process.env,
});
const factoryHome = factoryRuntime.home;

if (factoryRuntime.ignored.length > 0) {
  process.stderr.write(`Фабрика: ${factoryRuntime.ignored.join(', ')} из прежней настройки не используются, `
    + 'движок берётся из поставки. Внешний движок — GRIGDESK_ENGINE_MODE=external.\n');
}

const chatsDir = process.env.GRIGDESK_CHATS_DIR || dataPath(dataHome, 'chats');
const telegramDir = process.env.GRIGDESK_TELEGRAM_DIR || dataPath(dataHome, 'telegram');
const githubDir = process.env.GRIGDESK_GITHUB_DIR || dataPath(dataHome, 'github');
// Каталоги фабрики по умолчанию живут в папке данных (перенос из ~/.factory: старый
// путь после переезда не существует). Переменные окружения важнее этих умолчаний.
const routesDir = process.env.GRIGDESK_ROUTES_DIR || path.join(dataHome, 'factory', 'routes');
const factoryStateDir = process.env.FACTORY_STATE_DIR || path.join(dataHome, 'factory', 'state');
const deepseekRuntimeHome = process.env.GRIGDESK_DEEPSEEK_RUNTIME_HOME
  || path.join(factoryStateDir, 'grigdesk-deepseek');
// Корень private homes GLM. Абсолютность проверяет адаптер: кривое значение закрывает
// только карточку GLM, а не старт всей службы.
const glmRuntimeHome = process.env.GRIGDESK_GLM_RUNTIME_HOME || path.join(factoryStateDir, 'grigdesk-glm');

// Запуск kimi-чатов: host — прямой дочерний процесс сервера (parity с claude: host
// fs/config/credentials, без namespace/cgroup/egress allowlist), contained — прежний
// hardened bwrap-профиль (откат).
const kimiLaunchMode = process.env.GRIGDESK_KIMI_LAUNCH_MODE || 'host';
if (!['host', 'contained'].includes(kimiLaunchMode)) {
  throw new Error(`GRIGDESK_KIMI_LAUNCH_MODE: допустимо host|contained, получено "${kimiLaunchMode}"`);
}

// Служебный диапазон номеров ручных песочниц разбирается ЗДЕСЬ: кривое значение
// обязано ронять старт, а не всплывать пятисотым ответом при первом заходе человека
// в раздел. Тот же приём, что у GRIGDESK_KIMI_LAUNCH_MODE выше.
const manualRangeRaw = process.env.GRIGDESK_SANDBOX_MANUAL_RANGE || '990000-999999';
const manualRangeParts = /^([1-9][0-9]*)-([1-9][0-9]*)$/.exec(manualRangeRaw.trim());
if (!manualRangeParts || Number(manualRangeParts[1]) > Number(manualRangeParts[2])) {
  throw new Error(`GRIGDESK_SANDBOX_MANUAL_RANGE: нужен диапазон «от-до», получено "${manualRangeRaw}"`);
}
const sandboxManualRange = {
  // Границы уже проверены разбором выше: сюда доходит только пара целых чисел.
  from: Number(manualRangeParts[1]),
  to: Number(manualRangeParts[2]),
};

export const config = {
  // Доступ только с этой машины: HTTP-сокет не должен принимать пароль из сети.
  // Адрес фиксирован; окружение выбирает лишь номер порта.
  port: Number(process.env.GRIGDESK_PORT) || 8140,
  host: '127.0.0.1',
  // Отдельный TLS-вход мобильного контракта также принимает только loopback.
  // Ключи и привязки отделены от истории чатов и веб-сессий.
  mobileDir: process.env.GRIGDESK_MOBILE_DIR || dataPath(dataHome, 'mobile'),
  mobilePort: Number(process.env.GRIGDESK_MOBILE_PORT) || 8144,
  mobileApkDir: process.env.GRIGDESK_MOBILE_APK_DIR || dataPath(dataHome, 'mobileApk'),
  clientAccess: readClientConfig(),
  serverName: process.env.GRIGDESK_SERVER_NAME || os.hostname(),
  // Бюджет остановки целиком: слив ходов чата, закрытие сессий исполнителей и сокетов.
  // Должен быть меньше ожидания deploy/restart.sh и TimeoutStopSec юнита — иначе SIGKILL
  // придёт раньше, чем сервер успеет сохранить прерванные ходы.
  shutdownTimeoutMs: Number(process.env.GRIGDESK_SHUTDOWN_TIMEOUT_MS) || 30 * 1000,

  // Пути «мозга».
  // Корень репозитория GrigDesk — от него считаются скрипты запуска и ресурсы кода.
  rootDir,
  pipelineSampleDir: pipelineSampleDirectory(),
  installationBin,
  dataHome,
  dataStateDir,
  driversDir: process.env.GRIGDESK_DRIVERS_DIR || path.join(dataHome, 'drivers'),
  driverSourcesPath: path.join(dataHome, 'driver-sources.json'),
  driverInstallsPath: path.join(dataStateDir, 'driver-installs.json'),
  trackerSettingsPath: path.join(dataStateDir, 'tracker-settings.json'),
  trackerCredentialsPath: path.join(dataStateDir, 'tracker-credentials.json'),
  // Библиотека 3D отделена от чатов и проектных деревьев; плагин открывает её
  // только после включения, тестовые серверы задают собственный каталог.
  studio3dDir: process.env.GRIGDESK_3D_DIR || dataPath(dataHome, 'studio3d'),
  stateDir: factoryStateDir,
  // Доверенный control-каталог протокола маршрутов (движок пишет туда то, что провайдеру
  // менять нельзя). Задаём явно, а не полагаемся на умолчание: прогон уезжает
  // в transient-юнит systemd, окружение вызывающего он не наследует.
  factoryControlDir: process.env.FACTORY_CONTROL_ROOT || path.join(dataHome, 'factory', 'control'),
  // Движок входит в этот же репозиторий. Внешний checkout поддерживается только явным env.
  factoryHome,
  // Проектные профили живут отдельно от движка, в корне репозитория.
  profilesDir: singleBinary
    ? factoryProfilesRoot({
      kind: 'packaged',
      rootDir,
      dataHome,
      env: process.env,
    })
    : profilesDirFor({
      kind: runtimeKind(),
      rootDir,
      dataHome,
      env: process.env,
    }),
  factoryBin: factoryRuntime.bin,
  // Debug settings принадлежат engine writer-у, GrigDesk передаёт этот root его CLI.
  factoryConfigRoot: process.env.FACTORY_CONFIG_ROOT || path.join(dataHome, 'factory', 'config'),
  // Профиль для запуска на конвейер (пусто → определяется по данным/обнаружению).
  factoryProfile: process.env.GRIGDESK_FACTORY_PROFILE || '',
  // Бинарь Claude для чата с агентом по задаче.
  claudeBin: process.env.GRIGDESK_CLAUDE_BIN || 'claude',
  // Обычно OAuth-пара читается из установленного Claude CLI. Явный override допустим
  // только целиком: смешивать client id одного приложения с endpoint другого нельзя.
  claudeOauthClientId: process.env.GRIGDESK_CLAUDE_OAUTH_CLIENT_ID || '',
  claudeOauthTokenUrl: process.env.GRIGDESK_CLAUDE_OAUTH_TOKEN_URL || '',
  // Бинарь Codex CLI (GPT-исполнитель OpenAI). Не установлен → провайдер «недоступен».
  codexBin: process.env.GRIGDESK_CODEX_BIN || 'codex',
  // Kimi ставится обычным внешним CLI, как Claude/Codex. Режим запуска задаёт
  // kimiLaunchMode: host — обычный хост-процесс с наследованием host config (как claude),
  // contained — server-owned contained ACP profile (bwrap + user systemd cgroup
  // + versioned HTTPS allowlist); host config/hooks/plugins/MCP runtime не наследует.
  kimiLaunchMode,
  kimiBin: process.env.GRIGDESK_KIMI_BIN || 'kimi',
  kimiHome: process.env.GRIGDESK_KIMI_HOME
    || process.env.KIMI_CODE_HOME
    || path.join(home, '.kimi-code'),
  kimiRuntimeHome: process.env.GRIGDESK_KIMI_RUNTIME_HOME
    || path.join(factoryStateDir, 'grigdesk-kimi-contained'),
  kimiBwrapBin: process.env.GRIGDESK_KIMI_BWRAP_BIN || '/usr/bin/bwrap',
  kimiSystemdRunBin: process.env.GRIGDESK_KIMI_SYSTEMD_RUN_BIN || '/usr/bin/systemd-run',
  kimiSystemctlBin: process.env.GRIGDESK_KIMI_SYSTEMCTL_BIN || '/usr/bin/systemctl',
  kimiCaBundle: process.env.GRIGDESK_KIMI_CA_BUNDLE || '/etc/ssl/certs/ca-certificates.crt',
  // Pinned DeepSeek Harness живёт в server-owned runtime home. API key намеренно
  // не попадает в config: дочернее окружение строится отдельным allowlist-ом.
  deepseekRuntimeHome,
  deepseekCacheDir: dataPath(dataHome, 'deepseekRuntime'),
  // DeepSeek — отдельный ELF вне комплекта сервера: SEA-сервер не читает контракт исходников,
  // а source сохраняет проверку своего обязательного контракта поставки.
  deepseekRuntimeMode: runtimeKind() === 'packaged' ? 'binary' as const : deepSeekDistributionMode(
    path.join(rootDir, 'server/deepseek-runtime-contract.json'),
  ),
  deepseekBinOverride: process.env.GRIGDESK_DEEPSEEK_BIN,
  deepseekGenerationRoot: path.join(rootDir, 'server', 'runtime', 'deepseek'),
  deepseekBin: process.env.GRIGDESK_DEEPSEEK_BIN
    || path.join(installationBin, 'deepseek'),
  // GLM (Z.ai) работает на той же встроенной сборке DSH, но со своими homes и ключами.
  glmRuntimeHome,
  // Реестр моделей исполнителей (редактируемый; сеется из lib/models-registry.js).
  modelsPath: process.env.GRIGDESK_MODELS_PATH || path.join(dataStateDir, 'models.json'),
  // Ряды прогноза лимитов (modules/usage-forecast): снимки полос и журнал сбросов.
  usageForecastPath: process.env.GRIGDESK_USAGE_FORECAST_PATH
    || path.join(dataStateDir, 'usage-forecast.json'),
  // Автообнаружение новых моделей Anthropic ХОСТОВЫМ OAuth-токеном CLI (~/.claude/.credentials.json).
  // Явный опт-ин пользователя: токен предназначен для claude CLI, использовать его для прямых
  // API-запросов без разрешения нельзя. ANTHROPIC_API_KEY в окружении работает и без флага.
  discoverWithCliToken: process.env.GRIGDESK_DISCOVER_WITH_CLI_TOKEN === '1',

  // Свой API-ключ GrigDesk для claude (опционально). Хранится в .state (gitignore, 0600).
  // Пусто → чат использует авторизацию хостового CLI (`claude login` / ANTHROPIC_API_KEY).
  claudeAuthPath: process.env.GRIGDESK_CLAUDE_AUTH_PATH || path.join(dataStateDir, 'claude-auth.json'),

  // История чатов с агентами — каталог chats в папке данных (внутри свой .gitignore):
  // каждый чат — отдельный файл chats/YYYY-MM/<id>.json, мета — meta.json.
  // Общая для всех окон/устройств, битый файл одного чата не трогает остальные.
  chatsDir,
  // Server-owned sidecar provider-сессий. Отдельно от chat JSON: браузер не может
  // назначить resume id stale PUT-ом или поддельным полем sessionId.
  chatBindingsDir: process.env.GRIGDESK_CHAT_BINDINGS_DIR
    || path.join(chatsDir, '.bindings'),
  // Старое хранилище одним файлом — только для одноразовой миграции.
  chatStoreLegacyPath: process.env.GRIGDESK_CHAT_STORE || path.join(dataStateDir, 'chats.json'),

  // Архив входящих из Telegram — каталог telegram в папке данных (внутри свой .gitignore,
  // как chats/): NDJSON по месяцам плюс индекс. В дереве проекта, чтобы дамп
  // делался одной командой, а не собирался по системе.
  telegramDir,
  // Токен бота — в strict account-aware .state файле (0600), а НЕ в prefs:
  // prefs целиком уезжают в браузер ответом /api/settings/prefs.
  telegramAccountCredsPath: process.env.GRIGDESK_TELEGRAM_ACCOUNT_CREDS_PATH
    || path.join(dataStateDir, 'telegram-account-creds.json'),

  // GitHub Issues — второй channel общего Inbox. Нативный archive/rules/account binding
  // лежат отдельно от Telegram, а PAT и webhook secret — только в private .state.
  githubDir,
  githubCredsPath: process.env.GRIGDESK_GITHUB_CREDS_PATH
    || path.join(dataStateDir, 'github-creds.json'),
  // База callback-а принадлежит оператору. В request body адрес не принимается: иначе
  // connect превратился бы в SSRF/создание webhook на произвольный endpoint.
  githubWebhookBaseUrl: process.env.GRIGDESK_GITHUB_WEBHOOK_BASE_URL || '',

  // Рабочая папка агентов: снимки, дампы, скрипты и отчёты проверок. Вне дерева кода;
  // ход чата получает её на запись, картинки и документы из неё показываются.
  artifactsDir: process.env.GRIGDESK_ARTIFACTS_DIR || dataPath(dataHome, 'artifacts'),

  // Immutable-хранилище ОПУБЛИКОВАННЫХ маршрутов — runtime-артефакт движка,
  // как state/control, поэтому живёт в папке данных (factory/routes), а не в
  // репозитории. Каталог принадлежит единственному route-store; движок читает тот же путь.
  routesDir,
  // Черновики — отдельная область авторства рядом с опубликованным store.
  routesAuthoringDir: process.env.GRIGDESK_ROUTES_AUTHORING_DIR || `${routesDir}.authoring`,

  // Файловый журнал окна: дневные NDJSON, доступны только владельцу сервера.
  webLogDir: process.env.GRIGDESK_WEB_LOG_DIR || path.join(dataStateDir, 'web-log'),


  // Постановки задач для immutable route-прогонов. Хранилище GrigDesk, а НЕ
  // рабочее дерево задачи: дерево принадлежит агенту, и файл постановки в нём агент
  // может переписать. Движок делает себе доверенную копию сам.
  factoryTaskSourcesPath: process.env.GRIGDESK_FACTORY_TASK_SOURCES_PATH
    || path.join(dataStateDir, 'factory-task-sources.json'),
  grigdeskTasksPath: process.env.GRIGDESK_TASKS_PATH || path.join(dataStateDir, 'grigdesk-tasks.json'),

  ticketsDir: process.env.GRIGDESK_TICKETS_DIR || path.join(dataStateDir, 'tickets'),

  // Ручные песочницы: журнал подъёмов GrigDesk и служебный диапазон номеров стендов,
  // которые поднимают без задачи B24. Диапазон отделён от номеров задач намеренно:
  // стенд «поиграться» не должен занять номер, который завтра придёт из портала.
  sandboxJournalDir: process.env.GRIGDESK_SANDBOX_JOURNAL_DIR
    || path.join(dataStateDir, 'sandboxes'),
  sandboxManualRange,

  // Ролики раздела «Презентации»: записи, сцены и артефакты сборки. Каталог тяжёлый
  // и растёт от каждого прогона, поэтому вынесен переменной — на этой машине его
  // держат на диске побольше.
  showcaseDir: process.env.GRIGDESK_SHOWCASE_DIR || path.join(dataStateDir, 'showcase'),
  // Снимок входа тестовой учётки лежит ОТДЕЛЬНО от артефактов ролика и с правами
  // 0700: это действующие права на стенде, и попасть в скачиваемый файл, экспорт
  // или журнал он не должен.
  showcaseAuthDir: process.env.GRIGDESK_SHOWCASE_AUTH_DIR
    || path.join(dataStateDir, 'showcase-auth'),
  // Локальный синтез речи раздела: своё python-окружение и скачанные голоса.
  // Отдельно от media-venv распознавания намеренно — обновление голосового движка
  // не должно менять состав, на котором проверена диктовка.
  showcaseVoiceDir: process.env.GRIGDESK_SHOWCASE_VOICE_DIR
    || path.join(dataStateDir, 'showcase-voice'),
  // Браузер записи объявляется явно. Найденный в чужом кэше бинарник установкой
  // зависимости раздела не считается: версия Playwright требует свою ревизию, и
  // случайная чужая даёт то падающую запись, то пустой клип.
  showcaseBrowser: process.env.GRIGDESK_SHOWCASE_BROWSER || '',
  // Браузер, который раздел ставит сам из настроек плагина: сборка Chromium под
  // текущий playwright-core и манифест с версией. Явный GRIGDESK_SHOWCASE_BROWSER
  // сильнее него.
  showcaseBrowserDir: process.env.GRIGDESK_SHOWCASE_BROWSER_DIR
    || path.join(dataStateDir, 'showcase-browser'),
  // Облачный голос раздела: ключ сервисного аккаунта Yandex SpeechKit. Пусто —
  // говорят только локальные движки. Ключ остаётся серверной настройкой: интерфейс
  // получает статус «задан/не задан», а не значение.
  showcaseYandexApiKey: process.env.GRIGDESK_SHOWCASE_YANDEX_API_KEY || '',
  showcaseYandexFolderId: process.env.GRIGDESK_SHOWCASE_YANDEX_FOLDER_ID || '',
  // Облачный голос Microsoft (Edge TTS): ключа нет, включён по умолчанию, а
  // выключается явным нулём — текст сцен уходит поставщику, и установка, которой
  // это не подходит, отключает его одной переменной.
  showcaseEdgeTts: process.env.GRIGDESK_SHOWCASE_EDGE_TTS !== '0',

  // Общие настройки GrigDesk (редактируются из UI, живут в .state).
  prefsPath: process.env.GRIGDESK_PREFS_PATH || path.join(dataStateDir, 'prefs.json'),
  // SSH-профили, известные host keys и журнал команд агента содержат адреса боевых
  // машин и вывод команд, поэтому живут в отдельном приватном namespace, не в prefs.
  sshConnectionsPath: process.env.GRIGDESK_SSH_CONNECTIONS_PATH
    || path.join(dataStateDir, 'ssh', 'connections.json'),
  sshKnownHostsPath: process.env.GRIGDESK_SSH_KNOWN_HOSTS_PATH
    || path.join(dataStateDir, 'ssh', 'known-hosts.json'),
  sshAuditDir: process.env.GRIGDESK_SSH_AUDIT_DIR
    || path.join(dataStateDir, 'ssh', 'audit'),
  // DB-профили и журнал содержат адреса боевых систем и тексты запросов, поэтому
  // живут в своём приватном namespace, а не в общих prefs.
  dbProfilesPath: process.env.GRIGDESK_DB_PROFILES_PATH
    || path.join(dataStateDir, 'db', 'profiles.json'),
  dbAuditDir: process.env.GRIGDESK_DB_AUDIT_DIR
    || path.join(dataStateDir, 'db', 'audit'),
  // Личная подборка B24-задач. Отдельно от prefs: это пользовательские данные,
  // а не настройки интерфейса.
  taskFavoritesPath: process.env.GRIGDESK_TASK_FAVORITES_PATH
    || path.join(dataStateDir, 'task-favorites.json'),
  // Разбор арбитра последней остановки задачи. Хранится у GrigDesk, а не в журнале
  // попытки: журнал immutable и принадлежит движку, а это подсказка человеку, которую
  // перекрывает следующая остановка той же задачи.
  arbiterCardsPath: process.env.GRIGDESK_ARBITER_CARDS_PATH
    || path.join(dataStateDir, 'arbiter-cards.json'),
  arbiterConversationsDir: process.env.GRIGDESK_ARBITER_CONVERSATIONS_DIR
    || path.join(dataStateDir, 'arbiter-conversations'),
  // Личная полка B24-задач с серверными снимками наблюдаемого состояния.
  taskShelfPath: process.env.GRIGDESK_TASK_SHELF_PATH
    || path.join(dataStateDir, 'task-shelf.json'),
  // Просмотренные B24-задачи: набор серверный, чтобы метка «новая» снималась на всех
  // устройствах сразу.
  taskSeenPath: process.env.GRIGDESK_TASK_SEEN_PATH
    || path.join(dataStateDir, 'task-seen.json'),
  // Когда впервые увидели каждое ведро лимитов исполнителя. Серверный файл, потому что
  // метка «новое» обязана быть одинаковой во всех окнах.
  providerInstallStatePath: path.join(dataStateDir, 'provider-installs', 'state.json'),
  providerUsageSeenPath: process.env.GRIGDESK_PROVIDER_USAGE_SEEN_PATH
    || path.join(dataStateDir, 'provider-usage-seen.json'),

  // Триаж задач: разведка кода headless-агентом без стенда. Результаты (оценки + разведнота)
  // живут рядом с состоянием фабрики, но в своём каталоге — фабрика про них не знает.
  analysisDir: process.env.GRIGDESK_ANALYSIS_DIR || path.join(dataHome, 'factory', 'analysis'),
  analysisTimeoutMs: Number(process.env.GRIGDESK_ANALYSIS_TIMEOUT_MS) || 20 * 60 * 1000,
  // Параллельных оценок триажа: один воркер на большой очереди создаёт часы ожидания.
  analysisConcurrency: Number(process.env.GRIGDESK_ANALYSIS_CONCURRENCY) || 2,

  // Команда сноса стенда (проектно-специфична) — задаётся окружением, {task} подставляется.
  // Пусто → кнопка «снести стенд» отвечает «не настроено». Без хардкода путей проекта.
  sandboxDownCmd: process.env.GRIGDESK_SANDBOX_DOWN_CMD || '',

  // Медиа-конвейер использует штатный venv папки данных без дополнительной настройки.
  // GRIGDESK_MEDIA_PYTHON позволяет явно подключить внешнее окружение вместо штатного.
  mediaDir: process.env.GRIGDESK_MEDIA_DIR || path.join(dataStateDir, 'media'),
  mediaPython: process.env.GRIGDESK_MEDIA_PYTHON || path.join(dataPath(dataHome, 'mediaVenv'), 'bin/python'),
  // Собственный кэш моделей речи: обычный transcribe работает fail-closed и никогда
  // не скачивает веса в общий ~/.cache. Все Python-spawn получают этот HF_HOME.
  mediaHfDir: process.env.GRIGDESK_MEDIA_HF_DIR || path.join(dataStateDir, 'hf'),
  // Эталон для воспроизводимого speed benchmark задаёт оператор: голосовой бинарный
  // asset не тащим в исходники и не подменяем речь бессмысленным тоном/тишиной.
  speechBenchmarkAudioPath: process.env.GRIGDESK_SPEECH_BENCHMARK_AUDIO || '',

  // Вход в GrigDesk: файл сессий (формат 2) и прежний файл учётной записи. Оба в .state (0600).
  // Пароля больше нет: `authAccountPath` читается один раз как источник строки `clientScope`
  // (владельца незавершённых операций 3D) и продуктом не переписывается.
  authAccountPath: process.env.GRIGDESK_AUTH_ACCOUNT || path.join(dataStateDir, 'auth-account.json'),
  authSessionsPath: process.env.GRIGDESK_AUTH_SESSIONS || path.join(dataStateDir, 'auth-sessions.json'),
  // Токен для ЛОКАЛЬНЫХ CLI-потребителей API (bin/tracker, ship-этап фабрики, скиллы):
  // файл 0600 на этой же машине. Кто может его прочитать — уже владеет всеми кредами .state.
  cliTokenPath: process.env.GRIGDESK_CLI_TOKEN_PATH || path.join(dataStateDir, 'cli-token'),
  // Проверка и применение релизов GrigDesk. Это runtime-state машины, не часть релиза.
  grigDeskUpdateStatePath: process.env.GRIGDESK_UPDATE_STATE_PATH
    || path.join(dataStateDir, 'grigdesk-update.json'),
  // Пользовательские плагины: plugins/<id>/plugin.json (+server.js) в папке данных.
  userPluginsDir: process.env.GRIGDESK_PLUGINS_DIR || dataPath(dataHome, 'plugins'),
  // Данные пользовательского runtime находятся вне заменяемой папки пакета.
  // Путь передаётся server.js через options.dataDir и сохраняется при обновлении.
  userPluginsDataDir: process.env.GRIGDESK_PLUGINS_DATA_DIR || dataPath(dataHome, 'pluginData'),
  // Durable source/version, предыдущая копия и известные исходы installer.
  // Boot fixtures задают собственный путь, независимо от конфигурации машины.
  pluginInstallsStatePath: process.env.GRIGDESK_PLUGIN_INSTALLS_STATE_PATH
    || path.join(dataStateDir, 'plugin-installs.json'),

  // Внешние драйверы активируются только при следующем старте сервера.
  // Состояние установщика не входит в заменяемые пакеты.
  dbEnginesDir: process.env.GRIGDESK_DB_ENGINES_DIR || dataPath(dataHome, 'dbEngines'),
  dbEngineInstallsStatePath: process.env.GRIGDESK_DB_ENGINE_INSTALLS_STATE_PATH
    || path.join(dataStateDir, 'db-engine-installs.json'),

  // Машинные переменные читают все штатные способы запуска.
  // Общий writer сохраняет соседние настройки и порядок строк.
  envPath: envFilePath({ env: process.env, home }),

  // Режим.
  isDev: process.env.NODE_ENV === 'development',
};

// Конфигурация — доменная модель, а не свободный словарь: потребитель обязан ссылаться
// на этот тип, а не описывать у себя своё представление о полях. Форма выводится из
// самого объекта — второго списка полей, который разошёлся бы с ним, в проекте нет.
export type GrigDeskConfig = typeof config;
