// Источник DSH читает объявленные namespaces выбранного сервером профиля.
// Нативный документ не возвращается браузеру и не становится хранилищем Cockpit.

import type { NativeSettingsContext, NativeSettingsOwnership, NativeSettingsSnapshot } from './types.ts';
import type { NativeSettingsEvidence, PreparedNativeSettings } from './types.ts';
import type { DeepSeekWebClient } from '../deepseek/serverClient.ts';
import { decodeSettingsJson } from '../../../../shared/providerSettingsContracts.ts';
import { settingsFingerprint } from './fingerprint.ts';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startDeepSeekServer } from '../deepseek/serverRuntime.ts';
import { createNativeSettingsCapability } from './capability.ts';
import { verifyNativeSettings } from './capability.ts';
import { DEEPSEEK_PROFILE_REVISION } from '../deepseek/profile.ts';
import { readSettingsCliVersion } from './probe.ts';

type DeepSeekSettingsConfig = { deepseekBin: string };

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Некорректный ответ settings/describe');
  }

  return value as Record<string, unknown>;
}

/**
 * Профиль соответствует web-транспорту чатового адаптера, а документ probe всегда свой.
 * Разбор не пишет настройки пользователя и не создаёт ни session, ни prompt.
 */
export async function readDeepSeekSettings(
  config: DeepSeekSettingsConfig,
  context: NativeSettingsContext,
  { signal }: { signal: AbortSignal },
  startServer = startDeepSeekServer,
): Promise<NativeSettingsSnapshot> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-settings-dsh-'));
  let server: Awaited<ReturnType<typeof startServer>> | undefined;

  try {
    const overlayPath = path.join(root, 'overlay.yml');

    await fs.writeFile(overlayPath, '[]\n', { mode: 0o600 });
    server = await startServer({
      bin: config.deepseekBin,
      overlayPath,
      cwd: context.cwdRealpath,
      signal,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        DSH_HOME: root,
        DSH_TELEMETRY_DISABLED: '1',
        NO_COLOR: '1',
      },
    });

    const snapshot = deepSeekSettingsSnapshot(
      await server.client.rpc('settings/describe', {}, 10_000, signal),
      context,
    );

    snapshot.source.version = await readSettingsCliVersion(config.deepseekBin, signal);

    return snapshot;
  } finally {
    await server?.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
}

export const deepSeekNativeSettings = createNativeSettingsCapability<DeepSeekSettingsConfig>({
  id: 'deepseek',
  bin: (config) => config.deepseekBin,
  profile: () => ({
    transport: 'web',
    mode: 'default',
    identity: ['web', DEEPSEEK_PROFILE_REVISION],
  }),
  discover: readDeepSeekSettings,
});

/**
 * Setter работает только после выбора изолированного документа запуска.
 * Возвращаемые факты принятия слоя не означают применение моделью.
 */
export async function applyDeepSeekNativeSettings(
  client: Pick<DeepSeekWebClient, 'rpc'>,
  plan: PreparedNativeSettings,
): Promise<NativeSettingsEvidence[]> {
  const description = record(await client.rpc('settings/describe'));
  const namespaces = Array.isArray(description.namespaces) ? description.namespaces.map(record) : [];
  const readback = [];

  for (const name of new Set(plan.accepted.map((entry) => entry.path[0]!))) {
    const namespace = namespaces.find((item) => item.ns === name);

    if (!namespace || description.writable !== true) {
      throw new Error('Нативные настройки DeepSeek недоступны в запуске');
    }

    const entries = plan.accepted.filter((entry) => entry.path[0] === name);
    const changed = record(
      await client.rpc('settings/mutate', {
        ns: name,
        expectedRevision: namespace.revision,
        ops: entries.map((entry) => ({
          op: 'set',
          path: entry.path.slice(1),
          value: entry.value,
        })),
      }),
    );

    for (const entry of entries) {
      let value: unknown = changed.value;

      for (const segment of entry.path.slice(1)) {
        value = value && typeof value === 'object' ? (value as Record<string, unknown>)[segment] : undefined;
      }

      readback.push({
        fieldId: entry.fieldId,
        basis: 'effective' as const,
        ...(value !== undefined ? { value: decodeSettingsJson(value) } : {}),
      });
    }
  }

  const evidence = verifyNativeSettings(plan, readback);

  if (evidence.some((item) => item.result === 'overridden' || item.result === 'rejected')) {
    throw new Error('CLI DeepSeek не принял нативные настройки запуска');
  }

  return evidence;
}

const OWNERSHIP: NativeSettingsOwnership[] = [
  ...['llm-deepseek', 'llm-pi-ai'].flatMap((namespace) =>
    ['reasoningEffort', 'thinking'].map((key) => ({
      path: [namespace, key],
      owner: 'Модель и effort',
      reason: 'Управляется выбором модели и effort чата',
    })),
  ),
  {
    path: ['agent-default-model'],
    owner: 'Модель и effort',
    reason: 'Управляется выбором модели чата',
  },
  {
    path: ['sandbox-policy'],
    owner: 'Права чата',
    reason: 'Граница файлов задаётся запуском Cockpit',
  },
  {
    path: ['approval'],
    owner: 'Права чата',
    reason: 'Политика согласований задаётся запуском Cockpit',
  },
  {
    path: ['permission'],
    owner: 'Права чата',
    reason: 'Разрешения задаются запуском Cockpit',
  },
  {
    path: ['agent-instructions'],
    owner: 'Инструкции проекта',
    reason: 'Инструкции готовит Cockpit',
  },
  {
    path: ['hooks-claude-code'],
    owner: 'Служебные hooks',
    reason: 'Проверки SSH и БД готовит Cockpit',
  },
];

/**
 * Протокол describe сохраняет namespace в пути каждого поля.
 * Неизвестные применения будут показаны без возможности записи.
 */
export function deepSeekSettingsSnapshot(
  description: unknown,
  context: NativeSettingsContext,
): NativeSettingsSnapshot {
  const response = record(description);

  if (!Array.isArray(response.namespaces) || response.namespaces.length > 500) {
    throw new Error('Некорректный состав namespaces');
  }

  const ownership = structuredClone(OWNERSHIP);
  const names = new Set<string>();
  const areas = response.namespaces.map((input) => {
    const namespace = record(input);

    if (
      typeof namespace.ns !== 'string' ||
      !namespace.ns ||
      names.has(namespace.ns) ||
      !Number.isSafeInteger(namespace.revision) ||
      typeof namespace.applies !== 'string'
    ) {
      throw new Error('Некорректный namespace');
    }

    names.add(namespace.ns);

    for (const input of Array.isArray(namespace.secrets) ? namespace.secrets : []) {
      const secret = record(input);

      if (!Array.isArray(secret.path) || secret.path.some((part) => typeof part !== 'string')) {
        throw new Error('Некорректное описание secrets');
      }

      ownership.push({
        path: [namespace.ns, ...secret.path],
        secret: true,
        owner: 'Секрет CLI',
        reason: 'Значение скрыто и управляется CLI',
      });
    }

    const writable =
      response.writable === true &&
      response.hasDocument === true &&
      ['live', 'restart'].includes(namespace.applies);

    return {
      path: [namespace.ns],
      format: 'schemastery' as const,
      dialect: 'schemastery',
      schema: namespace.schema,
      coverage: 'complete' as const,
      ...(namespace.value !== undefined ? { base: decodeSettingsJson(namespace.value) } : {}),
      writeChannel: {
        id: 'isolated-settings-document',
        scope: 'cockpit-chats' as const,
        state: writable ? ('verified' as const) : ('unverified' as const),
        ...(!writable ? { reason: 'Namespace не подтверждён как изменяемый в этом профиле' } : {}),
      },
    };
  });

  return {
    context,
    generation: settingsFingerprint(areas.map(({ base: _base, ...area }) => area)),
    source: {
      kind: 'settings/describe',
      version: null,
      checkedAt: Date.now(),
      coverage: areas.map((area) => ({ path: area.path, coverage: area.coverage })),
    },
    areas,
    ownership,
  };
}
