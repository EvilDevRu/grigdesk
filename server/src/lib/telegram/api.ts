// Тонкий клиент Bot API. Только HTTP-обёртка: смысл методов живёт у тех, кто их
// зовёт, здесь — единый разбор ответа и единая типизация отказа.
//
// Отказ бывает двух РАЗНЫХ сортов, и путать их дорого:
//  • `kind: 'telegram'` — Телеграм ответил и отказал (неверный токен, нет прав).
//    Значит чинить надо у себя: перевыпустить токен, дать боту права;
//  • `kind: 'transport'` — до Телеграма не доехали вовсе (нет сети, VPN моргнул).
//    Токен при этом может быть отличным, и стирать его нельзя.
// Показать одинаковое «токен не принят» в обоих случаях — значит отправить
// человека перевыпускать рабочий токен из-за упавшего туннеля.
//
// Токен живёт в URL, поэтому любая ошибка чистится от него перед выбросом:
// сообщение уедет и в лог, и на экран.
import { maskToken } from './token.ts';

type Payload = Record<string, unknown>;

// Настройки одного вызова. `fetchImpl` подменяется в тестах, `retries` включает
// повтор только там, где он безопасен, — решает это вызывающий, а не клиент.
export interface BotApiOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retries?: number;
  limit?: number;
  sleepImpl?: (ms: number) => Promise<void>;
}

const BASE = 'https://api.telegram.org';

// Паузы между повторами транспортного отказа. Короткие: повтор идёт внутри хода,
// которого ждёт человек, и обязан либо быстро помочь, либо быстро сдаться.
const RETRY_DELAYS_MS = Object.freeze([500, 1500]);

/** Ошибка с типом отказа; текст уже без секрета. */
function apiError(message: string, kind: string, extra: Payload = {}): Error {
  return Object.assign(new Error(message), { kind, ...extra });
}

const wait = (ms: number) => new Promise<void>((resolve) => {
  setTimeout(resolve, ms);
});

/**
 * Повтор ТОЛЬКО транспортного отказа и ТОЛЬКО там, где повтор безопасен.
 *
 * Право на повтор даёт идемпотентность вызова, а не его важность: `getFile` и
 * скачивание байтов ничего не меняют на стороне Телеграма, поэтому вторая
 * попытка после оборванного TLS честно чинит моргнувшую сеть. Отправка
 * сообщения таким свойством не обладает: после таймаута нельзя узнать, дошла ли
 * первая, а idempotency key Bot API не даёт — там повтор означал бы дубль в
 * чужом чате. Поэтому `retries` по умолчанию 0, и включает его вызывающий.
 *
 * Отказ самого Телеграма (`kind: 'telegram'`) не повторяется никогда: неверный
 * токен, отсутствие прав и файл сверх предела ожиданием не лечатся.
 */
async function retryTransport<Result>(attempt: () => Promise<Result>, { retries = 0, sleepImpl = wait }: {
  retries?: number;
  sleepImpl?: (ms: number) => Promise<void>;
} = {}): Promise<Result> {
  const allowed = Math.max(0, Math.min(Number(retries) || 0, RETRY_DELAYS_MS.length));

  for (let done = 0; ; done += 1) {
    try {
      return await attempt();
    } catch (err) {
      if ((err as { kind?: unknown } | null)?.kind !== 'transport' || done >= allowed) throw err;
      await sleepImpl(Number(RETRY_DELAYS_MS[done]));
    }
  }
}

/** Убирает токен из любого текста — в лог и на экран уходит только маска. */
export function scrubToken(text: unknown, token: unknown): string {
  const t = String(token ?? '').trim();
  if (!t) return String(text ?? '');
  return String(text ?? '').split(t).join(maskToken(t));
}

/**
 * Вызов метода Bot API.
 * @param {string} token
 * @param {string} method
 * @param {object} [body]
 * @param {{ fetchImpl?: Function, timeoutMs?: number, retries?: number }} [opts]
 */
export async function callBotApi(
  token: string,
  method: string,
  body?: Payload,
  opts: BotApiOptions = {},
): Promise<Payload> {
  return retryTransport(() => callBotApiOnce(token, method, body, opts), opts);
}

async function callBotApiOnce(
  token: string,
  method: string,
  body?: Payload,
  opts: BotApiOptions = {},
): Promise<Payload> {
  const { fetchImpl = fetch, timeoutMs = 15000 } = opts;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res: Response;

  try {
    res = await fetchImpl(`${BASE}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: ac.signal,
    });
  } catch (err) {
    const failure = err as { message?: unknown; code?: unknown };
    const why = ac.signal.aborted
      ? `нет ответа за ${Math.round(timeoutMs / 1000)} с`
      : String(failure?.message ?? err);

    throw apiError(scrubToken(why, token), 'transport', { code: failure?.code || 'ABORT_ERR' });
  } finally {
    clearTimeout(timer);
  }

  let json: Payload = {};

  try { json = await res.json() as Payload; } catch { /* пустое тело разберём ниже по коду */ }
  if (!json.ok) {
    const why = String(json.description || `HTTP ${res.status}`);

    throw apiError(scrubToken(why, token), 'telegram', { status: res.status });
  }

  return json.result as Payload;
}

/**
 * Потолок скачивания у Bot API — 20 МБ. Это ограничение самого Телеграма, а не
 * наша осторожность: файл больше бот не получит никаким способом.
 */
export const FILE_LIMIT = 20 * 1024 * 1024;

/**
 * Где лежит файл. Отдельный шаг: `fileId` — это адрес НАВСЕГДА, а `filePath`
 * живёт около часа, поэтому его нельзя сохранить впрок и надо спрашивать заново
 * перед каждой загрузкой.
 * @returns {Promise<{fileId: string, filePath: string, size: number|null}>}
 */
export async function getFile(token: string, fileId: string, opts?: BotApiOptions): Promise<{
  fileId: string;
  filePath: string;
  size: number | null;
}> {
  const f = await callBotApi(token, 'getFile', { file_id: fileId }, opts);

  return {
    fileId,
    filePath: String(f.file_path || ''),
    size: (f.file_size as number) ?? null,
  };
}

/**
 * Байты файла. Адрес другой, чем у методов (`/file/bot…`), поэтому отдельная
 * функция, а не `callBotApi`: ответ здесь не JSON.
 *
 * Размер проверяется дважды — по заголовку и по факту: `content-length` бывает
 * пустым, а качать в память гигабайт из-за этого не хочется.
 */
export async function downloadFile(
  token: string,
  filePath: string,
  opts: BotApiOptions = {},
): Promise<Buffer> {
  return retryTransport(() => downloadFileOnce(token, filePath, opts), opts);
}

async function downloadFileOnce(
  token: string,
  filePath: string,
  opts: BotApiOptions = {},
): Promise<Buffer> {
  const { fetchImpl = fetch, timeoutMs = 60000, limit = FILE_LIMIT } = opts;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res: Response;

  try {
    res = await fetchImpl(`${BASE}/file/bot${token}/${filePath}`, { signal: ac.signal });
  } catch (err) {
    const failure = err as { message?: unknown; code?: unknown };
    const why = ac.signal.aborted
      ? `нет ответа за ${Math.round(timeoutMs / 1000)} с`
      : String(failure?.message ?? err);

    throw apiError(scrubToken(why, token), 'transport', { code: failure?.code || 'ABORT_ERR' });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw apiError(scrubToken(`HTTP ${res.status}`, token), 'telegram', { status: res.status });
  }
  const declared = Number(res.headers?.get?.('content-length') || 0);
  if (declared > limit) {
    throw apiError(`файл ${Math.round(declared / 1024 / 1024)} МБ — больше предела бота`, 'telegram');
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > limit) {
    throw apiError(`файл ${Math.round(buffer.length / 1024 / 1024)} МБ — больше предела бота`, 'telegram');
  }
  return buffer;
}

/**
 * Индикатор «печатает…» в чате. Намеренно без повтора: это неидемпотентный
 * вызов — после обрыва нельзя узнать, дошла ли первая попытка, а дубль
 * индикатора хуже его отсутствия. Поэтому идёт через `callBotApiOnce`,
 * а `retries` из opts здесь не действует.
 */
export async function sendChatAction(
  token: string,
  chatId: number | string,
  action: string,
  opts: BotApiOptions = {},
): Promise<Payload> {
  return callBotApiOnce(token, 'sendChatAction', { chat_id: chatId, action }, opts);
}

/**
 * Кто мы. Единственный способ проверить токен, ничего при этом не отправив.
 * @returns {Promise<{id:number, username:string, firstName:string,
 *   canJoinGroups:boolean, canReadAllGroupMessages:boolean}>}
 */
export async function getMe(token: string, opts?: BotApiOptions): Promise<{
  id: number;
  username: string;
  firstName: string;
  canJoinGroups: boolean;
  canReadAllGroupMessages: boolean;
}> {
  const me = await callBotApi(token, 'getMe', {}, opts);

  return {
    id: me.id as number,
    username: String(me.username || ''),
    firstName: String(me.first_name || ''),
    canJoinGroups: !!me.can_join_groups,
    // Он же выключенный privacy mode: без него бот в группе видит только
    // сообщения, адресованные ему, — то есть жалоб не увидит вовсе.
    canReadAllGroupMessages: !!me.can_read_all_group_messages,
  };
}
