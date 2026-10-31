import { randomBytes, createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { isRecord } from '../../../../shared/lib/objects.ts';
import type { ProviderLifecycleOperation, ProviderLifecyclePreparation }
  from '../../../../shared/chat/providerLifecycleContracts.ts';
import type { ExecutorAdapter } from '../executors/index.ts';
import { runCommand, type PluginCommandRunner } from '../packageInstall/runCommand.ts';
import { InstallEnvironmentError, type InstallRoots } from './npmEnvironment.ts';
import {
  resolveUserCliNpm, resolveUserCliEnvironment, type UserCliEnvironment,
} from './userCliEnvironment.ts';
import { discoverExternalCli } from './inventory.ts';
import { prepareNpmStrategy, type PreparedNpmStrategy } from './npmStrategy.ts';
import { prepareNativeStrategy, type PreparedNativeStrategy } from './nativeStrategy.ts';
import type { RemovedCliBinding } from './lifecycleBinding.ts';
import { readEnvFile } from '../envFile.ts';
import { treeSnapshot } from './treeSnapshot.ts';

export interface LifecycleRecord {
  preview: ProviderLifecyclePreparation;
  scope: string;
  prepared: PreparedNpmStrategy | PreparedNativeStrategy;
  environmentHash: string;
  consumed: boolean;
  removedBinding: RemovedCliBinding | null;
  configuredBin: string;
  bindingSnapshot: string | null;
  bindingPath: string | null;
}

/**
 * Export среды влияет на registry и proxy, но его значения никогда не выходят в DTO.
 * SHLVL и служебный underscore меняются между одинаковыми shell и не означают смену установки.
 */
export function lifecycleEnvironmentHash(shell: UserCliEnvironment): string {
  return createHash('sha256').update(JSON.stringify(Object.entries(shell.env)
    .filter(([key]) => !['_', 'SHLVL', 'OLDPWD'].includes(key)).sort(([a], [b]) => a.localeCompare(b))))
    .digest('hex');
}

/**
 * Подготовка выбирает стратегию по доказанному происхождению копии до получения token.
 * Официальный installer готовой программы не зависит от наличия npm на машине.
 */
export async function prepareLifecycleContext(input: {
  adapter: ExecutorAdapter;
  config: unknown;
  env: NodeJS.ProcessEnv;
  home: string;
  roots: InstallRoots;
  scratch: string;
  operation: Exclude<ProviderLifecycleOperation, 'migrate'>;
  scope: string;
  installationId?: string;
  latest?: string;
  ttl: number;
  run?: PluginCommandRunner;
}): Promise<LifecycleRecord> {
  const { adapter, operation } = input;
  const definition = structuredClone(adapter.externalCli?.(input.config, input.home) ?? null);

  if (!definition || adapter.distribution?.(input.config)?.managed) {
    throw new InstallEnvironmentError('unsupported_action',
      'Эта поставка не обслуживается через внешний CLI');
  }

  const shell = await resolveUserCliEnvironment({
    env: input.env,
    cliName: definition.binName,
    scratch: input.scratch,
  });
  const configuredBin = String(adapter.bin(input.config));
  const inventory = await discoverExternalCli({
    providerId: adapter.id,
    definition,
    configuredBin,
    env: shell.env,
    home: input.home,
  });
  const selectedId = input.installationId ?? inventory.selectedId;
  let selected = inventory.installations.find((entry) => entry.installationId === selectedId) ?? null;
  const missingCandidate = operation === 'install' && !input.installationId
    && selected?.state === 'missing' && path.isAbsolute(configuredBin);
  const missingSnapshot = missingCandidate ? await treeSnapshot(configuredBin) : null;
  const missingBinding = missingCandidate
    && !await fs.lstat(configuredBin).then(() => true, (error) => {
      if (error.code !== 'ENOENT') {
        throw error;
      }

      return false;
    });
  const removedBinding = (operation === 'uninstall' && selected?.aliases.includes(configuredBin))
    || missingBinding
    ? {
      configKey: definition.configKey,
      envKey: definition.envKey,
      binName: definition.binName,
      value: configuredBin,
    } : null;

  if (input.installationId && !selected) {
    throw new InstallEnvironmentError('preparation_changed', 'Выбранная копия больше не найдена');
  }

  // Удалённый абсолютный путь не является конкурирующей установкой.
  // Оставшаяся npm-копия терминала обслуживается на месте с обычным preview.
  if (missingBinding) {
    selected = inventory.installations.find((entry) => entry.installationId === inventory.terminalId) ?? null;
  }
  if (operation !== 'uninstall' && inventory.conflict && !missingBinding) {
    throw new InstallEnvironmentError('cli_selection_conflict',
      'GrigDesk и новый терминал выбирают разные существующие копии');
  }

  const installer = structuredClone(adapter.installation?.(input.config)?.install ?? null);
  const native = selected?.source === 'native';

  if (native && selected && (path.isAbsolute(configuredBin) && !selected.aliases.includes(configuredBin)
    || input.installationId && selected.installationId !== inventory.selectedId)) {
    throw new InstallEnvironmentError('cli_selection_conflict',
      'Выбранная копия не совпадает с текущей привязкой GrigDesk');
  }

  if (native && isRecord(input.config) && typeof input.config.envPath === 'string') {
    const stored = (await readEnvFile(input.config.envPath))[definition.envKey];
    const binding = input.env[definition.envKey];

    if ([stored, binding].some((value) => value && value !== configuredBin)) {
      throw new InstallEnvironmentError('cli_selection_conflict',
        'Сохранена другая ручная привязка программы');
    }
  }

  const resolved = native ? null : await resolveUserCliNpm({
    shell,
    env: input.env,
    cliName: definition.binName,
    packageId: definition.packageId,
    scratch: input.scratch,
    roots: input.roots,
  });

  let version: string | null = operation === 'reinstall' || operation === 'uninstall'
    ? selected?.version ?? null : input.latest ?? null;

  if (native && operation !== 'uninstall') {
    version = input.latest ?? null;
  }
  if (!version && resolved && (operation === 'install' || operation === 'update')) {
    const result = await (input.run ?? runCommand)(resolved.runtime.node,
      [resolved.runtime.npm, 'view', definition.packageId, 'version', '--json'], {
        cwd: input.home,
        env: resolved.runtime.env,
        timeoutMs: 30_000,
      });

    if (result.code === 0) {
      version = JSON.parse(result.stdout);
    }
  }

  if (native && !installer) {
    throw new InstallEnvironmentError('unsupported_action', 'Установщик программы не объявлен');
  }

  const prepared = native && installer ? await prepareNativeStrategy({
    operation,
    definition,
    selected: selected!,
    installer,
    home: input.home,
    env: shell.env,
    scratch: input.scratch,
    version,
    run: input.run,
  }) : await prepareNpmStrategy({
    providerId: adapter.id,
    operation: missingBinding && selected?.source === 'npm' ? 'update' : operation,
    definition,
    selected,
    runtime: resolved!.runtime,
    loginPath: resolved!.shell.loginEnv.PATH,
    prefix: resolved!.prefix,
    version,
    scratch: input.scratch,
    run: input.run,
  });

  if (native) {
    const refreshed = await discoverExternalCli({
      providerId: adapter.id,
      definition,
      configuredBin,
      env: shell.env,
      home: input.home,
    });

    if (!refreshed.installations.some((entry) => entry.installationId === selectedId)) {
      await fs.rm(prepared.directory, { recursive: true, force: true });

      throw new InstallEnvironmentError('preparation_changed', 'Копия изменилась во время подготовки');
    }
  }

  if (missingBinding && missingSnapshot) {
    prepared.snapshots[configuredBin] = missingSnapshot;
  }

  const token = randomBytes(24).toString('base64url');
  const prefix = native ? null : selected?.prefix ?? resolved!.prefix;
  const command = native ? operation === 'uninstall'
    ? `remove ${JSON.stringify(prepared.packageRoot)} ${JSON.stringify(prepared.alias)}`
    : installer!.command : operation === 'uninstall'
    ? `npm uninstall --global --prefix ${JSON.stringify(prefix)} ${definition.packageId}`
    : `npm install --global --prefix ${JSON.stringify(prefix)} ${definition.packageId}@${version}`;
  const preview: ProviderLifecyclePreparation = {
    schemaVersion: 2,
    token,
    expiresAt: Date.now() + input.ttl,
    providerId: adapter.id,
    affectedProviderIds: [adapter.id],
    operation,
    installationId: selected?.installationId ?? null,
    method: prepared.method,
    fromVersion: prepared.selectedVersion,
    targetVersion: operation === 'uninstall' ? null : version,
    command,
    prefix,
    footprint: [prepared.packageRoot, prepared.alias].map((file) => ({
      path: file,
      action: operation === 'uninstall' ? 'remove' : selected ? 'replace' : 'install',
      reason: definition.packageId,
    })),
    shellChanges: [],
    warnings: [],
  };

  if (selected) {
    preview.footprint.push({
      path: prepared.backup,
      action: 'install',
      reason: 'backup',
    });
  }
  if (removedBinding && isRecord(input.config) && typeof input.config.envPath === 'string') {
    preview.footprint.push({
      path: input.config.envPath,
      action: 'replace',
      reason: definition.envKey,
    });
  }

  return {
    preview,
    scope: input.scope,
    prepared,
    environmentHash: lifecycleEnvironmentHash(shell),
    consumed: false,
    removedBinding,
    configuredBin,
    bindingSnapshot: native && isRecord(input.config) && typeof input.config.envPath === 'string'
      ? await treeSnapshot(input.config.envPath) : null,
    bindingPath: isRecord(input.config) && typeof input.config.envPath === 'string'
      ? input.config.envPath : null,
  };
}
