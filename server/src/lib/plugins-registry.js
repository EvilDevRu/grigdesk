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

/** Системные плагины из коробки. */
export const SYSTEM = [
  {
    id: 'video',
    system: true,
    name: 'Видео → задачи',
    version: '1.0.0',
    description: 'Разбор видеозаписи встречи: распознавание речи (whisper), выжимка по темам, черновики задач в Б24 со скриншотами.',
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
    nav: { path: '/ssh', label: 'SSH', icon: 'terminal', group: 'dock', order: 40 },
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
export function normalizePluginNav(raw, fallbackLabel, warn = null) {
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
 * Скан пользовательских плагинов: plugins/<id>/plugin.json.
 * Битый манифест пропускается с warn — один плагин не валит остальные.
 */
export async function scanUserPlugins(userPluginsDir, log) {
  const out = [];
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
        nav: normalizePluginNav(m.nav, m.name || m.id, (message) => {
          log?.warn({ plugin: e.name }, message);
        }),
        settings: Array.isArray(m.settings) ? m.settings : [],
        dir,
        hasServer: await fs.access(path.join(dir, 'server.js')).then(() => true).catch(() => false),
      });
    } catch (err) {
      log?.warn({ plugin: e.name, err: err.message }, 'манифест пользовательского плагина не прочитан — пропущен');
    }
  }
  return out;
}

/**
 * Включён ли плагин по prefs. Явный выбор человека сильнее любого умолчания;
 * умолчание объявляет сам манифест (`defaultEnabled`), иначе действует общее
 * правило «системный — включён, пользовательский — нет».
 * @param {object} prefsData
 * @param {{id: string, system?: boolean, defaultEnabled?: boolean}} manifest
 */
export function isEnabled(prefsData, manifest) {
  const map = prefsData.plugins || {};
  if (manifest.id in map) return !!map[manifest.id];
  return manifest.defaultEnabled ?? !!manifest.system;
}

/** Значения настроек плагина: дефолты схемы, перекрытые сохранёнными. */
export function settingsValues(prefsData, manifest) {
  const saved = (prefsData.pluginSettings || {})[manifest.id] || {};
  const out = {};
  for (const s of manifest.settings || []) {
    out[s.key] = s.key in saved ? saved[s.key] : s.default;
  }
  return out;
}
