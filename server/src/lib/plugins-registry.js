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
//   plugins:        { <id>: true|false }   — отсутствие ключа = дефолт (системный вкл, пользовательский выкл)
//   pluginSettings: { <id>: {key: value} }
import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Системные плагины из коробки. */
export const SYSTEM = [
  {
    id: 'video',
    name: 'Видео → задачи',
    version: '1.0.0',
    description: 'Разбор видеозаписи встречи: распознавание речи (whisper), выжимка по темам, черновики задач в Б24 со скриншотами.',
    nav: { path: '/video', label: 'Видео', icon: 'video' },
    settings: [
      { key: 'whisperModel', label: 'Модель whisper', type: 'select', options: ['small', 'medium', 'large-v3'], default: 'medium' },
    ],
  },
  {
    id: 'demo',
    name: 'Демо фичи',
    version: '1.0.0',
    description: 'Съёмка демо-видео готовой фичи с живого стенда задачи (playwright + озвучка) — по кнопке, вне конвейера. Галерея готовых роликов.',
    nav: { path: '/demo', label: 'Демо', icon: 'demo' },
    settings: [],
  },
  {
    id: 'code',
    name: 'Код',
    version: '1.0.0',
    description: 'Просмотр кода и гита проектов как в VS Code: дерево файлов и несохранённые изменения любого дерева — основного репозитория или worktree. Только чтение. Пути репозиториев — в разделе «Проекты».',
    nav: { path: '/code', label: 'Код', icon: 'code' },
    settings: [],
  },
];

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;

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
        name: String(m.name || m.id),
        api: Number(m.api || 1),
        version: String(m.version || '0.0.0'),
        description: String(m.description || ''),
        nav: m.nav && m.nav.path ? { path: String(m.nav.path), label: String(m.nav.label || m.name || m.id), icon: String(m.nav.icon || 'plugin') } : null,
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

/** Включён ли плагин по prefs: системные включены по умолчанию, пользовательские — нет. */
export function isEnabled(prefsData, id, isSystem) {
  const map = prefsData.plugins || {};
  if (id in map) return !!map[id];
  return !!isSystem;
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
