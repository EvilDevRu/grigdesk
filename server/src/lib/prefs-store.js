// Общие настройки кокпита (не креды): JSON-файл в .state, редактируются из UI.
// Дефолты заданы здесь — отсутствующий файл означает «всё по умолчанию».
import fs from 'node:fs';
import path from 'node:path';
import { normalizeStoredTrustedDirectories } from './trusted-directories.js';

const DEFAULTS = {
  // Перед любым запуском (триаж, конвейер) подтягивать свежий код в репозитории
  // проекта: fetch всегда, pull --ff-only только на чистом master.
  gitRefreshBeforeRun: true,
  // После запуска Cockpit продолжать незакрытые конвейеры, если их демон погиб.
  // Ворота, явный human-stall и цикл перезапусков автоматика не пересекает.
  autoRecoverPipelines: true,
  // Показывать в выборе модели ВСЕ, что помнит CLI (включая Sonnet 3.7, Opus 4.0…),
  // а не только две свежие версии каждого семейства.
  showAllModels: false,
  // Дополнительные каталоги хоста, доступные всем ИИ-исполнителям в чатах Cockpit.
  // Текущий cwd запуска доступен отдельно; здесь — соседние репозитории и общие деревья.
  trustedDirectories: [],
  // Плагины: вкл/выкл по id (отсутствие ключа = дефолт: системный вкл, пользовательский выкл)
  // и значения их настроек. Схемы настроек — в lib/plugins-registry.js и манифестах.
  plugins: {},
  pluginSettings: {},
  // Паспорта проектов (раздел «Проекты»):
  // { <id>: { repos?, review: { repositories: { <key>: GitHubBinding } } } }.
  // Пути локальны для машины-мозга, поэтому живут в .state, а не в гитуемой базе.
  // У проектов фабрики источник ПУТЕЙ — bash-профиль; GitHub-привязка всё равно
  // принадлежит Cockpit и хранится здесь, не создавая второго источника путей.
  projects: {},
};

export class PrefsStore {
  /** @param {{ prefsPath: string }} opts */
  constructor({ prefsPath }) {
    this.prefsPath = prefsPath;
  }

  read() {
    try {
      const loaded = JSON.parse(fs.readFileSync(this.prefsPath, 'utf8'));
      return {
        ...DEFAULTS,
        ...loaded,
        trustedDirectories: normalizeStoredTrustedDirectories(loaded.trustedDirectories),
      };
    } catch {
      return { ...DEFAULTS };
    }
  }

  /** Частичное обновление: неизвестные ключи отбрасываются. */
  write(patch) {
    const next = { ...this.read() };
    for (const k of Object.keys(DEFAULTS)) {
      if (patch && k in patch) {
        next[k] = k === 'trustedDirectories'
          ? normalizeStoredTrustedDirectories(patch[k])
          : patch[k];
      }
    }
    fs.mkdirSync(path.dirname(this.prefsPath), { recursive: true });
    // Атомарно (tmp+rename): падение в момент записи не бьёт файл настроек.
    fs.writeFileSync(`${this.prefsPath}.tmp`, JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.renameSync(`${this.prefsPath}.tmp`, this.prefsPath);
    return next;
  }
}
