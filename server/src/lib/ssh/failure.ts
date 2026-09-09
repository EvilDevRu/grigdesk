/**
 * Отказ раздела с машинным кодом. HTTP-слой переводит код в статус ответа, а панель
 * различает по нему «сессия потеряна» и «так нельзя»: текст сообщения человеку
 * читаемый, но решение принимается по коду, и потому он обязан быть у каждого отказа.
 */
export class SshFailure extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'SshFailure';
    this.code = code;
  }
}

/**
 * Чужая ошибка приходит из библиотеки или файловой системы и своего типа не обещает.
 * Код читается мягко: его отсутствие — обычное дело, а не повод падать разбором.
 */
export function failureCode(error: unknown): string {
  const code = error !== null && typeof error === 'object'
    ? (error as { code?: unknown }).code
    : undefined;

  return typeof code === 'string' ? code : '';
}
