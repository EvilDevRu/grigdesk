import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { ExecutorAdapter } from '../executors/index.ts';
import { helperCommand } from '../runtimePaths.ts';
import { writeDurableFile } from '../durableFile.ts';
import { executableIdentity } from './executableIdentity.ts';
import { discoverExternalCli } from './inventory.ts';
import { resolveUserCliEnvironment } from './userCliEnvironment.ts';

/**
 * Закрытый канал стадии: точная копия, её identity, PATH и только безопасные
 * пользовательские переменные. Полный env и ключи остаются в серверном процессе.
 */
const PASS_THROUGH = [
  'PATH',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'ssl_cert_file',
  'ssl_cert_dir',
  'NODE_EXTRA_CA_CERTS',
  'npm_config_userconfig',
  'NPM_CONFIG_USERCONFIG',
  'npm_config_registry',
  'NPM_CONFIG_REGISTRY',
  'npm_config_proxy',
  'npm_config_https_proxy',
  'npm_config_cafile',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
];

export interface FactoryExternalCliProvider {
  bin: string;
  identity: string;
  providerId: string;
  resourceKey: string;
  leaseDirectory: string;
  leaseCommand: string[];
  env: Record<string, string>;
}

export interface FactoryExternalCliDescriptor {
  schemaVersion: 1;
  providers: Record<string, FactoryExternalCliProvider>;
  unavailable: Record<string, string>;
}

/**
 * Внешний запуск стадии не должен угадывать копию по PATH оркестратора.
 * Descriptor описывает выбранную копию и не содержит ключей, токенов или полного env.
 */
export async function buildFactoryExternalCliDescriptor(input: {
  adapters: Map<string, ExecutorAdapter>;
  config: unknown;
  env: NodeJS.ProcessEnv;
  home: string;
  scratch: string;
  leaseDirectory: string;
  descriptorPath: string;
}): Promise<FactoryExternalCliDescriptor> {
  const providers: Record<string, FactoryExternalCliProvider> = {};
  const unavailable: Record<string, string> = {};
  const lease = helperCommand('external-cli-lease', []);

  for (const adapter of input.adapters.values()) {
    const definition = adapter.externalCli?.(input.config, input.home);

    if (!definition || adapter.distribution?.(input.config)?.managed) {
      continue;
    }

    try {
      const shell = await resolveUserCliEnvironment({
        env: input.env,
        cliName: definition.binName,
        scratch: input.scratch,
      });
      const inventory = await discoverExternalCli({
        providerId: adapter.id,
        definition,
        configuredBin: String(adapter.bin(input.config) ?? ''),
        env: shell.env,
        home: input.home,
      });
      const selected = inventory.installations.find((entry) =>
        entry.installationId === (inventory.selectedId ?? inventory.terminalId));

      if (!selected?.realpath || selected.state !== 'ready') {
        unavailable[adapter.id] = selected?.state === 'broken' ? 'cli_broken' : 'cli_missing';

        continue;
      }

      const env: Record<string, string> = {};

      for (const key of PASS_THROUGH) {
        const value = shell.env[key];

        if (typeof value === 'string' && value && !value.includes('\0')) {
          env[key] = value;
        }
      }

      providers[adapter.id] = {
        bin: selected.realpath,
        // Хелпер лизы сверяет это поле со СВОЕЙ формулой executableIdentity(bin)
        // (realpath+dev+ino+size+mtime+ctime) — той же, что и штатный запуск executor-а
        // (externalCliRuntime). installationId сюда не подходит: это композитный digest
        // resourceKey+stat+манифеста, он не совпадает никогда — 29.10.2026 такая запись
        // закрывала ВСЕМ провайдерам пробы префлайта «Выбранная программа изменилась»
        // и блокировала любой запуск конвейера после обновления 31957c4a.
        identity: await executableIdentity(selected.realpath),
        providerId: adapter.id,
        resourceKey: selected.resourceKey,
        leaseDirectory: input.leaseDirectory,
        leaseCommand: [lease.command, ...lease.args],
        env,
      };
    } catch (error) {
      unavailable[adapter.id] = error instanceof Error && 'code' in error
        ? String(error.code) : 'environment_unavailable';
    }
  }

  const descriptor: FactoryExternalCliDescriptor = {
    schemaVersion: 1,
    providers,
    unavailable,
  };

  await fs.mkdir(path.dirname(input.descriptorPath), { recursive: true, mode: 0o700 });
  await writeDurableFile(input.descriptorPath, JSON.stringify(descriptor));

  return descriptor;
}

/**
 * Путь descriptor-а принадлежит папке данных и передаётся стадии явно.
 * Повреждённый или недоступный файл не отменяет маршрут: раннер падает на своём probe.
 */
export function factoryExternalCliDescriptorPath(dataHome: string): string {
  return path.join(dataHome, 'state', 'external-cli-factory.json');
}
