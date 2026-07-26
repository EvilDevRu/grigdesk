// Общие настройки кокпита (не креды): JSON-файл в .state, редактируются из UI.
// Дефолты заданы здесь — отсутствующий файл означает «всё по умолчанию».
import fs from 'node:fs';
import path from 'node:path';

const DEFAULTS = {
  // Перед любым запуском (триаж, конвейер) подтягивать свежий код в репозитории
  // проекта: fetch всегда, pull --ff-only только на чистом master.
  gitRefreshBeforeRun: true,
  // Показывать в выборе модели ВСЕ, что помнит CLI (включая Sonnet 3.7, Opus 4.0…),
  // а не только две свежие версии каждого семейства.
  showAllModels: false,
};

export class PrefsStore {
  /** @param {{ prefsPath: string }} opts */
  constructor({ prefsPath }) {
    this.prefsPath = prefsPath;
  }

  read() {
    try {
      return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(this.prefsPath, 'utf8')) };
    } catch {
      return { ...DEFAULTS };
    }
  }

  /** Частичное обновление: неизвестные ключи отбрасываются. */
  write(patch) {
    const next = { ...this.read() };
    for (const k of Object.keys(DEFAULTS)) {
      if (patch && k in patch) next[k] = patch[k];
    }
    fs.mkdirSync(path.dirname(this.prefsPath), { recursive: true });
    fs.writeFileSync(this.prefsPath, JSON.stringify(next, null, 2), { mode: 0o600 });
    return next;
  }
}
