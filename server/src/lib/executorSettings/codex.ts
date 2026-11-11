// Codex разделяет схему RPC, полный опубликованный config и каталог feature flags.
// Авторитет установленного CLI определяется отдельно от актуальности внешней схемы.

import { accessEnvironment } from '../accessProfiles/runtime.ts';
import { recordOrEmpty } from '../../../../shared/lib/objects.ts';

import type { NativeSettingsContext, NativeSettingsOwnership, NativeSettingsSnapshot } from './types.ts';
import { decodeSettingsJson } from '../../../../shared/chat/providerSettingsContracts.ts';
import { settingsFingerprint } from './fingerprint.ts';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from '../providerInstall/externalCliProcess.ts';
import { promisify } from 'node:util';
import { createNativeSettingsCapability } from './capability.ts';
import { readSettingsCliVersion, withSettingsStdioProbe } from './probe.ts';
import { readPublishedSettingsSchema } from './publishedSchema.ts';

type CodexSettingsConfig = { codexBin: string };

const execFileAsync = promisify(execFile);

/**
 * Фиксированный официальный источник имеет ограниченный кэш и предел объёма.
 * Его отказ не уничтожает установленную схему RPC и последний внешний snapshot.
 */
async function readPublishedConfig(signal: AbortSignal, refresh: boolean): Promise<unknown> {
  return readPublishedSettingsSchema('https://developers.openai.com/codex/config-schema.json', signal, {
    refresh,
  });
}

/**
 * Схема генерируется установленным бинарём в собственный временный каталог.
 * Живое чтение использует тот же cwd и базовый профиль, что чатовый app-server.
 */
export async function readCodexSettings(
  config: CodexSettingsConfig,
  context: NativeSettingsContext,
  { signal, refresh = false }: { signal: AbortSignal; refresh?: boolean },
): Promise<NativeSettingsSnapshot> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-settings-codex-'));

  try {
    const schemas = path.join(root, 'schema');

    await execFileAsync(
      config.codexBin,
      ['app-server', 'generate-json-schema', '--experimental', '--out', schemas],
      {
        cwd: context.cwdRealpath,
        signal,
        maxBuffer: 2_097_152,
      },
    );

    const file = path.join(schemas, 'v2', 'ConfigReadResponse.json');

    if ((await fs.stat(file)).size > 2_097_152) {
      throw new Error('Схема Codex превышает предел объёма');
    }

    const schema = JSON.parse(await fs.readFile(file, 'utf8'));
    const published = await readPublishedConfig(signal, refresh);

    return await withSettingsStdioProbe(
      {
        bin: config.codexBin,
        args: ['app-server'],
        cwd: context.cwdRealpath,
        signal,
      },
      async (probe) => {
        let id = 0;
        /**
         * Probe обращается только к методам чтения собственного app-server.
         * Ошибка RPC остаётся безопасной причиной без приватного envelope.
         */
        const rpc = async (method: string, params: Record<string, unknown>) => {
          const current = ++id;
          const response = await probe.request(
            {
              id: current,
              method,
              params,
            },
            (value) => value.id === current,
          );

          if (response.error) {
            throw new Error('Codex отклонил чтение настроек');
          }

          return response.result;
        };
        const initialized = recordOrEmpty(
          await rpc('initialize', {
            clientInfo: { name: 'grigdesk-settings', version: '1' },
            capabilities: { experimentalApi: true },
          }),
        );

        probe.send({ method: 'initialized' });

        const snapshot = await codexSettingsSnapshot(rpc, schema, context, published);

        snapshot.source.version =
          typeof initialized.userAgent === 'string'
            ? (initialized.userAgent.match(/grigdesk-settings\/([^ ]+)/)?.[1] ?? null)
            : null;

        snapshot.source.version ??= await readSettingsCliVersion(config.codexBin, signal);

        return snapshot;
      },
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

export const codexNativeSettings = createNativeSettingsCapability<CodexSettingsConfig>({
  id: 'codex',
  bin: (config) => config.codexBin,
  profile: () => ({
    transport: 'app-server',
    mode: 'default',
    identity: ['app-server-config-v1', accessEnvironment().CODEX_HOME ?? null],
  }),
  discover: readCodexSettings,
});

const OWNED = [
  'model',
  'review_model',
  'model_provider',
  'model_reasoning_effort',
  'plan_mode_reasoning_effort',
  'model_reasoning_summary',
  'model_auto_compact_token_limit',
  'model_instructions_file',
  'instructions',
  'developer_instructions',
  'compact_prompt',
  'experimental_compact_prompt_file',
  'sandbox_mode',
  'sandbox_workspace_write',
  'approval_policy',
  'approvals_reviewer',
  'permissions',
  'default_permissions',
  'hooks',
  'mcp_servers',
  'shell_environment_policy',
  'profile',
  'profiles',
  'projects',
];
const SECRET_BRANCHES = [
  'model_providers',
  'forced_login_method',
  'forced_chatgpt_workspace_id',
  'cli_auth_credentials_store',
  'mcp_oauth_credentials_store',
  'responses_api_metadata',
];

/**
 * Пространство definitions внешней схемы отделено от установленного RPC.
 * Latest без версии остаётся частичным источником с запретом записи новых веток.
 */
function publishedSchema(value: unknown): Record<string, unknown> {
  /**
   * Ссылки внешней схемы получают своё пространство definitions.
   * Одинаковые имена типов не подменяют определения установленного CLI.
   */
  function visit(item: unknown): unknown {
    if (Array.isArray(item)) {
      return item.map(visit);
    }

    if (!item || typeof item !== 'object') {
      return item;
    }

    return Object.fromEntries(
      Object.entries(item).map(([key, child]) => [
        key,
        key === '$ref' && typeof child === 'string'
          ? child.replace('#/definitions/', '#/definitions/published_')
          : visit(child),
      ]),
    );
  }

  const schema = recordOrEmpty(visit(value));

  schema.definitions = Object.fromEntries(
    Object.entries(recordOrEmpty(schema.definitions)).map(([key, definition]) => [
      `published_${key}`, definition
    ]),
  );

  return schema;
}

/**
 * Пагинация native flags не ограничивается первой страницей.
 * Форма не содержит перечня флагов или копии их стандартных значений.
 */
export async function codexSettingsSnapshot(
  rpc: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  schema: unknown,
  context: NativeSettingsContext,
  published?: unknown,
): Promise<NativeSettingsSnapshot> {
  const installed = recordOrEmpty(schema);
  const configSchema = recordOrEmpty(recordOrEmpty(installed.definitions).Config);

  if (configSchema.type !== 'object' || !configSchema.properties) {
    throw new Error('CLI не объявил схему Config RPC');
  }

  const read = recordOrEmpty(await rpc('config/read', { cwd: context.cwdRealpath, includeLayers: false }));
  const config = recordOrEmpty(read.config);
  const requirements = recordOrEmpty(recordOrEmpty(await rpc('configRequirements/read', {})).requirements);
  const ownership: NativeSettingsOwnership[] = [
    ...OWNED.map((key) => ({
      path: [key],
      owner: 'Запуск GrigDesk',
      reason: 'Управляется параметрами чата',
    })),
    ...SECRET_BRANCHES.map((key) => ({
      path: [key],
      owner: 'Авторизация CLI',
      reason: 'Приватная конфигурация управляется CLI',
      secret: true,
    })),
  ];
  const featureProperties: Record<string, unknown> = {};
  const featureBase: Record<string, boolean> = {};
  const seen = new Set<string>();
  let cursor: string | undefined;

  do {
    const page = recordOrEmpty(await rpc('experimentalFeature/list', {
      limit: 200,
      ...(cursor ? { cursor } : {})
    }));

    if (!Array.isArray(page.data) || seen.size > 100 || page.data.length > 10_000) {
      throw new Error('Повреждена пагинация feature flags');
    }

    for (const input of page.data) {
      const feature = recordOrEmpty(input);

      if (
        typeof feature.name !== 'string' ||
        typeof feature.enabled !== 'boolean' ||
        typeof feature.defaultEnabled !== 'boolean' ||
        Object.hasOwn(featureProperties, feature.name)
      ) {
        throw new Error('Повреждён каталог feature flags');
      }

      const supported = ['stable', 'beta', 'underDevelopment'].includes(String(feature.stage));

      Object.defineProperty(featureProperties, feature.name, {
        enumerable: true,
        value: {
          type: 'boolean',
          default: feature.defaultEnabled,
          readOnly: !supported,
          ...(typeof feature.displayName === 'string' ? { title: feature.displayName } : {}),
          ...(typeof feature.description === 'string' ? { description: feature.description } : {}),
        },
      });
      Object.defineProperty(featureBase, feature.name, { enumerable: true, value: feature.enabled });

      if (!supported || Object.hasOwn(recordOrEmpty(requirements.features), feature.name)) {
        ownership.push({
          path: ['features', feature.name],
          owner: 'Политика CLI',
          reason: !supported ? 'Стадия флага не поддерживает запись' : 'Значение ограничено requirements CLI',
        });
      }
    }

    if (page.nextCursor !== null && page.nextCursor !== undefined && typeof page.nextCursor !== 'string') {
      throw new Error('Повреждён cursor feature flags');
    }

    cursor = page.nextCursor as string | undefined;

    if (cursor && seen.has(cursor)) {
      throw new Error('Повтор cursor feature flags');
    }

    if (cursor) {
      seen.add(cursor);
    }
  } while (cursor);

  const external = publishedSchema(published);
  const externalProperties = recordOrEmpty(external.properties);
  const installedProperties = recordOrEmpty(configSchema.properties);
  const properties = { ...externalProperties, ...installedProperties };

  delete properties.features;

  for (const key of new Set([...Object.keys(externalProperties), ...Object.keys(config)])) {
    if (key !== 'features' && !Object.hasOwn(installedProperties, key)) {
      properties[key] = externalProperties[key] ?? {};
      ownership.push({
        path: [key],
        owner: 'Совместимость CLI',
        reason: 'Тип этой ветки не подтверждён схемой установленного CLI',
      });
    }
  }

  const channel = {
    id: 'app-server-config',
    scope: 'grigdesk-chats' as const,
    state: 'verified' as const,
  };
  const areas = [
    {
      path: [],
      format: 'json-schema' as const,
      dialect: 'draft-07',
      coverage: 'partial' as const,
      schema: {
        type: 'object',
        properties,
        definitions: {
          ...recordOrEmpty(external.definitions),
          ...recordOrEmpty(installed.definitions),
        },
      },
      writeChannel: channel,
      base: decodeSettingsJson(config),
    },
    {
      path: ['features'],
      format: 'json-schema' as const,
      dialect: 'draft-07',
      coverage: 'complete' as const,
      schema: { type: 'object', properties: featureProperties },
      writeChannel: channel,
      base: featureBase,
    },
  ];

  return {
    context,
    generation: settingsFingerprint(areas.map(({ base: _base, ...area }) => area)),
    source: {
      kind: 'app-server + config-schema',
      version: null,
      checkedAt: Date.now(),
      coverage: areas.map((area) => ({ path: area.path, coverage: area.coverage })),
    },
    areas,
    ownership,
  };
}
