import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { glmGateHash } from '../../../../shared/node/glmGateProtocol.ts';
import type { NativeGateIdentity } from './nativeGuard.ts';

import { DEEPSEEK_PIN } from '../deepseek/contract.ts';
import { buildLaunchFiles } from '../deepseek/profile.ts';
import type { DeepSeekLaunchFiles, YamlValue } from '../deepseek/profile.ts';
import { GLM_FACTORY_PROFILE_REVISION, GLM_PROFILE_REVISION, buildGlmRoute } from './contract.ts';
import type { GlmAccessMode } from './contract.ts';
import { glmFactoryPolicy, glmFactoryToolPolicy } from './factoryPolicy.ts';
import type { GlmFactoryFilesystem } from './factoryPolicy.ts';
import { helperCommand, runtimeKind } from '../runtimePaths.ts';
import { shellQuote as quoteShellArgument } from '../../../../shared/lib/shellQuote.ts';

export interface GlmLaunchFilesOptions {
  launchDir: string;
  cwd: string;
  workspaceRoot: string;
  projectRoot: string;
  accessMode: GlmAccessMode;
  model: string;
  transport: 'web' | 'acp';
  settingsDocument: string;
  hooks: {
    ssh: boolean;
    db: boolean;
    strictDb: boolean;
  };
  // Сырые имена инструментов grigdesk-work этого запуска: hook пропускает только их.
  workTools?: readonly string[];
  mcpServers?: readonly {
    name: string;
    command: string;
    args: readonly string[];
    env: readonly { name: string; value: string }[];
  }[];
  // Только тестовая подмена (DI): адрес фейковой модели и плагин запрета внешнего fetch.
  modelEndpoint?: string;
  egressGuard?: string;
  // Отвязанный этап фабрики: без него профиль чата остаётся прежним байт в байт.
  factory?: GlmFactoryProfileContext;
}

export interface GlmFactoryProfileContext {
  filesystem: GlmFactoryFilesystem;
}

export const GLM_POLICY_HOOK_PATH = fileURLToPath(
  new URL('../../../scripts/glmToolPolicyHook.mts', import.meta.url),
);

// Предел stderr hook в событии hook/result: дескриптор вызова должен влезать целиком.
const HOOK_STDERR_LIMIT = 4000;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/**
 * Отпечаток запуска GLM: версия DSH, ревизия профиля, overlay и hooks.
 * Смена ревизии профиля даёт новый отпечаток даже при тех же файлах.
 */
export function glmLaunchFingerprint({
  revision,
  overlay,
  hooks,
}: {
  revision: string;
  overlay: string;
  hooks: string;
}): string {
  return createHash('sha256')
    .update(`${DEEPSEEK_PIN.version}\0${revision}`)
    .update('\0')
    .update(overlay)
    .update('\0')
    .update(hooks)
    .digest('hex');
}

/**
 * Overlay и hooks процесса GLM поверх штатного профиля DSH (Р5): DeepSeek-провайдер и
 * заголовки выключены, модель по умолчанию — zai, маршрут llm-pi-ai вставлен overlay.
 * Web chat использует native gate; Factory и ACP сохраняют свой hook-контракт.
 */
export async function buildGlmLaunchFiles(
  options: GlmLaunchFilesOptions,
): Promise<DeepSeekLaunchFiles & { nativeGate?: NativeGateIdentity }> {
  // Режим и approval этапа выбирает только проверенная функция политики, до записи файлов.
  const factory = options.factory ? glmFactoryPolicy(options.factory.filesystem) : null;
  const nativeGate = !factory && options.transport === 'web';
  const launchId = randomUUID();
  const route = {
    ...buildGlmRoute(options.accessMode),
    ...(options.modelEndpoint ? { baseURL: options.modelEndpoint } : {}),
  } as { [key: string]: YamlValue };
  const defaultModel = { provider: 'zai', model: options.model };
  const policyFile = path.join(path.resolve(options.launchDir), 'glm-policy.json');
  const policyHelper = helperCommand('glm-tool-policy-hook', ['--policy', policyFile]);
  // Source-сериализация сохраняет обычный chat profile и его fingerprint байт в байт.
  // В payload команда берётся из каталога, пути и аргументы экранируются общим serializer.
  const policyCommand = runtimeKind() === 'packaged'
    ? [policyHelper.command, ...policyHelper.args].map(quoteShellArgument).join(' ') : [
      shellQuote(process.execPath),
      shellQuote(GLM_POLICY_HOOK_PATH),
      '--policy',
      shellQuote(policyFile),
    ].join(' ');
  const files = await buildLaunchFiles({
    launchDir: options.launchDir,
    cwd: options.cwd,
    workspaceRoot: options.workspaceRoot,
    mode: factory?.mode ?? 'workspace-write',
    approval: factory?.approval ?? 'ask',
    transport: options.transport,
    mcpServers: options.mcpServers,
    nativeSettingsDocument: options.settingsDocument,
    hooks: {
      bashToolName: 'bash',
      ssh: options.hooks.ssh,
      db: options.hooks.db,
      strictDb: options.hooks.strictDb,
      instructions: { projectRoot: options.projectRoot },
    },
  }, {
    pin: `${DEEPSEEK_PIN.version}\0${factory ? GLM_FACTORY_PROFILE_REVISION : GLM_PROFILE_REVISION}`,
    rows: [
      ...(nativeGate ? [{
        id: 'agent-presets', config: {
          default: 'grigdesk-glm', includeUserRoot: false,
        }
      }] : []),
      { id: 'llm-deepseek', disabled: true },
      { id: 'session-title-llm', disabled: true },
      options.transport === 'web'
        ? { id: 'agent-default-model', config: defaultModel }
        : { id: 'acp', config: defaultModel },
    ],
    insert: [
      ...(nativeGate ? [{
        id: 'grigdesk-glm-gate',
        name: 'grigdesk:glm-gate',
        config: {
          command: `${policyCommand} --native-gate`,
          policyFile,
          launchId
        },
      }] : []),
      {
        id: 'llm-pi-ai',
        name: '@deepseek-ai/dsh-llm-pi-ai',
        config: { providers: { zai: route } },
      },
      ...(options.egressGuard
        ? [{ id: 'grigdesk-glm-egress-guard', name: pathToFileURL(options.egressGuard).href }]
        : []),
    ],
    preToolUse: {
      matcher: '*',
      command: policyCommand,
      timeout: 30,
    },
    // Тот же hook на каждый prompt пишет маркер hooks-alive: регистрация проверяется ходом.
    userPromptSubmit: [{ command: policyCommand, timeout: 30 }],
    hooksConfig: { stderrSummaryMaxChars: HOOK_STDERR_LIMIT },
    // Готовность grigdesk-work обязательна до prompt, а потеря после неё останавливает ход:
    // без автоматического перезапуска сервера потерю видно как ошибку вызова.
    mcpConfig: {
      failOnStartupError: true,
      reconnect: { enabled: false },
    },
  });

  // Hook различает потребителя по форме документа: у чата прежний JSON без consumer.
  const policy = options.factory
    ? glmFactoryToolPolicy(options.factory.filesystem, options.workspaceRoot) : {
    workTools: [...options.workTools ?? []],
    ssh: options.hooks.ssh,
    db: options.hooks.db,
    strictDb: options.hooks.strictDb,
    ...(nativeGate ? { delegation: 'foreground-v1' } : {}),
  };

  await fs.writeFile(policyFile, `${JSON.stringify(policy)}\n`, { mode: 0o600 });
  await fs.chmod(policyFile, 0o600);

  if (nativeGate) {
    const hooks = JSON.parse(await fs.readFile(files.hooksPath, 'utf8'));

    delete hooks.hooks.PreToolUse;
    hooks.hooks.UserPromptSubmit[0].hooks = hooks.hooks.UserPromptSubmit[0].hooks.slice(0, 1);
    await fs.writeFile(files.hooksPath, `${JSON.stringify(hooks, null, 2)}\n`, { mode: 0o600 });

    const overlay = await fs.readFile(files.overlayPath, 'utf8');

    files.fingerprint = glmLaunchFingerprint({
      revision: GLM_PROFILE_REVISION,
      overlay,
      hooks: JSON.stringify(hooks, null, 2) + '\n',
    });
  }

  return { ...files, ...(nativeGate ? { nativeGate: { launchId, policyHash: glmGateHash(policy) } } : {}) };
}
