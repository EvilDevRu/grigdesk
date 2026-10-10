import { createHash } from 'node:crypto';

/**
 * Снимок запроса разрешения учитывает содержимое и свойства реального канала ответа.
 * Проверка выполняется синхронно владельцем pending перед его удалением и resolve.
 */
export function waitingIdentity(entry: {
  at?: unknown;
  tool?: unknown;
  input?: unknown;
  direct?: unknown;
  isQuestion?: unknown;
  acceptsComment?: unknown;
  acceptsText?: unknown;
  structuredAnswers?: unknown;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        at: entry.at ?? null,
        tool: entry.tool ?? null,
        input: entry.input ?? null,
        direct: entry.direct === true,
        isQuestion: entry.isQuestion === true,
        acceptsComment: entry.acceptsComment === true,
        acceptsText: entry.acceptsText === true,
        structuredAnswers: entry.structuredAnswers === true,
      }),
    )
    .digest('hex');
}
