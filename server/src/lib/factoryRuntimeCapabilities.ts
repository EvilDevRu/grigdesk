import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { dataPath } from '../../../shared/runtime/dataHome.ts';
import type { ArbiterCapabilities, StopIdentity } from '../../../shared/pipeline/arbiterConversation.ts';
import { config as runtimeConfig } from '../config.ts';
import { selectedFactoryRuntimeConfig } from './factoryLaunch.ts';
import { readExistingFactoryRuntimePin } from './factoryRuntimePins.ts';
import type { FactoryRuntimeSelection } from './factoryRuntimePins.ts';
import { routeLaunchEnv } from './factoryRouteCli.ts';
import type { RouteConfig } from './factoryRouteCli.ts';

const execute = promisify(execFile);
const supportedPackages = new Set<string>();
const unsupportedMessage = 'Эта попытка запущена старой версией движка; защищённое применение здесь '
  + 'недоступно. Доступны чтение и разбор; обновлённый движок используется в новой попытке.';
const unknownMessage = 'Не удалось проверить поддержку применения; проверку можно повторить.';

interface ProbeDeps {
  readPin?: (input: Parameters<typeof readExistingFactoryRuntimePin>[0])
    => Promise<FactoryRuntimeSelection | null>;
  exec?: (command: string, args: string[], options: {
    env: NodeJS.ProcessEnv;
    timeout: number;
    maxBuffer: number;
    encoding: 'utf8';
  }) => Promise<{ stdout: string; stderr?: string }>;
}

/**
 * Запускает engine A из уже существующего pin, даже если процесс сервера принадлежит B.
 * Только положительный ответ immutable package кэшируется; source и отказы проверяются снова.
 */
export async function probeFactoryGotoCapability(
  config: RouteConfig,
  identity: Pick<StopIdentity, 'task' | 'attempt' | 'profile'>,
  deps: ProbeDeps = {},
): Promise<Omit<ArbiterCapabilities, 'targets'>> {
  return probeFactoryCapability(config, identity, 'goto-expected-stage-v1', deps);
}

/**
 * Поддержка редактора проверяется отдельно от goto именно в закреплённом движке.
 * Отрицательный результат не кэшируется и допускает явный повтор discovery.
 */
export async function probeFactoryStageRunnerSettingsCapability(
  config: RouteConfig,
  identity: Pick<StopIdentity, 'task' | 'attempt' | 'profile'>,
  deps: ProbeDeps = {},
): Promise<Omit<ArbiterCapabilities, 'targets'>> {
  return probeFactoryCapability(config, identity, 'stage-runner-settings-v1', deps);
}

/**
 * Общий probe сохраняет authority pin и разделяет положительный кэш по capability.
 * Исходная поставка и ошибки перечитываются без подмены текущей версией сервера.
 */
async function probeFactoryCapability(
  config: RouteConfig,
  identity: Pick<StopIdentity, 'task' | 'attempt' | 'profile'>,
  feature: string,
  deps: ProbeDeps,
): Promise<Omit<ArbiterCapabilities, 'targets'>> {
  let selected;

  try {
    selected = await (deps.readPin || readExistingFactoryRuntimePin)({
      controlRoot: config.factoryControlDir,
      stateRoot: config.stateDir,
      profileRoot: config.profilesDir,
      cacheDir: config.runtime?.cacheDir
        ?? dataPath(
          config.dataHome
          ?? runtimeConfig.dataHome,
          'serverRuntime'
        ),
      ...identity,
    });
  } catch {
    return { status: 'unknown', message: unknownMessage };
  }

  if (!selected) {
    return {
      status: 'unavailable', message: 'У этой попытки нет подтверждённого закрепления движка. '
        + 'Доступны чтение и разбор; защищённое применение пока недоступно.'
    };
  }

  const cacheKey = `${feature}:${selected.packageId}`;

  if (selected.packageId && supportedPackages.has(cacheKey)) {
    return { status: 'supported', message: '' };
  }

  try {
    const prepared = selectedFactoryRuntimeConfig(config, selected);
    const response = await (deps.exec || execute)(selected.engineBin, ['capabilities', '--format', 'json'], {
      env: { ...process.env, ...routeLaunchEnv(prepared) },
      timeout: 5000,
      maxBuffer: 64 * 1024,
      encoding: 'utf8',
    });
    const value = JSON.parse(response.stdout);

    if (value?.schema !== 1 || !Array.isArray(value.features)
      || value.features.some((feature: unknown) => typeof feature !== 'string')
      || Object.keys(value).some((key) => !['schema', 'features'].includes(key))) {
      return { status: 'unknown', message: unknownMessage };
    }

    if (!value.features.includes(feature)) {
      return { status: 'unsupported', message: unsupportedMessage };
    }

    if (selected.packageId) {
      supportedPackages.add(cacheKey);
    }

    return { status: 'supported', message: '' };
  } catch (error) {
    const failure = error as { killed?: boolean; stderr?: string };
    const unknownEnglish = /unknown (?:command|argument)[^\n]*capabilities/i;
    const unknownRussian = /неизвестн[^\n]*(?:команд|аргумент)[^\n]*capabilities/i;
    const unknownCommand = [unknownEnglish, unknownRussian]
      .some((pattern) => pattern.test(String(failure.stderr || '')));

    return failure.killed || !unknownCommand
      ? { status: 'unknown', message: unknownMessage }
      : { status: 'unsupported', message: unsupportedMessage };
  }
}
