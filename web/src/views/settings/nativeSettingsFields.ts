// Форма отделяет доступные действия от справочника ограничений установленного CLI.
// Проекция сохраняет адреса, черновики и запреты исходного серверного каталога.

import type { JsonValue, ProviderSettingNode } from '../../../../shared/providerSettingsContracts.ts';

export interface NativeSettingsFieldsView {
  editable: ProviderSettingNode[];
  readOnly: ProviderSettingNode[];
  editableCount: number;
  readOnlyCount: number;
}

/**
 * Группы сохраняют только подходящих потомков, а поиск раскрывает совпадение по
 * подписи, пути или описанию. Сохранённый выбор, ввод и ошибки остаются видимыми
 * в рабочей части даже при временном запрете записи, чтобы их не потерять.
 */
export function nativeSettingsFields(
  fields: ProviderSettingNode[],
  query: string,
  drafts: Record<string, JsonValue>,
  errors: Record<string, string>,
): NativeSettingsFieldsView {
  const needle = query.trim().toLocaleLowerCase('ru');

  /**
   * Один обход строит две независимые ветки без изменения каталога стора.
   * Счётчики считают поля, а контейнер группы не добавляет лишнюю настройку.
   */
  function visit(nodes: ProviderSettingNode[], parentMatches = false): NativeSettingsFieldsView {
    const result: NativeSettingsFieldsView = {
      editable: [],
      readOnly: [],
      editableCount: 0,
      readOnlyCount: 0,
    };

    for (const field of nodes) {
      const matches = parentMatches || !needle || [
        field.label,
        field.path.join('.'),
        field.description ?? '',
      ].some((text) => text.toLocaleLowerCase('ru').includes(needle));

      if (field.children?.length) {
        const children = visit(field.children, matches);

        if (children.editable.length) {
          result.editable.push({ ...field, children: children.editable });
        }

        if (children.readOnly.length) {
          result.readOnly.push({ ...field, children: children.readOnly });
        }

        result.editableCount += children.editableCount;
        result.readOnlyCount += children.readOnlyCount;

        continue;
      }

      if (!matches) {
        continue;
      }

      const actionable = field.writable || field.override.state === 'known'
        || drafts[field.id] !== undefined || Boolean(errors[field.id]);

      if (actionable) {
        result.editable.push(field);
        result.editableCount += 1;
      } else {
        result.readOnly.push(field);
        result.readOnlyCount += 1;
      }
    }

    return result;
  }

  return visit(fields);
}
