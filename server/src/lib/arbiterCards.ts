// Разбор арбитра, сохранённый для человека.
//
// Арбитр — единственное место, где машинный жаргон вердиктов превращается в человеческую
// формулировку: его карточка объявлена в промпте как «одной фразой, без путей и хешей» и
// «обычными словами». Но до 28.08.2026 она никуда не сохранялась: HTTP-путь показывал её
// одноразовым диалогом, а автоматический вотчер отбрасывал вовсе — комментарий в его коде
// утверждал, что «карточка уже лежит в журнале сервера», хотя не лежала нигде. То есть
// автомат тратил живого агента и деньги, писал понятный ответ и терял его.
//
// Здесь он и хранится: по одной последней записи на задачу, привязанной к попытке. Запись
// переживает перезапуск сервера и показывается в карточке остановки, пока задача стоит.
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA_VERSION = 1;

// Верхняя граница набора. Записей столько же, сколько остановленных задач за историю
// установки; полсотни хватает с запасом, а неограниченный файл рос бы вечно.
const MAX_RECORDS = 50;

const TASK_RE = /^\d{1,12}$/;
const ATTEMPT_RE = /^a_[0-9a-f]{32}$/;
const NODE_RE = /^[a-z0-9][a-z0-9_]{0,40}$/;
// `deferred` — решение, которое меняет границу задачи, но арбитр взял его на себя,
// выбрав минимальный вариант. Конвейер при этом НЕ встаёт: проверка переносится на
// ворота, где человек и так принимает план и результат.
const VERDICTS = new Set(['resolve', 'human', 'deferred']);

// Сколько решений одной попытки помним ради сводки в воротах. Ворота — теперь
// единственная точка контроля человека, и «что решалось по дороге» обязано доехать
// до неё целиком; десяти хватает на маршрут любой длины.
const MAX_HISTORY = 10;
const CARD_FIELDS = ['what', 'why', 'proof', 'risk'];
const FIELD_LIMIT = 1200;
const MODEL_LIMIT = 120;
const CONTROL_RE = /[\u0000-\u001f\u007f]/g;

// Карточка разбора: четыре поля промпта, каждое уже обрезано и очищено от управляющих.
type ArbiterCard = Record<string, string>;

// Сохранённый разбор одной остановки: чем он вызван, чем закончился и что решалось
// по дороге в рамках ТОЙ ЖЕ попытки.
export interface ArbiterCardRecord {
  attempt: string | null;
  verdict: string;
  scopeChange: boolean;
  model: string | null;
  node: string | null;
  stop: string | null;
  at: string;
  card: ArbiterCard;
  history?: ArbiterCardRecord[];
}

// Файл целиком: версия схемы и записи по номеру задачи.
interface ArbiterCardsDocument {
  schemaVersion: number;
  records: Record<string, ArbiterCardRecord>;
}

function text(value: unknown, limit: number) {
  if (typeof value !== 'string') return '';
  const flat = value.replace(CONTROL_RE, ' ').replace(/[ \t]+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

const emptyDocument = (): ArbiterCardsDocument => ({ schemaVersion: SCHEMA_VERSION, records: {} });

/**
 * Нормализует прочитанный документ.
 *
 * Битую или чужую схему считаем отсутствующей: карточка арбитра — это подсказка человеку,
 * и падать из-за неё нельзя. Потерянная подсказка дешевле недоступной страницы конвейера.
 */
function normalizeDocument(value: unknown): ArbiterCardsDocument {
  const raw = value as { schemaVersion?: unknown; records?: unknown } | null;
  if (!raw || typeof raw !== 'object' || raw.schemaVersion !== SCHEMA_VERSION) {
    return emptyDocument();
  }
  const records: Record<string, ArbiterCardRecord> = {};
  const stored = (raw.records || {}) as Record<string, ArbiterCardRecord | null>;
  for (const [task, record] of Object.entries(stored)) {
    if (!TASK_RE.test(task) || !record || typeof record !== 'object') continue;
    if (!VERDICTS.has(record.verdict)) continue;
    const history = Array.isArray(record.history)
      ? record.history.filter((row) => row && VERDICTS.has(row.verdict)).slice(0, MAX_HISTORY)
      : [];
    records[task] = { ...record, history };
  }
  return { schemaVersion: SCHEMA_VERSION, records };
}

export class ArbiterCardsStore {
  readonly filePath: string;

  private _queue: Promise<unknown> = Promise.resolve();

  private _writeSeq = 0;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /**
   * Сохраняет разбор последней остановки задачи.
   *
   * Одна запись на задачу: разбор относится к тому, что человек видит на экране прямо
   * сейчас, а история арбитражей уже лежит в immutable-журнале попытки. Новая остановка
   * той же задачи перекрывает прежнюю подсказку — иначе человек читал бы вчерашнюю.
   */
  save(task: unknown, { attempt, verdict, card, scopeChange, model, node, stop }: {
    attempt?: string | null;
    verdict?: string;
    card?: Record<string, unknown> | null;
    scopeChange?: unknown;
    model?: unknown;
    node?: string | null;
    stop?: unknown;
  }): Promise<ArbiterCardRecord | null> {
    const key = String(task);
    if (!TASK_RE.test(key) || !VERDICTS.has(String(verdict))) return Promise.resolve(null);

    const record: ArbiterCardRecord = {
      attempt: ATTEMPT_RE.test(attempt || '') ? String(attempt) : null,
      verdict: String(verdict),
      scopeChange: scopeChange === true,
      model: text(model, MODEL_LIMIT) || null,
      node: NODE_RE.test(node || '') ? String(node) : null,
      stop: text(stop, 40) || null,
      at: new Date().toISOString(),
      card: Object.fromEntries(CARD_FIELDS.map((field) => [field, text(card?.[field], FIELD_LIMIT)])),
    };

    return this._run(() => {
      const document = this._read();
      // История принадлежит ПОПЫТКЕ: после resume или новой попытки прежние решения
      // относятся к работе, которой больше нет, и в сводку ворот попасть не должны.
      const previous = document.records[key];
      const sameAttempt = previous && record.attempt && previous.attempt === record.attempt;
      const history = sameAttempt ? [...(previous.history || [])] : [];
      history.unshift({ ...record, history: undefined });
      record.history = history.slice(0, MAX_HISTORY);
      document.records[key] = record;

      // Вытесняем самые давние записи, а не первые попавшиеся: свежая подсказка нужнее.
      const keys = Object.keys(document.records)
        .sort((a, b) => String(document.records[b]?.at).localeCompare(String(document.records[a]?.at)));
      for (const stale of keys.slice(MAX_RECORDS)) delete document.records[stale];

      this._write(document);
      return record;
    });
  }

  /**
   * Разбор, относящийся к ТЕКУЩЕЙ попытке задачи.
   *
   * Привязка к попытке обязательна: после `resume` или нового запуска прежний разбор
   * относится к работе, которой больше нет, и показывать его как свежий нельзя.
   */
  read(task: unknown, attempt?: string | null): ArbiterCardRecord | null {
    const key = String(task);
    if (!TASK_RE.test(key)) return null;
    let document: ArbiterCardsDocument;
    try {
      document = this._read();
    } catch {
      return null;
    }
    const record = document.records[key];
    if (!record) return null;
    if (record.attempt && attempt && record.attempt !== attempt) return null;
    return record;
  }

  _run<Value>(fn: () => Value): Promise<Value> {
    const result = this._queue.then(fn, fn);
    this._queue = result.then(() => undefined, () => undefined);
    return result;
  }

  _read(): ArbiterCardsDocument {
    let source: string;
    try {
      source = fs.readFileSync(this.filePath, 'utf8');
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === 'ENOENT') return emptyDocument();
      throw error;
    }
    try {
      return normalizeDocument(JSON.parse(source));
    } catch {
      return emptyDocument();
    }
  }

  _write(document: ArbiterCardsDocument) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this._writeSeq += 1;
    const temporary = `${this.filePath}.${process.pid}.${this._writeSeq}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(document, null, 2), { mode: 0o600 });
      fs.renameSync(temporary, this.filePath);
      fs.chmodSync(this.filePath, 0o600);
    } catch (error) {
      try { fs.unlinkSync(temporary); } catch { /* файл мог не создаться */ }
      throw error;
    }
  }
}
