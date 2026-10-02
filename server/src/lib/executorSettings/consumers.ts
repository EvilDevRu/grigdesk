// Профили имеют общие field IDs и один storage; отсутствие второго источника не доказывает web-only.
// Ownership/secret ограничения объединяются раньше схем и публичных значений.

import type { SettingsConsumerSupport } from '../../../../shared/providerSettingsContracts.ts';
import type { NativeSettingsSnapshot, NormalizedSettingNode } from './types.ts';
import { normalizeNativeSettingsSnapshot } from './catalog.ts';
import { canonicalSettingsJson, settingsFingerprint } from './fingerprint.ts';

function unsupported(reason: string): SettingsConsumerSupport {
  return { state: 'unsupported', reason };
}

/**
 * Сравниваются semantic constraints, типы и вложенные поля, без uid Schemastery и values.
 * Совпадение текущего значения не означает совместимую схему для будущего override.
 */
function schemaIdentity(node: NormalizedSettingNode): unknown {
  return {
    kind: node.kind,
    constraints: node.constraints,
    children: node.children?.map((child) => [child.id, schemaIdentity(child)])
      .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
    items: node.items ? schemaIdentity(node.items) : undefined,
  };
}

/**
 * Каждый узел получает доказанную область; непроверенный ACP остаётся явным unverified.
 * Несовместимые схемы не открывают второй writable канал и сохраняют прежний override.
 */
function mergeFields(
  chat: NormalizedSettingNode[],
  pipeline: NormalizedSettingNode[],
  pipelineKnown: boolean,
): NormalizedSettingNode[] {
  const ids = [...new Set([...chat.map((node) => node.id), ...pipeline.map((node) => node.id)])];

  return ids.map((id) => {
    const web = chat.find((node) => node.id === id);
    const acp = pipeline.find((node) => node.id === id);
    const node = structuredClone(web || acp!);
    const same = !web || !acp || canonicalSettingsJson(schemaIdentity(web)) ===
      canonicalSettingsJson(schemaIdentity(acp));
    const forbidden = node.secret || Boolean(node.owner);
    const chatSupport: SettingsConsumerSupport = !web
      ? unsupported('Поле отсутствует в подтверждённой схеме чата')
      : forbidden || !web.writable
        ? unsupported(web.reason || 'Поле управляется другим редактором')
        : same
          ? { state: 'verified' }
          : { state: 'unverified', reason: 'Схемы web и ACP несовместимы' };
    const pipelineSupport: SettingsConsumerSupport = forbidden
      ? unsupported(node.reason || 'Поле управляется другим редактором')
      : !pipelineKnown
        ? { state: 'unverified', reason: 'Схема ACP не подтверждена' }
        : !acp
          ? unsupported('Поле доступно только в чатах')
          : !acp.writable
            ? unsupported(acp.reason || 'Запись в ACP не подтверждена')
            : same
              ? { state: 'verified' }
              : { state: 'unverified', reason: 'Схемы web и ACP несовместимы' };

    node.consumerSupport = { chat: chatSupport, pipeline: pipelineSupport };
    node.appliesTo = [
      ...(chatSupport.state === 'verified' ? ['chat' as const] : []),
      ...(pipelineSupport.state === 'verified' ? ['pipeline' as const] : []),
    ];
    node.writable = node.appliesTo.length > 0;

    if (!node.writable && !node.reason) {
      node.reason = chatSupport.reason || pipelineSupport.reason;
    }

    if (web?.children || acp?.children) {
      node.children = mergeFields(web?.children ?? [], acp?.children ?? [], pipelineKnown);
    }

    if (web?.items || acp?.items) {
      node.items = mergeFields(
        web?.items ? [web.items] : [], acp?.items ? [acp.items] : [], pipelineKnown,
      )[0];
    }

    return node;
  });
}

/**
 * Union запретов применяется к обоим источникам до построения value slots.
 * Нормализованные схемы consumers остаются приватными для повторной validation запуска.
 */
export function mergeNativeSettingsConsumers(
  chat: NativeSettingsSnapshot,
  pipeline: NativeSettingsSnapshot | null,
  { pipelineSupported = true }: { pipelineSupported?: boolean } = {},
): NativeSettingsSnapshot {
  const ownership = [...chat.ownership, ...(pipeline?.ownership ?? [])];
  const web = normalizeNativeSettingsSnapshot({
    ...chat,
    ownership,
    normalizedFields: undefined,
  });
  const acp = pipeline
    ? normalizeNativeSettingsSnapshot({
      ...pipeline,
      ownership,
      normalizedFields: undefined,
    }) : [];
  const pipelineKnown = Boolean(pipeline &&
    pipeline.source.coverage.every((area) => area.coverage === 'complete'));
  const fields = mergeFields(web, acp, pipelineKnown || !pipelineSupported);

  return {
    ...chat,
    ownership,
    scope: pipelineSupported
      ? { id: 'cockpit-chats-and-pipelines', label: 'Для чатов и конвейеров Cockpit' }
      : { id: 'cockpit-chats', label: 'Для чатов Cockpit' },
    normalizedFields: fields,
    consumerFields: { chat: web, ...(pipeline ? { pipeline: acp } : {}) },
    generation: settingsFingerprint([chat.generation, pipeline?.generation ?? null, fields]),
  };
}
