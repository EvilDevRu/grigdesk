import type { UiModelModifiers, UiSelectValue } from '../types/uiFields';

export interface UiSelectOptionSnapshot {
  index: number;
  value: string;
  label: string;
  groupKey: string;
  groupLabel: string;
  description: string;
  disabled: boolean;
}

/**
 * Читаем уже отрендеренные options, поэтому Fragment, v-for и вложенный текст
 * остаются ответственностью Vue. Индекс относится к native options, а не к фильтру.
 */
export function readUiSelectOptions(select: HTMLSelectElement): UiSelectOptionSnapshot[] {
  const groups = [...select.querySelectorAll('optgroup')];

  return [...select.options].flatMap((option, index) => {
    const parent = option.parentElement;
    const group = parent?.tagName === 'OPTGROUP' ? parent as HTMLOptGroupElement : null;

    if (option.hidden || group?.hidden) {
      return [];
    }

    return [{
      index,
      value: option.value,
      label: option.label || option.text,
      groupKey: group ? String(groups.indexOf(group)) : '',
      groupLabel: group?.label ?? '',
      description: option.getAttribute('data-description') ?? option.title,
      disabled: option.disabled || Boolean(group?.disabled),
    }];
  });
}

/**
 * Фильтр использует подписи и техническое значение, сохраняя исходный порядок.
 * Пустой запрос возвращает копию, поэтому consumer не может изменить общий снимок.
 */
export function filterUiSelectOptions(
  options: UiSelectOptionSnapshot[],
  query: string,
): UiSelectOptionSnapshot[] {
  const needle = query.trim().toLocaleLowerCase();

  return options.filter((option) => {
    const text = [option.label, option.value, option.groupLabel, option.description]
      .join(' ')
      .toLocaleLowerCase();

    return !needle || text.includes(needle);
  });
}

/**
 * Повторяем прежний контракт UiSelect: native value остаётся строкой без modifier.
 * Пустота не становится нулём, а нечисловое значение не теряется при number.
 */
export function normalizeUiSelectValue(
  input: string,
  modifiers: UiModelModifiers,
): UiSelectValue {
  let value: UiSelectValue = modifiers.trim ? input.trim() : input;

  if (modifiers.number && value !== '') {
    const number = Number.parseFloat(String(value));

    if (!Number.isNaN(number)) {
      value = number;
    }
  }

  return value;
}
