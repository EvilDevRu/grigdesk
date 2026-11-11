// Общие настройки GrigDesk (не креды): JSON-файл в .state, редактируются из UI.
// Дефолты заданы здесь — отсутствующий файл означает «всё по умолчанию».
import fs from 'node:fs';
import path from 'node:path';
import { ARBITER_DEFAULTS, normalizeArbiterSettings } from './factoryArbiter.ts';
import { SPEECH_DEFAULTS, normalizeSpeechSettings } from './speechSettings.ts';

const DEFAULTS = {
  browserAgentMode: 'legacy',
  // Перед любым запуском (триаж, конвейер) подтягивать свежий код в репозитории
  // проекта: fetch всегда, pull --ff-only только на чистом master.
  gitRefreshBeforeRun: true,
  // Показывать в выборе модели ВСЕ, что помнит CLI (включая Sonnet 3.7, Opus 4.0…),
  // а не только две свежие версии каждого семейства.
  showAllModels: false,
  // Автоматические измерения квот требуют явного включения владельцем.
  // Кнопка ручной проверки остаётся доступной независимо от этого выбора.
  providerUsageAutoRefresh: false,
  providerUsagePolicyRevision: 0,
  // Держать процесс исполнителя живым между ходами чата. Разовый запуск умирал вместе
  // с ответом, унося фоновые команды и субагентов, поэтому дефолт — включено. Тумблер
  // оставлен для отката: живая сессия держит память и свои MCP-серверы, а исполнители
  // без объявленного `session` работают по-прежнему независимо от этого значения.
  chatLiveSessions: true,
  // Продолжать упавший ход чата автоматически: до трёх продолжений подряд без
  // подтверждённого продвижения и не больше десяти начатых на исходный ход. Паузы
  // растут (сеть — 10/60/180 с, сбой поставщика — 30/120/300 с), «Стоп» и новое
  // сообщение человека отменяют ожидание. Окончательные причины (вход, лимит,
  // переполнение контекста, политика, отклонённый запрос) не повторяются: до их
  // сброса повтор не поможет, а исходный запрос не отправляется заново никогда.
  chatAutoContinue: true,
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
  // Порог молчания хода конвейера (секунды): дольше — GrigDesk зовёт человека.
  // Порог должен пропускать долгую сборку, но срабатывать раньше таймаута зависшего MCP.
  // 0 — не оповещать.
  runSilenceWindow: 900,
  // Плагины: вкл/выкл по id (отсутствие ключа = дефолт: системный вкл, пользовательский выкл)
  // и значения их настроек. Схемы настроек — в lib/plugins-registry.js и манифестах.
  plugins: {},
  pluginSettings: {},
  // Тумблеры размещений плагинов в слотах: { <id>: { <slot>: boolean } }. Отсутствие
  // ключа = умолчание манифеста; сами слоты объявлены в shared/plugins/slots/.
  pluginPlacements: {},
  // Свои настройки исполнителей (плашки «Настройки → Исполнители»):
  // { <providerId>: { <settingId>: value } }. Схему объявляет сам executor полем
  // `settings` (lib/executors/index.js) — здесь лежит только выбор человека.
  providerSettings: {},
  // Настройки распознавания имеют собственный валидированный endpoint. Объект здесь
  // обязателен: PrefsStore.write отбрасывает неизвестные ключи верхнего уровня.
  speech: SPEECH_DEFAULTS,
  // Арбитр типизированной остановки конвейера: { modelRef, effort, auto }.
  // `auto: false` по умолчанию: арбитр действует САМ, двигая курсор чужой задачи, и
  // включённым по умолчанию делал бы это там, где его решений ещё никто не читал.
  arbiter: ARBITER_DEFAULTS,
  // Паспорта проектов GrigDesk (раздел «Проекты»): { <id>: { repos: [{key, dir}] } }.
  // Пути локальны для машины-мозга, поэтому живут в .state, а не в гитуемой базе.
  // У проектов фабрики источник путей — их bash-профиль; сюда они не пишутся.
  projects: {},
  // Служебные данные реестра проектов: версия схемы, время миграции и надгробия
  // удалённых записей. Внутри `projects` служебных записей нет — иначе паспорт
  // проекта пришлось бы отличать от метаданных по форме ключа.
  projectsMeta: { schemaVersion: 0, migratedAt: null, tombstones: {} },
};

// Снятые режимы доступа не выдаются и не переносятся при следующей записи prefs.
// Сырое чтение остаётся прежним: диск меняется только после успешного write().
const REMOVED_PREF_KEYS = ['accessLocalHttps', 'accessGateway'];

// Настройки GrigDesk целиком: актуальные ключи DEFAULTS и сохранённые соседние значения.
export type GrigDeskPrefs = Record<string, unknown>;

/**
 * Общий prefs API сохраняет прежние локальные ручки исполнителей.
 * Нативный контейнер выдаётся только через проверенную проекцию своего каталога.
 */
export function publicPrefsView(prefs: GrigDeskPrefs): GrigDeskPrefs {
  const providers = asRecord(prefs.providerSettings);
  const providerSettings = Object.fromEntries(Object.entries(providers).map(([id, value]) => {
    const { nativeSettings: _private, ...local } = asRecord(value);

    return [id, local];
  }));

  return { ...prefs, providerSettings };
}

/** Запись настроек из недоверенного файла: не объект читается как пустая. */
function asRecord(value: unknown): GrigDeskPrefs {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as GrigDeskPrefs
    : {};
}

/** Файл настроек есть, но прочитать его как объект нельзя: запись отклонена. */
export class PrefsCorruptedError extends Error {
  constructor(message = 'Файл настроек не читается как объект', options?: ErrorOptions) {
    super(message, options);
    this.name = 'PrefsCorruptedError';
  }
}

export class PrefsStore {
  readonly prefsPath: string;

  constructor({ prefsPath }: { prefsPath: string }) {
    this.prefsPath = prefsPath;
  }

  /**
   * Фактически записанный JSON без overlay DEFAULTS и скрытия внутренней revision.
   * Нечитаемый файл — ошибка, а не пустые настройки: иначе вызывающий не отличит
   * «настроек нет» от «настройки испорчены» и запишет поверх чужой порчи умолчания.
   * Отсутствие файла — не порча: его ещё не заводили, и это штатное состояние.
   */
  readStored(): GrigDeskPrefs {
    try {
      const loaded = JSON.parse(fs.readFileSync(this.prefsPath, 'utf8'));
      if (loaded === null || typeof loaded !== 'object' || Array.isArray(loaded)) {
        throw new PrefsCorruptedError();
      }

      return loaded as GrigDeskPrefs;
    } catch (err) {
      if ((err as { code?: unknown } | null)?.code === 'ENOENT') return {};
      throw err;
    }
  }

  /**
   * Снимок для последующей записи: нечитаемый файл — всегда PrefsCorruptedError, чем бы
   * он ни был испорчен — формой или битым JSON. Для вызывающего это один отказ «писать
   * некуда», и HTTP отвечает на него 500 prefs_corrupted. Различие причин остаётся в cause.
   */
  readForWrite(): GrigDeskPrefs {
    try {
      return this.readStored();
    } catch (err) {
      if (err instanceof PrefsCorruptedError) throw err;
      throw new PrefsCorruptedError(
        `Файл настроек не читается, запись отклонена: ${this.prefsPath}`,
        { cause: err },
      );
    }
  }

  /**
   * Публичный снимок объединяет умолчания и сохранённые настройки.
   * Удалённые настройки доступа не выдаются наружу и не переносятся следующей записью.
   */
  read(): GrigDeskPrefs {
    let loaded: GrigDeskPrefs = {};
    try { loaded = this.readStored(); } catch { /* прежний fail-soft контракт read() */ }
    // Старый общий доступ больше не участвует в запуске. Следующая запись prefs
    // удалит устаревший ключ с диска, не перенося его в настройки отдельных чатов.
    delete loaded.trustedDirectories;

    for (const key of REMOVED_PREF_KEYS) {
      delete loaded[key];
    }

    return {
      ...DEFAULTS,
      ...loaded,
      providerUsageAutoRefresh: loaded.providerUsageAutoRefresh === true,
      providerUsagePolicyRevision: Number.isSafeInteger(loaded.providerUsagePolicyRevision)
        && Number(loaded.providerUsagePolicyRevision) >= 0
        ? Number(loaded.providerUsagePolicyRevision) : 0,
      // Общий store мержит верхний уровень. Speech доклеиваем отдельно, иначе старый
      // частичный объект затрёт новые поля defaults целиком.
      speech: normalizeSpeechSettings(loaded.speech),
      arbiter: normalizeArbiterSettings(loaded.arbiter),
      // Реестру служебных данных нужна своя копия умолчаний: consumers правят
      // надгробия на месте, а общий объект DEFAULTS живёт до перезапуска процесса.
      projectsMeta: {
        ...DEFAULTS.projectsMeta,
        ...asRecord(loaded.projectsMeta),
      },
    };
  }

  /**
   * Оба writer настроек исполнителей меняют строгий актуальный снимок без await.
   * Чистый mutator работает с копией, а no-op не переписывает файл.
   */
  updateProviderSettings(
    mutator: (current: Record<string, unknown>) => Record<string, unknown>,
  ): Record<string, unknown> {
    const stored = this.readForWrite();
    const saved = stored.providerSettings === undefined ? {} : stored.providerSettings;

    if (saved === null || typeof saved !== 'object' || Array.isArray(saved)) {
      throw new PrefsCorruptedError('Настройки исполнителей не читаются как объект');
    }

    const current = saved as Record<string, unknown>;
    const next = mutator(structuredClone(current));

    if (JSON.stringify(next) !== JSON.stringify(current)) {
      this.write({ providerSettings: next });
    }

    return next;
  }

  /**
   * Частичное обновление: неизвестные ключи отбрасываются. Запись здесь fail-closed,
   * а чтение — fail-soft, и это разные решения. Чтение обязано отдать хоть что-то,
   * иначе один битый файл гасит весь интерфейс; запись же собирает новый файл из
   * прочитанного, поэтому на нечитаемом файле она молча записала бы умолчания поверх
   * чужих настроек и паспортов проектов. Отсутствие файла — не порча: его заводят
   * этой же записью, и только для неё здесь допустима пустая основа.
   */
  write(patch: GrigDeskPrefs | null | undefined): GrigDeskPrefs {
    const stored = this.readForWrite();
    const next: GrigDeskPrefs = { ...this.read() };

    for (const k of Object.keys(DEFAULTS)) {
      if (patch && k in patch) {
        // Форму настройки арбитра нормализуем на записи: она уходит в аргументы CLI,
        // и произвольный объект из тела запроса храниться здесь не должен.
        if (k === 'arbiter') next[k] = normalizeArbiterSettings(patch[k]);
        else next[k] = patch[k];
      }
    }

    const priorRevision = Number.isSafeInteger(stored.providerUsagePolicyRevision)
      && Number(stored.providerUsagePolicyRevision) >= 0
      ? Number(stored.providerUsagePolicyRevision) : 0;
    const policyChanged = (stored.providerUsageAutoRefresh === true)
      !== (next.providerUsageAutoRefresh === true);

    next.providerUsagePolicyRevision = priorRevision + (policyChanged ? 1 : 0);

    // Публичный read() намеренно скрывает внутреннюю speech revision. Обычная правка
    // соседней настройки не должна её стирать и делать consent вкладки stale без причины.
    const storedSpeech = stored.speech as { _revision?: unknown } | undefined;
    if (!(patch && 'speech' in patch) && typeof storedSpeech?._revision === 'string') {
      next.speech = { ...(next.speech as object), _revision: storedSpeech._revision };
    }
    fs.mkdirSync(path.dirname(this.prefsPath), { recursive: true });
    // Атомарно (tmp+rename): падение в момент записи не бьёт файл настроек.
    fs.writeFileSync(`${this.prefsPath}.tmp`, JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.renameSync(`${this.prefsPath}.tmp`, this.prefsPath);
    return { ...next, speech: normalizeSpeechSettings(next.speech) };
  }
}
