import { createHash } from 'node:crypto';

import { isRecord } from '../../../../shared/lib/objects.ts';

import type { QwenModel, QwenSnapshot } from './settings.ts';

const defaultEndpoints = new Map([
  ['openai', 'https://api.openai.com/v1'],
  ['anthropic', 'https://api.anthropic.com'],
  ['gemini', 'https://generativelanguage.googleapis.com'],
]);

const authTypes = new Map([
  ['anthropic', 'api-key'],
  ['gemini', 'google-api-key'],
]);

/**
 * Провайдер остаётся тем же при перестановке каталога. Ключ хранится у шлюза.
 * Публичные id GrigDesk остаются стабильными для сохранённых чатов и маршрутов.
 */
export function qwenPreviewProvider(model: QwenModel) {
  const protocol = model.authType;
  const baseUrl = String(model.entry.baseUrl || defaultEndpoints.get(protocol) || '');
  const envKey = model.entry.envKey;

  if (!defaultEndpoints.has(protocol) || !baseUrl || typeof envKey !== 'string') {
    return null;
  }

  const digest = createHash('sha256').update(JSON.stringify([protocol, baseUrl, envKey]));

  return {
    id: `grigdesk-${digest.digest('hex').slice(0, 24)}`,
    protocol,
    baseUrl,
    envKey,
    authType: authTypes.get(protocol) || 'bearer',
  };
}

/**
 * Идентификатор модели ACP связывает роут GrigDesk с выпущенным провайдером.
 * Неподдерживаемый протокол не даёт имени для запуска или выбора.
 */
export function qwenPreviewModelId(model: QwenModel): string {
  const provider = qwenPreviewProvider(model);

  return provider ? `${provider.id}/${model.entry.id}` : '';
}

/**
 * Preview читает `providers`, один явно выданный набор разрешений и пустой список hooks.
 * Исходные настройки доступа преобразуются в данные, исполняемые поля не копируются.
 */
export function qwenPreviewSettings(snapshot: QwenSnapshot, directories: readonly string[],
  gateway: { origin: string; token: string }, nativeModelId?: string) {
  const providers: Record<string, Record<string, unknown> & { models: Record<string, unknown>[] }> = {};

  for (const model of snapshot.models) {
    const provider = qwenPreviewProvider(model);

    if (!provider) {
      continue;
    }

    const { id, protocol, authType } = provider;
    const entry = isRecord(model.entry.generationConfig) ? model.entry.generationConfig : {};
    const modalities = isRecord(entry.modalities) ? entry.modalities : {};
    const modelId = String(model.entry.id);
    const config = providers[id] ??= {
      type: 'openai-compatible',
      protocol,
      authType,
      apiKey: gateway.token,
      baseUrl: `${gateway.origin}/${id}`,
      models: [],
    };

    config.models.push({
      model: modelId,
      displayName: String(model.entry.name || modelId),
      ...(Number.isSafeInteger(entry.contextWindowSize) ? { contextWindow: entry.contextWindowSize } : {}),
      capabilities: { vision: modalities.image === true },
    });
  }

  return {
    providers,
    model: { name: nativeModelId ?? snapshot.models.map(qwenPreviewModelId).find(Boolean) },
    privacy: { usageStatisticsEnabled: false },
    permissions: { additionalDirectories: directories },
    disableAllHooks: true,
    skills: { disableShellExecution: true },
  };
}
