// Ошибки границы настроек содержат только безопасные коды и русское пояснение.
// Дамп процесса и введённое значение не становятся HTTP-ошибкой.

export class NativeSettingsError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly fieldIds: readonly string[];
  readonly reasons: readonly { fieldId: string; message: string }[];

  constructor(
    code: string,
    statusCode: number,
    message: string,
    fieldIds: readonly string[] = [],
    reasons: readonly { fieldId: string; message: string }[] = [],
  ) {
    super(message);
    this.name = 'NativeSettingsError';
    this.code = code;
    this.statusCode = statusCode;
    this.fieldIds = fieldIds;
    this.reasons = reasons;
  }
}
