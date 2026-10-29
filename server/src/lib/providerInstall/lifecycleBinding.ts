import { isRecord } from '../../../../shared/lib/objects.ts';
import { readEnvFile, updateEnvFile } from '../envFile.ts';
import { InstallEnvironmentError } from './npmEnvironment.ts';

export interface RemovedCliBinding {
  configKey: string;
  envKey: string;
  binName: string;
  value: string;
}

/**
 * Снимается только привязка к отсутствующей копии; новый выбор человека остаётся нетронутым.
 * Файл меняется с проверкой прежнего значения, затем обновляются config и окружение процесса.
 */
export async function clearRemovedCliBinding(binding: RemovedCliBinding | null | undefined,
  config: unknown, env: NodeJS.ProcessEnv): Promise<void> {
  if (!binding || !isRecord(config) || config[binding.configKey] !== binding.value) {
    return;
  }

  try {
    if (typeof config.envPath !== 'string' || !config.envPath) {
      throw new Error('Не задан файл настроек исполнителя');
    }

    const values = await readEnvFile(config.envPath);
    const stored = values[binding.envKey] ?? null;

    if (stored !== null && stored !== binding.value) {
      throw new Error('Привязка изменилась');
    }

    await updateEnvFile(config.envPath, { [binding.envKey]: null }, {
      expected: { [binding.envKey]: stored },
    });
  } catch {
    throw new InstallEnvironmentError('npm_binding_failed',
      'Не удалось снять привязку к отсутствующему пути программы');
  }

  if (config[binding.configKey] === binding.value) {
    config[binding.configKey] = binding.binName;
  }
  if (config[binding.envKey] === binding.value) {
    delete config[binding.envKey];
  }
  if (env[binding.envKey] === binding.value) {
    delete env[binding.envKey];
  }
}
