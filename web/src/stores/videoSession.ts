// Сеанс разбора встречи: части записи и их job'ы, расшифровка и черновики задач.
//
// Раздел «Видео» — обычная страница, и до этого весь сеанс жил в её компоненте: уход
// в соседний раздел размонтировал вью вместе с id уже идущего распознавания. Сама
// работа при этом не прекращалась (она идёт на сервере), но вернуться к ней было
// нечем — id существовал только в замыкании компонента. Поэтому владелец сеанса —
// стор: он переживает переходы, продолжает поллинг фоном, а тонкий снимок в
// localStorage переживает и F5. Расшифровка в снимок НЕ входит: она уже лежит на
// сервере и перечитывается по jobId, а её копия в браузере копила бы мегабайты.
import { defineStore } from 'pinia';

import { api } from '../shared/api-client.js';
import { mmss } from '../shared/format.js';
import { mediaApi } from '../shared/mediaApi.ts';
import type {
  MediaClip,
  MediaFrame,
  MediaJob,
  MediaTranscriptSegment,
} from '../../../shared/mediaContracts.ts';
import { usePluginsStore } from './plugins.js';

// Окно фрагмента: 15 секунд до и после места задачи, шаг расширения тот же, потолок
// минута с каждой стороны. Дальше это уже не «нужный кусок», а пересказ соседних тем.
export const CLIP_WINDOW_STEP = 15;
export const CLIP_WINDOW_MAX = 60;

const STORAGE_KEY = 'cockpit-video-session';
const SESSION_SCHEMA = 1;
// Сеанс живёт столько же, сколько кадры и фрагменты записи на сервере: снимок,
// переживший их уборку, показывал бы черновики с битыми вложениями.
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SAVE_DEBOUNCE_MS = 500;
const POLL_INTERVAL_MS = 2000;
// Поллинг не имеет права молотить закрытый API вечно: после выхода из кокпита или
// падения сервера подряд идущие отказы гасят цикл, а причина остаётся на экране.
const POLL_FAILURES_MAX = 5;

const PLAN_ERRORS: Record<string, string> = {
  no_model: 'Модель для разбора не выбрана — «Настройки → Плагины → Видео → задачи».',
  unknown_model: 'Выбранной модели нет в реестре исполнителей: проверь настройку плагина.',
  unsafe_model_provider: 'У выбранного исполнителя нет безопасного режима для чужого текста.'
    + ' Подходят Claude и модели Ollama.',
  registry_failed: 'Не удалось прочитать реестр моделей.',
  executor_unavailable: 'Исполнитель выбранной модели недоступен.',
  run_failed: 'Модель не ответила. Можно повторить или собрать задачи вручную.',
  bad_plan: 'Модель ответила не по формату — задачи не разобраны. Можно повторить.',
  empty_transcript: 'В расшифровке нет ни одной реплики.',
  not_ready: 'Расшифровка ещё не готова.',
};

export interface VideoPart {
  name: string;
  size: number;
  jobId: string | null;
  job: MediaJob | null;
  gone: boolean;
}

export interface VideoDraft {
  title: string;
  description: string;
  createdById: string;
  responsibleId: string;
  groupId: string;
  priority: number;
  confidence: number | null;
  reason: string;
  // Кадр записи на том же таймкоде, что стоит в описании: показывается до постановки и
  // уезжает на портал вложением. `frameOff` — отказ человека от конкретного кадра.
  frame: MediaFrame | null;
  frameOff: boolean;
  // Фрагмент записи вокруг того же места. `at` живёт в черновике отдельно от кадра:
  // кусок режется по секунде задачи, а кадра может не быть вовсе.
  at: number | null;
  clip: MediaClip | null;
  clipOff: boolean;
  clipBusy: boolean;
  clipError: string | null;
  clipWindow: number;
  // Состояние постановки живёт В САМОМ черновике: задачи ставятся по одной, и общий
  // флаг на секцию не сказал бы, какая именно уехала, а какая ждёт.
  creating: boolean;
  createdId: string | number | null;
  error: string | null;
  // Предложенная моделью задача открывается ПРЕВЬЮ: её пришли прочитать, а не
  // заполнить. Пустой черновик, наоборот, сразу в правке — читать в нём нечего.
  editing: boolean;
}

export interface VideoPlanInfo {
  count: number;
  model: string;
  truncated: boolean;
  shown: number;
}

export interface VideoUploadedFile {
  name: string;
  size: number;
}

export interface VideoSessionState {
  hydrated: boolean;
  // Части одной встречи. Инструменты записи режут длинный созвон на файлы, и разбирать
  // их по отдельности значит терять поводы, начатые в одной части и договорённые в другой.
  parts: VideoPart[];
  uploaded: VideoUploadedFile | null;
  uploading: boolean;
  error: string | null;
  drafts: VideoDraft[];
  created: (string | number)[];
  creating: boolean;
  planning: boolean;
  planHint: string;
  planError: string | null;
  planInfo: VideoPlanInfo | null;
  // От кого, кому и куда ставим по умолчанию — выбирается один раз на всю встречу:
  // у задач одного созвона они обычно общие.
  defCreator: string;
  defResponsible: string;
  defGroup: string;
  defPriority: number;
  pollFailures: number;
  // Идёт ли поллинг — видно и человеку: по нему раздел показывает, что разбор ещё
  // тикает после возврата на страницу.
  polling: boolean;
}

// Поля черновика, которые переживают перезагрузку. Runtime-флаги (идёт постановка,
// режется фрагмент) в снимок не идут: восстановленные, они изображали бы работу,
// которой после перезагрузки уже нет.
const DRAFT_PERSISTED = [
  'title', 'description', 'createdById', 'responsibleId', 'groupId', 'priority',
  'confidence', 'reason', 'frame', 'frameOff', 'at', 'clip', 'clipOff', 'clipWindow',
  'createdId', 'editing',
] as const satisfies readonly (keyof VideoDraft)[];

interface VideoPluginsSource {
  byId(id: string): { values?: Record<string, unknown> } | null | undefined;
}

interface SessionTimers {
  poll: ReturnType<typeof setInterval> | null;
  save: ReturnType<typeof setTimeout> | null;
}

/**
 * Окно ещё можно расширить: у фиксированного куска это единственная ручка человека.
 * Потолок стоит там, где кусок перестаёт быть местом задачи и становится пересказом.
 */
export function canWidenClip(draft: { clipWindow?: unknown } | null | undefined): boolean {
  return (Number(draft?.clipWindow) || CLIP_WINDOW_STEP) < CLIP_WINDOW_MAX;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Чтение снимка. Приватный режим браузера бросает на самом обращении к хранилищу,
 * и для раздела это просто «снимка нет», а не повод упасть.
 */
function readStorage(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/**
 * Запись снимка. Пустое значение снимок удаляет; переполненная квота и приватный
 * режим гасятся молча — сеанс на экране от этого не страдает.
 */
function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) {
      globalThis.localStorage?.removeItem(key);
    } else {
      globalThis.localStorage?.setItem(key, value);
    }
  } catch {
    /* приватный режим и переполненная квота — не повод ронять раздел */
  }
}

// Таймеры живут ВНЕ state, и это не стилистика: подписка на сохранение снимка будится
// любой правкой state, а таймер, лежащий в нём, будил бы её сам собой — бесконечным
// кругом «мутация → запись → мутация». WeakMap, а не модульная переменная, потому что
// в одном процессе (тесты) живёт несколько pinia, и чужой интервал гасить нечем.
const timers = new WeakMap<object, SessionTimers>();

/** Число из снимка: посторонняя строка не должна доехать до формы числом NaN. */
function finiteNumber(value: unknown, fallback: number | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

// Поле, которого в снимке прежней схемы могло не быть вовсе: отсутствие означает
// «как у пустого черновика», а не «выключено». Повреждённое значение — то же самое.
function savedFlag(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function savedText(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

/**
 * Кадр из снимка. Вложение уезжает на портал по имени, поэтому повреждённое имя или
 * потерянная секунда означают «кадра нет»: черновик при этом остаётся, а показывать
 * и прикладывать нечего.
 */
function restoredFrame(value: unknown): MediaFrame | null {
  const frame = asRecord(value);
  const at = finiteNumber(frame.at, null);

  if (typeof frame.name !== 'string' || !frame.name || at === null) {
    return null;
  }

  return { name: frame.name, at };
}

/**
 * Фрагмент из снимка: границы и вес нужны целиком. Половина куска ничего не значит —
 * без «от» и «до» его нечем показать, а без веса непонятно, вырезался ли он вообще.
 */
function restoredClip(value: unknown): MediaClip | null {
  const clip = asRecord(value);
  const at = finiteNumber(clip.at, null);
  const from = finiteNumber(clip.from, null);
  const to = finiteNumber(clip.to, null);
  const bytes = finiteNumber(clip.bytes, null);

  if (typeof clip.name !== 'string' || !clip.name
    || at === null || from === null || to === null || bytes === null) {
    return null;
  }

  return {
    name: clip.name,
    at,
    from,
    to,
    bytes,
  };
}

/**
 * Черновик из снимка: пустой черновик плюс проверенные сохранённые поля. Runtime
 * из хранилища не восстанавливается вовсе — «ставится» и «режется» относятся к
 * прошлой вкладке, и поднятый с ними черновик выглядел бы навсегда занятым.
 */
function restoredDraft(value: unknown, base: VideoDraft): VideoDraft {
  const draft = asRecord(value);
  const createdId = draft.createdId;

  return {
    ...base,
    title: savedText(draft.title, base.title),
    description: savedText(draft.description, base.description),
    createdById: savedText(draft.createdById, base.createdById),
    responsibleId: savedText(draft.responsibleId, base.responsibleId),
    groupId: savedText(draft.groupId, base.groupId),
    priority: finiteNumber(draft.priority, base.priority) ?? base.priority,
    confidence: finiteNumber(draft.confidence, base.confidence),
    reason: savedText(draft.reason, base.reason),
    frame: restoredFrame(draft.frame),
    frameOff: savedFlag(draft.frameOff, base.frameOff),
    at: finiteNumber(draft.at, base.at),
    clip: restoredClip(draft.clip),
    clipOff: savedFlag(draft.clipOff, base.clipOff),
    clipWindow: finiteNumber(draft.clipWindow, base.clipWindow) ?? base.clipWindow,
    createdId: typeof createdId === 'string' || typeof createdId === 'number' ? createdId : null,
    editing: savedFlag(draft.editing, base.editing),
  };
}

function timersOf(store: object): SessionTimers {
  let value = timers.get(store);

  if (!value) {
    value = { poll: null, save: null };
    timers.set(store, value);
  }

  return value;
}

export const useVideoSessionStore = defineStore('video-session', {
  state: (): VideoSessionState => ({
    hydrated: false,
    parts: [],
    uploaded: null,
    uploading: false,
    error: null,
    drafts: [],
    created: [],
    creating: false,
    planning: false,
    planHint: '',
    planError: null,
    planInfo: null,
    defCreator: '',
    defResponsible: '',
    defGroup: '',
    defPriority: 1,
    pollFailures: 0,
    polling: false,
  }),
  getters: {
    /** Статус первой части: раздел показывает по нему общий ход распознавания. */
    job: (state): MediaJob | null => state.parts[0]?.job || null,
    partsDone: (state) => state.parts.filter((part) => part.job?.status === 'done'),
    /**
     * Разбор уже есть на сервере, а его состояние ещё не прочитано. Бывает после
     * перезагрузки страницы (в снимке только jobId) и сразу после загрузки файла, до
     * первого опроса. Без этого признака экран на секунды выглядит так, будто ничего
     * не происходит, — а происходит ровно то, ради чего человек сюда пришёл.
     */
    restoring: (state) => !state.uploading
      && state.parts.some((part) => part.jobId && !part.gone)
      && !state.parts[0]?.job,
    /** Части ещё разбираются — значит поллинг обязан идти. */
    needsPoll: (state) => state.parts.some((part) => part.jobId && !part.gone
      && part.job?.status !== 'done' && part.job?.status !== 'failed'),
    /**
     * Реплики всех частей со СКВОЗНЫМИ таймкодами. Сдвиг берём по длительности записи,
     * а не по концу последней реплики: молчание в хвосте части — обычное дело, и по
     * речи следующая часть наехала бы на предыдущую. Ровно так же склеивает сервер
     * перед обращением к модели — иначе «04:31» в задаче и в ленте указывали бы на
     * разные места записи.
     */
    segments: (state): MediaTranscriptSegment[] => {
      const out: MediaTranscriptSegment[] = [];
      let offset = 0;

      for (const part of state.parts) {
        if (part.job?.status !== 'done') {
          break;
        }

        const result = part.job.result;
        const partSegments = result?.transcript.segments || [];

        for (const segment of partSegments) {
          out.push({
            ...segment,
            start: segment.start + offset,
            end: segment.end + offset,
          });
        }

        const duration = Number(result?.duration);

        offset += Number.isFinite(duration) && duration > 0
          ? duration
          : Number(partSegments.at(-1)?.end || 0);
      }

      return out;
    },
    /** Длительность всей встречи — сумма длительностей частей. */
    mediaDuration: (state): number | null => {
      let total = 0;

      for (const part of state.parts) {
        const duration = Number(part.job?.result?.duration);

        if (Number.isFinite(duration) && duration > 0) {
          total += duration;
        }
      }

      // Ноль означает «длительности нет»: строку в шапке рисовать нечем, а показанный
      // «00:00» читался бы как пустая запись.
      return total > 0 ? total : null;
    },
    /** Черновик, который ещё можно поставить: есть заголовок и он не уехал раньше. */
    ready: (state) => state.drafts.filter((draft) => draft.title.trim() && !draft.createdId),
  },
  actions: {
    /** Пустой черновик с общими для встречи умолчаниями постановки. */
    emptyDraft(): VideoDraft {
      return {
        title: '',
        description: '',
        createdById: this.defCreator,
        responsibleId: this.defResponsible,
        groupId: this.defGroup,
        priority: this.defPriority,
        confidence: null,
        reason: '',
        frame: null,
        frameOff: false,
        at: null,
        clip: null,
        clipOff: false,
        clipBusy: false,
        clipError: null,
        clipWindow: CLIP_WINDOW_STEP,
        creating: false,
        createdId: null,
        error: null,
        editing: true,
      };
    },

    /**
     * Поднимает прошлый сеанс из localStorage и подписывается на его сохранение.
     * Зовётся из раздела при каждом монтировании и обязана быть идемпотентной: при
     * возврате на страницу сеанс уже в памяти, и повторное чтение снимка откатило бы
     * его к последнему сохранению.
     */
    hydrate() {
      if (this.hydrated) {
        return;
      }

      this.hydrated = true;
      this.restore();

      // detached: подписку ставит компонент раздела, но сеанс переживает его унмаунт —
      // иначе уход со страницы отключал бы запись снимка ровно тогда, когда фоновый
      // поллинг продолжает менять состояние.
      this.$subscribe(() => this.persistSoon(), { detached: true });
      globalThis.addEventListener?.('beforeunload', () => this.persistNow());
    },

    /**
     * Снимок прошлого сеанса: своя схема, свой возраст и никакой расшифровки. Чужая
     * или протухшая схема не разбирается по частям — такой снимок просто удаляется.
     */
    restore() {
      const raw = readStorage(STORAGE_KEY);

      if (!raw) {
        return;
      }

      let parsed: unknown = null;

      try {
        parsed = JSON.parse(raw);
      } catch {
        writeStorage(STORAGE_KEY, null);

        return;
      }

      const snapshot = asRecord(parsed);
      const savedAt = Number(snapshot.savedAt) || 0;

      if (snapshot.v !== SESSION_SCHEMA || Date.now() - savedAt > SESSION_TTL_MS) {
        writeStorage(STORAGE_KEY, null);

        return;
      }

      const parts = Array.isArray(snapshot.parts) ? snapshot.parts : [];

      this.parts = parts.map((raw) => {
        const part = asRecord(raw);

        return {
          name: text(part.name),
          size: Number(part.size) || 0,
          jobId: part.jobId ? String(part.jobId) : null,
          job: null,
          gone: false,
        };
      });

      const uploaded = asRecord(snapshot.uploaded);

      this.uploaded = typeof uploaded.name === 'string' && uploaded.name
        ? { name: uploaded.name, size: finiteNumber(uploaded.size, 0) ?? 0 }
        : null;
      this.created = (Array.isArray(snapshot.created) ? snapshot.created : [])
        .filter((id: unknown): id is string | number => (
          typeof id === 'string' || typeof id === 'number'
        ));
      this.planHint = text(snapshot.planHint);
      this.defCreator = text(snapshot.defCreator);
      this.defResponsible = text(snapshot.defResponsible);
      this.defGroup = text(snapshot.defGroup);
      this.defPriority = finiteNumber(snapshot.defPriority, 1) ?? 1;

      const drafts: unknown[] = Array.isArray(snapshot.drafts) ? snapshot.drafts : [];

      // Черновик поднимается поверх пустого: у сохранённого нет runtime-полей, а
      // у прежней схемы могло не быть и части смысловых.
      this.drafts = drafts.map((draft) => restoredDraft(draft, this.emptyDraft()));
    },

    /** Отложенная запись снимка: черновик набирают с клавиатуры, посимвольно писать незачем. */
    persistSoon() {
      const own = timersOf(this);

      clearTimeout(own.save ?? undefined);
      own.save = setTimeout(() => this.persistNow(), SAVE_DEBOUNCE_MS);
    },

    /**
     * Немедленная запись снимка. Пустой сеанс снимок удаляет: он не должен переживать
     * собственное содержимое и возвращать на экран уже убранный разбор.
     */
    persistNow() {
      const own = timersOf(this);

      clearTimeout(own.save ?? undefined);
      own.save = null;

      if (!this.parts.length && !this.drafts.length) {
        writeStorage(STORAGE_KEY, null);

        return;
      }

      const snapshot = {
        v: SESSION_SCHEMA,
        savedAt: Date.now(),
        parts: this.parts.map((part) => ({
          name: part.name,
          size: part.size,
          jobId: part.jobId,
        })),
        uploaded: this.uploaded,
        created: this.created,
        planHint: this.planHint,
        defCreator: this.defCreator,
        defResponsible: this.defResponsible,
        defGroup: this.defGroup,
        defPriority: this.defPriority,
        drafts: this.drafts.map((draft) => Object.fromEntries(
          DRAFT_PERSISTED.map((key) => [key, draft[key]]),
        )),
      };

      writeStorage(STORAGE_KEY, JSON.stringify(snapshot));
    },

    /**
     * Убрать разбор с экрана целиком: липкий сеанс обязан иметь свою кнопку выхода.
     * Снимок стирается сразу, иначе вчерашняя встреча вернулась бы после перезагрузки.
     */
    reset() {
      this.stopPoll();
      this.parts = [];
      this.uploaded = null;
      this.uploading = false;
      this.error = null;
      this.drafts = [];
      this.created = [];
      this.planning = false;
      this.planHint = '';
      this.planError = null;
      this.planInfo = null;
      this.persistNow();
    },

    /**
     * Выбранные файлы одной встречи. Части сортируем по времени файла: записаны они
     * последовательно, а браузер отдаёт выбор в порядке каталога. Имя — только
     * тай-брейк: оно не контракт, у другого инструмента формат свой.
     */
    async onFiles(files: File[]) {
      const picked = [...files];
      const first = picked[0];

      if (!picked.length || !first) {
        return;
      }

      this.stopPoll();
      this.uploading = true;
      this.error = null;
      this.drafts = [];
      this.created = [];
      this.planError = null;
      this.planInfo = null;

      picked.sort((a, b) => (a.lastModified || 0) - (b.lastModified || 0)
        || String(a.name).localeCompare(String(b.name), 'ru'));
      this.parts = picked.map((file) => ({
        name: file.name,
        size: file.size,
        jobId: null,
        job: null,
        gone: false,
      }));
      // Что именно выбрано — запоминаем ДО отправки и показываем рядом с разбором.
      // Файлы записи называются почти одинаково и лежат рядом; без имени и размера на
      // экране «я выбирал другой» и «раздел обрезал» неотличимы друг от друга.
      this.uploaded = { name: first.name, size: first.size };

      try {
        // Последовательно: распознавание всё равно идёт по одному, а параллельная
        // отправка сотен мегабайт только отбирает канал у самой первой части.
        for (const [index, file] of picked.entries()) {
          const stored = await mediaApi.upload(file);
          const part = this.parts[index];

          if (part) {
            part.jobId = stored.jobId;
          }
        }

        this.startPoll();
      } catch (err) {
        this.error = text(asRecord(err).message);
      } finally {
        this.uploading = false;
      }
    },

    /**
     * Дочитать статусы частей и, если разбор ещё идёт, продолжить поллинг. Зовётся при
     * каждом открытии раздела: после перезагрузки страницы у восстановленных частей
     * есть только jobId, а расшифровка и прогресс лежат на сервере.
     */
    async resume() {
      if (!this.parts.length) {
        return;
      }

      await this.tick();

      if (this.needsPoll) {
        this.startPoll();
      }
    },

    /**
     * Один шаг поллинга. Опрашиваем ВСЕ незавершённые части: разбор запускается, только
     * когда готова каждая, иначе модель прочитала бы половину встречи и выдала бы это
     * за целую.
     */
    async tick() {
      let failures = 0;

      for (const part of this.parts) {
        if (!part.jobId || part.gone) {
          continue;
        }
        if (part.job?.status === 'done' || part.job?.status === 'failed') {
          continue;
        }

        try {
          part.job = await mediaApi.job(part.jobId);
        } catch (err) {
          // Пропавший job — не сбой сети: сервер потерял разбор (чистили каталог,
          // переезжал mediaDir), и ждать его возвращения бессмысленно.
          if (asRecord(err).status === 404) {
            part.gone = true;
            this.error = `Разбор части «${part.name}» больше не найден на сервере`
              + ' — запись придётся загрузить заново.';
            continue;
          }

          failures += 1;
        }
      }

      if (failures) {
        this.pollFailures += 1;

        if (this.pollFailures >= POLL_FAILURES_MAX) {
          this.stopPoll();
          this.error = 'Сервер не отвечает — статус разбора не обновляется. Обнови страницу.';
        }

        return;
      }

      this.pollFailures = 0;

      const failed = this.parts.find((part) => part.job?.status === 'failed');

      if (failed) {
        this.stopPoll();
        this.error = failed.job?.error || 'распознавание не удалось';

        return;
      }

      const alive = this.parts.filter((part) => !part.gone);

      if (alive.length && alive.every((part) => part.job?.status === 'done')) {
        this.stopPoll();
        // Разбор запускается САМ: человек пришёл за задачами, а не за расшифровкой,
        // и лишний клик между «готово» и единственным осмысленным следующим шагом
        // ничего не решает. Ручная кнопка остаётся — для повтора с уточнением.
        if (this.planModelRef() && !this.drafts.length && !this.planning) {
          void this.planTasks();
        }
      }
    },

    /** Модель разбора — своя настройка плагина «Видео»; её отсутствие не ломает раздел. */
    planModelRef(): unknown {
      const plugins = usePluginsStore() as unknown as VideoPluginsSource;

      return plugins.byId('video')?.values?.triageModel || null;
    },

    /**
     * Запускает опрос статуса. Прежний цикл гасится первым: два интервала на один
     * сеанс удвоили бы запросы и разошлись бы в счёте отказов.
     */
    startPoll() {
      this.stopPoll();
      this.pollFailures = 0;
      this.polling = true;
      timersOf(this).poll = setInterval(() => {
        void this.tick();
      }, POLL_INTERVAL_MS);
    },

    /**
     * Гасит опрос. Таймер живёт вне state: лежащий в нём, он будил бы подписку на
     * сохранение снимка сам собой — бесконечным кругом «мутация → запись → мутация».
     */
    stopPoll() {
      const own = timersOf(this);

      clearInterval(own.poll ?? undefined);
      own.poll = null;
      this.polling = false;
    },

    /**
     * Разбор расшифровки моделью: одна посылка на всю встречу, черновики дополняются.
     * Уже набранное руками разбор не трогает — стереть чужую работу кнопкой нельзя.
     */
    async planTasks() {
      this.planning = true;
      this.planError = null;
      this.planInfo = null;

      try {
        // Все части одной посылкой: сервер склеит их со сквозными таймкодами до модели.
        // Разбор по частям порознь терял бы поводы, начатые в одной и договорённые в другой.
        const plan = await mediaApi.planTasks({
          jobIds: this.partsDone.map((part) => part.jobId ?? ''),
          hint: this.planHint,
        });
        // Черновики модели ДОПОЛНЯЮТ уже набранные руками, а не заменяют их: человек мог
        // начать разбирать сам, и стереть его работу кнопкой «разобрать» — потеря данных.
        const added: VideoDraft[] = [];

        for (const task of plan.tasks) {
          this.drafts.push({
            ...this.emptyDraft(),
            title: task.title,
            description: task.description,
            confidence: task.confidence,
            reason: task.reason,
            // Кадра может не быть вовсе (аудиозапись, отказ ffmpeg) — это не ошибка разбора.
            frame: task.frame,
            at: task.at ?? task.frame?.at ?? null,
            editing: false,
          });

          // В список берём ИМЕННО реактивную копию из стора, а не исходный объект: `push`
          // оборачивает его прокси, и правка сырого объекта поменяла бы данные молча —
          // фрагмент приезжал бы, но на экране не появлялся.
          const stored = this.drafts[this.drafts.length - 1];

          if (stored) {
            added.push(stored);
          }
        }

        // Фрагменты подтягиваются ФОНОМ, уже после показа плана: резать их на сервере —
        // секунды ffmpeg на каждый, и ждать их вместе с разбором значит держать человека
        // перед пустым экраном ради того, что он посмотрит не в первую очередь.
        void this.loadClips(added);
        this.planInfo = {
          count: plan.tasks.length,
          model: plan.model,
          truncated: plan.truncated,
          shown: plan.count,
        };
      } catch (err) {
        // Машинный код лежит в `data.error`; фразу для человека собираем здесь, потому что
        // сервер отдаёт только код — у «модель не выбрана» и «модель не ответила» разные выходы.
        const code = text(asRecord(asRecord(err).data).error);

        this.planError = PLAN_ERRORS[code] || text(asRecord(err).message) || 'Разбор не удался.';
      } finally {
        this.planning = false;
      }
    },

    /**
     * Фрагмент к одному черновику. Окно фиксированное и стоит вокруг той же секунды, что
     * кадр и ссылка в описании: у картинки, у ссылки и у куска записи должно быть одно
     * место, иначе сверять их между собой нечем.
     */
    async requestClip(draft: VideoDraft, window = CLIP_WINDOW_STEP) {
      if (!Number.isFinite(draft.at) || draft.clipBusy) {
        return;
      }

      draft.clipBusy = true;
      draft.clipError = null;

      try {
        const cut = await mediaApi.clip({
          jobIds: this.partsDone.map((part) => part.jobId ?? ''),
          at: Number(draft.at),
          window,
        });

        // Пустой ответ — аудиозапись без картинки или отказ ffmpeg. Это не ошибка: задача
        // уже разобрана, и блок просто исчезает, как исчезает отсутствующий кадр.
        draft.clip = cut.clip;
        draft.clipWindow = window;
      } catch (err) {
        draft.clipError = text(asRecord(asRecord(err).data).message)
          || 'Фрагмент записи не вырезан.';
      } finally {
        draft.clipBusy = false;
      }
    },

    /**
     * Фрагменты ко всем свежим черновикам — ПО ОДНОМУ. Каждый кусок это запуск ffmpeg на
     * мозге, и десяток параллельных отнял бы машину у распознавания следующей записи.
     */
    async loadClips(list: VideoDraft[]) {
      for (const draft of list) {
        await this.requestClip(draft);
      }
    },

    widenClip(draft: VideoDraft) {
      const next = (Number(draft.clipWindow) || CLIP_WINDOW_STEP) + CLIP_WINDOW_STEP;

      return this.requestClip(draft, Math.min(CLIP_WINDOW_MAX, next));
    },

    addDraft() {
      this.drafts.push(this.emptyDraft());
    },

    removeDraft(index: number) {
      this.drafts.splice(index, 1);
    },

    /**
     * Перенести реплику в описание последнего черновика (ручной разбор). Черновика
     * может не быть вовсе — тогда он заводится тем же действием.
     */
    appendSegment(segment: MediaTranscriptSegment) {
      if (!this.drafts.length) {
        this.drafts.push(this.emptyDraft());
      }

      const draft = this.drafts[this.drafts.length - 1];

      if (!draft) {
        return;
      }

      const line = `[${mmss(segment.start)}] ${segment.text.trim()}`;

      draft.description = (draft.description ? `${draft.description}\n` : '') + line;
    },

    useFullText(value: string) {
      this.drafts.push({ ...this.emptyDraft(), description: value });
    },

    /**
     * Ставит ОДИН черновик. Отдельная кнопка у каждого — не удобство: формулировку собрала
     * модель по чужой речи, и человек принимает решение по каждой задаче отдельно. Общая
     * кнопка заставляла бы удалять лишние черновики только затем, чтобы поставить нужный.
     */
    async createOne(draft: VideoDraft) {
      if (draft.creating || draft.createdId || !draft.title.trim()) {
        return null;
      }

      draft.creating = true;
      draft.error = null;

      try {
        // Пустой выбор уезжает как null, а НЕ как 0: нулевой responsibleId портал
        // понимает буквально и отвечает ошибкой о несуществующем исполнителе
        // (docs/cockpit/b24.md). Пропуск же означает «поставить на владельца сессии».
        const created: unknown = await api.post('/api/b24/tasks', {
          title: draft.title.trim(),
          description: draft.description,
          // Постановщик: пусто — значит владелец сессии, и `CREATED_BY` порталу не уезжает
          // вовсе. Тот же запрет на ноль, что и у исполнителя.
          createdById: draft.createdById ? Number(draft.createdById) : null,
          responsibleId: draft.responsibleId ? Number(draft.responsibleId) : null,
          groupId: draft.groupId ? Number(draft.groupId) : null,
          priority: Number(draft.priority),
          // Кадр уезжает ИМЕНЕМ: путь на диске подставит сервер. Отказ человека от кадра
          // и его отсутствие выглядят для портала одинаково — вложений просто нет.
          frames: draft.frame && !draft.frameOff ? [draft.frame.name] : [],
          // Фрагмент — такое же вложение по имени. Отказ человека и отсутствие куска
          // выглядят для портала одинаково: вложения просто нет.
          clips: draft.clip && !draft.clipOff ? [draft.clip.name] : [],
        });
        const id = asRecord(created).id;

        draft.createdId = typeof id === 'number' || typeof id === 'string' ? id : '✓';
        this.created.push(draft.createdId);

        return draft.createdId;
      } catch (err) {
        // Ошибка остаётся У СВОЕГО черновика: при постановке пачкой общая плашка не
        // говорила бы, какая именно задача не уехала.
        draft.error = text(asRecord(err).message);

        return null;
      } finally {
        draft.creating = false;
      }
    },

    /**
     * Ставит все готовые черновики подряд. Последовательно: у B24Client одна портальная
     * сессия, и параллельные вызовы её рвут.
     */
    async createAll() {
      this.creating = true;
      this.error = null;

      try {
        // Последовательно: у B24Client одна портальная сессия, и параллельные вызовы её рвут.
        // Уже поставленные пропускаются сами — `ready` их не содержит.
        for (const draft of [...this.ready]) {
          await this.createOne(draft);
        }
      } finally {
        this.creating = false;
      }
    },
  },
});
