// Claude публикует значения и отдельные applied-факты через control protocol.
// Внешняя схема не превращает отсутствующее effective значение в известный default.

import { recordOrEmpty } from '../../../../shared/lib/objects.ts';

import type { NativeSettingsContext, NativeSettingsSnapshot } from './types.ts';
import { decodeSettingsJson } from '../../../../shared/chat/providerSettingsContracts.ts';
import { settingsFingerprint } from './fingerprint.ts';
import { normalizeJsonSchema } from './jsonSchema.ts';
import { flattenNativeSettings, validateNativeSetting } from './validation.ts';
import { createNativeSettingsCapability } from './capability.ts';
import { readSettingsCliVersion, withSettingsStdioProbe } from './probe.ts';
import { readPublishedSettingsSchema } from './publishedSchema.ts';

/**
 * Опубликованная схема задаёт типы, но её соответствие версии не заявляется полным.
 * Ключ из effective без схемы остаётся unknown и не считается удалённым.
 */
export function claudeSettingsSnapshot(
  settings: unknown,
  schema: unknown,
  context: NativeSettingsContext,
): NativeSettingsSnapshot {
  const response = recordOrEmpty(settings);

  if (!response.effective || !response.sources || !response.applied) {
    throw new Error('Claude не подтвердил get_settings');
  }

  const effective = recordOrEmpty(response.effective);
  const external = recordOrEmpty(schema);
  const properties = { ...recordOrEmpty(external.properties) };

  for (const key of Object.keys(effective)) {
    if (!Object.hasOwn(properties, key)) {
      properties[key] = {};
    }
  }

  const ownership = [
    ...[
      'fastMode',
      'model',
      'effortLevel',
      'alwaysThinkingEnabled',
      'permissions',
      'sandbox',
      'hooks',
      'disableAllHooks',
      'mcpServers',
      'enabledMcpjsonServers',
      'disabledMcpjsonServers',
      'enableAllProjectMcpServers',
      'allowedMcpServers',
      'deniedMcpServers',
    ].map((key) => ({
      path: [key],
      owner: 'Запуск GrigDesk',
      reason: 'Управляется существующими параметрами чата',
    })),
    ...['env', 'apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'otelHeadersHelper'].map((key) => ({
      path: [key],
      owner: 'Авторизация CLI',
      reason: 'Приватная конфигурация управляется CLI',
      secret: true,
    })),
  ];
  const normalizedSchema = {
    ...external,
    type: 'object',
    properties,
  };
  const area = {
    path: [],
    format: 'json-schema' as const,
    dialect: 'draft-07',
    coverage: 'partial' as const,
    schema: normalizedSchema,
    base: decodeSettingsJson(effective),
    writeChannel: {
      id: 'settings-json-overlay',
      scope: 'grigdesk-chats' as const,
      state: 'verified' as const,
    },
  };
  const fields = normalizeJsonSchema(normalizedSchema, { ...area, ownership });

  for (const field of flattenNativeSettings(fields)) {
    if (
      field.base.state === 'known' &&
      field.writable &&
      validateNativeSetting(fields, field.id, field.base.value)?.code === 'invalid_value'
    ) {
      ownership.push({
        path: field.path,
        owner: 'Совместимость CLI',
        reason: 'Значение CLI расходится с опубликованной схемой',
      });
    }
  }

  return {
    context,
    generation: settingsFingerprint({ schema: normalizedSchema, ownership }),
    areas: [area],
    ownership,
    source: {
      kind: 'get_settings + SchemaStore',
      version: null,
      checkedAt: Date.now(),
      coverage: [{ path: [], coverage: 'partial' }],
    },
  };
}

type ClaudeSettingsConfig = { claudeBin: string };

/**
 * Initialize и get_settings обходятся без пользовательского сообщения и модели.
 * Неизвестный subtype или сбой протокола закрывает источник, а не угадывает effective.
 */
export async function readClaudeSettings(
  config: ClaudeSettingsConfig,
  context: NativeSettingsContext,
  { signal, refresh = false }: { signal: AbortSignal; refresh?: boolean },
): Promise<NativeSettingsSnapshot> {
  const schema = await readPublishedSettingsSchema(
    'https://json.schemastore.org/claude-code-settings.json',
    signal,
    { refresh },
  );

  return withSettingsStdioProbe(
    {
      bin: config.claudeBin,
      args: [
        '-p',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--verbose',
        '--no-session-persistence',
      ],
      cwd: context.cwdRealpath,
      signal,
    },
    async (probe) => {
      let id = 0;
      /**
       * Каждый control response сопоставляется с собственным request id.
       * Отказ subtype не выдаётся за успешно прочитанные настройки.
       */
      const control = async (subtype: string) => {
        const requestId = `settings-${++id}`;
        const result = await probe.request(
          {
            type: 'control_request',
            request_id: requestId,
            request: { subtype },
          },
          (response) =>
            response.type === 'control_response' && recordOrEmpty(response.response).request_id === requestId,
        );
        const response = recordOrEmpty(result.response);

        if (response.subtype !== 'success') {
          throw new Error('Claude не подтвердил control protocol настроек');
        }

        return response.response;
      };

      await control('initialize');

      const snapshot = claudeSettingsSnapshot(await control('get_settings'), schema, context);

      snapshot.source.version = await readSettingsCliVersion(config.claudeBin, signal);

      return snapshot;
    },
  );
}

export const claudeNativeSettings = createNativeSettingsCapability<ClaudeSettingsConfig>({
  id: 'claude',
  bin: (config) => config.claudeBin,
  profile: () => ({
    transport: 'stream-json',
    mode: 'default',
    identity: ['settings-json-v1', process.env.CLAUDE_CONFIG_DIR ?? null],
  }),
  discover: readClaudeSettings,
});
