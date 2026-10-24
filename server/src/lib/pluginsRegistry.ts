// Реестр плагинов GrigDesk. Плагин = отключаемый функциональный блок со своей
// плашкой в «Настройки → Плагины» и (опционально) пунктом в сайдбаре.
//
// Два источника:
//  • СИСТЕМНЫЕ (из коробки) — описаны в SYSTEM ниже. Их код — обычные модули сервера
//    и вьюхи фронта, собранные в бандл; «плагинность» для них = вкл/выкл + настройки.
//  • ПОЛЬЗОВАТЕЛЬСКИЕ — папки plugins/<id>/ в папке данных: plugin.json (манифест
//    той же формы, что SYSTEM-записи) + опционально server.js (default-экспорт
//    fastify-плагина; регистрируется на старте, роуты обязаны жить под /api/ext/<id>/)
//    + опционально своя страница (`web`: папка с index.html — GrigDesk раздаёт её под
//    /api/ext/<id>/web/ и показывает панелью в рейке или страницей по nav.path).
//    Выключенный пользовательский плагин не регистрируется вовсе (вкл/выкл — рестарт).
//
// Состояние (вкл/выкл, значения настроек) — в prefs (state/prefs.json в папке данных):
//   plugins:        { <id>: true|false }   — отсутствие ключа = дефолт манифеста
//                                            (defaultEnabled, иначе системный вкл / пользовательский выкл)
//   pluginSettings: { <id>: {key: value} }
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { selectPluginServerEntry } from './pluginServerEntry.ts';
import { normalizePluginCategory } from '../../../shared/plugins/pluginsContracts.ts';
import type {
  PluginNav,
  PluginPlacementDecl,
  PluginPlacementState,
  PluginSetting,
  PluginSetup,
} from '../../../shared/plugins/pluginsContracts.ts';
import { PLUGIN_SLOT_LABELS, isPluginSlotName } from '../../../shared/plugins/slots/index.ts';
import { resolvePluginWebModule } from './pluginWebModule.ts';
import type { ResolvedPluginWebModule } from './pluginWebModule.ts';

export type { PluginNav, PluginPlacementDecl, PluginPlacementState, PluginSetting, PluginSetup };

// Манифест плагина: системного из SYSTEM или пользовательского из plugin.json.
export interface PluginManifest {
  id: string;
  system?: boolean;
  defaultEnabled?: boolean;
  name: string;
  api?: number;
  version: string;
  description: string;
  // Род работы для раздела настроек; значения — из общего контракта категорий.
  category?: string;
  nav: PluginNav | null;
  settings: PluginSetting[];
  // Слоты, которые плагин умеет занимать; тумблер на каждое место — в его настройках.
  placements?: PluginPlacementDecl[];
  // Ручка готовности: что плагину нужно на машине и что он ставит сам. Объявляют
  // только системные плагины — у пользовательского серверной части такого рода нет.
  setup?: PluginSetup | null;
  dir?: string;
  hasServer?: boolean;
  serverEntry?: 'server.js' | 'server.ts' | null;
  serverError?: string | null;
  // Своя страница пользовательского плагина: каталог с index.html и адрес, под которым
  // GrigDesk его раздаёт. Ядро не исполняет этот код — оно лишь показывает страницу.
  web?: PluginWebPage | null;
  webModule?: ResolvedPluginWebModule | null;
}

export interface PluginWebPage {
  dir: string;
  url: string;
}

// Журнал сервера в том минимуме, который использует скан.
interface RegistryLog {
  warn?: (fields: Record<string, unknown>, message: string) => void;
}

/** Системные плагины из коробки. */
export const SYSTEM: PluginManifest[] = [
  {
    id: 'video',
    system: true,
    name: 'Видео → задачи',
    version: '1.0.0',
    description: 'Разбор видеозаписи встречи: распознавание речи (whisper), выжимка по темам, черновики задач в Б24 со скриншотами.',
    category: 'work',
    nav: { path: '/video', label: 'Видео', icon: 'video', group: 'tools', order: 10 },
    // Настройки распознавания диктовки и видео живут в едином speech-контракте.
    // Здесь — только то, что делают С УЖЕ ГОТОВОЙ расшифровкой.
    settings: [
      {
        key: 'triageModel',
        label: 'Модель для разбора встречи',
        type: 'model',
        // Своя настройка, а не общая с «Входящими»: там модель читает обращение
        // одного человека, здесь — разговор нескольких, и выбор модели у этих
        // задач разный. Молчаливого fallback на чужой плагин нет: он связал бы
        // два раздела скрытой зависимостью.
        hint: 'Кнопка «Разобрать на задачи» отдаёт расшифровку модели, и та предлагает черновики. '
          + 'Расшифровка — чужая речь, поэтому нужен безопасный режим недоверенного ввода: '
          + 'подходят Claude и GPT через Codex. '
          + 'Не выбрана — задачи собираются вручную, как раньше.',
        default: null,
      },
    ],
  },
  {
    id: 'code',
    system: true,
    name: 'Код',
    version: '1.0.0',
    description: 'Код и Git проектов как в VS Code: дерево файлов, staged/unstaged '
      + 'изменения, коммиты и push для основного репозитория или worktree. Пути '
      + 'репозиториев — в разделе «Проекты».',
    category: 'dev',
    nav: { path: '/code', label: 'Код', icon: 'code', group: 'dock', order: 10 },
    settings: [
      {
        key: 'commitMessageModel',
        label: 'Модель для сообщения коммита',
        type: 'model',
        hint: 'Кнопка генерации читает только staged diff и предлагает одно название '
          + 'коммита. Diff считается недоверенным вводом, поэтому подходят исполнители '
          + 'с безопасным model-only режимом: Claude и GPT через Codex.',
        default: null,
        requiresCapability: 'untrustedText',
      },
    ],
  },
  {
    id: 'analysis',
    system: true,
    defaultEnabled: true,
    name: 'Триаж',
    version: '1.0.0',
    description: 'Оценка сложности и рисков задачи с разведкой кода перед запуском конвейера.',
    category: 'work',
    nav: null,
    settings: [
      {
        key: 'triageModel',
        label: 'Модель для оценки задач',
        type: 'model',
        hint: 'Исполнитель читает репозитории профиля в изолированной рабочей области.',
        default: null,
        requiresCapability: 'scopedWorkspace',
      },
      {
        key: 'autoArbitrate',
        label: 'Автоматически разбирать вопросы по коду',
        type: 'checkbox',
        hint: 'Продуктовые решения, приоритеты и изменение границы задачи всегда остаются человеку.',
        default: false,
      },
    ],
  },
  {
    id: 'shelf',
    system: true,
    defaultEnabled: true,
    name: 'Полка',
    version: '1.0.0',
    description: 'Личный список задач Б24, по которым человек ждёт оценку, '
      + 'событие конвейера или новые комментарии.',
    category: 'work',
    nav: { path: '/shelf', label: 'Полка', icon: 'shelf', group: 'dock', order: 20 },
    settings: [
      {
        key: 'browserNotifications',
        label: 'Оповещать в браузере',
        type: 'checkbox',
        hint: 'Новое событие по задаче на полке даёт одно оповещение: в окне GrigDesk или системное, '
          + 'если GrigDesk свёрнут',
        default: true,
      },
      {
        key: 'autoAddOnAnalysis',
        label: 'Класть на полку при запуске оценки',
        type: 'checkbox',
        hint: 'Любой запуск триажа автоматически добавляет задачу с причиной «жду оценку».',
        default: true,
      },
    ],
  },
  {
    id: 'inbox',
    system: true,
    defaultEnabled: true,
    name: 'Входящие',
    version: '1.0.0',
    description: 'Единая очередь новых обращений из подключённых каналов с ручным разбором и созданием задач в Б24.',
    category: 'work',
    nav: { path: '/inbox', label: 'Входящие', icon: 'inbox', group: 'rail', order: 30 },
    settings: [
      {
        key: 'triageModel',
        label: 'Модель для разбора',
        type: 'model',
        hint: 'Одна модель разбирает обращения всех активных каналов. '
          + 'Нужен безопасный Inbox-режим и поддержка изображений: '
          + 'подходят Claude и GPT через Codex. '
          + 'Пока совместимая модель не выбрана, автоматические задачи не создаются.',
        default: null,
      },
      // Разбора вложений эти галки не касаются: речь и кадры видео модель читает
      // всегда, настройка решает только, что уезжает файлом НА ПОРТАЛ.
      {
        key: 'attachPhotos',
        label: 'Прикладывать фотографии к задаче',
        type: 'checkbox',
        hint: 'Снимок экрана в задаче обычно и есть постановка, поэтому фотографии загружаются на портал.',
        default: true,
      },
      {
        key: 'attachVideos',
        label: 'Прикладывать видео к задаче',
        type: 'checkbox',
        hint: 'Видео весит десятки мегабайт, а его содержимое уже пересказано транскриптом в описании. Включай, когда важна сама запись.',
        default: false,
      },
    ],
  },
  {
    id: 'telegram',
    system: true,
    // Системный (нужны своя страница, адаптер трекера и запуск конвейера), но
    // ВЫКЛЮЧЕН по умолчанию: раздел просит токен бота, и появляться сам, без
    // спроса, у всех установок он не должен.
    defaultEnabled: false,
    name: 'Телеграм',
    version: '0.1.0',
    description: 'Подключение Telegram Bot API, нативный архив и allowlist чатов для общего раздела «Входящие».',
    category: 'work',
    nav: { path: '/telegram', label: 'Телеграм', icon: 'telegram', group: 'tools', order: 20 },
    settings: [],
  },
  {
    id: 'github',
    system: true,
    defaultEnabled: false,
    name: 'GitHub Issues',
    version: '0.1.0',
    description: 'Подключение одного GitHub repository: новые Issues поступают в общий раздел «Входящие» через подписанный webhook и REST-сверку.',
    category: 'work',
    nav: { path: '/github', label: 'GitHub', icon: 'github', group: 'tools', order: 30 },
    settings: [],
  },
  {
    id: 'ssh',
    system: true,
    defaultEnabled: false,
    name: 'SSH',
    version: '0.1.0',
    description: 'Терминал и SFTP для человека, надзорное выполнение команд для агента.',
    category: 'dev',
    nav: { path: '/ssh', label: 'SSH', icon: 'ssh', group: 'dock', order: 40 },
    settings: [
      {
        key: 'outputLimitKiB',
        label: 'Лимит вывода, KiB',
        type: 'number',
        default: 64,
        min: 4,
        max: 1024,
        step: 4,
        hint: 'Начало и конец более длинного вывода сохраняются, середина удаляется.',
      },
      {
        key: 'echoToTerminal',
        label: 'Эхо команд агента в терминал',
        type: 'checkbox',
        default: true,
        hint: 'Команда и её вывод видны в открытом терминале сессии по мере выполнения.',
      },
    ],
  },
  {
    id: 'db',
    system: true,
    defaultEnabled: false,
    name: 'Базы',
    version: '0.1.0',
    description: 'Надзорный доступ человека и агента к базам данных без хранения паролей.',
    category: 'dev',
    nav: { path: '/db', label: 'Базы', icon: 'db', group: 'dock', order: 50 },
    settings: [
      {
        key: 'allowDdlAdmin',
        label: 'Разрешить DDL и административные команды',
        type: 'checkbox',
        default: false,
        hint: 'При выключенной настройке такие запросы отклоняются без вопроса человеку.',
      },
      {
        key: 'autoRead',
        label: 'Не подтверждать безопасное чтение',
        type: 'checkbox',
        default: false,
        hint: 'Действует только при подтверждённых read-only правах и соблюдении всех лимитов.',
      },
      {
        key: 'autoReadProd',
        label: 'Автоподтверждение чтения на проде',
        type: 'checkbox',
        default: false,
        hint: 'Отдельный допуск для профилей с признаком «прод».',
      },
      {
        key: 'strictClientPolicy',
        label: 'Блокировать неразобранные вызовы DB-клиентов',
        type: 'checkbox',
        default: false,
        hint: 'Неясная форма команды Bash отклоняется до запуска.',
      },
      {
        key: 'maxRows',
        label: 'Лимит строк результата',
        type: 'number',
        default: 1000,
        min: 1,
        max: 100000,
        step: 1,
      },
      {
        key: 'maxBytesKiB',
        label: 'Лимит результата, KiB',
        type: 'number',
        default: 256,
        min: 4,
        max: 16384,
        step: 4,
      },
      {
        key: 'timeoutSeconds',
        label: 'Таймаут запроса, секунд',
        type: 'number',
        default: 15,
        min: 1,
        max: 300,
        step: 1,
      },
      {
        key: 'autoReadPerMinute',
        label: 'Авточтений в минуту',
        type: 'number',
        default: 10,
        min: 1,
        max: 120,
        step: 1,
      },
      {
        key: 'idleCloseMinutes',
        label: 'Закрывать по простою, минут',
        type: 'number',
        default: 15,
        min: 1,
        max: 240,
        step: 1,
      },
    ],
  },
  {
    id: 'docker',
    system: true,
    // Выключен по умолчанию: панель показывает контейнеры ВСЕЙ машины, а не только
    // стенды GrigDesk, и появляться сама, без спроса, у каждой установки не должна.
    defaultEnabled: false,
    name: 'Докер',
    version: '0.1.0',
    description: 'Обзор локального Docker: контейнеры и compose-проекты, порты, образы, '
      + 'тома и сети, логи и терминал контейнера, очистка неиспользуемого места.',
    category: 'dev',
    nav: { path: '/docker', label: 'Докер', icon: 'docker', group: 'dock', order: 60 },
    settings: [
      {
        key: 'allowVolumeRemoval',
        label: 'Разрешить удаление томов',
        type: 'checkbox',
        default: false,
        hint: 'В томах лежат базы стендов. Пока настройка выключена, сервер отклоняет '
          + 'и удаление отдельного тома, и очистку неиспользуемых.',
      },
      {
        key: 'allowImagePruneAll',
        label: 'Разрешить очистку всех неиспользуемых образов',
        type: 'checkbox',
        default: false,
        hint: 'Без неё очистка убирает только висячие образы без тегов. С ней кнопка '
          + 'сможет снести любой образ, под которым сейчас нет контейнера, — включая '
          + 'редко используемые, но нужные.',
      },
      {
        key: 'allowExec',
        label: 'Терминал внутрь контейнера',
        type: 'checkbox',
        default: true,
        hint: 'Оболочка запускается от пользователя образа и живёт, пока открыта вкладка.',
      },
      {
        key: 'logTailLines',
        label: 'Строк лога при открытии',
        type: 'number',
        default: 500,
        min: 50,
        max: 10000,
        step: 50,
      },
      {
        key: 'statsIntervalSeconds',
        label: 'Период обновления статистики, секунд',
        type: 'number',
        default: 3,
        min: 1,
        max: 60,
        step: 1,
        hint: 'Срез CPU и памяти сервер снимает сам и шлёт одним сообщением на все '
          + 'видимые контейнеры.',
      },
    ],
  },
  {
    id: 'showcase',
    system: true,
    // Выключен по умолчанию: раздел открывает браузер по адресу стенда, синтезирует
    // речь у внешнего поставщика и складывает видео. Такое не должно появляться
    // само у каждой установки — его включает человек, объявив контракт профиля.
    defaultEnabled: false,
    name: 'Презентации',
    version: '0.1.0',
    description: 'Ролик о готовой работе по сценам: сценарий, озвучка, запись браузера '
      + 'и сборка mp4 с субтитрами. Адреса, экраны и вход берутся из объявления профиля.',
    category: 'knowledge',
    nav: { path: '/showcase', label: 'Презентации', icon: 'video', group: 'tools', order: 50 },
    // Разделу нужны браузер записи, ffmpeg, голос и распознавание: что из этого
    // есть и что можно поставить кнопкой, показывают настройки плагина.
    setup: { path: '/api/showcase/setup' },
    settings: [
      {
        key: 'scriptModel',
        label: 'Модель для брифа и сценария',
        type: 'model',
        hint: 'Модель составляет сценарий и проверяет кадры пробного прохода. '
          + 'Нужны поддержка изображений и безопасный режим недоверенного ввода: '
          + 'подходят Claude и GPT через Codex.',
        default: null,
        requiresCapability: 'untrustedText',
      },
      {
        key: 'retentionDays',
        label: 'Срок хранения завершённых роликов, дней',
        type: 'number',
        default: 30,
        min: 1,
        max: 365,
        step: 1,
        hint: 'Считается для незакреплённых результатов без живых ссылок. Закреплённый '
          + 'ролик и файлы идущей работы остаются независимо от срока.',
      },
      {
        key: 'maxScenes',
        label: 'Предел числа сцен в ролике',
        type: 'number',
        default: 20,
        min: 1,
        max: 100,
        step: 1,
        hint: 'Проверяется до запуска: превышение видно человеку заранее, а не после '
          + 'получаса записи.',
      },
    ],
  },
  {
    id: 'studio3d',
    system: true,
    defaultEnabled: false,
    name: '3D',
    version: '1.0.0',
    description: 'Трёхмерные модели через 3D-исполнителей: создание, библиотека с поиском '
      + 'и версиями, просмотр, скелет и движения, экспорт в проект. Выключение блокирует '
      + 'новые заказы; принятые продолжаются. После запуска сервера с выключенным плагином '
      + 'скачивание ждёт включения; срок хранения результатов у поставщика не гарантирован.',
    category: 'dev',
    nav: {
      path: '/3d',
      label: '3D',
      icon: 'cube',
      group: 'dock',
      order: 30,
    },
    settings: [
      {
        key: 'autoImport',
        label: 'Подтягивать прошлые заказы и заказы агентов',
        type: 'checkbox',
        default: true,
        hint: 'Записи task.json в проектах и история трат исполнителя.',
      },
      {
        key: 'lowDiskGb',
        label: 'Предупреждать, когда свободно меньше, ГБ',
        type: 'number',
        default: 10,
        min: 1,
        max: 1000,
        step: 1,
      },
      {
        key: 'libraryDir',
        label: 'Папка библиотеки',
        type: 'text',
        default: '',
        hint: 'Пусто — 3d в папке данных. Смена после завершения заданий, без переноса файлов.',
      },
    ],
  },
  {
    id: 'usage-forecast',
    system: true,
    // Включён по умолчанию: блок читает те же снимки лимитов, что и полосы, ничего не
    // запускает и наружу не ходит.
    defaultEnabled: true,
    name: 'Прогноз лимитов',
    version: '0.1.0',
    description: 'Хватит ли окна лимита до сброса при вашем темпе: '
      + 'по снимкам полос исполнителей, без запросов к вендорам сверх обычных.',
    category: 'dev',
    nav: null,
    placements: [{ slot: 'provider.popover.after-bars', default: true }],
    settings: [
      {
        key: 'providers',
        label: 'Исполнители',
        type: 'providers',
        default: [],
        hint: 'У остальных полосы не замеряются и блока во всплывашке нет.',
      },
      {
        key: 'sampleTickMinutes',
        label: 'Фоновый замер без окон, минут',
        type: 'number',
        default: 15,
        min: 0,
        max: 120,
        step: 5,
        hint: 'Пока открыто окно GrigDesk, замеры приносит обычный тик лимитов; без окон '
          + 'плагин перечитывает их сам с этим шагом. 0 — не замерять без окон.',
      },
    ],
  },
];

export const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;
export const NAV_GROUPS = ['rail', 'tools', 'dock'];

export type UserManifestFields = Pick<PluginManifest,
  'id' | 'system' | 'name' | 'api' | 'version' | 'description'
  | 'category' | 'nav' | 'settings' | 'placements'
> & { webDir: string | null };

/**
 * Installer и scanner читают принятый manifest через одну чистую функцию.
 * Политика допуска и проверки файлов остаётся у соответствующего caller.
 */
export function decodeUserPluginManifest(
  raw: Record<string, unknown>,
  warn: (message: string) => void = () => {},
): UserManifestFields {
  const name = String(raw.name || raw.id);
  const nav = raw.nav !== null && typeof raw.nav === 'object' && !Array.isArray(raw.nav)
    ? raw.nav : null;

  return {
    id: String(raw.id),
    system: false,
    name,
    api: Number(raw.api || 1),
    version: String(raw.version || '0.0.0'),
    description: String(raw.description || ''),
    category: userPluginCategory(raw.category, warn),
    nav: normalizePluginNav(nav, name, warn),
    settings: Array.isArray(raw.settings) ? raw.settings as PluginSetting[] : [],
    placements: normalizePlacements(raw.placements, warn),
    webDir: normalizePluginPackagePath(raw.web, false),
  };
}

/**
 * Относительный путь пакета использует posix форму и не может выйти из корня.
 * Корень разрешён только для npm; scanner и installer получают одинаковую форму web.
 */
export function normalizePluginPackagePath(raw: unknown, rootAllowed: boolean): string | null {
  if (typeof raw !== 'string' || !raw || path.posix.isAbsolute(raw) || /[\\\x00-\x1f\x7f]/u.test(raw)) {
    return null;
  }

  const relative = path.posix.normalize(raw).replace(/\/$/u, '');

  if (relative === '..' || relative.startsWith('../') || relative === '.' && !rootAllowed) {
    return null;
  }

  return relative;
}

/**
 * Положение ссылки — только декларация навигации. Оно не даёт пользовательскому
 * плагину права загрузить Vue-код: клиентский runtime встроенных инструментов
 * остаётся отдельным реестром во фронте.
 */
export function normalizePluginNav(
  raw: { path?: unknown; label?: unknown; icon?: unknown; group?: unknown; order?: unknown } | null,
  fallbackLabel: string,
  warn: ((message: string) => void) | null = null,
): PluginNav | null {
  if (!raw?.path) return null;
  const requested = raw.group == null ? '' : String(raw.group).trim();
  const group = NAV_GROUPS.includes(requested) ? requested : 'rail';
  if (!requested || group !== requested) {
    warn?.(`nav.group «${requested || 'не задан'}» не поддерживается — ссылка помещена в rail`);
  }
  const order = typeof raw.order === 'number' ? raw.order : Number.NaN;
  return {
    path: String(raw.path),
    label: String(raw.label || fallbackLabel),
    icon: String(raw.icon || 'plugin'),
    group,
    ...(Number.isFinite(order) ? { order } : {}),
  };
}

/**
 * Категория пользовательского манифеста приводится к известной. Подмена заявленного
 * значения на «Прочее» не остаётся молчаливой: иначе автор плагина искал бы свою
 * группу на экране настроек, которого нет.
 */
function userPluginCategory(raw: unknown, warn: (message: string) => void): string {
  const category = normalizePluginCategory(raw);
  const requested = raw == null ? '' : String(raw).trim();

  if (requested && requested !== category) {
    warn(`category «${requested}» не поддерживается — плагин помещён в «Прочее»`);
  }

  return category;
}

/**
 * Страница пользовательского плагина: поле `web` — путь папки относительно каталога
 * плагина, внутри обязан лежать index.html. Абсолютный путь и выход за каталог
 * отвергаются: манифест называет свою папку, а не любое место на машине.
 */
async function resolvePluginWeb(
  dir: string,
  id: string,
  raw: unknown,
  warn: (message: string) => void,
): Promise<PluginWebPage | null> {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string' || path.isAbsolute(raw)) {
    warn('web должен быть относительным путём к папке страницы — страница пропущена');
    return null;
  }
  const webDir = path.resolve(dir, raw);
  if (!webDir.startsWith(`${path.resolve(dir)}${path.sep}`) && webDir !== path.resolve(dir)) {
    warn('web выходит за каталог плагина — страница пропущена');
    return null;
  }
  const index = await fs.stat(path.join(webDir, 'index.html')).then((s) => s.isFile()).catch(() => false);
  if (!index) {
    warn(`в папке страницы (${raw}) нет index.html — страница пропущена`);
    return null;
  }
  return { dir: webDir, url: `/api/ext/${id}/web/` };
}

/**
 * Скан пользовательских плагинов: plugins/<id>/plugin.json.
 * Битый манифест пропускается с warn — один плагин не валит остальные.
 */
export async function scanUserPlugins(
  userPluginsDir: string,
  log?: RegistryLog,
): Promise<PluginManifest[]> {
  const out: PluginManifest[] = [];
  let entries = [];
  try {
    entries = await fs.readdir(userPluginsDir, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const e of entries) {
    if (!e.isDirectory() || !PLUGIN_ID_RE.test(e.name)) {
      continue;
    }

    const dir = path.join(userPluginsDir, e.name);

    try {
      const m = JSON.parse(await fs.readFile(path.join(dir, 'plugin.json'), 'utf8'));

      if (!m.id || m.id !== e.name) {
        throw new Error(`id в манифесте («${m.id}») не совпадает с папкой «${e.name}»`);
      }

      const decoded = decodeUserPluginManifest(m, (message: string) => {
        log?.warn?.({ plugin: e.name }, message);
      });
      const { webDir, ...fields } = decoded;
      const webModule = fields.api === 2 ? resolvePluginWebModule(
        dir, m.id, m.webModule, normalizePluginPackagePath,
        (message) => log?.warn?.({ plugin: e.name }, message),
      ) : null;

      const [jsPresent, tsPresent] = await Promise.all(['server.js', 'server.ts'].map((entry) =>
        fs.access(path.join(dir, entry)).then(() => true).catch(() => false)));

      out.push({
        ...fields,
        nav: fields.nav ?? (webModule && m.nav == null ? {
          path: `/ext/${m.id}`,
          label: fields.name,
          icon: 'plugin',
          group: 'dock',
        } : null),
        dir,
        webModule,
        ...selectPluginServerEntry(jsPresent ?? false, tsPresent ?? false),
        web: await resolvePluginWeb(dir, m.id, webDir ?? m.web, (message: string) => {
          log?.warn?.({ plugin: e.name }, message);
        }),
      });
    } catch (err) {
      log?.warn?.(
        { plugin: e.name, err: (err as Error).message },
        'манифест пользовательского плагина не прочитан — пропущен',
      );
    }
  }
  return out;
}

/**
 * Включён ли плагин по prefs. Явный выбор человека сильнее любого умолчания;
 * умолчание объявляет сам манифест (`defaultEnabled`), иначе действует общее
 * правило «системный — включён, пользовательский — нет».
 */
export function isEnabled(
  prefsData: Record<string, unknown>,
  manifest: Pick<PluginManifest, 'id' | 'system' | 'defaultEnabled'>,
): boolean {
  const map = (prefsData.plugins || {}) as Record<string, unknown>;
  if (manifest.id in map) return !!map[manifest.id];
  return manifest.defaultEnabled ?? !!manifest.system;
}

/**
 * Размещения плагина с состоянием тумблеров: только слоты, известные оглавлению, —
 * место, которого в ядре нет, в настройках показывать нечего. Умолчание объявляет
 * манифест (`default`, иначе включено), сохранённое — prefs `pluginPlacements`.
 */
export function placementsState(
  prefsData: Record<string, unknown>,
  manifest: Pick<PluginManifest, 'id' | 'placements'>,
): PluginPlacementState[] {
  const stored = (prefsData.pluginPlacements || {}) as Record<string, unknown>;
  const saved = (stored[manifest.id] || {}) as Record<string, unknown>;
  const out: PluginPlacementState[] = [];

  for (const decl of manifest.placements || []) {
    if (!isPluginSlotName(decl.slot)) {
      continue;
    }

    out.push({
      slot: decl.slot,
      label: PLUGIN_SLOT_LABELS[decl.slot],
      enabled: decl.slot in saved ? !!saved[decl.slot] : decl.default ?? true,
    });
  }

  return out;
}

/**
 * Размещения чужого манифеста: массив записей со слотом из оглавления. Незнакомый
 * слот отбрасывается с предупреждением, а не роняет плагин — место могло появиться в
 * новой версии GrigDesk, которой на этой машине ещё нет.
 */
export function normalizePlacements(raw: unknown, warn: (message: string) => void): PluginPlacementDecl[] {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw)) {
    warn('placements манифеста должен быть массивом — размещения пропущены');

    return [];
  }

  const out: PluginPlacementDecl[] = [];

  for (const item of raw as Array<{ slot?: unknown; default?: unknown } | null>) {
    const slot = item && typeof item === 'object' ? item.slot : undefined;

    if (!isPluginSlotName(slot)) {
      warn(`неизвестный слот размещения: ${String(slot)}`);
      continue;
    }

    out.push({ slot, ...(typeof item?.default === 'boolean' && { default: item.default }) });
  }

  return out;
}

/** Значения настроек плагина: дефолты схемы, перекрытые сохранёнными. */
export function settingsValues(
  prefsData: Record<string, unknown>,
  manifest: Pick<PluginManifest, 'id' | 'settings'>,
): Record<string, unknown> {
  const stored = (prefsData.pluginSettings || {}) as Record<string, unknown>;
  const saved = (stored[manifest.id] || {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const s of manifest.settings || []) {
    out[s.key] = s.key in saved ? saved[s.key] : s.default;
  }
  return out;
}
