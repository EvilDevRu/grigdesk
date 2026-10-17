// Источник DSH читает объявленные namespaces выбранного сервером профиля.
// Нативный документ не возвращается браузеру и не становится хранилищем Cockpit.

import type { NativeSettingsContext, NativeSettingsOwnership, NativeSettingsSnapshot } from './types.ts';
import type { NativeSettingsEvidence, PreparedNativeSettings } from './types.ts';
import { startDeepSeekAcpSettings } from '../deepseek/nativeSettingsRpc.ts';
import type { DeepSeekSettingsRpc } from '../deepseek/nativeSettingsRpc.ts';
import { decodeSettingsJson } from '../../../../shared/chat/providerSettingsContracts.ts';
import type { SettingsConsumer } from '../../../../shared/chat/providerSettingsContracts.ts';
import { settingsFingerprint } from './fingerprint.ts';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startDeepSeekServer } from '../deepseek/serverRuntime.ts';
import { createNativeSettingsCapability } from './capability.ts';
import { verifyNativeSettings } from './capability.ts';
import { ProviderSettingsCatalogCache } from './catalog.ts';
import { validateNativeSetting } from './validation.ts';
import { mergeNativeSettingsConsumers } from './consumers.ts';
import { DEEPSEEK_PROFILE_REVISION } from '../deepseek/profile.ts';
import { readSettingsCliVersion } from './probe.ts';
import { resolveDeepSeekRuntimeAsync } from '../deepseek/runtimeProcess.ts';
import type { DeepSeekRuntimeConfig, DeepSeekRuntimeDescriptor } from '../deepseek/runtimeProcess.ts';

type DeepSeekSettingsConfig = DeepSeekRuntimeConfig & { deepseekBin: string };

const contextRuntimes = new WeakMap<NativeSettingsContext, DeepSeekRuntimeDescriptor>();
const acpOwnership = new Map<string, NativeSettingsOwnership[]>();

/**
 * Контекст закрепляет descriptor до discovery и хранит только identity в публичном объекте.
 * Последующая смена current не меняет профиль процесса, который описывает этот контекст.
 */
async function deepSeekSettingsContext(
  config: DeepSeekSettingsConfig,
  cwd: string,
  consumer: SettingsConsumer,
) {
  const runtime = await resolveDeepSeekRuntimeAsync(config);

  if (consumer === 'pipeline' && !runtime.capabilities.settingsAcp) {
    throw Object.assign(new Error('Настройки DeepSeek для конвейера не подтверждены этим runtime'), {
      code: 'native_settings_unverified',
    });
  }

  const context: NativeSettingsContext = {
    providerId: 'deepseek',
    binaryIdentity: runtime.identity,
    runtimeIdentity: runtime.identity,
    ...(runtime.buildId ? { buildId: runtime.buildId } : {}),
    profileFingerprint: DEEPSEEK_PROFILE_REVISION,
    transport: consumer === 'pipeline' ? 'acp' : 'web',
    consumer,
    mode: 'default',
    cwdRealpath: await fs.realpath(cwd),
  };

  contextRuntimes.set(context, runtime);

  return context;
}

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
  startAcp = startDeepSeekAcpSettings,
): Promise<NativeSettingsSnapshot> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-settings-dsh-'));
  const runtime = contextRuntimes.get(context) || await resolveDeepSeekRuntimeAsync(config);
  let server: Awaited<ReturnType<typeof startServer>> | undefined;

  try {
    const overlayPath = path.join(root, 'overlay.yml');

    await fs.writeFile(overlayPath, '[]\n', { mode: 0o600 });
    server = await startServer({
      runtime,
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

    snapshot.source.version = runtime.kind === 'embedded'
      ? runtime.upstreamVersion : await readSettingsCliVersion(runtime.command, signal);

    if (!runtime.capabilities.settingsAcp) {
      return mergeNativeSettingsConsumers(snapshot, null, { pipelineSupported: false });
    }

    let acp: Awaited<ReturnType<typeof startAcp>> | undefined;
    let pipeline: NativeSettingsSnapshot | null = null;
    const ownershipKey = settingsFingerprint([runtime.identity, context.cwdRealpath, context.mode]);

    try {
      const acpHome = path.join(root, 'acp');

      await fs.mkdir(acpHome, { mode: 0o700 });
      acp = await startAcp({
        runtime,
        overlayPath,
        cwd: context.cwdRealpath,
        signal,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          DSH_HOME: acpHome,
          DSH_TELEMETRY_DISABLED: '1',
          NO_COLOR: '1',
        },
      });
      pipeline = deepSeekSettingsSnapshot(
        await acp.client.rpc('settings/describe', {}, 10_000, signal), context,
      );
      acpOwnership.set(ownershipKey, pipeline.ownership);
    } catch {
      // Неуспешное discovery не доказывает web-only; известные запреты остаются закрытыми.
      snapshot.ownership.push(...(acpOwnership.get(ownershipKey) ?? []));
    } finally {
      await acp?.stop();
    }

    return mergeNativeSettingsConsumers(snapshot, pipeline);
  } finally {
    await server?.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
}

export const deepSeekNativeSettings = createNativeSettingsCapability<DeepSeekSettingsConfig>({
  id: 'deepseek',
  consumers: ['chat', 'pipeline'],
  bin: (config) => config.deepseekBin,
  context: deepSeekSettingsContext,
  profile: (_config, consumer) => ({
    transport: consumer === 'pipeline' ? 'acp' : 'web',
    mode: 'default',
    identity: [consumer, DEEPSEEK_PROFILE_REVISION],
  }),
  discover: readDeepSeekSettings,
});

/**
 * Setter работает только после выбора изолированного документа запуска.
 * Возвращаемые факты принятия слоя не означают применение моделью.
 */
export async function applyDeepSeekNativeSettings(
  client: DeepSeekSettingsRpc,
  plan: PreparedNativeSettings,
  signal?: AbortSignal,
): Promise<NativeSettingsEvidence[]> {
  const description = record(await client.rpc('settings/describe', {}, 10_000, signal));
  const namespaces = Array.isArray(description.namespaces) ? description.namespaces.map(record) : [];
  const context: NativeSettingsContext = {
    providerId: 'deepseek',
    binaryIdentity: plan.runtimeIdentity || 'launch',
    profileFingerprint: plan.contextFingerprint || 'launch',
    transport: 'web',
    mode: 'default',
    cwdRealpath: '/',
  };
  const read = await new ProviderSettingsCatalogCache().read({
    discover: async () => deepSeekSettingsSnapshot(description, context),
  }, context);

  for (const entry of plan.accepted) {
    if (validateNativeSetting(read.fields, entry.fieldId, entry.value, plan.accepted)) {
      throw new Error('Нативное поле DeepSeek недоступно или несовместимо в запуске');
    }
  }

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
      }, 10_000, signal),
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

  if (evidence.some((item) => ['overridden', 'rejected', 'unknown'].includes(item.result))) {
    throw new Error('CLI DeepSeek не принял нативные настройки запуска');
  }

  return evidence;
}

/**
 * Повторный readback проверяет слой после restart и после настройки рабочей сессии.
 * Unknown столь же закрыт, как mismatch: ни одно принятое поле не теряется перед prompt.
 */
export async function verifyDeepSeekNativeSettings(
  client: DeepSeekSettingsRpc,
  plan: PreparedNativeSettings,
  signal?: AbortSignal,
): Promise<NativeSettingsEvidence[]> {
  const description = record(await client.rpc('settings/describe', {}, 10_000, signal));
  const namespaces = Array.isArray(description.namespaces) ? description.namespaces.map(record) : [];
  const readback = plan.accepted.map((entry) => {
    const namespace = namespaces.find((item) => item.ns === entry.path[0]);
    let value: unknown = namespace?.value;

    for (const segment of entry.path.slice(1)) {
      value = value && typeof value === 'object' ? (value as Record<string, unknown>)[segment] : undefined;
    }

    return {
      fieldId: entry.fieldId,
      basis: 'effective' as const,
      ...(value !== undefined ? { value: decodeSettingsJson(value) } : {}),
    };
  });
  const evidence = verifyNativeSettings(plan, readback);

  if (evidence.some((item) => ['overridden', 'rejected', 'unknown'].includes(item.result))) {
    throw new Error('Нативные настройки DeepSeek не подтверждены перед prompt');
  }

  return evidence;
}

/**
 * Restart определяется исходным namespace descriptor, без догадок по именам полей.
 * Повторный процесс читает тот же уже изменённый приватный документ запуска.
 */
export async function deepSeekSettingsNeedRestart(client: DeepSeekSettingsRpc, plan: PreparedNativeSettings) {
  const description = record(await client.rpc('settings/describe'));
  const namespaces = Array.isArray(description.namespaces) ? description.namespaces.map(record) : [];

  return plan.accepted.some((entry) =>
    namespaces.find((item) => item.ns === entry.path[0])?.applies === 'restart');
}

const OWNERSHIP: NativeSettingsOwnership[] = [
  {
    path: ['llm-pi-ai'],
    owner: 'Маршруты моделей Кокпита',
    reason: 'Подключение и параметры llm-pi-ai задаёт профиль запуска Кокпита',
  },
  ...['llm-deepseek', 'llm-pi-ai'].flatMap((namespace) =>
    ['reasoningEffort', 'thinking'].map((key) => ({
      path: [namespace, key],
      owner: 'Модель и effort',
      reason: 'Управляется выбором модели и effort чата',
    })),
  ),
  ...['llm-deepseek', 'llm-pi-ai', 'web-search-deepseek'].flatMap((namespace) =>
    ['apiKey', 'apiKeyEnv'].map((key) => ({
      path: [namespace, key],
      owner: 'Авторизация исполнителя',
      reason: 'Credentials управляются отдельным источником авторизации',
    })),
  ),
  ...['credentials', 'credentials-local', 'mcp', 'mcp-client'].map((namespace) => ({
    path: [namespace],
    owner: 'Авторизация и MCP',
    reason: 'Credentials и MCP задаёт собственный редактор',
  })),
  ...['permission-presets', 'fs-sandbox'].map((namespace) => ({
    path: [namespace],
    owner: 'Права запуска',
    reason: 'Sandbox и permissions задаёт Cockpit',
  })),
  {
    path: ['web-search-deepseek', 'model'],
    owner: 'Модель и effort',
    reason: 'Модель задаёт собственный редактор',
  },
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
