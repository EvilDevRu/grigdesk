// Нечат-модели экосистемы Qwen — декларативные данные, а не ветвление в компонентах.
// Сервисы DashScope/QwenCloud не объявляют модальность в /models, а CLI 0.27.2
// подтверждает любой id как чатовый и не раскрывает выходную модальность. Поэтому
// пригодность задаёт таблица семейств: новая версия известного семейства попадает
// под то же правило, новое семейство добавляется одной строкой данных.
// Неизвестная модель остаётся чатовой (fail-open): каталог обещает появление новых
// моделей без правки кода, а ошибочно скрытая полезная модель хуже видимой лишней.

export interface QwenNonChatRule {
  pattern: string;
  reason: string;
}

// Глоб сверяется с голым id без учёта регистра; `*` — любая подстрока.
// Причина — данные для интерфейса и отказа запуска, не ключ перевода.
export const QWEN_NON_CHAT_RULES: readonly QwenNonChatRule[] = Object.freeze([
  { pattern: 'wan*-t2v*', reason: 'Генерация видео по тексту, не текстовый чат' },
  { pattern: 'wan*-i2v*', reason: 'Генерация видео по изображению, не текстовый чат' },
  { pattern: 'wan*-r2v*', reason: 'Генерация видео по референсу, не текстовый чат' },
  { pattern: 'wan*-kf2v*', reason: 'Генерация видео по кадрам, не текстовый чат' },
  { pattern: 'wan*-s2v*', reason: 'Генерация видео по звуку, не текстовый чат' },
  { pattern: 'wan*-video*', reason: 'Генерация или редактирование видео, не текстовый чат' },
  { pattern: 'wan*videoedit*', reason: 'Редактирование видео, не текстовый чат' },
  { pattern: 'wan*animate*', reason: 'Анимация изображений, не текстовый чат' },
  { pattern: 'videoretalk', reason: 'Пересинхронизация речи на видео, не текстовый чат' },
  { pattern: 'video-style-transform', reason: 'Стилизация видео, не текстовый чат' },
  { pattern: 'happyhorse-*', reason: 'Генерация или редактирование видео, не текстовый чат' },
  { pattern: 'wan*-image*', reason: 'Генерация изображений, не текстовый чат' },
  { pattern: 'wanx*', reason: 'Генерация изображений, не текстовый чат' },
  { pattern: 'qwen-image*', reason: 'Генерация изображений, не текстовый чат' },
  { pattern: '*-tts-*', reason: 'Синтез речи, не текстовый чат' },
  { pattern: '*-tts', reason: 'Синтез речи, не текстовый чат' },
  { pattern: 'qwen-tts*', reason: 'Синтез речи, не текстовый чат' },
  { pattern: 'cosyvoice*', reason: 'Синтез речи, не текстовый чат' },
  { pattern: 'sambert*', reason: 'Синтез речи, не текстовый чат' },
  { pattern: '*-asr-*', reason: 'Распознавание речи, не текстовый чат' },
  { pattern: '*-asr', reason: 'Распознавание речи, не текстовый чат' },
  { pattern: 'paraformer*', reason: 'Распознавание речи, не текстовый чат' },
  { pattern: 'sensevoice*', reason: 'Распознавание речи, не текстовый чат' },
  { pattern: '*-realtime*', reason: 'Голосовой realtime-режим, не текстовый чат' },
  { pattern: 'text-embedding*', reason: 'Векторные представления текста, не текстовый чат' },
  { pattern: 'multimodal-embedding*', reason: 'Мультимодальные эмбеддинги, не текстовый чат' },
  { pattern: 'gte-rerank*', reason: 'Реранжирование документов, не текстовый чат' },
]);

const compiled = new Map<string, RegExp>();

/**
 * Глоб правила компилируется один раз: спецсимволы экранируются, `*` становится
 * любой подстрокой, совпадение проверяется по всему id без учёта регистра.
 */
function patternRegex(pattern: string): RegExp {
  let regex = compiled.get(pattern);

  if (!regex) {
    const source = pattern.toLowerCase().split('*')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*');

    regex = new RegExp(`^${source}$`, 'i');
    compiled.set(pattern, regex);
  }

  return regex;
}

/**
 * Первое совпавшее правило задаёт причину нечат-модели; порядок строк таблицы
 * значим только для выбора причины. Пустой и неизвестный id чат-пригодность не теряют.
 */
export function classifyQwenModel(bareId: unknown): { reason: string } | null {
  const id = String(bareId ?? '').trim().toLowerCase();

  if (!id) {
    return null;
  }

  for (const rule of QWEN_NON_CHAT_RULES) {
    if (patternRegex(rule.pattern).test(id)) {
      return { reason: rule.reason };
    }
  }

  return null;
}
