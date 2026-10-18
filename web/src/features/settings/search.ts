import {
  SETTINGS_FIELDS,
  SETTINGS_GROUPS,
  SETTINGS_PAGES,
  resolveFieldAddress,
  type SettingsFieldMetadata,
} from './catalog.ts';
import type { FieldAddress } from './contracts.ts';

export interface SettingsSearchResult {
  label: string;
  description: string;
  pageId: string;
  address?: FieldAddress;
  load?: boolean;
}

const PAGE_SYNONYMS: Record<string, string[]> = {
  'interface.shortcuts': ['клавиши', 'сочетания', 'hotkey'],
};

/**
 * Нормализация одинакова для запроса, подписи и пути категории.
 * Сегменты адреса поля не нормализуются и не участвуют в индексе.
 */
export function normalizeSettingsQuery(value: string): string {
  return value.trim().toLocaleLowerCase('ru').replace(/ё/g, 'е').replace(/\s+/g, ' ');
}

/**
 * Из DTO забирается только белый список публичных метаданных.
 * Значения и секреты не могут оказаться ни в индексе, ни в результате поиска.
 */
export function publicFieldMetadata(field: SettingsFieldMetadata): SettingsFieldMetadata | null {
  const address = resolveFieldAddress(field.address);

  if (!address || typeof field.label !== 'string' || typeof field.description !== 'string') {
    return null;
  }

  return {
    address,
    label: field.label,
    description: field.description,
    synonyms: field.synonyms?.filter((word) => typeof word === 'string'),
    load: field.load === true,
    available: field.available !== false,
  };
}

/**
 * Чистый поиск работает по метаданным уже известных полей без DOM и API.
 * Незагруженный доступный каталог остаётся переходом к продолжению поиска.
 */
export function searchSettings(
  query: string,
  fields: readonly SettingsFieldMetadata[] = [],
): SettingsSearchResult[] {
  const words = normalizeSettingsQuery(query).split(' ').filter(Boolean);

  if (!words.length) {
    return [];
  }

  const results: SettingsSearchResult[] = [];

  for (const page of SETTINGS_PAGES) {
    const group = SETTINGS_GROUPS.find((item) => item.id === page.groupId);
    const path = `${group?.label} ${page.label}`;
    const pageIndex = normalizeSettingsQuery(
      `${path} ${page.description} ${(PAGE_SYNONYMS[page.id] ?? []).join(' ')}`,
    );

    if (words.every((word) => pageIndex.includes(word))) {
      results.push({
        label: path,
        description: page.description,
        pageId: page.id,
      });
    }

    for (const source of [...SETTINGS_FIELDS, ...fields]) {
      const field = publicFieldMetadata(source);

      if (!field || field.available === false || field.address.pageId !== page.id) {
        continue;
      }

      const index = normalizeSettingsQuery(
        `${path} ${field.label} ${field.description} ${(field.synonyms ?? []).join(' ')}`,
      );

      if (field.load || words.every((word) => index.includes(word))) {
        results.push({
          label: field.label,
          description: field.description,
          pageId: page.id,
          address: field.address,
          load: field.load,
        });
      }
    }
  }

  return results;
}
