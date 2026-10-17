// Закрытые DTO для изолированных web tests; номера синтетические UUID.
// Переопределение полей позволяет моделировать поздний ответ и смену библиотеки.
export const LIBRARY_ID = '00000000-0000-4000-8000-000000000099';
export const INTENT_ID = '00000000-0000-4000-8000-000000000001';
export const UNIT = {
  one: 'кредит',
  few: 'кредита',
  many: 'кредитов'
};

/**
 * Версия содержит всю обязательную форму, без облачного ключа и подписанной ссылки.
 * Состояния прогресса меняются patch, а decoder остаётся настоящим.
 */
export function versionDto(patch = {}) {
  return {
    libraryId: LIBRARY_ID,
    id: 'v01-model',
    seq: 1,
    parent: null,
    kind: 'model',
    operation: 'text-to-model',
    provider: 'tripo',
    label: 'Модель',
    status: 'running',
    progress: 30,
    etaSeconds: 60,
    params: {},
    files: [],
    preview: null,
    stats: null,
    task: null,
    cost: {
      estimated: 30,
      actual: null,
      free: false,
      unit: UNIT,
      state: 'reserved'
    },
    error: null,
    origin: 'section',
    createdAt: '2026-10-11T10:00:00Z',
    updatedAt: '2026-10-11T10:00:00Z',
    savedTo: [],
    rigCheck: null,
    intentId: INTENT_ID,
    childId: 'child-1',
    waitReason: null,
    retryAvailable: false,
    retryReason: null,
    views: [],
    mainFileId: null,
    ...patch
  };
}

/**
 * Карточка модели и detail используют один идентификатор для проверок selection.
 * Финансовые группы отделены от legacy spent, неизвестные суммы остаются null.
 */
export function modelDto(patch = {}) {
  return {
    id: 'fixture-model',
    name: 'Куб',
    project: null,
    category: 'prop',
    tags: [],
    origin: 'section',
    createdAt: '2026-10-11T10:00:00Z',
    updatedAt: '2026-10-11T10:00:00Z',
    mainVersion: 'v01-model',
    preview: null,
    versions: 1,
    active: 1,
    spent: null,
    spending: [],
    sizeBytes: 0,
    has: {
      rig: false,
      animation: false,
      parts: false,
      images: false
    },
    ...patch
  };
}

/**
 * State показывает независимые доступный баланс, резерв и disk warning.
 * Library marker один для всей фикстуры, смена задаётся явным patch.
 */
export function stateDto(patch = {}) {
  return {
    libraryId: LIBRARY_ID,
    library: {
      dir: '/fixture/library',
      ok: true,
      error: null,
      bytes: Math.round(3.2 * 1024 ** 3),
      freeBytes: 53 * 1024 ** 3,
      lowDisk: false,
      modelBytes: 0,
      inputBytes: 0,
      temporaryBytes: 0
    },
    providers: [{
      id: 'tripo',
      name: 'Tripo',
      available: true,
      local: false,
      unit: UNIT,
      balance: { available: 215, reserved: 100 },
      billingUrl: 'https://www.tripo3d.ai/'
    }],
    active: 2,
    autoImport: false,
    ...patch
  };
}

/**
 * Detail даёт агенту путь модели, а список версии — viewer и следующие шаги.
 * Создание нового detail не разделяет изменяемые массивы с предыдущим ответом.
 */
export function detailDto(patch = {}) {
  return {
    libraryId: LIBRARY_ID,
    model: modelDto(),
    notes: '',
    versions: [versionDto()],
    incoming: [],
    modelDirectory: '/fixture/library/fixture-model',
    ...patch
  };
}

/**
 * Задачи содержат честный partial флаг и отдельные активные и внешние группы.
 * Пустая история не выдаётся как полная статистика аккаунта.
 */
export function tasksDto(patch = {}) {
  return {
    libraryId: LIBRARY_ID,
    active: [],
    recent: [],
    external: [],
    week: { partial: true, groups: [] },
    historyPartial: true,
    historyError: null,
    ...patch
  };
}
