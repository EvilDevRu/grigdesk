// Общие настройки кокпита (не креды): JSON-файл в .state, редактируются из UI.
// Дефолты заданы здесь — отсутствующий файл означает «всё по умолчанию».
import fs from 'node:fs';
import path from 'node:path';
import { SPEECH_DEFAULTS, normalizeSpeechSettings } from './speech-settings.js';
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
  // Порог автокомпакта чата (токены контекста). CLI обычно сжимает разговор только у
  // потолка окна модели; ранний управляемый порог удерживает размер и задержку хода
  // предсказуемыми и оставляет запас до окна. Это не тарифная граница провайдера.
  // 0 — не вмешиваться, оставить дефолт CLI.
  chatAutoCompactWindow: 200000,
  // Тот же порог, но для ЭТАПОВ конвейера — своей настройкой, а не переиспользованием
  // чатовой: цена сжатия разная. В чате оно рвёт нить разговора с человеком, на этапе —
  // просто ужимает рабочий контекст между вызовами инструментов, и трогать его можно
  // смелее. Уезжает движку переменной
  // FACTORY_STAGE_AUTO_COMPACT, дальше раннер переводит её на диалект своего CLI.
  // 0 — не вмешиваться, оставить дефолт CLI (его собственный порог обычно задан долей окна).
  stageAutoCompactWindow: 200000,
  // Порог молчания хода конвейера (секунды): дольше — кокпит зовёт человека.
  // Порог должен пропускать долгую сборку, но срабатывать раньше таймаута зависшего MCP.
  // 0 — не оповещать.
  runSilenceWindow: 900,
  // Локальный HTTPS («Настройки → Доступ»): намерение загрузить state-сертификат и поднять
  // :8143 при следующем старте. Выключение НЕ закрывает LAN (остаётся HTTP :8140) и не
  // стирает сертификат/корень. accessGateway — прежний маркер раскрытого визарда, оставленный
  // для совместимости сохранённых prefs; runtime шлюза им никогда не гейтится.
  accessLocalHttps: false,
  accessGateway: false,
  // Плагины: вкл/выкл по id (отсутствие ключа = дефолт: системный вкл, пользовательский выкл)
  // и значения их настроек. Схемы настроек — в lib/plugins-registry.js и манифестах.
  plugins: {},
  pluginSettings: {},
  // Свои настройки исполнителей (плашки «Настройки → Исполнители»):
  // { <providerId>: { <settingId>: value } }. Схему объявляет сам executor полем
  // `settings` (lib/executors/index.js) — здесь лежит только выбор человека.
  providerSettings: {},
  // Настройки распознавания имеют собственный валидированный endpoint. Объект здесь
  // обязателен: PrefsStore.write отбрасывает неизвестные ключи верхнего уровня.
  speech: SPEECH_DEFAULTS,
  // Паспорта КОКПИТНЫХ проектов (раздел «Проекты»): { <id>: { repos: [{key, dir}] } }.
  // Пути локальны для машины-мозга, поэтому живут в .state, а не в гитуемой базе.
  // У проектов фабрики источник путей — их bash-профиль; сюда они не пишутся.
  projects: {},
};

export class PrefsStore {
  /** @param {{ prefsPath: string }} opts */
  constructor({ prefsPath }) {
    this.prefsPath = prefsPath;
  }

  /** Фактически записанный JSON без overlay DEFAULTS и скрытия внутренней revision. */
  readStored() {
    try {
      const loaded = JSON.parse(fs.readFileSync(this.prefsPath, 'utf8'));
      return loaded !== null && typeof loaded === 'object' && !Array.isArray(loaded)
        ? loaded
        : {};
    } catch (err) {
      if (err?.code === 'ENOENT') return {};
      throw err;
    }
  }

  read() {
    let loaded = {};
    try { loaded = this.readStored(); } catch { /* прежний fail-soft контракт read() */ }
    return {
      ...DEFAULTS,
      ...loaded,
      trustedDirectories: normalizeStoredTrustedDirectories(loaded.trustedDirectories),
      // Общий store мержит верхний уровень. Speech доклеиваем отдельно, иначе старый
      // частичный объект затрёт новые поля defaults целиком.
      speech: normalizeSpeechSettings(loaded.speech),
    };
  }

  /** Частичное обновление: неизвестные ключи отбрасываются. */
  write(patch) {
    let stored = {};
    try { stored = this.readStored(); } catch { /* write сохраняет прежний fail-soft контракт */ }
    const next = { ...this.read() };
    for (const k of Object.keys(DEFAULTS)) {
      if (patch && k in patch) {
        next[k] = k === 'trustedDirectories'
          ? normalizeStoredTrustedDirectories(patch[k])
          : patch[k];
      }
    }
    // Публичный read() намеренно скрывает внутреннюю speech revision. Обычная правка
    // соседней настройки не должна её стирать и делать consent вкладки stale без причины.
    if (!(patch && 'speech' in patch) && typeof stored.speech?._revision === 'string') {
      next.speech = { ...next.speech, _revision: stored.speech._revision };
    }
    fs.mkdirSync(path.dirname(this.prefsPath), { recursive: true });
    // Атомарно (tmp+rename): падение в момент записи не бьёт файл настроек.
    fs.writeFileSync(`${this.prefsPath}.tmp`, JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.renameSync(`${this.prefsPath}.tmp`, this.prefsPath);
    return { ...next, speech: normalizeSpeechSettings(next.speech) };
  }
}
