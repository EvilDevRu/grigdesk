import type { ProviderEntry } from '../../../shared/chat/providersContracts.ts';

export type ModelSelectProvider = Pick<ProviderEntry,
  'id' | 'name' | 'color' | 'available' | 'chatEnabled' | 'models'>;
export type ModelSelectValueFormat = 'id' | 'modelRef';

/**
 * Общий допуск каталога скрывает недоступных и отключённых исполнителей.
 * Сохранённый выбор разрешается отдельно и не меняется при обновлении доступности.
 */
export function isSelectableModelProvider(
  provider: Pick<ProviderEntry, 'available' | 'chatEnabled'> | null,
): boolean {
  return provider?.available === true && provider.chatEnabled !== false;
}

/**
 * Настройки хранят целую пару, чат сохраняет прежний native id.
 * JSON-кодирование не разбирает двоеточия, слэши и вложенный wire-id модели.
 */
export function modelSelectValue(
  provider: string,
  model: string,
  format: ModelSelectValueFormat = 'modelRef',
): string {
  return format === 'id' ? model : JSON.stringify({ provider, model });
}
