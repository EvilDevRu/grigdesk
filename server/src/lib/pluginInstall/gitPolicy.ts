import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { PluginCommandRunner } from './runCommand.ts';

export const GIT_SSH_COMMAND = '/usr/bin/ssh -o BatchMode=yes -o ConnectTimeout=20'
  + ' -o StrictHostKeyChecking=yes';

// Базовая политика применяется уже в первых локальных fixtures:
// Git не читает конфигурацию машины и не наследует repository/trace overrides.
export const GIT_POLICY_ARGS = [
  '-c', 'protocol.allow=never',
  '-c', 'protocol.https.allow=always',
  '-c', 'protocol.ssh.allow=always',
  '-c', 'protocol.file.allow=always',
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.fsmonitor=false',
  '-c', 'maintenance.auto=false',
  '-c', 'gc.auto=0',
  '-c', 'core.attributesFile=/dev/null',
  '-c', `core.sshCommand=${GIT_SSH_COMMAND}`,
];

/**
 * Среда не копируется целиком: Git overrides, askpass и trace не получают допуска.
 * Ceiling запрещает discovery родительского репозитория при работе в staging.
 */
export function gitPolicyEnv(cwd: string, baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    PATH: '/usr/bin:/bin',
    HOME: baseEnv.HOME,
    SSH_AUTH_SOCK: baseEnv.SSH_AUTH_SOCK,
    XDG_CONFIG_HOME: baseEnv.XDG_CONFIG_HOME,
    GIT_SSH_COMMAND,
    GIT_SSH_VARIANT: 'ssh',
    LC_ALL: 'C',
    LANGUAGE: 'C',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_CEILING_DIRECTORIES: path.dirname(cwd),
    TMPDIR: os.tmpdir(),
  };
}

export interface GitPolicyOptions {
  baseEnv?: NodeJS.ProcessEnv;
  credentialConfig?: () => Promise<string>;
}

/**
 * Из доверенного host config копируются только строки credential.helper.
 * Includes, переписывание адресов, hooks, filters и core команды не переносятся.
 */
function credentialHelpersOnly(text: string): string {
  let section: string | null = null;
  const lines: string[] = [];

  for (const raw of text.split('\n')) {
    const line = raw.trim();

    if (line.startsWith('[')) {
      section = /^\[credential(?:\s+"[^"\r\n]+")?\]$/iu.test(line) ? line : null;
      continue;
    }

    if (section && /^helper\s*=/iu.test(line)) {
      lines.push(section, line);
    }
  }

  return `${lines.join('\n')}\n`;
}

/**
 * Читаются обычные host config пути, независимо от GIT_CONFIG_GLOBAL overrides.
 * Для file/SSH этот reader не вызывается: HTTPS helper нужен только сетевому transport.
 */
async function readCredentialConfig(baseEnv: NodeJS.ProcessEnv): Promise<string> {
  const home = baseEnv.HOME ?? os.homedir();
  const xdg = baseEnv.XDG_CONFIG_HOME ?? path.join(home, '.config');
  const contents: string[] = [];

  for (const file of [path.join(xdg, 'git/config'), path.join(home, '.gitconfig')]) {
    const info = await stat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        return null;
      }

      throw error;
    });

    if (info?.isFile() && info.size <= 1024 * 1024) {
      contents.push(await readFile(file, 'utf8'));
    }
  }

  return contents.join('\n');
}

/**
 * Приватный generated config живёт только до завершения соответствующей команды.
 * Runner сохраняет ownership и budget исходного вызова, без глобального singleton.
 */
export function createGitPolicyRunner(
  run: PluginCommandRunner,
  options: GitPolicyOptions,
): PluginCommandRunner {
  const baseEnv = options.baseEnv ?? process.env;

  return async (file, args, command) => {
    const boundary = args.indexOf('--');
    const remote = (args.includes('clone') || args.includes('ls-remote')) && boundary >= 0
      ? args[boundary + 1] : undefined;
    let directory: string | null = null;
    let global = '/dev/null';

    try {
      if (remote?.startsWith('https://')) {
        const supplied = await (options.credentialConfig?.() ?? readCredentialConfig(baseEnv));
        const config = credentialHelpersOnly(supplied);

        directory = await mkdtemp(path.join(os.tmpdir(), 'cockpit-git-config-'));
        global = path.join(directory, 'global');

        await writeFile(global, config, { mode: 0o600, flag: 'wx' });
      }

      const env = gitPolicyEnv(command.cwd ?? os.tmpdir(), baseEnv);

      env.GIT_CONFIG_GLOBAL = global;

      return await run(file, args, { ...command, env });
    } finally {
      if (directory) {
        await rm(directory, { recursive: true, force: true });
      }
    }
  };
}
