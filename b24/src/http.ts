import http from 'node:http';
import type { IncomingMessage } from 'node:http';
import https from 'node:https';

import type { Connection } from './config.ts';
import { B24Error } from './errors.ts';

export interface RequestSpec {
  method: 'GET' | 'POST';
  path: string;
  body?: Uint8Array | string;
  json?: boolean;
}

const NETWORK_ERROR = 'Не удалось связаться с GrigDesk.';
const TIMEOUT_ERROR = 'GrigDesk не ответил за 300 с: операция могла выполниться — '
  + 'проверьте результат перед повтором.';
const TIMEOUT_MS = 300_000;
const REASON_BYTES = 64 * 1024;
const REASON_CHARS = 500;

/**
 * Достаёт русскую причину отказа из поля message JSON-тела сервера, читая не больше 64 КиБ.
 * Ошибки чтения остаются транспортными; только неверный JSON даёт пустую причину.
 * Токен маскируется до обрезки, C0/DEL/C1 заменяются пробелом; остальное тело не показывается.
 */
async function failureReason(response: IncomingMessage, token: string): Promise<string> {
  const type = response.headers['content-type'] || '';

  if (!type.includes('application/json')) {
    response.destroy();

    return '';
  }

  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of response) {
    size += chunk.length;

    if (size > REASON_BYTES) {
      return '';
    }

    chunks.push(chunk);
  }

  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { message?: unknown } | null;
    const message = typeof parsed?.message === 'string' ? parsed.message : '';
    const masked = token ? message.replaceAll(token, '***') : message;
    const clean = masked.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim();

    return clean.length > REASON_CHARS ? `${clean.slice(0, REASON_CHARS)}…` : clean;
  } catch {
    return '';
  }
}

/**
 * Выполняет один запрос к GrigDesk без повторов и без перехода по redirect.
 * Собственный агент без proxyEnv игнорирует прокси; простой сокета ограничен 300 секундами.
 * Успешное тело читается целиком до выдачи, агент закрывается при любом исходе.
 */
export async function request(
  connection: Connection,
  spec: RequestSpec,
  options: { timeoutMs?: number } = {},
): Promise<Uint8Array> {
  const headers: Record<string, string> = { 'X-GrigDesk-Token': connection.token };

  if (spec.json) {
    headers['Content-Type'] = 'application/json';
  }

  if (spec.body !== undefined) {
    headers['Content-Length'] = String(Buffer.byteLength(spec.body));
  }

  const transport = connection.baseUrl.startsWith('https:') ? https : http;
  const agent = new transport.Agent();
  let timedOut = false;

  try {
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const outgoing = transport.request(`${connection.baseUrl}${spec.path}`, {
        method: spec.method,
        headers,
        agent,
      }, resolve);

      outgoing.once('error', reject);
      outgoing.setTimeout(options.timeoutMs ?? TIMEOUT_MS, () => {
        timedOut = true;
        outgoing.destroy(new Error('Истёк срок простоя сокета'));
      });
      outgoing.end(spec.body);
    });
    const status = response.statusCode ?? 0;

    if (status < 200 || status > 299) {
      const reason = await failureReason(response, connection.token);
      const detail = reason ? `: ${reason}` : '';
      const end = /[.!?…]$/.test(detail) ? '' : '.';

      throw new B24Error(22, `Запрос к GrigDesk завершился ошибкой HTTP ${status}${detail}${end}`);
    }

    const chunks: Buffer[] = [];

    for await (const chunk of response) {
      chunks.push(chunk);
    }

    return Buffer.concat(chunks);
  } catch (error) {
    if (error instanceof B24Error) {
      throw error;
    }

    throw new B24Error(22, timedOut ? TIMEOUT_ERROR : NETWORK_ERROR);
  } finally {
    agent.destroy();
  }
}
