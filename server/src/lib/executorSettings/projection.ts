// Единственный публичный путь native values фильтрует все value slots.
// Неактивный выбор хранится приватно и публикуется только с безопасной причиной.

import type {
  ProviderSettingsCatalog,
  ProviderSettingNode,
} from '../../../../shared/chat/providerSettingsContracts.ts';
import type { NativeSettingsCatalogRead } from './catalog.ts';
import type { NativeSettingsStorage, NormalizedSettingNode } from './types.ts';
import { flattenNativeSettings, validateNativeSetting } from './validation.ts';

/**
 * Приватная схема и канал не становятся частью HTTP-каталога.
 * Override доступен только для проверенного типизированного поля.
 */
function publicNode(
  node: NormalizedSettingNode,
  storage: NativeSettingsStorage,
  stale: boolean,
  fields: NormalizedSettingNode[],
): ProviderSettingNode {
  const saved = storage.overrides[node.id];
  const valid =
    saved && !validateNativeSetting(fields, node.id, saved.value, Object.values(storage.overrides));

  return {
    id: node.id,
    path: [...node.path],
    label: node.label,
    ...(node.description ? { description: node.description } : {}),
    kind: node.kind,
    constraints: node.secret ? {} : node.constraints,
    writable: node.writable && !stale,
    ...(node.reason ? { reason: node.reason } : {}),
    ...(node.owner ? { owner: node.owner } : {}),
    ...(node.appliesTo ? { appliesTo: node.appliesTo } : {}),
    ...(node.consumerSupport ? { consumerSupport: node.consumerSupport } : {}),
    ...(node.children
      ? { children: node.children.map((child) => publicNode(child, storage, stale, fields)) }
      : {}),
    ...(node.items ? { items: publicNode(node.items, storage, stale, fields) } : {}),
    default: node.secret ? { state: 'redacted' } : node.default,
    base: node.secret ? { state: 'redacted' } : node.base,
    override: node.secret
      ? { state: 'redacted', present: Boolean(saved) }
      : valid
        ? { state: 'known', value: saved.value }
        : { state: saved ? 'unknown' : 'unset' },
  };
}

/**
 * Последний успешный каталог остаётся видимым при сбое без вывода значений
 * неактивных полей. GET не исправляет и не удаляет prefs.
 */
export function projectNativeSettingsCatalog(
  read: NativeSettingsCatalogRead,
  storage: NativeSettingsStorage,
): ProviderSettingsCatalog {
  const inactiveOverrides = Object.entries(storage.overrides).flatMap(([id, entry]) => {
    const field = flattenNativeSettings(read.fields).find((item) => item.id === id);
    const invalid = validateNativeSetting(read.fields, id, entry.value, Object.values(storage.overrides));

    const complete = read.snapshot?.areas.some(
      (area) => area.coverage === 'complete' && area.path.every((part, index) => entry.path[index] === part),
    );
    const reason = !field
      ? complete
        ? 'Поле удалено из подтверждённой схемы'
        : 'Поддержка поля не подтверждена неполной схемой'
      : (invalid?.message ?? '');

    return invalid
      ? [
          {
            id,
            path: entry.path,
            label: field?.label ?? entry.path.join(' → '),
            reason,
          },
        ]
      : [];
  });

  return {
    protocolVersion: 1,
    providerId: read.context.providerId,
    state: read.state,
    scope: read.snapshot?.scope ?? { id: 'cockpit-chats', label: 'Для чатов Cockpit' },
    source: read.snapshot?.source ?? {
      kind: 'cli',
      version: null,
      checkedAt: 0,
      coverage: [],
    },
    schemaRevision: read.schemaRevision,
    revision: String(storage.revision),
    fields: read.fields.map((node) => publicNode(node, storage, read.state === 'stale', read.fields)),
    inactiveOverrides,
  };
}
