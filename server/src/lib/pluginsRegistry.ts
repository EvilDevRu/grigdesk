// Реестр плагинов кокпита. Плагин = отключаемый функциональный блок со своей
// плашкой в «Настройки → Плагины» и (опционально) пунктом в сайдбаре.
//
// Два источника:
//  • СИСТЕМНЫЕ (из коробки) — описаны в SYSTEM ниже. Их код — обычные модули сервера
//    и вьюхи фронта, собранные в бандл; «плагинность» для них = вкл/выкл + настройки.
//  • ПОЛЬЗОВАТЕЛЬСКИЕ — папки plugins/<id>/ в корне проекта: plugin.json (манифест
//    той же формы, что SYSTEM-записи) + опционально server.js (default-экспорт
//    fastify-плагина; регистрируется на старте, роуты обязаны жить под /api/ext/<id>/).
//    Выключенный пользовательский плагин не регистрируется вовсе (вкл/выкл — рестарт).
//
// Состояние (вкл/выкл, значения настроек) — в prefs (server/.state/prefs.json):
//   plugins:        { <id>: true|false }   — отсутствие ключа = дефолт манифеста
//                                            (defaultEnabled, иначе системный вкл / пользовательский выкл)
//   pluginSettings: { <id>: {key: value} }
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { normalizePluginCategory } from '../../../shared/pluginsContracts.ts';
import type { PluginNav, PluginSetting, PluginSetup } from '../../../shared/pluginsContracts.ts';

export type { PluginNav, PluginSetting, PluginSetup };

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
  // Ручка готовности: что плагину нужно на машине и что он ставит сам. Объявляют
  // только системные плагины — у пользовательского серверной части такого рода нет.
  setup?: PluginSetup | null;
  dir?: string;
  hasServer?: boolean;
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
        hint: 'Кнопка «Разобрать на задачи» отдаёт расшифровку модели, и та предлагает черновики. Расшифровка — чужая речь, поэтому нужен безопасный режим недоверенного ввода: подходят Claude и модели Ollama. Не выбрана — задачи собираются вручную, как раньше.',
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
          + 'с безопасным model-only режимом, например Claude и Ollama.',
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
        hint: 'Новое событие по задаче на полке даёт одно системное оповещение.',
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
        hint: 'Одна модель разбирает обращения всех активных каналов. Нужен безопасный Inbox-режим и поддержка изображений; сейчас подходят Claude и vision-модели Ollama. Пока совместимая модель не выбрана, автоматические задачи не создаются.',
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
    id: 'knowledge',
    system: true,
    defaultEnabled: true,
    name: 'Знания',
    version: '1.0.0',
    description: 'Локальная база проверенных проектных фактов с морфологическим поиском.',
    category: 'knowledge',
    nav: { path: '/knowledge', label: 'Знания', icon: 'knowledge', group: 'tools', order: 40 },
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
    // стенды кокпита, и появляться сама, без спроса, у каждой установки не должна.
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
        hint: 'Модель читает текст задачи и разрешённый diff — это недоверенный ввод, '
          + 'поэтому нужен безопасный model-only режим: подходят Claude и модели Ollama. '
          + 'Не выбрана — сцены пишутся руками.',
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
];

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;
export const NAV_GROUPS = ['rail', 'tools', 'dock'];

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
 * Скан пользовательских плагинов: plugins/<id>/plugin.json.
 * Битый манифест пропускается с warn — один плагин не валит остальные.
 */
export async function scanUserPlugins(
  userPluginsDir: string,
  log?: RegistryLog,
): Promise<PluginManifest[]> {
  const out: PluginManifest[] = [];
  let entries = [];
  try { entries = await fs.readdir(userPluginsDir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory() || !ID_RE.test(e.name)) continue;
    const dir = path.join(userPluginsDir, e.name);
    try {
      const m = JSON.parse(await fs.readFile(path.join(dir, 'plugin.json'), 'utf8'));
      if (!m.id || m.id !== e.name) throw new Error(`id в манифесте («${m.id}») не совпадает с папкой «${e.name}»`);
      out.push({
        id: m.id,
        system: false,
        name: String(m.name || m.id),
        api: Number(m.api || 1),
        version: String(m.version || '0.0.0'),
        description: String(m.description || ''),
        category: userPluginCategory(m.category, (message: string) => {
          log?.warn?.({ plugin: e.name }, message);
        }),
        nav: normalizePluginNav(m.nav, String(m.name || m.id), (message: string) => {
          log?.warn?.({ plugin: e.name }, message);
        }),
        settings: Array.isArray(m.settings) ? m.settings : [],
        dir,
        hasServer: await fs.access(path.join(dir, 'server.js')).then(() => true).catch(() => false),
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
