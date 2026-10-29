/**
 * Только экземпляр этой ошибки переносит безопасное сообщение адаптера в HTTP-ответ.
 * Произвольный stderr, пути и секреты из исключения процесса остаются за общей границей.
 */
export class ExecutorRuntimeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ExecutorRuntimeError';
    this.code = code;
  }
}
