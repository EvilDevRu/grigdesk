// Единая конфигурация сервера кокпита.
// Всё, что зависит от машины/окружения, — только здесь (задел «сменный мозг»).
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const home = os.homedir();
const rootDir = path.join(__dirname, '..', '..');
const factoryHome = process.env.FACTORY_HOME || path.join(rootDir, 'engine');
const chatsDir = process.env.COCKPIT_CHATS_DIR || path.join(rootDir, 'chats');
const telegramDir = process.env.COCKPIT_TELEGRAM_DIR || path.join(rootDir, 'telegram');
const githubDir = process.env.COCKPIT_GITHUB_DIR || path.join(rootDir, 'github');
const factoryStateDir = process.env.FACTORY_STATE_DIR || path.join(home, '.factory', 'state');
const publicDomain = process.env.COCKPIT_PUBLIC_DOMAIN || '';

// Запуск kimi-чатов: host — прямой дочерний процесс сервера (parity с claude: host
// fs/config/credentials, без namespace/cgroup/egress allowlist), contained — прежний
// hardened bwrap-профиль (откат).
const kimiLaunchMode = process.env.COCKPIT_KIMI_LAUNCH_MODE || 'host';
if (!['host', 'contained'].includes(kimiLaunchMode)) {
  throw new Error(`COCKPIT_KIMI_LAUNCH_MODE: допустимо host|contained, получено "${kimiLaunchMode}"`);
}

export const config = {
  // Сеть. HOST=0.0.0.0 — чтобы окно (планшет) достучалось по локальной сети и через шлюз.
  port: Number(process.env.COCKPIT_PORT) || 8140,
  host: process.env.COCKPIT_HOST || '0.0.0.0',

  // Пути «мозга».
  // Корень репозитория кокпита — от него считаются bin/restart, plugins/ и базы в корне.
  rootDir,
  stateDir: factoryStateDir,
  // Доверенный control-каталог протокола маршрутов (движок пишет туда то, что провайдеру
  // менять нельзя). Задаём явно, а не полагаемся на дефолт по $HOME: прогон уезжает
  // в transient-юнит systemd, окружение вызывающего он не наследует.
  factoryControlDir: process.env.FACTORY_CONTROL_ROOT || path.join(home, '.factory', 'control'),
  // Движок входит в этот же репозиторий. Внешний checkout поддерживается только явным env.
  factoryHome,
  // Проектные профили живут отдельно от движка, в корне репозитория.
  profilesDir: process.env.FACTORY_PROFILES_DIR || path.join(rootDir, 'profiles'),
  factoryBin: process.env.COCKPIT_FACTORY_BIN || path.join(factoryHome, 'bin', 'factory'),
  // Debug settings принадлежат engine writer-у, Cockpit передаёт этот root его CLI.
  factoryConfigRoot: process.env.FACTORY_CONFIG_ROOT || path.join(home, '.factory', 'config'),
  // Профиль для запуска на конвейер (пусто → определяется по данным/обнаружению).
  factoryProfile: process.env.COCKPIT_FACTORY_PROFILE || '',
  // Бинарь Claude для чата с агентом по задаче.
  claudeBin: process.env.COCKPIT_CLAUDE_BIN || 'claude',
  // Обычно OAuth-пара читается из установленного Claude CLI. Явный override допустим
  // только целиком: смешивать client id одного приложения с endpoint другого нельзя.
  claudeOauthClientId: process.env.COCKPIT_CLAUDE_OAUTH_CLIENT_ID || '',
  claudeOauthTokenUrl: process.env.COCKPIT_CLAUDE_OAUTH_TOKEN_URL || '',
  // Бинарь Codex CLI (GPT-исполнитель OpenAI). Не установлен → провайдер «недоступен».
  codexBin: process.env.COCKPIT_CODEX_BIN || 'codex',
  // Kimi ставится обычным внешним CLI, как Claude/Codex. Режим запуска задаёт
  // kimiLaunchMode: host — обычный хост-процесс с наследованием host config (как claude),
  // contained — server-owned contained ACP profile (bwrap + user systemd cgroup
  // + versioned HTTPS allowlist); host config/hooks/plugins/MCP runtime не наследует.
  kimiLaunchMode,
  kimiBin: process.env.COCKPIT_KIMI_BIN || 'kimi',
  kimiHome: process.env.COCKPIT_KIMI_HOME
    || process.env.KIMI_CODE_HOME
    || path.join(home, '.kimi-code'),
  kimiRuntimeHome: process.env.COCKPIT_KIMI_RUNTIME_HOME
    || path.join(factoryStateDir, 'cockpit-kimi-contained'),
  kimiBwrapBin: process.env.COCKPIT_KIMI_BWRAP_BIN || '/usr/bin/bwrap',
  kimiSystemdRunBin: process.env.COCKPIT_KIMI_SYSTEMD_RUN_BIN || '/usr/bin/systemd-run',
  kimiSystemctlBin: process.env.COCKPIT_KIMI_SYSTEMCTL_BIN || '/usr/bin/systemctl',
  kimiCaBundle: process.env.COCKPIT_KIMI_CA_BUNDLE || '/etc/ssl/certs/ca-certificates.crt',
  // Машинный override адреса демона Ollama. Обычный путь — настройка «Адрес демона»
  // в UI («Настройки → Исполнители», prefs.providerSettings.ollama.host); env — для
  // стендов, где prefs не трогают.
  ollamaBaseUrl: process.env.COCKPIT_OLLAMA_HOST || '',
  // Реестр моделей исполнителей (редактируемый; сеется из lib/models-registry.js).
  modelsPath: process.env.COCKPIT_MODELS_PATH || path.join(__dirname, '..', '.state', 'models.json'),
  // Автообнаружение новых моделей Anthropic ХОСТОВЫМ OAuth-токеном CLI (~/.claude/.credentials.json).
  // Явный опт-ин пользователя: токен предназначен для claude CLI, использовать его для прямых
  // API-запросов без разрешения нельзя. ANTHROPIC_API_KEY в окружении работает и без флага.
  discoverWithCliToken: process.env.COCKPIT_DISCOVER_WITH_CLI_TOKEN === '1',

  // Свой API-ключ кокпита для claude (опционально). Хранится в .state (gitignore, 0600).
  // Пусто → чат использует авторизацию хостового CLI (`claude login` / ANTHROPIC_API_KEY).
  claudeAuthPath: process.env.COCKPIT_CLAUDE_AUTH_PATH || path.join(__dirname, '..', '.state', 'claude-auth.json'),

  // История чатов с агентами — папка в корне проекта (внутри свой .gitignore):
  // каждый чат — отдельный файл chats/YYYY-MM/<id>.json, мета — meta.json.
  // Общая для всех окон/устройств, битый файл одного чата не трогает остальные.
  chatsDir,
  // Server-owned sidecar provider-сессий. Отдельно от chat JSON: браузер не может
  // назначить resume id stale PUT-ом или поддельным полем sessionId.
  chatBindingsDir: process.env.COCKPIT_CHAT_BINDINGS_DIR
    || path.join(chatsDir, '.bindings'),
  // Старое хранилище одним файлом — только для одноразовой миграции.
  chatStoreLegacyPath: process.env.COCKPIT_CHAT_STORE || path.join(__dirname, '..', '.state', 'chats.json'),

  // Архив входящих из Telegram — папка в корне проекта (внутри свой .gitignore,
  // как chats/): NDJSON по месяцам плюс индекс. В дереве проекта, чтобы дамп
  // делался одной командой, а не собирался по системе.
  telegramDir,
  // Токен бота — в strict account-aware .state файле (0600), а НЕ в prefs:
  // prefs целиком уезжают в браузер ответом /api/settings/prefs.
  telegramAccountCredsPath: process.env.COCKPIT_TELEGRAM_ACCOUNT_CREDS_PATH
    || path.join(__dirname, '..', '.state', 'telegram-account-creds.json'),

  // GitHub Issues — второй channel общего Inbox. Нативный archive/rules/account binding
  // лежат отдельно от Telegram, а PAT и webhook secret — только в private .state.
  githubDir,
  githubCredsPath: process.env.COCKPIT_GITHUB_CREDS_PATH
    || path.join(__dirname, '..', '.state', 'github-creds.json'),
  // База callback-а принадлежит оператору. В request body адрес не принимается: иначе
  // connect превратился бы в SSRF/создание webhook на произвольный endpoint.
  githubWebhookBaseUrl: process.env.COCKPIT_GITHUB_WEBHOOK_BASE_URL
    || (publicDomain ? `https://${publicDomain}/hooks/github` : ''),

  // База агентов (стадий конвейера) — папка в корне проекта (внутри свой .gitignore,
  // как chats/): каждый агент — файл agents/<id>.md (frontmatter + промпт).
  agentsDir: process.env.COCKPIT_AGENTS_DIR || path.join(__dirname, '..', '..', 'agents'),
  // Версионируемый стандартный набор агентов: отсюда кнопка «Установить набор»
  // доустанавливает отсутствующих (create-only, существующие файлы не трогает).
  agentsSeedDir: process.env.COCKPIT_AGENTS_SEED_DIR || path.join(__dirname, '..', 'seed', 'agents'),

  // Immutable-хранилище ОПУБЛИКОВАННЫХ маршрутов — runtime-артефакт движка,
  // как state/control, поэтому живёт в ~/.factory, а не в репозитории. Каталог
  // принадлежит единственному route-store; движок читает тот же путь.
  routesDir: process.env.COCKPIT_ROUTES_DIR || path.join(home, '.factory', 'routes'),

  // Собранный фронт (по умолчанию отдаём тем же сервером — один origin).
  webDist: process.env.COCKPIT_WEB_DIST || path.join(__dirname, '..', '..', 'web', 'dist'),


  // Битрикс24. Куки и креды — В СВОЁМ каталоге (изоляция: свой cookie-файл = нет
  // session-thrash). Портал/креды задаются из «Настроек» и живут в .state (gitignore).
  // Никаких проектных значений по умолчанию в коде — пустой кокпит не знает ничего.
  b24BaseUrl: process.env.COCKPIT_B24_BASE_URL || '',
  b24CookiePath: process.env.B24_COOKIE_PATH || path.join(__dirname, '..', '.state', 'b24-cookies.json'),
  b24CredsPath: process.env.B24_CREDS_PATH || path.join(__dirname, '..', '.state', 'b24-creds.json'),

  // Постановки задач для immutable route-прогонов. Хранилище кокпита, а НЕ
  // рабочее дерево задачи: дерево принадлежит агенту, и файл постановки в нём агент
  // может переписать. Движок делает себе доверенную копию сам.
  ticketsDir: process.env.COCKPIT_TICKETS_DIR || path.join(__dirname, '..', '.state', 'tickets'),

  // Общие настройки кокпита (редактируются из UI, живут в .state).
  prefsPath: process.env.COCKPIT_PREFS_PATH || path.join(__dirname, '..', '.state', 'prefs.json'),
  // Личная подборка B24-задач. Отдельно от prefs: это пользовательские данные,
  // а не настройки интерфейса.
  taskFavoritesPath: process.env.COCKPIT_TASK_FAVORITES_PATH
    || path.join(__dirname, '..', '.state', 'task-favorites.json'),
  // Просмотренные B24-задачи: набор серверный, чтобы метка «новая» снималась на всех
  // устройствах сразу.
  taskSeenPath: process.env.COCKPIT_TASK_SEEN_PATH
    || path.join(__dirname, '..', '.state', 'task-seen.json'),

  // Триаж задач: разведка кода headless-агентом без стенда. Результаты (оценки + разведнота)
  // живут рядом с состоянием фабрики, но в своём каталоге — фабрика про них не знает.
  analysisDir: process.env.COCKPIT_ANALYSIS_DIR || path.join(home, '.factory', 'analysis'),
  analysisModel: process.env.COCKPIT_ANALYSIS_MODEL || 'sonnet',
  analysisTimeoutMs: Number(process.env.COCKPIT_ANALYSIS_TIMEOUT_MS) || 20 * 60 * 1000,
  // Параллельных оценок триажа: один воркер на большой очереди создаёт часы ожидания.
  analysisConcurrency: Number(process.env.COCKPIT_ANALYSIS_CONCURRENCY) || 2,

  // Команда сноса стенда (проектно-специфична) — задаётся окружением, {task} подставляется.
  // Пусто → кнопка «снести стенд» отвечает «не настроено». Без хардкода путей проекта.
  sandboxDownCmd: process.env.COCKPIT_SANDBOX_DOWN_CMD || '',

  // Медиа-конвейер (распознавание речи). Runtime-venv из server/.state подключается через
  // COCKPIT_MEDIA_PYTHON; читается в media/preflight.js. Хранилище job'ов/медиа.
  mediaDir: process.env.COCKPIT_MEDIA_DIR || path.join(__dirname, '..', '.state', 'media'),
  mediaPython: process.env.COCKPIT_MEDIA_PYTHON || '',
  // Собственный кэш моделей речи: обычный transcribe работает fail-closed и никогда
  // не скачивает веса в общий ~/.cache. Все Python-spawn получают этот HF_HOME.
  mediaHfDir: process.env.COCKPIT_MEDIA_HF_DIR || path.join(__dirname, '..', '.state', 'hf'),
  // Эталон для воспроизводимого speed benchmark задаёт оператор: голосовой бинарный
  // asset не тащим в исходники и не подменяем речь бессмысленным тоном/тишиной.
  speechBenchmarkAudioPath: process.env.COCKPIT_SPEECH_BENCHMARK_AUDIO || '',

  // Вход в кокпит: учётка (логин + scrypt-хеш пароля) и сессии. Оба файла в .state (0600).
  // Один пользователь — пульт личный. Пароль задаётся при первом открытии или в install.sh,
  // меняется в настройках.
  authAccountPath: process.env.COCKPIT_AUTH_ACCOUNT || path.join(__dirname, '..', '.state', 'auth-account.json'),
  authSessionsPath: process.env.COCKPIT_AUTH_SESSIONS || path.join(__dirname, '..', '.state', 'auth-sessions.json'),
  // Токен для ЛОКАЛЬНЫХ CLI-потребителей API (bin/b24, ship-этап фабрики, скиллы):
  // файл 0600 на этой же машине. Кто может его прочитать — уже владеет всеми кредами .state.
  cliTokenPath: process.env.COCKPIT_CLI_TOKEN_PATH || path.join(__dirname, '..', '.state', 'cli-token'),
  // Проверка и применение релизов Cockpit. Это runtime-state машины, не часть релиза.
  cockpitUpdateStatePath: process.env.COCKPIT_UPDATE_STATE_PATH
    || path.join(__dirname, '..', '.state', 'cockpit-update.json'),
  // Пользовательские плагины: plugins/<id>/plugin.json (+server.js) в корне проекта.
  userPluginsDir: process.env.COCKPIT_PLUGINS_DIR || path.join(__dirname, '..', '..', 'plugins'),

  // TLS. Сертификат есть → поднимается ВТОРОЙ сокет (https) на своём порту, а http остаётся
  // жить на `port` — но из сети отдаёт только корневой сертификат и редирект на https
  // (см. lib/tls/local.js и plugins/http-scope.js).
  //
  // Почему не «https вместо http»: 8140 — внутренняя шина. По нему ходят MCP разрешений чата
  // (иначе каждое действие агента автоматически отклоняется), `bin/b24` (через него SHIP-этап
  // фабрики пишет комментарий в задачу), `bin/restart`, dev-прокси Vite и шлюз с VPS. Все они
  // остаются на http/loopback и ничего не знают про сертификат. Бонусом `http://localhost:8140`
  // — сам по себе secure context, поэтому на самом мозге PWA работает без установки корня.
  //
  // Прямо связано с авторизацией: по http пароль уходит открытым текстом, поэтому для доступа
  // вне localhost TLS обязателен, иначе вход декоративный. От него же зависит флаг Secure
  // у сессионной cookie (решается по запросу — Fastify смотрит на сокет).
  //
  // Терминируем сами, без прокси: на этом порту живут SSE (`/api/events`) и
  // WebSocket-терминал (`/api/terminal`) — именно эти потоки обычно и ломает лишний прокси.
  //
  // Пути из env — приоритетный override (шлюз, ручные случаи). Пусто → берём то, что
  // выпущено из «Настроек» и лежит в `tlsDir` с маркером `state.json`.
  tlsKeyPath: process.env.COCKPIT_TLS_KEY || '',
  tlsCertPath: process.env.COCKPIT_TLS_CERT || '',
  tlsPort: Number(process.env.COCKPIT_TLS_PORT) || 8143,
  tlsDir: process.env.COCKPIT_TLS_DIR || path.join(__dirname, '..', '.state', 'tls'),
  // Ключ корневого сертификата — ВНЕ репозитория. Причины конкретные: `server/.state` лежит
  // внутри дерева проекта, поэтому его утащит любой `tar` папки, а плагин «Код» отдаёт по HTTP
  // любой файл под корнем зарегистрированного репозитория — `GET /api/code/<проект>/file?path=
  // server/.state/tls/ca.key` вернул бы приватный ключ CA прямо в JSON.
  tlsCaDir: process.env.COCKPIT_TLS_CA_DIR || path.join(home, '.config', 'cockpit', 'ca'),

  // Работа за доверенным шлюзом (VPS с Caddy + обратный туннель). Пусто → выключено.
  //
  // Значение уходит в Fastify как `trustProxy` и должно перечислять ИМЕННО адрес соседа,
  // от которого приходят запросы (для SSH-туннеля это `127.0.0.1`), а НЕ `true`. С `true`
  // любой клиент сам назначал бы себе адрес через `X-Forwarded-For`: лимит попыток входа
  // обходился бы сменой заголовка, а проверка «настройка только с localhost» — подделкой.
  //
  // Что включается: `request.protocol` начинает учитывать `X-Forwarded-Proto` (от него зависит
  // флаг Secure у сессионной cookie) и `request.ip` становится реальным адресом клиента,
  // а не адресом шлюза (иначе все попытки входа схлопнулись бы в одно ведро).
  trustProxy: process.env.COCKPIT_TRUST_PROXY || '',

  // Публичный домен кокпита за шлюзом (например `cockpit.example.ru`). Пусто → шлюза нет.
  // Нужен валидатору имён для сертификатов по требованию: разрешаем сам домен и `p<порт>.<домен>`
  // с портом из диапазонов стендов, остальное — отказ (иначе нас заставят выпускать сертификаты
  // на чужие имена, пока не упрёмся в лимиты Let's Encrypt).
  publicDomain,

  // Установка шлюза из «Настроек»: свой ключ доступа к VPS, свой known_hosts и слепок установки.
  // Отдельный каталог, а не `tlsDir`: у ключа доступа к чужой машине и у сертификата разная цена
  // ошибки, и складывать их в одну кучу нельзя. Секретов человека (пароль root, токен DNS) здесь
  // НЕТ вовсе — они живут только в памяти процесса на время установки.
  gatewayDir: process.env.COCKPIT_GATEWAY_DIR || path.join(__dirname, '..', '.state', 'gateway'),

  // Машинные переменные кокпита. Установщик шлюза дописывает сюда `COCKPIT_TRUST_PROXY`
  // и `COCKPIT_PUBLIC_DOMAIN` — их читают ВСЕ три способа запуска (юнит systemd, bin/cockpit,
  // bin/restart), поэтому другого места у них нет (см. docs/cockpit/gotchas.md).
  envPath: process.env.COCKPIT_ENV_FILE || path.join(rootDir, '.env'),

  // Режим.
  isDev: process.env.NODE_ENV === 'development',
};
