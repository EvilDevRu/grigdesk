// OpenAPI задаёт отдельно форму GET и допустимый запрос POST конфигурации Kimi.
// Redacted ответ не используется как полный документ для замены настроек.

import { recordOrEmpty } from '../../../../shared/lib/objects.ts';

import type { NativeSettingsContext, NativeSettingsSnapshot } from './types.ts';
import { decodeSettingsJson } from '../../../../shared/chat/providerSettingsContracts.ts';
import { settingsFingerprint } from './fingerprint.ts';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startKimiServer } from '../kimi/serverRuntime.ts';
import { createNativeSettingsCapability } from './capability.ts';
import { verifyNativeSettings } from './capability.ts';
import type { KimiServerClient } from '../kimi/serverClient.ts';
import type { PreparedNativeSettings } from './types.ts';
import { readSettingsCliVersion } from './probe.ts';

type KimiSettingsConfig = {
  kimiBin: string;
  kimiHome: string;
  kimiLaunchMode?: string;
};

function jsonSchema(content: unknown): Record<string, unknown> {
  return recordOrEmpty(
    recordOrEmpty(recordOrEmpty(recordOrEmpty(content).content)['application/json']).schema
  );
}

/**
 * Форма записи берётся из request schema, а не угадывается по текущему value.
 * GET-only поля остаются видимыми без активного редактора.
 */
export function kimiSettingsSnapshot(
  openapi: unknown,
  read: unknown,
  context: NativeSettingsContext,
): NativeSettingsSnapshot {
  const description = recordOrEmpty(openapi);
  const dialect =
    typeof description.openapi === 'string'
      ? `openapi-${description.openapi.split('.').slice(0, 2).join('.')}`
      : 'openapi-3.0';
  const route = recordOrEmpty(recordOrEmpty(description.paths)['/api/v1/config']);
  const request = jsonSchema(recordOrEmpty(route.post).requestBody);
  const response = jsonSchema(recordOrEmpty(recordOrEmpty(route.get).responses)['200']);
  const publicResponse = recordOrEmpty(recordOrEmpty(response.properties).data);
  const data = recordOrEmpty(recordOrEmpty(read).data ?? read);

  if (request.type !== 'object' || !request.properties
    || (recordOrEmpty(read).code && recordOrEmpty(read).code !== 0)) {
    throw new Error('Kimi не подтвердил request schema конфигурации');
  }

  const properties = { ...recordOrEmpty(publicResponse.properties), ...recordOrEmpty(request.properties) };
  const getOnly = new Set(
    [...Object.keys(recordOrEmpty(publicResponse.properties)), ...Object.keys(data)].filter(
      (key) => !Object.hasOwn(recordOrEmpty(request.properties), key),
    ),
  );

  for (const key of Object.keys(data)) {
    if (!Object.hasOwn(properties, key)) {
      properties[key] = {};
    }
  }

  delete properties.raw;

  const ownership = [
    ...['default_model', 'default_provider', 'thinking', 'secondary_model'].map((key) => ({
      path: [key],
      owner: 'Модель и effort',
      reason: 'Управляется параметрами чата',
    })),
    ...[
      'yolo',
      'plan_mode',
      'default_permission_mode',
      'default_plan_mode',
      'permission',
      'hooks',
      'services',
      'mcp',
    ].map((key) => ({
      path: [key],
      owner: 'Запуск Cockpit',
      reason: 'Права и служебные инструменты задаёт запуск чата',
    })),
    ...['providers', 'models'].map((key) => ({
      path: [key],
      owner: 'Авторизация и модели CLI',
      reason: 'Приватная ветка управляется CLI',
      secret: true,
    })),
    ...Array.from(getOnly, (key) => ({
      path: [key],
      owner: 'Конфигурация CLI',
      reason: 'Поле отсутствует в request schema POST',
    })),
  ];
  const area = {
    path: [],
    format: 'json-schema' as const,
    dialect,
    coverage: 'partial' as const,
    schema: { ...request, properties },
    base: decodeSettingsJson(data),
    writeChannel: {
      id: 'isolated-config-post',
      scope: 'cockpit-chats' as const,
      state: context.mode === 'contained' ? ('unsupported' as const) : ('verified' as const),
      ...(context.mode === 'contained'
        ? { reason: 'Config contained-профиля смонтирован только для чтения' }
        : {}),
    },
  };

  return {
    context,
    generation: settingsFingerprint(area.schema),
    areas: [area],
    ownership,
    source: {
      kind: 'openapi request + config GET',
      version: null,
      checkedAt: Date.now(),
      coverage: [{ path: [], coverage: 'partial' }],
    },
  };
}

/**
 * Host probe получает собственную копию config; contained не наследует host home.
 * Токен и полный приватный файл остаются внутри временного каталога процесса.
 */
export async function readKimiSettings(
  config: KimiSettingsConfig,
  context: NativeSettingsContext,
  { signal }: { signal: AbortSignal },
): Promise<NativeSettingsSnapshot> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-settings-kimi-'));
  let server: Awaited<ReturnType<typeof startKimiServer>> | undefined;

  try {
    if (context.mode === 'host') {
      const source = path.join(config.kimiHome, 'config.toml');

      try {
        if ((await fs.stat(source)).size > 2_097_152) {
          throw new Error('Конфигурация Kimi превышает предел объёма');
        }

        await fs.copyFile(source, path.join(home, 'config.toml'));
        await fs.chmod(path.join(home, 'config.toml'), 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new Error('Не удалось подготовить probe конфигурации Kimi');
        }
      }
    }

    server = await startKimiServer({
      bin: config.kimiBin,
      home,
      cwd: context.cwdRealpath,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        KIMI_CODE_HOME: home,
      },
      signal,
    });

    const openapi = await server.client.settingsSchema(signal);
    const read = await server.client.readSettings(signal);
    const snapshot = kimiSettingsSnapshot(openapi, read, context);
    const meta = await server.client.meta();

    snapshot.source.version = typeof meta.version === 'string' ? meta.version : null;
    snapshot.source.version ??= await readSettingsCliVersion(config.kimiBin, signal);

    return snapshot;
  } finally {
    await server?.stop();
    await fs.rm(home, { recursive: true, force: true });
  }
}

export const kimiNativeSettings = createNativeSettingsCapability<KimiSettingsConfig>({
  id: 'kimi',
  bin: (config) => config.kimiBin,
  profile: (config) => ({
    transport: 'web',
    mode: config.kimiLaunchMode ?? 'host',
    identity: [
      config.kimiLaunchMode ?? 'host',
      config.kimiLaunchMode === 'contained' ? 'contained' : config.kimiHome,
    ],
  }),
  discover: readKimiSettings,
});

/**
 * POST адресно изменяет свой файл запуска и сохраняет скрытых соседей.
 * Ответ подтверждает принятый слой, а не применение настройками конкретного prompt.
 */
export async function applyKimiNativeSettings(
  client: Pick<KimiServerClient, 'updateSettings'>,
  plan: PreparedNativeSettings,
  signal?: AbortSignal,
) {
  const changed = await client.updateSettings(plan.payload, signal);
  const evidence = verifyNativeSettings(
    plan,
    plan.accepted.map((entry) => {
      let value: unknown = changed;

      for (const segment of entry.path) {
        value = value && typeof value === 'object' ? recordOrEmpty(value)[segment] : undefined;
      }

      return {
        fieldId: entry.fieldId,
        basis: 'effective' as const,
        ...(value !== undefined ? { value: decodeSettingsJson(value) } : {}),
      };
    }),
  );

  if (evidence.some((item) => item.result === 'overridden' || item.result === 'rejected')) {
    throw new Error('Kimi не принял нативный слой конфигурации');
  }

  return evidence;
}
