const REASONS: Record<string, string> = {
  disabled: 'Автоподтверждение чтения выключено.',
  prod_auto_read_disabled: 'Для прод-соединения нужен отдельный допуск.',
  not_read_query: 'Запрос не является чтением.',
  writable_rights: 'У пользователя обнаружено право записи.',
  connection_not_read_only: 'Соединение не открыто в read-only режиме.',
  multiple_statements: 'Разрешён только один запрос.',
  forbidden_query: 'Запрос содержит запрещённую конструкцию.',
  table_function: 'Табличная функция может читать внешний источник.',
  row_limit: 'Оценка превышает лимит строк.',
  byte_limit: 'Оценка превышает лимит байтов.',
  time_limit: 'Оценка превышает лимит времени.',
  rate_limit: 'Исчерпан лимит автозапросов в минуту.',
};

// Исход проверки. Отказ всегда называет причину: человеку нужно знать, почему
// запрос требует подтверждения, а не просто что оно требуется.
export interface AutoReadVerdict {
  eligible: boolean;
  reason: { code: string; message: string } | null;
}

export interface AutoReadInput {
  settings?: Record<string, unknown>;
  profile?: Record<string, unknown>;
  rights?: Record<string, unknown>;
  connection?: Record<string, unknown>;
  analysis?: Record<string, unknown>;
  limits?: Record<string, unknown>;
  rate?: Record<string, unknown>;
}

function denied(code: string): AutoReadVerdict {
  return { eligible: false, reason: { code, message: REASONS[code] as string } };
}

/** Auto-read разрешён только при одновременном доказательстве всех безопасных условий. */
export function evaluateAutoRead({
  settings = {}, profile = {}, rights = {}, connection = {},
  analysis = {}, limits = {}, rate = {},
}: AutoReadInput = {}): AutoReadVerdict {
  if (settings.enabled !== true) return denied('disabled');
  if (profile.prod === true && settings.prodEnabled !== true) return denied('prod_auto_read_disabled');
  if (analysis.queryClass !== 'read') return denied('not_read_query');
  if (rights.confirmedReadOnly !== true || rights.writable === true) return denied('writable_rights');
  if (connection.readOnlyActive !== true) return denied('connection_not_read_only');
  if (analysis.single !== true) return denied('multiple_statements');
  if ((analysis.forbidden as unknown[] | undefined)?.length) return denied('forbidden_query');
  if ((analysis.tableFunctions as unknown[] | undefined)?.length) return denied('table_function');
  if (!Number.isFinite(limits.rows)
      || Number(limits.rows) > Number(settings.maxRows)) return denied('row_limit');
  if (!Number.isFinite(limits.bytes)
      || Number(limits.bytes) > Number(settings.maxBytes)) return denied('byte_limit');
  if (!Number.isFinite(limits.timeoutMs)
      || Number(limits.timeoutMs) > Number(settings.timeoutMs)) {
    return denied('time_limit');
  }
  if (Number(rate.used) >= Number(settings.maxPerMinute)) return denied('rate_limit');
  return { eligible: true, reason: null };
}

export const decideAutoRead = evaluateAutoRead;
export default evaluateAutoRead;
