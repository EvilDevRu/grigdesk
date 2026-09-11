// Категории раздела «Настройки → Плагины». Плагины режутся по РОДУ РАБОТЫ человека,
// а не по месту в интерфейсе: место объявляет `nav.group`, и оно отвечает на другой
// вопрос — «где появится ссылка», а не «зачем этот модуль нужен».
//
// Список общий для сервера и веба: сервер нормализует значение манифеста, веб рисует
// по нему заголовки групп. Второй копии названий нет, поэтому неизвестная категория
// чужого плагина не заводит на экране новую группу — она уходит в «Прочее».

// Ссылка плагина в навигации — только декларация, кода фронта она не даёт.
export interface PluginNav {
  path: string;
  label: string;
  icon: string;
  group: string;
  order?: number;
}

// Одно поле настройки плагина: схему объявляет манифест, значение живёт в prefs.
export interface PluginSetting {
  key: string;
  label?: string;
  type?: string;
  hint?: string;
  default?: unknown;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
  requiresCapability?: string;
}

// Сохранённый выбор настройки типа `model`: пара «исполнитель + модель» и уровень
// усилия запуска. Склеенной строкой её не хранят — id модели сам бывает с двоеточиями.
export interface PluginModelValue {
  provider: string;
  model: string;
  effort?: string;
}

// Готовность плагина к работе: что ему нужно на машине и что из этого он умеет
// поставить сам. Ручку объявляет манифест, форму ответа — общий контракт: диалог
// настроек рисует любой плагин одинаково, а откуда берётся состояние, знает только
// сам плагин.
export interface PluginSetup {
  path: string;
}

export type PluginSetupItemStatus = 'ready' | 'blocked' | 'warning' | 'unknown';

export interface PluginSetupJob {
  state: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  label: string;
  error: string | null;
}

export interface PluginSetupItem {
  id: string;
  title: string;
  status: PluginSetupItemStatus;
  reason: string;
  // Кнопка есть только у того, что сервер умеет поставить сам; остальное
  // объясняется словами в причине.
  action: { label: string; hint: string } | null;
  job: PluginSetupJob | null;
}

export interface PluginSetupStatus {
  items: PluginSetupItem[];
  checkedAt: string;
}

// Запись списка `/api/plugins`: манифест плюс состояние этой установки.
export interface PluginListItem {
  id: string;
  name: string;
  version: string;
  description: string;
  system?: boolean;
  category?: string;
  nav: PluginNav | null;
  enabled: boolean;
  needsRestart?: boolean;
  settings: PluginSetting[];
  values: Record<string, unknown>;
  setup?: PluginSetup | null;
}

export interface PluginCategory {
  id: string;
  label: string;
  hint: string;
}

// Категория, в которую попадает всё незаявленное, — она же последняя на экране.
export const PLUGIN_CATEGORY_OTHER = 'other';

// Порядок массива — порядок групп в разделе настроек.
export const PLUGIN_CATEGORIES: PluginCategory[] = [
  {
    id: 'work',
    label: 'Задачи и связь',
    hint: 'Обращения, задачи Б24 и каналы, из которых они приходят.',
  },
  {
    id: 'dev',
    label: 'Разработка',
    hint: 'Код, стенды и доступ к машинам.',
  },
  {
    id: 'knowledge',
    label: 'Знания и показ',
    hint: 'Проектные факты и материалы о готовой работе.',
  },
  {
    id: PLUGIN_CATEGORY_OTHER,
    label: 'Прочее',
    hint: 'Модули без объявленной категории — обычно свои плагины.',
  },
];

const KNOWN = new Set(PLUGIN_CATEGORIES.map((category) => category.id));

/**
 * Приведение категории манифеста к известной. Пустое и незнакомое значение — не
 * ошибка манифеста, а обычное состояние стороннего плагина, поэтому оно молча
 * даёт «Прочее»; предупредить об этом — дело того, кто читает манифест.
 */
export function normalizePluginCategory(raw: unknown): string {
  const requested = raw == null ? '' : String(raw).trim();

  return KNOWN.has(requested) ? requested : PLUGIN_CATEGORY_OTHER;
}

/** Заголовок группы для известной категории; для чужой — заголовок «Прочего». */
export function pluginCategoryLabel(id: unknown): string {
  const normalized = normalizePluginCategory(id);

  return PLUGIN_CATEGORIES.find((category) => category.id === normalized)?.label || '';
}
