import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const REVISION_RE = /^[A-Za-z0-9][A-Za-z0-9._~^/-]{0,120}$/;

interface RepoHistoryDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface RepoHistoryResult {
  ok: boolean;
  error?: string;
  output?: string;
}

const descriptor: RepoHistoryDescriptor = {
  name: 'repo_history',
  description: 'Прочитать ограниченный git log либо содержимое файла в выбранной ревизии.',
  inputSchema: {
    type: 'object',
    required: ['repo', 'action'],
    additionalProperties: false,
    properties: {
      repo: { type: 'string' },
      action: { type: 'string', enum: ['log', 'show'] },
      revision: { type: 'string' },
      path: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
    },
  },
};

function validRelativePath(value: unknown): string {
  const file = String(value || '').trim();
  return file
    && !path.isAbsolute(file)
    && !file.split(/[\\/]+/).includes('..')
    ? file
    : '';
}

/**
 * Инструмент принимает только server-owned ключ репозитория и два read-only действия;
 * модель не передаёт raw argv и не способна добавить write-флаг.
 */
export function createRepoHistoryTools(
  repositories: { key?: unknown; dir?: unknown }[] = [],
) {
  const repos = new Map<string, string>(
    repositories.filter((repo) => repo?.key && repo?.dir)
      .map((repo) => [String(repo.key), String(repo.dir)]),
  );

  async function invoke(
    name: string,
    input: Record<string, unknown> = {},
  ): Promise<RepoHistoryResult> {
    if (name !== descriptor.name) {
      return { ok: false, error: 'tool_not_found' };
    }
    const cwd = repos.get(String(input.repo || ''));
    if (!cwd) {
      return { ok: false, error: 'unknown_repo' };
    }
    const action = String(input.action || '');
    const revision = String(input.revision || 'HEAD');
    if (!REVISION_RE.test(revision)) {
      return { ok: false, error: 'invalid_revision' };
    }

    let args: string[];
    if (action === 'log') {
      const limit = Math.min(100, Math.max(1, Number(input.limit) || 20));
      args = ['-C', cwd, 'log', `-${limit}`, '--format=%h %ad %s', '--date=short'];
    } else if (action === 'show') {
      const file = validRelativePath(input.path);
      if (!file) {
        return { ok: false, error: 'invalid_path' };
      }
      args = ['-C', cwd, 'show', `${revision}:${file}`];
    } else {
      return { ok: false, error: 'invalid_action' };
    }

    try {
      const { stdout } = await execFileAsync('git', args, {
        timeout: 10_000,
        maxBuffer: 512 * 1024,
      });
      return { ok: true, output: String(stdout || '').slice(0, 512 * 1024) };
    } catch (error) {
      const failure = error !== null && typeof error === 'object'
        ? error as { stderr?: unknown }
        : {};

      return {
        ok: false,
        error: 'repo_history_failed',
        output: String(failure.stderr || '').slice(-1000),
      };
    }
  }

  return { descriptors: [structuredClone(descriptor)], invoke };
}

export default createRepoHistoryTools;
