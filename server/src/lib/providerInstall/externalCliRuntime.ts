import os from 'node:os';
import path from 'node:path';

import { isRecord } from '../../../../shared/lib/objects.ts';
import { artifactsPath, dataHome } from '../../../../shared/runtime/dataHome.ts';
import type { ExecutorAdapter } from '../executors/index.ts';
import { discoverExternalCli } from './inventory.ts';
import { executableIdentity } from './executableIdentity.ts';
import { resolveUserCliEnvironment } from './userCliEnvironment.ts';
import { InstallEnvironmentError } from './npmEnvironment.ts';
import type { ExternalCliProcessContext } from './externalCliProcess.ts';

export interface ExternalCliRuntime {
  config: Record<string, unknown>;
  process: ExternalCliProcessContext;
}

/**
 * Единый выбор внешнего CLI следует новому пользовательскому shell, сохраняя явный absolute-bin.
 * Окружение, приватная identity и корень leases остаются внутренними данными сервера.
 */
export async function prepareExternalCliRuntime(adapter: ExecutorAdapter, config: unknown,
  parent: NodeJS.ProcessEnv = process.env): Promise<ExternalCliRuntime | null> {
  const home = parent.HOME || os.homedir();
  const definition = adapter.externalCli?.(config, home);

  if (!definition) {
    return null;
  }

  const values = isRecord(config) ? config : {};
  const input = { env: parent, home };
  const artifacts = typeof values.artifactsDir === 'string' ? values.artifactsDir : artifactsPath(input);
  const data = typeof values.dataHome === 'string' ? values.dataHome : dataHome(input);
  const shell = await resolveUserCliEnvironment({
    env: parent,
    cliName: definition.binName,
    scratch: path.join(artifacts, 'provider-install-probes'),
  });
  const inventory = await discoverExternalCli({
    providerId: adapter.id,
    definition,
    configuredBin: String(adapter.bin(config)),
    env: shell.env,
    home,
  });
  const selected = inventory.installations.find((item) => item.installationId === inventory.selectedId);

  if (!selected?.realpath || ['missing', 'broken'].includes(selected.state)) {
    throw new InstallEnvironmentError('cli_missing', 'Выбранная программа исполнителя отсутствует');
  }

  return {
    config: { ...values, [definition.configKey]: selected.path },
    process: {
      providerId: adapter.id,
      executable: selected.path,
      executableIdentity: await executableIdentity(selected.path),
      resourceKey: selected.resourceKey,
      leaseDirectory: path.join(data, 'provider-cli-leases'),
      env: shell.env,
    },
  };
}
