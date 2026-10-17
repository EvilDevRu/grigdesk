// API выдаёт безопасные коды и собственные сообщения без stack, accountKey или CDN URL.
// Внешние тексты доступны только в уже нормализованном ProviderError.
import { parseStudio3d } from '../../../../shared/studio3d/studio3dContracts.ts';
import { JobError } from '../../lib/studio3d/jobs.ts';
import { ProviderFailure } from '../../lib/studio3d/provider.ts';

import { StudioHttpError } from '../../lib/studio3d/assetErrors.ts';

export { StudioHttpError } from '../../lib/studio3d/assetErrors.ts';

/**
 * Filesystem ошибки не публикуют внутренний path. Конфликт библиотеки и оплаты
 * остаётся 409, неверный пользовательский ввод — 400, отсутствующий объект — 404.
 */
export function publicStudioError(error: unknown) {
  if (error instanceof ProviderFailure) {
    return { status: 502, body: {
      error: 'provider_error',
      message: error.error.message,
      providerError: {
        kind: error.error.kind,
        message: error.error.message,
        detail: error.error.detail
      }
    } };
  }

  if (error instanceof StudioHttpError) {
    return { status: error.statusCode, body: {
      error: error.code,
      message: error.message,
      ...error.extra
    } };
  }

  const source = (error && typeof error === 'object' ? error : {}) as {
    code?: string;
    statusCode?: number;
    details?: Record<string, unknown>
  };
  const code = source.code ?? '';
  const extra: Record<string, unknown> = {};

  if (error instanceof JobError && error.data && typeof error.data === 'object') {
    const data = error.data as Record<string, unknown>;

    if (['price_changed', 'price_unknown'].includes(code) && data.quote) {
      extra.quote = parseStudio3d.price(data.quote);
    }

    if (code === 'validation_failed' && data.validation) {
      extra.validation = parseStudio3d.validation(data.validation);
    }
  }
  
  const conflicts = ['stale_library', 'library_busy', 'library_unavailable', 'price_changed',
    'price_unknown', 'idempotency_conflict', 'provider_unavailable', 'has_children', 'main_version',
    'leased', 'retry_unavailable', 'task_already_linked', 'account_changed', 'not_unknown',
      'exists', 'changed'];

  if (conflicts.includes(code)) {
    return { status: 409, body: {
      error: code,
      message: code === 'stale_library' ? 'Библиотека изменилась. Обновите раздел.'
        : code === 'library_busy' ? 'Дождитесь завершения заданий и операций с файлами.'
          : code === 'price_changed' ? 'Цена изменилась. Подтвердите новый расчёт.'
            : 'Действие сейчас недоступно.',
      ...extra
    } };
  }

  if (code === 'validation_failed') {
    return { status: 422, body: {
      error: code,
      message: 'Проверьте параметры.',
      ...extra
    } };
  }

  if (code === 'plugin_disabled') {
    return { status: 404, body: { error: code, message: 'Плагин «3D» выключен.' } };
  }

  if (['ENOENT', 'file_not_found', 'version_not_found', 'job_not_found', 'child_not_found',
    'intent_not_found'].includes(code)) {
    return { status: 404, body: { error: 'not_found', message: 'Объект не найден.' } };
  }

  if (source.statusCode === 413) {
    return { status: 413, body: { error: 'too_large', message: 'Файл превышает допустимый размер.' } };
  }

  return { status: 400, body: { error: code && /^[a-z_]+$/.test(code) ? code : 'invalid_request',
    message: 'Не удалось безопасно выполнить запрос.' } };
}
