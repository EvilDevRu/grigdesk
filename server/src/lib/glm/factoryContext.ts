import { FACTORY_STATUS_ENV_NAMES } from '../factoryProviderRunner.ts';
import { factoryBrowserPublicEnabled } from '../browser/factoryBrowserCapability.ts';

import path from 'node:path';

import { glmAccessError } from './env.ts';
import { GLM_FACTORY_STATUS_SERVER, glmFactoryPolicy } from './factoryPolicy.ts';
import type { GlmFactoryFilesystem } from './factoryPolicy.ts';
import type { GlmMcpServer } from './mcp.ts';

export interface GlmFactoryTurnContext {
  task: string;
  stage: string;
  runId: string;
  epoch: string;
  filesystem: GlmFactoryFilesystem;
  stateDir?: string;
  browser?: true;
  statusServer: GlmMcpServer;
}

// Identity попытки в env статусного MCP обязана совпасть с контекстом хода.
const STATUS_IDENTITY = Object.freeze([
  ['FACTORY_RUN_TASK', 'task'],
  ['FACTORY_RUN_STAGE', 'stage'],
  ['FACTORY_RUN_ID', 'runId'],
  ['FACTORY_RUN_EPOCH', 'epoch'],
] as const);

function invalidContext(): Error & { code: string } {
  return glmAccessError('glm_factory_context_invalid', 'Контекст этапа GLM от хоста повреждён.');
}

function cleanText(value: unknown): value is string {
  return typeof value === 'string' && !value.includes('\0');
}

/**
 * Статусный сервер этапа принимается только целиком: точное имя, абсолютная команда,
 * строковые аргументы и env без повторов. Чужой сервер не превращается в разрешённый.
 */
function statusServer(value: unknown): GlmMcpServer {
  const server = value as Partial<GlmMcpServer> | null;

  if (!server || typeof server !== 'object' || server.name !== GLM_FACTORY_STATUS_SERVER
    || !cleanText(server.command) || !path.isAbsolute(server.command)
    || !Array.isArray(server.args) || !server.args.every(cleanText)
    || !Array.isArray(server.env) || server.env.some((entry) => !entry || !cleanText(entry.name)
      || !cleanText(entry.value))) {
    throw invalidContext();
  }

  if (new Set(server.env.map((entry) => entry.name)).size !== server.env.length) {
    throw invalidContext();
  }

  if (server.env.some((entry) => !FACTORY_STATUS_ENV_NAMES.includes(entry.name))) {
    throw invalidContext();
  }

  return {
    name: server.name,
    command: server.command,
    args: [...server.args],
    env: server.env.map((entry) => ({ name: entry.name, value: entry.value })),
  };
}

/**
 * Контекст отвязанного этапа выдаёт host-wrapper: identity попытки, файловый режим узла
 * и единственный статусный MCP. Любое расхождение — отказ до процесса и prompt.
 */
export function assertGlmFactoryContext(value: unknown): GlmFactoryTurnContext {
  const context = value as Partial<GlmFactoryTurnContext> | null;

  if (!context || typeof context !== 'object' || !/^[0-9]+$/u.test(String(context.task ?? ''))
    || !/^[A-Z][A-Z0-9_]*$/u.test(String(context.stage ?? ''))
    || !/^[A-Za-z0-9._-]+$/u.test(String(context.runId ?? ''))
    || !/^[1-9][0-9]*$/u.test(String(context.epoch ?? ''))) {
    throw invalidContext();
  }

  glmFactoryPolicy(String(context.filesystem));

  if (context.filesystem === 'state-only'
    && (!cleanText(context.stateDir) || !path.isAbsolute(context.stateDir))) {
    throw invalidContext();
  }

  const server = statusServer(context.statusServer);
  const env = new Map(server.env.map((entry) => [entry.name, entry.value]));

  if (STATUS_IDENTITY.some(([name, key]) => env.get(name) !== context[key])
    || env.get('FACTORY_STATUS_MODE') !== 'request'
    || !path.isAbsolute(env.get('FACTORY_STATUS_REQUEST_DIR') ?? '')) {
    throw invalidContext();
  }

  const browser = factoryBrowserPublicEnabled(Object.fromEntries(env));

  if (context.browser !== undefined && context.browser !== (browser ? true : undefined)) {
    throw invalidContext();
  }

  return {
    task: context.task!,
    stage: context.stage!,
    runId: context.runId!,
    epoch: context.epoch!,
    filesystem: context.filesystem!,
    ...(context.filesystem === 'state-only' ? { stateDir: context.stateDir! } : {}),
    ...(browser ? { browser: true as const } : {}),
    statusServer: server,
  };
}
