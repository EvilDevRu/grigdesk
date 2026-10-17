export const UNKNOWN_FAILURE = 'Не удалось выполнить команду b24.';

/**
 * Отказ команды b24 с кодом выхода и русским сообщением для stderr.
 * Сообщение не содержит токена, тела ответа и английского стека.
 */
export class B24Error extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = 'B24Error';
    this.code = code;
  }
}

/**
 * Приводит любой отказ к известной паре код/сообщение.
 * Неизвестная внутренняя ошибка не показывает произвольный message.
 */
export function describeFailure(error: unknown): B24Error {
  if (error instanceof B24Error) {
    return error;
  }

  return new B24Error(1, UNKNOWN_FAILURE);
}
