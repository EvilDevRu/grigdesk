import type {
  Studio3dVersion,
  Studio3dStats,
  VersionStatus,
} from '../../../../shared/studio3d/studio3dContracts.ts';
import { formatPrice, pluralForm } from '../../../../shared/studio3d/studio3dOperations.ts';

export const statusLabels: Record<VersionStatus, string> = {
  submitting: 'Отправляется',
  waiting: 'Ожидает',
  queued: 'В очереди',
  running: 'В работе',
  downloading: 'Скачивается',
  ready: 'Готово',
  failed: 'Ошибка',
  unknown: 'Исход неизвестен',
  unresolved: 'Оставлен неразобранным',
  remote: 'В облаке',
  lightened: 'Облегчена'
};

export const valueLabels: Record<string, string> = {
  front: 'спереди',
  left: 'слева',
  back: 'сзади',
  right: 'справа',
  character: 'персонаж',
  prop: 'предмет',
  part: 'часть',
  scene: 'сцена',
  image: 'картинка',
  mask: 'маска',
  preview: 'превью',
  biped: 'двуногий',
  quadruped: 'четвероногий',
  hexapod: 'шестиногий',
  octopod: 'восьминогий',
  avian: 'птица',
  serpentine: 'змеевидный',
  walk: 'ходьба',
  run: 'бег',
  idle: 'ожидание',
  jump: 'прыжок',
  'v3.1-20260211': 'Детальная модель',
  'P1-20260311': 'Быстрая модель P1',
  'P2-20260801': 'Быстрая модель P2',
  'v3.0-20250812': 'Текстуры версии 3.0',
  'v3.5-20260815': 'Текстуры версии 3.5',
  'v1.0-20240301': 'Скелет для человека',
  'v2.5-20260210': 'Скелет для разных типов тела',
  'v1.0-20250506': 'Разделение на части версии 1.0',
  'v2.0-20260430': 'Разделение на части версии 2.0'
};

const parameterLabels: Record<string, string> = {
  prompt: 'Описание',
  negative_prompt: 'Исключить из описания',
  category: 'Категория',
  view: 'Вид',
  rig_type: 'Тип тела',
  model: 'Модель исполнителя',
  animation: 'Движение',
  animations: 'Движения',
  format: 'Формат',
  texture: 'Текстуры',
  texture_quality: 'Качество текстур',
  texture_resolution: 'Размер текстур',
  pbr: 'Материалы PBR',
  seed: 'Начальное число',
  face_limit: 'Предел полигонов',
  target_face_num: 'Число полигонов',
  quad: 'Четырёхугольная сетка',
  turn: 'Поворот',
  height: 'Высота',
  orientation: 'Ориентация',
  export_orientation: 'Ориентация экспорта',
  original_model_id: 'Исходная модель',
  input: 'Исходная версия'
};

/**
 * Идентификатор исполнителя заменяется его публичным именем из состояния раздела.
 * Неизвестный технический код не выводится человеку как название.
 */
export function providerLabel(id: string | null, providers?: { id: string; name: string }[]): string {
  return providers?.find((item) => item.id === id)?.name
    ?? (id === 'tripo' ? 'Tripo' : id === 'local' || !id ? 'Локально' : 'Исполнитель');
}

/**
 * Типы прошлых облачных заказов получают те же подписи действий, что и новые версии.
 * Незнакомый тип остаётся общим заказом без публикации внутреннего имени API.
 */
export function taskTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    text_to_model: 'Модель по описанию',
    image_to_model: 'Модель по картинке',
    multiview_to_model: 'Модель по видам',
    text_to_image: 'Картинка по описанию',
    generate_image: 'Картинка',
    image_to_image: 'Изменение картинки',
    image_to_multiview: 'Виды',
    edit_multiview: 'Изменение видов',
    animate_prerigcheck: 'Проверка скелета',
    animate_rig: 'Скелет',
    animate_retarget: 'Движение',
    convert_model: 'Экспорт',
    texture_model: 'Текстуры',
    stylize_model: 'Стиль',
    decimate_model: 'Уменьшение полигонов',
    mesh_segmentation: 'Части',
    mesh_completion: 'Дополнение частей',
    image_to_splat: 'Сплат'
  };

  return labels[type] ?? 'Облачный заказ';
}

/**
 * Значения известных перечислений переводятся, числа и свободное описание сохраняют смысл.
 * Ссылки на другие заказы и код пресета заменяются подписью вместо сырого идентификатора.
 */
function parameterValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '—';
  }
  if (typeof value === 'boolean') {
    return value ? 'Да' : 'Нет';
  }
  if (Array.isArray(value)) {
    return value.map(parameterValue).join(', ');
  }
  if (typeof value === 'object') {
    return Object.entries(value).map(([key, item]) =>
      `${parameterLabels[key] ?? 'Параметр'}: ${parameterValue(item)}`).join('; ');
  }

  const text = String(value);

  if (valueLabels[text]) {
    return valueLabels[text]!;
  }

  if (/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(text)) {
    return 'Другой облачный заказ';
  }
  if (text.startsWith('preset:')) {
    return valueLabels[text.split(':').at(-1)!] ?? 'Выбранное движение';
  }
  if (/^v\d+\.\d+-\d+$/.test(text)) {
    return `Версия ${text.split('-')[0]!.slice(1)}`;
  }

  return valueLabels[text] ?? text;
}

/**
 * Параметры выводятся отдельными строками с человеческими названиями и значениями.
 * Неизвестное поле не превращает страницу версии в JSON или список внутренних ключей.
 */
export function parameterRows(params: Record<string, unknown>): { name: string; value: string }[] {
  return Object.entries(params).map(([key, value], index) => ({
    name: parameterLabels[key] ?? `Дополнительный параметр ${index + 1}`,
    value: ['prompt', 'negative_prompt'].includes(key) ? String(value ?? '—') : parameterValue(value)
  }));
}

/**
 * Браузерные ошибки связи и тайм-аута показывают одну понятную причину.
 * Русское объяснение сервера сохраняется, технические коды получают локальную подпись.
 */
export function studioErrorMessage(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '';
  const codes: Record<string, string> = {
    price_changed: 'Цена изменилась. Подтвердите новую цену.',
    not_found: 'Запись не найдена.',
    unauthorized: 'Требуется вход в GrigDesk.',
    plugin_disabled: 'Плагин «3D» выключен.',
    unavailable: 'Раздел временно недоступен.',
    invalid_request: 'Проверьте параметры запроса.'
  };

  if (/Failed to fetch|fetch failed|signal timed out|aborted due to timeout|NetworkError|Load failed/i
    .test(message)) {
    return 'Нет связи с сервером';
  }

  if (!codes[message] && /^[a-z0-9]+(?:_[a-z0-9]+)+$/i.test(message)) {
    return 'Не удалось выполнить действие. Обновите раздел и повторите.';
  }

  return codes[message] ?? (message || 'Не удалось выполнить действие.');
}

/**
 * Проверка скелета имеет собственный результат и не заменяет статус самой версии.
 * Тип тела переводится в человеческую подпись; отсутствие ответа не выдаётся за отказ.
 */
export function rigCheckText(check: Studio3dVersion['rigCheck']): string {
  if (!check) {
    return '';
  }
  if (check.status === 'pending') {
    return 'Проверяется…';
  }
  if (check.status === 'ready') {
    const types: Record<string, string> = {
      biped: 'двуногий',
      quadruped: 'четвероногий',
      hexapod: 'шестиногий',
      octopod: 'восьминогий',
      avian: 'птица',
      serpentine: 'змеевидный'
    };

    return check.riggable ? `Можно: ${types[check.rigType ?? ''] ?? 'подходящий тип тела'}`
      : 'Нельзя: модель не подходит для построения скелета.';
  }

  return check.error?.message ?? 'Результат проверки неизвестен. Разберите заказ во вкладке «Задачи».';
}

/**
 * Неизвестное списание и резерв показываются отдельно от подтверждённой оплаты.
 * Даже оценка с точным числом не становится фактическим расходом.
 */
export function paymentText(cost: Studio3dVersion['cost']): string {
  if (cost.state === 'free') {
    return 'Бесплатно';
  }
  if (cost.state === 'refunded') {
    return 'Возврат подтверждён';
  }
  if (cost.state === 'charged' && cost.actual !== null) {
    return `Списано ${formatPrice(cost.actual, cost.unit)}`;
  }
  if (cost.state === 'unknown') {
    return 'Списание неизвестно';
  }
  if (cost.state === 'reserved') {
    return `В резерве ${formatPrice(cost.estimated, cost.unit)}`;
  }

  return `Оценка ${formatPrice(cost.estimated, cost.unit)}`;
}

/**
 * Сводка одинакова в странице модели и черновике вопроса агенту.
 * Предположение о взгляде не выдаётся за результат распознавания человека.
 */
export function statsText(stats: Studio3dStats | null): string {
  if (!stats) {
    return 'Сводка пока недоступна';
  }

  const textures = stats.textures.filter((item) => item !== null)
    .map((item) => `${item.width}×${item.height}`).join(', ');
  const size = stats.size?.map((value) => value.toFixed(2)).join(' × ');

  return `${new Intl.NumberFormat('ru-RU').format(stats.triangles)} треугольников, `
    + `текстуры ${textures || 'нет'}, ${stats.bones} ${pluralForm(stats.bones, {
      one: 'кость',
      few: 'кости',
      many: 'костей'
    })}, ${stats.animations.length} ${pluralForm(stats.animations.length, {
      one: 'движение',
      few: 'движения',
      many: 'движений'
    })}`
    + (size ? `, размер ${size}` : '')
    + (stats.facing ? `, предполагаемый взгляд +${stats.facing.toUpperCase()}` : '');
}

/**
 * Имя сохраняемого файла не содержит разделителей пути и сохраняет расширение источника.
 * Короткие имена остаются читаемыми на русском и помещаются в серверный предел.
 */
export function studioSlug(value: string): string {
  return value.trim().toLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '')
    .slice(0, 70) || 'model';
}
