export class MobileInputError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/**
 * Проверяет короткое имя, которое допускается показывать в настройках и QR.
 * Пустые имена и управляющие символы не становятся частью протокола.
 */
export function deviceName(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.trim().length > 40 ||
    /[\x00-\x1f]/.test(value)
  ) {
    throw new MobileInputError('bad_name', 'Имя должно содержать от 1 до 40 символов.');
  }

  return value.trim();
}
