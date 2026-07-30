// Единая конфигурация сервера кокпита.
// Всё, что зависит от машины/окружения, — только здесь (задел «сменный мозг»).
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const home = os.homedir();
const rootDir = path.join(__dirname, '..', '..');
const factoryHome = process.env.FACTORY_HOME || path.join(rootDir, 'engine');

export const config = {
  // Сеть. HOST=0.0.0.0 — чтобы окно (планшет) достучалось через Tailscale.
  port: Number(process.env.COCKPIT_PORT) || 8140,
  host: process.env.COCKPIT_HOST || '0.0.0.0',

  // Пути «мозга».
  // Корень репозитория кокпита — от него считаются bin/restart, plugins/ и базы в корне.
  rootDir,
  stateDir: process.env.FACTORY_STATE_DIR || path.join(home, '.factory', 'state'),
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
  // Бинарь Codex CLI (GPT-исполнитель OpenAI). Не установлен → провайдер «недоступен».
  codexBin: process.env.COCKPIT_CODEX_BIN || 'codex',
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
  chatsDir: process.env.COCKPIT_CHATS_DIR || path.join(__dirname, '..', '..', 'chats'),
  // Старое хранилище одним файлом — только для одноразовой миграции.
  chatStoreLegacyPath: process.env.COCKPIT_CHAT_STORE || path.join(__dirname, '..', '.state', 'chats.json'),

  // База агентов (стадий конвейера) — папка в корне проекта (внутри свой .gitignore,
  // как chats/): каждый агент — файл agents/<id>.md (frontmatter + промпт).
  agentsDir: process.env.COCKPIT_AGENTS_DIR || path.join(__dirname, '..', '..', 'agents'),

  // База маршрутов конвейера — папка в корне проекта (внутри свой .gitignore):
  // routes/<профиль>/<id>.json + сайдкары промптов routes/<профиль>/<id>/<этап>.md.
  routesDir: process.env.COCKPIT_ROUTES_DIR || path.join(__dirname, '..', '..', 'routes'),

  // Собранный фронт (по умолчанию отдаём тем же сервером — один origin).
  webDist: process.env.COCKPIT_WEB_DIST || path.join(__dirname, '..', '..', 'web', 'dist'),


  // Битрикс24. Куки и креды — В СВОЁМ каталоге (изоляция: свой cookie-файл = нет
  // session-thrash). Портал/креды задаются из «Настроек» и живут в .state (gitignore).
  // Никаких проектных значений по умолчанию в коде — пустой кокпит не знает ничего.
  b24BaseUrl: process.env.COCKPIT_B24_BASE_URL || '',
  b24CookiePath: process.env.B24_COOKIE_PATH || path.join(__dirname, '..', '.state', 'b24-cookies.json'),
  b24CredsPath: process.env.B24_CREDS_PATH || path.join(__dirname, '..', '.state', 'b24-creds.json'),

  // Общие настройки кокпита (редактируются из UI, живут в .state).
  prefsPath: process.env.COCKPIT_PREFS_PATH || path.join(__dirname, '..', '.state', 'prefs.json'),

  // Триаж задач: разведка кода headless-агентом без стенда. Результаты (оценки + разведнота)
  // живут рядом с состоянием фабрики, но в своём каталоге — фабрика про них не знает.
  analysisDir: process.env.COCKPIT_ANALYSIS_DIR || path.join(home, '.factory', 'analysis'),
  analysisModel: process.env.COCKPIT_ANALYSIS_MODEL || 'sonnet',
  analysisTimeoutMs: Number(process.env.COCKPIT_ANALYSIS_TIMEOUT_MS) || 20 * 60 * 1000,
  // Параллельных оценок триажа: 1 воркер на очереди в 70 задач — это часы ожидания.
  analysisConcurrency: Number(process.env.COCKPIT_ANALYSIS_CONCURRENCY) || 2,

  // Автоматическое ревью GitHub PR. Это отдельное состояние: оно не создаёт и не
  // переписывает t<TASK>.pipeline фабрики. В каталоге лежат снимки, рекомендации,
  // review-runs и их изолированные worktree.
  reviewsDir: process.env.COCKPIT_REVIEWS_DIR || path.join(__dirname, '..', '.state', 'reviews'),
  reviewPollMs: Number(process.env.COCKPIT_REVIEW_POLL_MS) || 5 * 60 * 1000,
  reviewDebounceMs: Number(process.env.COCKPIT_REVIEW_DEBOUNCE_MS) || 45 * 1000,
  reviewAnalysisConcurrency: Number(process.env.COCKPIT_REVIEW_ANALYSIS_CONCURRENCY) || 1,
  reviewAnalysisTimeoutMs: Number(process.env.COCKPIT_REVIEW_ANALYSIS_TIMEOUT_MS) || 30 * 60 * 1000,
  // Анализатор и переводчик запускаются новыми read-only сессиями Codex. Модель
  // меняется окружением без хардкода проектного профиля.
  reviewProvider: process.env.COCKPIT_REVIEW_PROVIDER || 'codex',
  reviewModel: process.env.COCKPIT_REVIEW_MODEL || 'gpt-5.6-sol',
  reviewEffort: process.env.COCKPIT_REVIEW_EFFORT || 'high',

  // Команда сноса стенда (проектно-специфична) — задаётся окружением, {task} подставляется.
  // Пусто → кнопка «снести стенд» отвечает «не настроено». Без хардкода путей проекта.
  sandboxDownCmd: process.env.COCKPIT_SANDBOX_DOWN_CMD || '',

  // Медиа-конвейер (распознавание речи). Runtime-venv из server/.state подключается через
  // COCKPIT_MEDIA_PYTHON; читается в media/preflight.js. Хранилище job'ов/медиа.
  mediaDir: process.env.COCKPIT_MEDIA_DIR || path.join(__dirname, '..', '.state', 'media'),
  mediaPython: process.env.COCKPIT_MEDIA_PYTHON || '',

  // Вход в кокпит: учётка (логин + scrypt-хеш пароля) и сессии. Оба файла в .state (0600).
  // Один пользователь — пульт личный. Пароль задаётся при первом открытии или в install.sh,
  // меняется в настройках.
  authAccountPath: process.env.COCKPIT_AUTH_ACCOUNT || path.join(__dirname, '..', '.state', 'auth-account.json'),
  authSessionsPath: process.env.COCKPIT_AUTH_SESSIONS || path.join(__dirname, '..', '.state', 'auth-sessions.json'),
  // Токен для ЛОКАЛЬНЫХ CLI-потребителей API (bin/b24, ship-этап фабрики, скиллы):
  // файл 0600 на этой же машине. Кто может его прочитать — уже владеет всеми кредами .state.
  cliTokenPath: process.env.COCKPIT_CLI_TOKEN_PATH || path.join(__dirname, '..', '.state', 'cli-token'),
  // Пользовательские плагины: plugins/<id>/plugin.json (+server.js) в корне проекта.
  userPluginsDir: process.env.COCKPIT_PLUGINS_DIR || path.join(__dirname, '..', '..', 'plugins'),

  // TLS. Пусто → http. Задать оба пути → Fastify слушает https на том же порту.
  //
  // Прямо связано с авторизацией: по http пароль уходит открытым текстом, поэтому для доступа
  // вне localhost TLS обязателен, иначе вход декоративный. От него же зависит флаг Secure
  // у сессионной cookie.
  //
  // Терминируем в самом Fastify, без прокси: на этом порту живут SSE (`/api/events`) и
  // WebSocket-терминал (`/api/terminal`) — именно эти потоки обычно и ломает лишний прокси.
  tlsKeyPath: process.env.COCKPIT_TLS_KEY || '',
  tlsCertPath: process.env.COCKPIT_TLS_CERT || '',

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
  publicDomain: process.env.COCKPIT_PUBLIC_DOMAIN || '',

  // Режим.
  isDev: process.env.NODE_ENV === 'development',
};
