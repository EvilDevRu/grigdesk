import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DIRECT_SSH_HOOK_PATH } from '../executors/_directSshPolicy.ts';
import {
  DEEPSEEK_BASH_COMMAND_FIELD,
  DEEPSEEK_BASH_TOOL,
  DEEPSEEK_PIN,
} from './contract.ts';

export interface DeepSeekLaunchFilesOptions {
  launchDir: string;
  cwd: string;
  workspaceRoot: string;
  mode: 'read-only' | 'workspace-write';
  approval: 'ask' | 'never';
  hooks: {
    bashToolName: string;
    ssh: boolean;
    db: boolean;
    strictDb: boolean;
    instructions: { projectRoot: string };
  };
}

export interface DeepSeekLaunchFiles {
  launchDir: string;
  overlayPath: string;
  hooksPath: string;
  fingerprint: string;
  version: string;
}

type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };

const DISABLED_ROWS = Object.freeze([
  'subagent',
  'subagent-spawn-in-process',
  'subagent-fork-in-process',
  'tool-subagent-control',
  'tool-subagent-list-agents',
  'tool-subagent',
  'tool-subagent-fork',
  'workflow-worker-thread',
  'tool-workflow',
  'tool-ralph',
  'tool-jobs',
  'web',
  'web-search-deepseek',
  'web-fetch-http',
  'tool-web',
]);

// Входит в persisted cache/session fingerprint. Менять при любом смысловом изменении
// overlay, hooks или их enforcement, даже если версия DSH осталась прежней.
export const DEEPSEEK_PROFILE_REVISION = 'deepseek-host-sandbox-v3';

const INSTRUCTIONS_HOOK_PATH = fileURLToPath(
  new URL('../../../scripts/deepseekInstructionsHook.mts', import.meta.url),
);

function yamlScalar(value: string | number | boolean | null): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === null) return 'null';
  return String(value);
}

function yamlLines(value: YamlValue, indent = 0): string[] {
  const prefix = ' '.repeat(indent);
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return [`${prefix}- ${yamlScalar(entry as string | number | boolean | null)}`];
      }
      const pairs = Object.entries(entry);
      return pairs.flatMap(([key, child], index) => {
        const itemPrefix = index === 0 ? `${prefix}- ` : `${prefix}  `;
        if (child && typeof child === 'object') {
          return [`${itemPrefix}${key}:`, ...yamlLines(child, indent + (index === 0 ? 4 : 4))];
        }
        return [`${itemPrefix}${key}: ${yamlScalar(child as string | number | boolean | null)}`];
      });
    });
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, child]) => {
      if (child && typeof child === 'object') {
        return [`${prefix}${key}:`, ...yamlLines(child, indent + 2)];
      }
      return [`${prefix}${key}: ${yamlScalar(child as string | number | boolean | null)}`];
    });
  }
  return [`${prefix}${yamlScalar(value)}`];
}

function serializeOverlay(value: YamlValue): string {
  return [
    '# Cockpit overlay для штатного профиля acp. Генерируется на каждый запуск.',
    ...yamlLines(value),
    '',
  ].join('\n');
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function assertAbsolute(label: string, value: string): void {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) {
    throw new TypeError(`DeepSeek ${label} должен быть абсолютным путём`);
  }
}

function permissionPreset(
  mode: DeepSeekLaunchFilesOptions['mode'],
  approval: DeepSeekLaunchFilesOptions['approval'],
): string {
  if (approval === 'ask') return mode;
  return mode === 'read-only' ? 'factory-state-only' : 'factory-workspace-write';
}

async function privateFile(file: string, content: string): Promise<void> {
  await fs.writeFile(file, content, { mode: 0o600 });
  await fs.chmod(file, 0o600);
}

/** Строит единственные server-owned patch и hooks для одного процесса DSH. */
export async function buildLaunchFiles(
  options: DeepSeekLaunchFilesOptions,
): Promise<DeepSeekLaunchFiles> {
  const { launchDir, cwd, workspaceRoot, mode, approval, hooks } = options;
  assertAbsolute('launchDir', launchDir);
  assertAbsolute('cwd', cwd);
  assertAbsolute('workspaceRoot', workspaceRoot);
  assertAbsolute('projectRoot', hooks.instructions.projectRoot);
  if (mode !== 'read-only' && mode !== 'workspace-write') {
    throw new TypeError(`DeepSeek mode не поддерживается: ${String(mode)}`);
  }
  if (approval !== 'ask' && approval !== 'never') {
    throw new TypeError(`DeepSeek approval не поддерживается: ${String(approval)}`);
  }
  if (hooks.bashToolName !== DEEPSEEK_BASH_TOOL) {
    throw new TypeError(`DeepSeek bashToolName не прошёл pinned-контракт: ${hooks.bashToolName}`);
  }
  const relativeCwd = path.relative(hooks.instructions.projectRoot, cwd);
  if (relativeCwd.startsWith('..') || path.isAbsolute(relativeCwd)) {
    throw new TypeError('DeepSeek projectRoot должен содержать cwd');
  }
  const relativeWorkspaceCwd = path.relative(workspaceRoot, cwd);
  if (relativeWorkspaceCwd.startsWith('..') || path.isAbsolute(relativeWorkspaceCwd)) {
    throw new TypeError('DeepSeek workspaceRoot должен содержать cwd');
  }

  await fs.mkdir(launchDir, { recursive: true, mode: 0o700 });
  await fs.chmod(launchDir, 0o700);
  const hooksPath = path.join(launchDir, 'hooks.json');
  const overlayPath = path.join(launchDir, 'overlay.yml');
  const commandFlags = [
    ...(hooks.ssh ? ['--ssh'] : ['--no-ssh']),
    ...(hooks.db ? ['--db'] : []),
    ...(hooks.db && hooks.strictDb ? ['--strict-db'] : []),
  ];
  const policyCommand = [
    shellQuote(process.execPath),
    shellQuote(DIRECT_SSH_HOOK_PATH),
    '--tool-name',
    shellQuote(hooks.bashToolName),
    '--command-field',
    DEEPSEEK_BASH_COMMAND_FIELD,
    ...commandFlags,
  ].join(' ');
  const instructionsCommand = [
    shellQuote(process.execPath),
    shellQuote(INSTRUCTIONS_HOOK_PATH),
    '--root',
    shellQuote(hooks.instructions.projectRoot),
    '--cwd',
    shellQuote(cwd),
  ].join(' ');
  const hooksDocument = {
    hooks: {
      ...((hooks.ssh || hooks.db) ? {
        PreToolUse: [{
          matcher: hooks.bashToolName,
          hooks: [{ type: 'command', command: policyCommand, timeout: 5 }],
        }],
      } : {}),
      UserPromptSubmit: [{
        hooks: [{ type: 'command', command: instructionsCommand, timeout: 20 }],
      }],
    },
  };
  const hooksJson = `${JSON.stringify(hooksDocument, null, 2)}\n`;
  const overlay = serializeOverlay([
    { id: 'sandbox-policy', config: { mode, workspaceRoot } },
    { id: 'approval', config: { policy: approval } },
    {
      // Upstream не объявляет preset для Factory-комбинаций `approval: never`.
      // Явная таблица сохраняет выбранные knob-ы и не подменяет state-only более
      // широким штатным preset-ом danger-full-access.
      id: 'permission',
      config: {
        presets: {
          'read-only': { sandbox: 'read-only', approval: 'ask' },
          'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
          'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
          'factory-state-only': { sandbox: 'read-only', approval: 'never' },
          'factory-workspace-write': { sandbox: 'workspace-write', approval: 'never' },
        },
        defaultPreset: permissionPreset(mode, approval),
      },
    },
    { id: 'agent-instructions', config: { maxBytes: 262_144 } },
    ...DISABLED_ROWS.map((id) => ({ id, disabled: true })),
    {
      insert: [{
        id: 'hooks-claude-code',
        name: '@deepseek-ai/dsh-hooks-claude-code',
        config: { configPath: hooksPath, projectDir: cwd },
      }],
    },
  ]);

  await Promise.all([
    privateFile(hooksPath, hooksJson),
    privateFile(overlayPath, overlay),
  ]);
  const fingerprint = createHash('sha256')
    .update(DEEPSEEK_PIN.version)
    .update('\0')
    .update(overlay)
    .update('\0')
    .update(hooksJson)
    .digest('hex');
  return {
    launchDir,
    overlayPath,
    hooksPath,
    fingerprint,
    version: DEEPSEEK_PIN.version,
  };
}
