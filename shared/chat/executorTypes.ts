// Порядок и подписи типов общие для сервера и окна.
// Старые адаптеры без типа продолжают считаться универсальными.
export const EXECUTOR_TYPES = [
  {
    id: 'universal',
    label: 'Универсальные',
    hint: 'Разговоры, код и работа с проектами.',
  },
  {
    id: '3d',
    label: '3D-генерация',
    hint: 'Исполнители для создания трёхмерных моделей.',
  },
] as const;

export type ExecutorType = typeof EXECUTOR_TYPES[number]['id'];

interface TypedProvider {
  type?: unknown;
  chatEnabled?: boolean;
  available?: boolean;
}

/**
 * Нормализует декларацию старого или нового адаптера по общему списку типов.
 * Неизвестный тип сохраняет совместимость универсального исполнителя.
 */
export function normalizeExecutorType(value: unknown): ExecutorType {
  const id = typeof value === 'string' ? value.trim() : '';

  return EXECUTOR_TYPES.find((type) => type.id === id)?.id ?? 'universal';
}

/**
 * Универсальные иконки сохраняют прежний допуск чата, включая недоступные CLI.
 * Узкий исполнитель появляется только после локальной настройки доступа.
 */
export function isTopbarProvider(provider: TypedProvider): boolean {
  return normalizeExecutorType(provider.type) === 'universal'
    ? provider.chatEnabled !== false
    : provider.available === true;
}

/**
 * Группирует все карточки в порядке типов, не меняя порядок реестра внутри группы.
 * Пустые группы отсутствуют, поэтому окно само решает, нужны ли заголовки.
 */
export function executorTypeGroups<Provider extends TypedProvider>(providers: readonly Provider[]) {
  return EXECUTOR_TYPES.map((type) => ({
    ...type,
    providers: providers.filter((provider) => normalizeExecutorType(provider.type) === type.id),
  })).filter((group) => group.providers.length > 0);
}
