import type { FieldAddress } from './contracts.ts';

export interface SettingsGroup {
  id: string;
  label: string;
}

export interface SettingsPage {
  id: string;
  groupId: string;
  label: string;
  description: string;
}

export interface SettingsFieldMetadata {
  address: FieldAddress;
  label: string;
  description: string;
  synonyms?: string[];
  load?: boolean;
  available?: boolean;
}

export interface StaticSettingsField extends SettingsFieldMetadata {
  resourceId: string;
  key: string;
  control: 'switch' | 'number' | 'text' | 'textarea' | 'select' | 'custom';
  scope: string;
}

const PREFERENCE_DEFINITIONS = [
  ['automation.chats', 'chatLiveSessions', 'switch', 'Держать агента чата живым между ходами',
    'Применится к следующему ходу. Свободные процессы можно погасить в разделе «Процессы».'],
  ['automation.chats', 'chatAutoContinue', 'switch', 'Продолжать ход сам после обрыва связи',
    'Выключение отменяет будущие попытки, уже начатый ход продолжает работать.'],
  ['automation.context', 'chatAutoCompactWindow', 'number', 'Порог сжатия чата, токены',
    '0 — оставить сжатие исполнителю. Настройка применяется к новым ходам.'],
  ['automation.context', 'stageAutoCompactWindow', 'number', 'Порог сжатия этапа, токены',
    'Отдельный порог для этапов конвейера. 0 — оставить сжатие исполнителю.'],
  ['automation.launch', 'gitRefreshBeforeRun', 'switch', 'Обновлять репозитории перед запуском',
    'Действует на новые запуски триажа и конвейера.'],
  ['automation.monitoring', 'runSilenceWindow', 'number', 'Порог молчания хода, минуты',
    '0 — выключить оповещение о зависшем ходе конвейера.'],
  ['automation.arbiter', 'arbiterAuto', 'switch', 'Разбирать автоматически',
    'Арбитр разбирает остановки конвейера на сервере.'],
  ['automation.arbiter', 'arbiterModelRef', 'select', 'Модель арбитра',
    'Исполнитель и модель сохраняются вместе с усилием.'],
  ['automation.arbiter', 'arbiterEffort', 'select', 'Усилие арбитра',
    'Доступные ступени берутся из каталога выбранной модели.'],
  ['agents.models', 'showAllModels', 'switch', 'Показывать все модели',
    'Включая скрытые модели и старые версии.'],
] as const;

export const SETTINGS_FIELDS: StaticSettingsField[] = PREFERENCE_DEFINITIONS.map(
  ([pageId, key, control, label, description]) => ({
    address: { pageId, fieldPath: [key] },
    resourceId: 'prefs',
    key,
    control,
    scope: 'Все устройства',
    label,
    description,
  }),
);

interface SettingsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface PageRequest {
  pageId?: unknown;
  queryPage?: unknown;
  storage?: SettingsStorage;
}

const DEVICE_FIELDS = [
  ['interface.behavior', 'wakeLock', 'enabled', 'switch', 'Не гасить экран',
    'Экран удерживается включённым, пока приложение активно.'],
  ['interface.notifications', 'operations', 'notificationTest', 'custom', 'Системные оповещения',
    'Разрешение и тестовый показ выполняются сразу по этой кнопке.'],
  ['interface.shortcuts', 'hotkeys', 'overrides', 'custom', 'Сочетания клавиш инструментов',
    'Клавиши сохраняются по «Применить». Escape отменяет запись сочетания.'],
] as const;

SETTINGS_FIELDS.push(...DEVICE_FIELDS.map(([pageId, resourceId, key, control, label, description]) => ({
  address: { pageId, fieldPath: [key] },
  resourceId,
  key,
  control,
  label,
  description,
  scope: 'Это устройство',
})));

SETTINGS_FIELDS.push({
  address: { pageId: 'system.diagnostics', fieldPath: ['level'] },
  resourceId: 'factoryDebug',
  key: 'level',
  control: 'select',
  label: 'Уровень диагностики',
  description: 'Действует для сервера и окна. Источник переопределения показан рядом.',
  scope: 'Все устройства',
});

const SPEECH_FIELDS = [
  ['speech.dictation', 'engine', 'select', 'Движок диктовки', 'Браузер или Whisper на сервере GrigDesk.'],
  ['speech.dictation', 'browserProcessing', 'select', 'Обработка браузером',
    'Локальный режим не разрешает облачную обработку вместо человека.'],
  ['speech.dictation', 'quality', 'select', 'Качество диктовки', 'Пресет модели и глубины распознавания.'],
  ['speech.video', 'videoQuality', 'select', 'Качество видео', 'Пресет распознавания записи встречи.'],
  ['speech.video', 'videoInitialPrompt', 'textarea', 'Стилевая подсказка видео',
    'До 600 символов. Короткий пример текста задаёт стиль расшифровки.'],
  ['speech.language', 'language', 'select', 'Язык распознавания', 'Автоматически, русский или английский.'],
  ['speech.language', 'dictionary', 'textarea', 'Термины проекта',
    'До 800 символов, по одному термину на строке.'],
  ['speech.advanced', 'model', 'select', 'Модель диктовки', 'Пустой выбор оставляет модель пресета.'],
  ['speech.advanced', 'videoModel', 'select', 'Модель видео', 'Пустой выбор оставляет модель пресета.'],
  ['speech.advanced', 'device', 'select', 'Устройство обработки',
    'CUDA доступна только после успешной проверки.'],
  ['speech.advanced', 'computeType', 'select', 'Тип вычислений', 'Пустой выбор оставляет тип по устройству.'],
  ['speech.advanced', 'beamSize', 'number', 'Глубина поиска диктовки', 'От 1 до 10, пусто — по пресету.'],
  ['speech.advanced', 'vadSilenceMs', 'number', 'Пауза VAD, мс', 'От 100 до 5000 миллисекунд.'],
  ['speech.advanced', 'conditionOnPreviousText', 'switch', 'Учитывать предыдущий текст',
    'Для диктовки. Расшифровка видео использует собственный контракт.'],
] as const;

SETTINGS_FIELDS.push(...SPEECH_FIELDS.map(([pageId, key, control, label, description]) => ({
  address: { pageId, fieldPath: [key] },
  resourceId: 'speech',
  key,
  control,
  label,
  description,
  scope: 'Все устройства',
})));

const CONNECTION_FIELDS = [
  ['baseUrl', 'text', 'Адрес портала Б24', 'Полный адрес сохраняется вместе с логином и новым паролем.'],
  ['login', 'text', 'Логин Б24', 'Учётная запись портала для всех устройств.'],
  ['password', 'text', 'Пароль Б24', 'Введите новый пароль при любом изменении подключения.'],
] as const;

SETTINGS_FIELDS.push(...CONNECTION_FIELDS.map(([key, control, label, description]) => ({
  address: { pageId: 'connections.b24', fieldPath: [key] },
  resourceId: 'b24',
  key,
  control,
  label,
  description,
  scope: 'Все устройства',
})), {
  address: { pageId: 'system.startup', fieldPath: ['enabled'] },
  resourceId: 'autostart',
  key: 'enabled',
  control: 'switch',
  label: 'Запускать при включении машины',
  description: 'Настройка юнита systemd на этой машине; живой процесс продолжает работать.',
  scope: 'Эта машина',
});

SETTINGS_FIELDS.push(...[
  ['name', 'Имя устройства', 'Название приложения в списке доступа машины.'],
  ['address', 'Адрес машины', 'Необязательный доступный адрес для строки и QR привязки.'],
].map(([key, label, description]) => ({
  address: { pageId: 'connections.devices', fieldPath: [key!] },
  resourceId: 'devicePairing',
  key: key!,
  control: 'text' as const,
  label: label!,
  description: description!,
  scope: 'Эта машина',
})));

export const SETTINGS_PAGE_KEY = 'grigdesk-settings-page';
export const DEFAULT_SETTINGS_PAGE = 'interface.behavior';

export const SETTINGS_GROUPS: readonly SettingsGroup[] = [
  {
    id: 'interface',
    label: 'Интерфейс',
  },
  {
    id: 'agents',
    label: 'ИИ-исполнители',
  },
  {
    id: 'automation',
    label: 'Чаты и конвейер',
  },
  {
    id: 'speech',
    label: 'Речь и расшифровка',
  },
  {
    id: 'connections',
    label: 'Подключения и доступ',
  },
  {
    id: 'plugins',
    label: 'Плагины',
  },
  {
    id: 'system',
    label: 'Система',
  },
];

export const SETTINGS_PAGES: readonly SettingsPage[] = [
  {
    id: 'interface.behavior',
    groupId: 'interface',
    label: 'Поведение',
    description: 'Удержание экрана на этом устройстве.',
  },
  {
    id: 'interface.notifications',
    groupId: 'interface',
    label: 'Оповещения',
    description: 'Разрешение и проверка системных оповещений.',
  },
  {
    id: 'interface.shortcuts',
    groupId: 'interface',
    label: 'Горячие клавиши',
    description: 'Сочетания клавиш для открытия инструментов.',
  },
  {
    id: 'agents.providers',
    groupId: 'agents',
    label: 'Исполнители',
    description: 'Доступ, модели, параметры и MCP исполнителей.',
  },
  {
    id: 'agents.models',
    groupId: 'agents',
    label: 'Модели',
    description: 'Видимость скрытых моделей и старых версий.',
  },
  {
    id: 'automation.chats',
    groupId: 'automation',
    label: 'Чаты',
    description: 'Живые сессии и продолжение после обрыва связи.',
  },
  {
    id: 'automation.context',
    groupId: 'automation',
    label: 'Контекст',
    description: 'Раздельные пороги сжатия чата и этапа конвейера.',
  },
  {
    id: 'automation.launch',
    groupId: 'automation',
    label: 'Запуск',
    description: 'Обновление репозиториев перед запуском.',
  },
  {
    id: 'automation.monitoring',
    groupId: 'automation',
    label: 'Наблюдение',
    description: 'Порог молчания хода конвейера.',
  },
  {
    id: 'automation.arbiter',
    groupId: 'automation',
    label: 'Арбитр',
    description: 'Автоматический разбор остановок, модель и усилие.',
  },
  {
    id: 'speech.dictation',
    groupId: 'speech',
    label: 'Диктовка',
    description: 'Движок, место обработки и качество диктовки.',
  },
  {
    id: 'speech.video',
    groupId: 'speech',
    label: 'Расшифровка видео',
    description: 'Качество и стилевая подсказка расшифровки.',
  },
  {
    id: 'speech.language',
    groupId: 'speech',
    label: 'Язык и термины',
    description: 'Язык распознавания и словарь терминов.',
  },
  {
    id: 'speech.models',
    groupId: 'speech',
    label: 'Локальные модели',
    description: 'Каталог моделей, скачивание и копирование.',
  },
  {
    id: 'speech.advanced',
    groupId: 'speech',
    label: 'Дополнительные параметры',
    description: 'Модели, устройство, окружение и замер скорости.',
  },
  {
    id: 'connections.b24',
    groupId: 'connections',
    label: 'Битрикс24',
    description: 'Портал, учётные данные и проверка подключения.',
  },
  {
    id: 'connections.devices',
    groupId: 'connections',
    label: 'Устройства приложений',
    description: 'Привязка приложения, QR, имя устройства и адрес машины, отзыв доступа.',
  },
  {
    id: 'connections.mobile',
    groupId: 'connections',
    label: 'Телефон и доступ',
    description: 'Посредники, привязка устройств и вход на этом компьютере.',
  },
  {
    id: 'plugins.installed',
    groupId: 'plugins',
    label: 'Установленные',
    description: 'Включение, параметры, источник и готовность плагинов.',
  },
  {
    id: 'plugins.install',
    groupId: 'plugins',
    label: 'Установка',
    description: 'Установка плагина из Git и восстановление задания.',
  },
  {
    id: 'system.startup',
    groupId: 'system',
    label: 'Запуск системы',
    description: 'Автозапуск, ярлык и состояние процесса сервера.',
  },
  {
    id: 'system.updates',
    groupId: 'system',
    label: 'Обновления',
    description: 'Версии, применение обновлений и пересборка интерфейса.',
  },
  {
    id: 'system.diagnostics',
    groupId: 'system',
    label: 'Диагностика',
    description: 'Уровень диагностики, отметка сбоя и журнал окна.',
  },
  {
    id: 'system.processes',
    groupId: 'system',
    label: 'Процессы',
    description: 'Живые агенты, открытие чата и погашение процессов.',
  },
];

/**
 * Хранилище может быть запрещено политикой браузера или приватным режимом.
 * Его отказ не мешает открыть настройки и перейти к следующему источнику страницы.
 */
function readStoredPage(storage: SettingsStorage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * Старое имя вкладки читается только при открытии и отсутствии нового ключа.
 * Запись переноса предшествует удалению, чтобы отказ storage не терял предпочтение.
 */
function migrateLegacyPage(storage: SettingsStorage): string | undefined {
  const legacyKey = 'grigdesk-settings-tab';
  const legacyPages = new Map([
    ['app', 'interface.behavior'],
    ['speech', 'speech.dictation'],
    ['b24', 'connections.b24'],
    ['providers', 'agents.providers'],
    ['runs', 'automation.chats'],
    ['plugins', 'plugins.installed'],
    ['server', 'system.startup'],
    ['access', 'connections.mobile'],
  ]);
  const tab = readStoredPage(storage, legacyKey);
  const page = legacyPages.get(tab ?? '');

  if (tab !== null) {
    try {
      storage.setItem(SETTINGS_PAGE_KEY, page ?? DEFAULT_SETTINGS_PAGE);
      storage.removeItem(legacyKey);
    } catch {
      // Разовый выбор работает в памяти даже при недоступном хранилище.
    }
  }

  return page;
}

/**
 * Приоритет источников фиксирован и не зависит от порядка монтирования страниц.
 * Неизвестные ID не разрешаются в импорт и не затирают сохранённую страницу.
 */
export function resolveSettingsPage(request: PageRequest = {}): string {
  const saved = request.storage ? readStoredPage(request.storage, SETTINGS_PAGE_KEY) : null;
  const migrated = request.storage && saved === null ? migrateLegacyPage(request.storage) : undefined;
  const candidates = [request.pageId, request.queryPage, saved, migrated];

  return candidates.find((id) => SETTINGS_PAGES.some((page) => page.id === id)) as string
    ?? DEFAULT_SETTINGS_PAGE;
}

/**
 * Адрес сохраняет отдельные сегменты и получает собственную копию пути.
 * Допустимость динамического поля проверяет владелец каталога после загрузки сущности.
 */
export function resolveFieldAddress(address: FieldAddress): FieldAddress | null {
  if (!SETTINGS_PAGES.some((page) => page.id === address.pageId)
      || !Array.isArray(address.fieldPath) || address.fieldPath.length === 0
      || address.fieldPath.some((part) => typeof part !== 'string' || part.length === 0)) {
    return null;
  }

  return { ...address, fieldPath: [...address.fieldPath] };
}

/**
 * Точки и слеши внутри ID и пути являются частью имени поля, а не разделителями.
 * Отсутствующая цель не совпадает с полем и не запускает его раскрытие.
 */
export function equalFieldAddress(left: FieldAddress | null, right: FieldAddress | null): boolean {
  return Boolean(left && right && left.pageId === right.pageId && left.entityId === right.entityId
    && left.tabId === right.tabId && left.fieldPath.length === right.fieldPath.length
    && left.fieldPath.every((part, index) => part === right.fieldPath[index]));
}
