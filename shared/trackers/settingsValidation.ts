import type { TrackerSettingsField, TrackerSettingsSchema } from './contracts.ts';

/**
 * Адрес портала распознаётся по общей подписи схемы, независимо от поставщика драйвера.
 * Отсутствующая схема становится HTTPS; явная схема и остальные реквизиты сохраняются.
 */
export function normalizeTrackerPortalInput(field: TrackerSettingsField, value: string): string {
  if (field.type !== 'string' || field.secret || !field.label || typeof field.label !== 'object'
    || !('key' in field.label)
    || field.label.key !== 'core.trackerPortal') {
    return value;
  }

  const address = value.trim();
  const hasScheme = /^[a-z][a-z\d+.-]*:/iu.test(address)
    && !/^[^/?#]+:\d+(?:[/?#]|$)/u.test(address);

  if (!address || hasScheme) {
    return address;
  }

  return address.startsWith('//') ? `https:${address}` : `https://${address}`;
}

/**
 * Назначение секрета задаёт схема, без выбора поставщика по id драйвера.
 * Прежние пакеты распознаются по общей семантической подписи поля токена.
 */
export function isTrackerTokenField(field: TrackerSettingsField): boolean {
  return field.type === 'string' && field.secret === true && (field.format === 'api-token'
    || Boolean(field.label && typeof field.label === 'object'
      && 'key' in field.label && field.label.key === 'core.trackerAccessToken'));
}

/**
 * Непрозрачный токен не ограничивается алфавитом Bearer: транспорт задаёт драйвер.
 * Отсекаются ошибки вставки; подлинность проверяет testAuth, пустой ввод сохраняет секрет.
 */
export function isTrackerTokenInput(value: string): boolean {
  return value === '' || (!/[\s\p{C}]/u.test(value)
    && !/^["']|["']$/u.test(value)
    && !/^[a-z][a-z\d+.-]*:\/\//iu.test(value));
}

/**
 * Действующий режим определяется объединёнными реквизитами, включая сохранённый select.
 * Скрытый токен не мешает режиму пароля и не вызывает проверку чужого транспорта.
 */
export function visibleTrackerTokenKeys(
  schema: TrackerSettingsSchema,
  values: Record<string, unknown>,
): string[] {
  return Object.entries(schema)
    .filter(([, field]) => isTrackerTokenField(field)
      && (!field.visibleIf || values[field.visibleIf.field] === field.visibleIf.equals))
    .map(([key]) => key);
}
