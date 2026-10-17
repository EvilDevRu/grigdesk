import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  PluginInstalledVersion,
  PluginVersionRef,
} from '../../../../shared/plugins/pluginInstallContracts.ts';
import { parseStableTag } from '../cockpitRelease.ts';
import { installError, PluginInstallError } from './errors.ts';

import { normalizeGitUrl } from './gitUrl.ts';
import { runCommand } from './runCommand.ts';
import type { PluginCommandRunner } from './runCommand.ts';
import { safeGitConfigDigest, installedPayloadFiles } from './gitMetadata.ts';
import { createGitPolicyRunner, gitPolicyEnv, GIT_POLICY_ARGS } from './gitPolicy.ts';
import {
  completeGitStdout,
  parsePluginTags,
  parseGitProgress,
  parsePluginCommits,
  parsePluginChangedFiles,
} from './gitText.ts';
import type { PluginSource } from './sources.ts';
import type { PluginInstalledState } from './sources.ts';
import type { PluginSourceChanges } from './sources.ts';
import { PACKAGE_LIMITS } from './validatePackage.ts';
import type { PackageLimits } from './validatePackage.ts';

import type { PluginFetchRequest } from './sources.ts';

export interface GitPluginSourceOptions {
  run?: PluginCommandRunner;
  listTimeoutMs?: number;
  fetchTimeoutMs?: number;
  localTimeoutMs?: number;
  // Изолированная среда fixture; Git overrides всё равно не получают допуска.
  baseEnv?: NodeJS.ProcessEnv;
  credentialConfig?: () => Promise<string>;
  packageLimits?: PackageLimits;
}

/**
 * Git остаётся стратегией за общим портом, без знания HTTP или runtime плагина.
 * Первый сценарий требует реальные refs собственного file origin.
 */
export class GitPluginSource implements PluginSource {
  readonly kind = 'git';

  private readonly run: PluginCommandRunner;
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly listTimeoutMs: number;
  private readonly fetchTimeoutMs: number;
  private readonly localTimeoutMs: number;
  private readonly packageLimits: PackageLimits;

  /**
   * Runner подменяется только через constructor, без глобального singleton.
   * Production по умолчанию использует supervisor, сервис добавит durable ownership.
   */
  constructor(options: GitPluginSourceOptions = {}) {
    this.baseEnv = options.baseEnv ?? process.env;
    this.run = createGitPolicyRunner(options.run ?? runCommand, {
      baseEnv: this.baseEnv,
      credentialConfig: options.credentialConfig,
    });
    this.listTimeoutMs = options.listTimeoutMs ?? 30000;
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? 300000;
    this.localTimeoutMs = options.localTimeoutMs ?? 15000;
    this.packageLimits = options.packageLimits ?? PACKAGE_LIMITS;
  }

  normalizeUrl(raw: unknown): string {
    return normalizeGitUrl(raw);
  }

  /**
   * Listing не импортирует файлы пакета и возвращает только стабильные tags.
   * Результат используется только после проверки отказа и полноты stdout.
   */
  async listVersions(raw: string, signal?: AbortSignal): Promise<PluginVersionRef[]> {
    const url = this.normalizeUrl(raw);
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'cockpit-plugin-git-list-'));

    try {
      const result = await this.run('/usr/bin/git', [...GIT_POLICY_ARGS, 'ls-remote', '--tags', '--', url], {
        cwd,
        env: gitPolicyEnv(cwd, this.baseEnv),
        timeoutMs: this.listTimeoutMs,
        signal,
      });

      return parsePluginTags(completeGitStdout(result));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }

  /**
   * Fetch получает точный ref и отдельный staging, не меняя установленный плагин.
   * Первый RED требует материализованный manifest и detached HEAD.
   */
  async fetch(request: PluginFetchRequest): Promise<void> {
    const url = this.normalizeUrl(request.url);

    if (parseStableTag(request.target.tag) !== request.target.version
      || !/^([a-f0-9]{40}|[a-f0-9]{64})$/u.test(request.target.sha)) {
      throw installError('version_not_found');
    }

    let lastPercent = -1;
    let tail = '';
    const report = (percent: number) => {
      if (percent > lastPercent) {
        lastPercent = percent;
        request.onProgress?.(percent);
      }
    };
    const clone = await this.run('/usr/bin/git', [
      ...GIT_POLICY_ARGS,
      'clone', '--no-checkout', '--no-local', '--progress', '--template=', '--', url, request.destination,
    ], {
      cwd: path.dirname(request.destination),
      env: gitPolicyEnv(path.dirname(request.destination), this.baseEnv),
      timeoutMs: this.fetchTimeoutMs,
      signal: request.signal,
      workspaceBudget: request.workspaceBudget,
      onStderr: (chunk) => {
        tail = (tail + chunk).slice(-4096);

        const percent = parseGitProgress(tail);

        if (percent !== null) {
          report(Math.min(99, percent));
        }
      },
    });

    completeGitStdout(clone);

    const tagged = await this.run('/usr/bin/git', [
      ...GIT_POLICY_ARGS, 'rev-parse', '--verify', `refs/tags/${request.target.tag}^{commit}`,
    ], {
      cwd: request.destination,
      env: gitPolicyEnv(request.destination, this.baseEnv),
      timeoutMs: this.localTimeoutMs,
      signal: request.signal,
      workspaceBudget: request.workspaceBudget,
    });

    if (tagged.code !== 0 && !tagged.aborted && !tagged.timedOut && !tagged.workspaceLimitExceeded) {
      throw installError('checkout_mismatch');
    }

    if (completeGitStdout(tagged).trim() !== request.target.sha) {
      throw installError('checkout_mismatch');
    }

    const tree = await this.localGit(request.destination, [
      'ls-tree', '-rz', '-l', request.target.sha,
    ], request);

    const rows = completeGitStdout(tree).split('\0').filter(Boolean);
    let totalBytes = 0;

    if (rows.length > this.packageLimits.maxFiles) {
      throw installError('package_too_large');
    }

    for (const row of rows) {
      if (row.startsWith('120000 ')) {
        throw installError('symlink_forbidden');
      }

      if (row.startsWith('160000 ')) {
        throw installError('submodules_forbidden');
      }

      const match = /^([0-9]{6}) blob ([a-f0-9]+)\s+([0-9]+)\t([\s\S]+)$/u.exec(row);

      if (!match) {
        throw installError('package_unsupported');
      }

      const file = match[4] ?? '';
      const blob = match[2] ?? '';
      const size = Number(match[3]);

      totalBytes += size;

      if (totalBytes > this.packageLimits.maxBytes) {
        throw installError('package_too_large');
      }

      const components = file.split('/');
      const base = components.at(-1);

      if (components.includes('.git') || components.includes('node_modules')
        || base === '.npmrc' || base === 'npm-shrinkwrap.json') {
        throw installError('package_unsupported');
      }

      if (base === '.gitmodules') {
        throw installError('submodules_forbidden');
      }

      {
        const content = base === '.gitattributes'
          ? await this.localGit(request.destination, ['cat-file', 'blob', blob], request)
          : await this.run(process.execPath, [
            fileURLToPath(new URL('./gitBlobPrefix.mjs', import.meta.url)), blob,
          ], {
            cwd: request.destination,
            env: gitPolicyEnv(request.destination, this.baseEnv),
            timeoutMs: this.localTimeoutMs,
            signal: request.signal,
            workspaceBudget: request.workspaceBudget,
          });
        const contents = completeGitStdout(content);

        if (base === '.gitattributes'
          && /(?:^|\s)[-!?]?(?:filter|working-tree-encoding)(?:=|\s|$)/mu.test(contents)) {
          throw installError('package_unsupported');
        }

        if (contents.startsWith('version https://git-lfs.github.com/spec/v1')) {
          throw installError('package_unsupported');
        }
      }
    }

    const checkout = await this.run('/usr/bin/git', [
      ...GIT_POLICY_ARGS, 'checkout', '--detach', request.target.sha,
    ], {
      cwd: request.destination,
      env: gitPolicyEnv(request.destination, this.baseEnv),
      timeoutMs: this.localTimeoutMs,
      signal: request.signal,
      workspaceBudget: request.workspaceBudget,
    });

    completeGitStdout(checkout);

    const head = await this.run('/usr/bin/git', [...GIT_POLICY_ARGS, 'rev-parse', '--verify', 'HEAD'], {
      cwd: request.destination,
      env: gitPolicyEnv(request.destination, this.baseEnv),
      timeoutMs: this.localTimeoutMs,
      signal: request.signal,
      workspaceBudget: request.workspaceBudget,
    });

    if (completeGitStdout(head).trim() !== request.target.sha) {
      throw installError('checkout_mismatch');
    }

    report(100);
  }


  /**
   * Локальное сравнение версий не выполняет сеть и не импортирует пакет.
   * Отсутствующий исходный commit означает недоступную историю, а не пустой diff.
   */
  async changes(directory: string, fromSha: string, toSha: string): Promise<PluginSourceChanges | null> {
    for (const sha of [fromSha, toSha]) {
      if (!/^([a-f0-9]{40}|[a-f0-9]{64})$/u.test(sha)) {
        throw installError('version_not_found');
      }
    }

    if (!await safeGitConfigDigest(directory)) {
      throw installError('package_unsupported');
    }

    const from = await this.localGit(directory, ['cat-file', '-t', fromSha]);

    if (from.code !== 0 && /could not get object info|not a valid object name/iu.test(from.stderr)) {
      return null;
    }

    if (completeGitStdout(from).trim() !== 'commit') {
      throw installError('source_failed');
    }

    const to = await this.localGit(directory, ['cat-file', '-t', toSha]);

    if (completeGitStdout(to).trim() !== 'commit') {
      throw installError('source_failed');
    }

    const history = await this.localGit(directory, [
      'log', '-z', '--max-count=51', '--format=%H%x00%s', `${fromSha}..${toSha}`, '--',
    ]);
    const diff = await this.localGit(directory, [
      'diff', '--name-status', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', fromSha, toSha, '--',
    ]);
    const commits = parsePluginCommits(completeGitStdout(history));
    const files = parsePluginChangedFiles(completeGitStdout(diff));

    return {
      commits: commits.records,
      files: files.records,
      truncated: commits.truncated || files.truncated,
    };
  }

  /**
   * Inspection сначала должна доказать безопасность Git metadata и снимка.
   * Ошибка считается ручным изменением и не разрешает замену копии.
   */
  async inspectInstalled(directory: string, expected: PluginInstalledVersion): Promise<PluginInstalledState> {
    let sha: string | null = null;

    try {
      if (await safeGitConfigDigest(directory) !== expected.gitConfigDigest) {
        return { sha, modified: true };
      }

      const head = await this.localGit(directory, ['rev-parse', '--verify', 'HEAD']);

      sha = completeGitStdout(head).trim();

      if (sha !== expected.sha) {
        return { sha, modified: true };
      }

      const status = await this.localGit(directory, [
        'status', '--porcelain=v1', '-z', '--untracked-files=all',
      ]);
      const generated = expected.npmDirs.map((dir) => path.posix.join(dir, 'node_modules'));

      for (const row of completeGitStdout(status).split('\0').filter(Boolean)) {
        const state = row.slice(0, 2);
        const file = row.slice(3);
        const knownGenerated = generated.some((dir) => file === dir || file.startsWith(`${dir}/`));

        if (state !== '??' || !knownGenerated) {
          return { sha, modified: true };
        }
      }

      const tracked = await this.localGit(directory, ['ls-files', '-z']);
      const known = new Set(completeGitStdout(tracked).split('\0').filter(Boolean));
      const files = await installedPayloadFiles(directory, expected.npmDirs);

      return { sha, modified: files.some((file) => !known.has(file)) };
    } catch (error) {
      if (error instanceof PluginInstallError && error.code === 'command_output_limit') {
        throw error;
      }

      return { sha, modified: true };
    }
  }

  /**
   * Чтение собственного клона использует такую же закрытую среду и policy flags.
   * Повторяющиеся command options остаются одной точкой для локальных операций.
   */
  private localGit(
    directory: string,
    args: string[],
    context: Pick<PluginFetchRequest, 'signal' | 'workspaceBudget'> = {},
  ) {
    return this.run('/usr/bin/git', [...GIT_POLICY_ARGS, ...args], {
      cwd: directory,
      env: gitPolicyEnv(directory, this.baseEnv),
      timeoutMs: this.localTimeoutMs,
      signal: context.signal,
      workspaceBudget: context.workspaceBudget,
    });
  }

}
