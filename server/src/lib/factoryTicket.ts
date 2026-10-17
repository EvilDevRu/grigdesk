// Тикет route-прогона — единственный вход задачи в движок.
//
// В v1 задача уезжала в конвейер одной строкой `--ticket <текст>`, и её формат был
// делом договорённости. Теперь тикет — файл, который движок делает СВОЕЙ доверенной
// копией (режим 400, один hardlink) и больше никогда не перечитывает: попытка
// immutable, значит и постановка задачи immutable. Отсюда жёсткость валидатора
// (engine/bin/factory-context, read_ticket): ровно шесть полей, лишнее поле или
// пустая строка — отказ 78.
//
// ПОЧЕМУ ПРОВЕРЯЕМ У СЕБЯ. Движок читает тикет не на старте, а при сборке
// bootstrap-контекста — то есть ПОСЛЕ подъёма песочницы. Опечатка в поле обернулась
// бы отказом через 20–25 минут провижининга и потерянным слотом стенда. Поэтому
// правила валидатора продублированы здесь один в один; расхождение ловит
// tests/server/factory-ticket.test.js.
import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Лимиты движка (engine/bin/factory-context). Меняются только вместе с ним. */
export const TICKET_LIMITS = {
  title: 500,
  description: 100_000,
  criteria: 100,
  criterion: 2_000,
  sourceUrl: 2_000,
  // MAX_JSON_BYTES валидатора: потолок на ФАЙЛ, а не на поле. С кириллицей два байта
  // на символ, поэтому описание в 100 000 символов лимит поля пройдёт, а файл — нет.
  fileBytes: 256 * 1024,
};

const TICKET_FIELDS = ['schema', 'taskId', 'title', 'description', 'acceptanceCriteria', 'sourceUrl'];

// Тикет ровно в той форме, которую принимает `read_ticket` движка: шесть полей, не больше.
export interface RouteTicket {
  schema: 1;
  taskId: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  sourceUrl: string;
}

// Дополнительный контекст, которого нет в описании задачи: уточнения и комментарии.
export interface TicketSection {
  title?: unknown;
  text?: unknown;
}

// Из чего кокпит собирает тикет. Всё, кроме номера задачи, приходит из трекера и от
// человека, поэтому объявлено недоверенным и чистится при сборке.
export interface TicketDraft {
  task: string | number | null | undefined;
  title?: unknown;
  description?: unknown;
  acceptanceCriteria?: unknown;
  sourceUrl?: unknown;
  sections?: Array<TicketSection | null | undefined>;
}
// Регулярки — копии валидатора движка (URL_RE, TASK_RE). Специально не «умнее» его:
// пропустить то, что он отвергнет, значит вернуть отказ через полчаса провижининга.
const URL_RE = /^https?:\/\/[A-Za-z0-9.:[\]-]+(?:\/.*)?$/;
const TASK_RE = /^[1-9][0-9]{0,18}$/;
const TRUNCATED = '\n\n[описание обрезано кокпитом: не помещается в тикет]';

/** Тикет не собран/не прошёл проверку — роут отвечает 400, а не 500. */
export class TicketError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TicketError';
  }
}

/** Ровно тот JSON, который увидит движок (и человек, если откроет файл). */
export function serializeTicket(ticket: RouteTicket): string {
  return `${JSON.stringify(ticket, TICKET_FIELDS, 2)}\n`;
}

function assertString(value: unknown, label: string, { min = 1, max }: {
  min?: number;
  max: number;
}): string {
  if (typeof value !== 'string' || value.length < min || value.length > max || value.includes('\0')) {
    throw new TicketError(`${label}: нужна строка ${min}–${max} символов без нулевых байтов`);
  }
  return value;
}

/**
 * Проверка ровно тем же набором правил, что и `read_ticket` движка.
 * Причина отказа — человеческий текст в TicketError.
 */
export function validateTicket(ticket: unknown, expectedTask: string | number): RouteTicket {
  if (!ticket || typeof ticket !== 'object' || Array.isArray(ticket)) {
    throw new TicketError('тикет: ожидался объект');
  }
  // Набор ключей сверяется прямо ниже, поэтому дальше объект читается как тикет.
  const candidate = ticket as RouteTicket;
  const keys = Object.keys(ticket).sort();
  const expected = [...TICKET_FIELDS].sort();
  if (keys.length !== expected.length || keys.some((k, i) => k !== expected[i])) {
    throw new TicketError(`тикет: ожидались ровно поля ${expected.join(', ')} (пришло: ${keys.join(', ') || '—'})`);
  }
  if (candidate.schema !== 1) throw new TicketError('ticket.schema: поддерживается только 1');
  const taskId = assertString(candidate.taskId, 'ticket.taskId', { max: 512 });
  if (!TASK_RE.test(taskId)) throw new TicketError('ticket.taskId: нужен номер задачи строкой');
  if (String(expectedTask) !== taskId) throw new TicketError('ticket.taskId: не совпадает с запуском');
  assertString(candidate.title, 'ticket.title', { max: TICKET_LIMITS.title });
  assertString(candidate.description, 'ticket.description', { max: TICKET_LIMITS.description });
  if (!Array.isArray(candidate.acceptanceCriteria)
    || candidate.acceptanceCriteria.length > TICKET_LIMITS.criteria) {
    throw new TicketError(`ticket.acceptanceCriteria: ожидался массив до ${TICKET_LIMITS.criteria} строк`);
  }
  candidate.acceptanceCriteria.forEach((item, index) => {
    assertString(item, `ticket.acceptanceCriteria[${index}]`, { max: TICKET_LIMITS.criterion });
  });
  const url = assertString(candidate.sourceUrl, 'ticket.sourceUrl', { max: TICKET_LIMITS.sourceUrl });
  if (!URL_RE.test(url)) throw new TicketError('ticket.sourceUrl: нужен http(s) URL');
  const size = Buffer.byteLength(serializeTicket(candidate), 'utf8');
  if (size > TICKET_LIMITS.fileBytes) {
    throw new TicketError(`тикет: ${size} байт при потолке ${TICKET_LIMITS.fileBytes} — сократи описание или критерии`);
  }
  return candidate;
}

/**
 * Описание урезаем до ДВУХ потолков сразу: посимвольного (поле) и побайтового (файл).
 * Режем именно описание: заголовок и критерии приёмки — это постановка, терять их
 * молча нельзя, а описание всегда есть в трекере целиком.
 */
function fitDescription(draft: RouteTicket): RouteTicket {
  let body = draft.description;
  let trimmed = false;
  const compose = () => ({ ...draft, description: trimmed ? body + TRUNCATED : body });
  const room = TICKET_LIMITS.description - TRUNCATED.length;
  if (body.length > room) {
    body = body.slice(0, room);
    trimmed = true;
  }
  // Байты считаем по факту сериализации: экранирование JSON тоже занимает место.
  for (let guard = 0; guard < 64; guard += 1) {
    const ticket = compose();
    const over = Buffer.byteLength(serializeTicket(ticket), 'utf8') - TICKET_LIMITS.fileBytes;
    if (over <= 0) return ticket;
    if (!body) break;
    // Символ кириллицы — два байта, поэтому «лишние байты / 2» это минимум среза;
    // запас в 64 символа не даёт циклу ползти по одному символу за проход.
    body = body.slice(0, Math.max(0, body.length - Math.ceil(over / 2) - 64));
    trimmed = true;
  }
  return compose();
}

/**
 * Собрать тикет из того, что знает кокпит.
 *
 * `sections` — контекст, которого нет в описании задачи (уточнения человека,
 * комментарии из трекера). Отдельных полей под них в тикете нет и завести нельзя
 * (валидатор требует ровно шесть), поэтому они уходят в конец описания теми же
 * заголовками, что и в v1: агент читал их именно так.
 */
export function buildTicket({
  task, title, description = '', acceptanceCriteria = [], sourceUrl = '', sections = [],
}: TicketDraft): RouteTicket {
  const id = String(task ?? '').trim();
  if (!TASK_RE.test(id)) throw new TicketError('номер задачи: нужен положительный номер');
  const clean = (value: unknown) => String(value ?? '').replace(/\0/g, '').trim();

  const head = clean(title);
  if (!head) throw new TicketError('заголовок задачи пуст — движок отвергнет тикет');
  const url = clean(sourceUrl);
  if (!url) throw new TicketError('нет ссылки на задачу: заполни адрес портала в «Настройках → Битрикс24»');

  const body = [clean(description), ...sections
    .map((s) => ({ title: clean(s?.title), text: clean(s?.text) }))
    .filter((s) => s.text)
    .map((s) => (s.title ? `${s.title}\n${s.text}` : s.text))].filter(Boolean).join('\n\n');

  const criteria = (Array.isArray(acceptanceCriteria) ? acceptanceCriteria : [])
    .map((item) => clean(item).slice(0, TICKET_LIMITS.criterion))
    .filter(Boolean)
    .slice(0, TICKET_LIMITS.criteria);

  const ticket = fitDescription({
    schema: 1,
    taskId: id,
    title: head.slice(0, TICKET_LIMITS.title),
    // Пустое описание валидатор не примет: задача без постановки — это не задача.
    description: body || head,
    acceptanceCriteria: criteria,
    sourceUrl: url.slice(0, TICKET_LIMITS.sourceUrl),
  });
  return validateTicket(ticket, id);
}

/**
 * Записать тикет туда, откуда движок сможет сделать доверенную копию.
 *
 * Требования `canonical_file`: абсолютный путь без symlink-компонентов, обычный
 * файл. Каталог — хранилище кокпита (state/ в папке данных), а НЕ рабочее дерево задачи:
 * дерево принадлежит агенту, и файл постановки в нём агент может переписать.
 * Возвращает абсолютный путь тикета.
 */
export async function writeTicketFile({ dir, task, ticket }: {
  dir: string;
  task: string | number;
  ticket: RouteTicket;
}): Promise<string> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const real = await fs.realpath(dir);
  const file = path.join(real, `t${String(task)}.ticket.json`);
  const tmp = path.join(real, `.t${String(task)}.ticket.json.tmp`);
  await fs.writeFile(tmp, serializeTicket(ticket), { encoding: 'utf8', mode: 0o600 });
  await fs.rename(tmp, file);
  return file;
}
