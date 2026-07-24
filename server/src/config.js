// Единая конфигурация сервера кокпита.
// Всё, что зависит от машины/окружения, — только здесь (задел «сменный мозг»).
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const home = os.homedir();

export const config = {
  // Сеть. HOST=0.0.0.0 — чтобы окно (планшет) достучалось через Tailscale.
  port: Number(process.env.COCKPIT_PORT) || 8140,
  host: process.env.COCKPIT_HOST || '0.0.0.0',

  // Пути «мозга».
  stateDir: process.env.FACTORY_STATE_DIR || path.join(home, '.factory', 'state'),
  factoryHome: process.env.FACTORY_HOME || path.join(home, 'Workspace', 'factory'),
  factoryBin: process.env.COCKPIT_FACTORY_BIN || path.join(process.env.FACTORY_HOME || path.join(home, 'Workspace', 'factory'), 'bin', 'factory'),
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
  // каждый маршрут — файл routes/<id>.json (цепочка агентов + возвраты).
  routesDir: process.env.COCKPIT_ROUTES_DIR || path.join(__dirname, '..', '..', 'routes'),

  // Собранный фронт (по умолчанию отдаём тем же сервером — один origin).
  webDist: process.env.COCKPIT_WEB_DIST || path.join(__dirname, '..', '..', 'web', 'dist'),

  // Токен на мутации (POST/PUT/DELETE). Пусто → мутации открыты внутри доверенной сети
  // (Tailscale). Для боевого доступа задать COCKPIT_TOKEN.
  mutateToken: process.env.COCKPIT_TOKEN || '',

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

  // Команда сноса стенда (проектно-специфична) — задаётся окружением, {task} подставляется.
  // Пусто → кнопка «снести стенд» отвечает «не настроено». Без хардкода путей проекта.
  sandboxDownCmd: process.env.COCKPIT_SANDBOX_DOWN_CMD || '',

  // Медиа-конвейер (распознавание речи). Python venv — через COCKPIT_MEDIA_PYTHON
  // (venv тяжёлый, переиспользуем; читается в media/preflight.js). Хранилище job'ов/медиа.
  mediaDir: process.env.COCKPIT_MEDIA_DIR || path.join(__dirname, '..', '.state', 'media'),
  mediaPython: process.env.COCKPIT_MEDIA_PYTHON || '',

  // Режим.
  isDev: process.env.NODE_ENV === 'development',
};
