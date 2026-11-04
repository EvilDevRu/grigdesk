// Реестр плагинов GrigDesk. Плагин = отключаемый функциональный блок с настройками:
// системный — на тематической странице, пользовательский — во вкладке «Установленные».
// Пункт в сайдбаре необязателен.
//
// Два источника:
//  • СИСТЕМНЫЕ (из коробки) — описаны в SYSTEM ниже. Их код — обычные модули сервера
//    и вьюхи фронта, собранные в бандл; «плагинность» для них = вкл/выкл + настройки.
//  • ПОЛЬЗОВАТЕЛЬСКИЕ — папки plugins/<id>/ в папке данных: plugin.json (манифест
//    той же формы, что SYSTEM-записи) + опционально server.js (default-экспорт
//    fastify-плагина; регистрируется на старте, роуты обязаны жить под /api/ext/<id>/)
//    + модуль интерфейса и серверный вход, явно объявленные в entrypoints.
//
// Состояние (вкл/выкл, значения настроек) — в prefs (state/prefs.json в папке данных):
//   plugins:        { <id>: true|false }   — отсутствие ключа = дефолт манифеста
//                                            (defaultEnabled, иначе системный вкл / пользовательский выкл)
//   pluginSettings: { <id>: {key: value} }
import type {
  PluginMetadata as PluginManifest,
} from '../../../packages/plugin-types/src/manifest.ts';
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
import { isRecord } from '../../../shared/lib/objects.ts';
import { compareSemVer, parseSemVer } from './releaseCommon.ts';
import { installError, errorInfo } from './packageInstall/errors.ts';
import { pluginResourcePath, resolvePluginAssets } from './pluginAssets.ts';
import { resolvePluginWebModule } from './pluginWebModule.ts';

export type { PluginNav, PluginPlacementDecl, PluginPlacementState, PluginSetting, PluginSetup };

// Нормализованные метаданные отличаются от входного plugin.json автора.
export type { PluginMetadata as PluginManifest } from
  '../../../packages/plugin-types/src/manifest.ts';

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
    nav: {
      path: '/video',
      label: 'Видео',
      group: 'tools',
      order: 10,
    },
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
    nav: {
      path: '/code',
      label: 'Код',
      group: 'dock',
      order: 10,
    },
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
    nav: {
      path: '/shelf',
      label: 'Полка',
      group: 'dock',
      order: 20,
    },
    settings: [
      {
        key: 'browserNotifications',
        label: 'Оповещать о событиях полки',
        type: 'checkbox',
        hint: 'Новое событие по задаче на полке показывает оповещение в окне GrigDesk. '
          + 'Если окно свёрнуто или не в фокусе, добавляется системное уведомление.',
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
    nav: {
      path: '/inbox',
      label: 'Входящие',
      group: 'rail',
      order: 30,
    },
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
    nav: {
      path: '/telegram',
      label: 'Телеграм',
      group: 'tools',
      order: 20,
    },
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
    nav: {
      path: '/github',
      label: 'GitHub',
      group: 'tools',
      order: 30,
    },
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
    nav: {
      path: '/ssh',
      label: 'SSH',
      group: 'dock',
      order: 40,
    },
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
    nav: {
      path: '/db',
      label: 'Базы',
      group: 'dock',
      order: 50,
    },
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
    nav: {
      path: '/docker',
      label: 'Докер',
      group: 'dock',
      order: 60,
    },
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
    nav: {
      path: '/showcase',
      label: 'Презентации',
      group: 'tools',
      order: 50,
    },
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

for (const plugin of SYSTEM) {
  plugin.icon = `/plugin-icons/${plugin.id}.png`;
  plugin.compatibility = {
    status: 'compatible',
    code: null,
    reason: null,
  };
  plugin.contributes = {
    panels: plugin.nav ? [{ title: plugin.nav.label, group: plugin.nav.group as 'dock' }] : [],
    slots: (plugin.placements ?? []).map((placement) => ({ ...placement, kind: 'provider-usage' })),
    settings: plugin.settings,
  };
}

export const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;
export const NAV_GROUPS = ['rail', 'tools', 'dock'];

export type UserManifestFields = PluginManifest;

/**
 * Единый структурный допуск выполняется до файловых проверок и импорта кода.
 * Старые поля не адаптируются: совпадающее api=1 не означает новый контракт.
 */
export function decodeUserPluginManifest(
  raw: Record<string, unknown>,
  warn: (message: string) => void = () => {},
  grigDeskVersion = '0.0.0',
): UserManifestFields {
  const legacy = ['web', 'webModule', 'nav', 'settings', 'placements', 'minGrigDeskVersion'];

  if (raw.api === 2 || legacy.some((key) => Object.hasOwn(raw, key))
    || !Object.hasOwn(raw, 'entrypoints') || !Object.hasOwn(raw, 'contributes')) {
    throw installError('manifest_incompatible');
  }

  if (raw.api !== 1) {
    throw installError('api_unsupported');
  }

  if (typeof raw.id !== 'string' || !PLUGIN_ID_RE.test(raw.id)) {
    throw installError('id_invalid');
  }

  if (typeof raw.description !== 'string' || !raw.description.trim() || raw.description.length > 4096
    || !isRecord(raw.entrypoints) || !isRecord(raw.contributes)) {
    throw installError('manifest_invalid', 'нужны description, entrypoints и contributes');
  }

  pluginResourcePath(raw.icon);

  if (raw.engines !== undefined) {
    const minimum = isRecord(raw.engines) && typeof raw.engines.grigdesk === 'string'
      ? raw.engines.grigdesk.match(/^>=(\d+\.\d+\.\d+)$/u)?.[1] : null;

    if (!minimum || !parseSemVer(minimum)) {
      throw installError('manifest_invalid', 'engines.grigdesk должен быть вида >=X.Y.Z');
    }

    if (compareSemVer(minimum, grigDeskVersion) > 0) {
      throw installError('grigdesk_too_old');
    }
  }

  const contributes = raw.contributes;
  const panels = contributes.panels ?? [];
  const slots = contributes.slots ?? [];
  const settings = contributes.settings ?? [];

  if (!Array.isArray(panels) || panels.length > 1 || !panels.every(isRecord)
    || !Array.isArray(slots) || !slots.every(isRecord) || !Array.isArray(settings)) {
    throw installError('manifest_invalid', 'неверные декларации contributes');
  }

  if (panels.length && !isRecord(raw.entrypoints.web)) {
    throw installError('manifest_invalid', 'панель требует entrypoints.web');
  }

  for (const slot of slots) {
    if (slot.kind !== 'provider-usage' || !isPluginSlotName(slot.slot) || !raw.entrypoints.server) {
      throw installError('manifest_invalid', 'слот provider-usage требует известное место и серверный вход');
    }
  }

  for (const key of ['commands', 'themes']) {
    const declarations = contributes[key] ?? [];

    if (!Array.isArray(declarations) || !declarations.every((item) => isRecord(item)
      && typeof item.id === 'string' && typeof item.title === 'string')) {
      throw installError('manifest_invalid', 'неверные декларации команд или тем');
    }
  }

  const name = String(raw.name || raw.id);
  const panel = panels[0];
  const nav = panel ? normalizePluginNav({
    path: `/ext/${raw.id}`,
    label: panel.title,
    group: panel.group ?? 'dock',
    order: panel.order,
  }, name, warn) : null;

  return {
    id: raw.id,
    system: false,
    name,
    api: 1,
    version: String(raw.version || '0.0.0'),
    description: raw.description,
    category: userPluginCategory(raw.category, warn),
    defaultEnabled: typeof raw.defaultEnabled === 'boolean' ? raw.defaultEnabled : undefined,
    nav,
    settings: settings as PluginSetting[],
    placements: normalizePlacements(slots, warn),
    contributes: contributes as PluginManifest['contributes'],
    compatibility: {
    status: 'compatible',
    code: null,
    reason: null,
  },
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
  raw: {
    path?: unknown;
    label?: unknown;
    group?: unknown;
    order?: unknown;
  } | null,
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
 * Ошибка одного пакета сохраняет его карточку с причиной несовместимости.
 * Ни старые, ни повреждённые пакеты не получают права на исполнение кода.
 */
export async function scanUserPlugins(
  userPluginsDir: string,
  log?: RegistryLog,
  grigDeskVersion = '0.0.0',
): Promise<PluginManifest[]> {
  const out: PluginManifest[] = [];
  const entries = await fs.readdir(userPluginsDir, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    if (!entry.isDirectory() || !PLUGIN_ID_RE.test(entry.name)) {
      continue;
    }

    const dir = path.join(userPluginsDir, entry.name);
    let raw: Record<string, unknown> = {};

    try {
      raw = JSON.parse(await fs.readFile(path.join(dir, 'plugin.json'), 'utf8'));

      if (!isRecord(raw) || raw.id !== entry.name) {
        throw installError('id_mismatch');
      }

      const fields = decodeUserPluginManifest(raw, (message) => {
        log?.warn?.({ plugin: entry.name }, message);
      }, grigDeskVersion);
      const declared = raw.entrypoints as Record<string, unknown>;
      const web = resolvePluginWebModule(dir, entry.name, declared.web, normalizePluginPackagePath,
        () => {
          throw installError('manifest_invalid', 'неверный entrypoints.web');
        });

      out.push({
        ...fields,
        dir,
        entrypoints: { web },
        ...selectPluginServerEntry(dir, declared.server),
        ...resolvePluginAssets(dir, entry.name, raw),
      });
    } catch (error) {
      const failure = errorInfo(error);

      log?.warn?.({ plugin: entry.name, code: failure.code }, failure.message);
      out.push({
        id: entry.name,
        name: typeof raw?.name === 'string' ? raw.name : entry.name,
        version: typeof raw?.version === 'string' ? raw.version : '0.0.0',
        description: typeof raw?.description === 'string' ? raw.description.slice(0, 4096) : '',
        dir,
        nav: null,
        settings: [],
        placements: [],
        entrypoints: {},
        contributes: {},
        icon: null,
        compatibility: {
          status: 'incompatible',
          code: failure.code,
          reason: failure.message,
        },
      });
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
  manifest: Pick<PluginManifest, 'id' | 'system' | 'defaultEnabled' | 'compatibility'>,
): boolean {
  if (manifest.compatibility?.status === 'incompatible') {
    return false;
  }

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
