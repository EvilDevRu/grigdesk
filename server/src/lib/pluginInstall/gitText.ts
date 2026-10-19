import type {
  PluginInstallCommit,
  PluginInstallChangedFile,
  PluginVersionRef,
} from '../../../../shared/plugins/pluginInstallContracts.ts';
import type { PluginCommandResult } from './runCommand.ts';
import { parseStableTag, compareSemVer } from '../releaseCommon.ts';

import { installError } from './errors.ts';
import type { PluginInstallError } from './errors.ts';

/**
 * Теги источника становятся только стабильными ссылками на точный commit.
 * Аннотированный тег выбирает peeled SHA независимо от порядка строк.
 */
export function parsePluginTags(output: unknown): PluginVersionRef[] {
  if (typeof output !== 'string') {
    return [];
  }

  const tags = new Map<string, PluginVersionRef>();
  const peeled = new Set<string>();

  for (const line of String(output).split('\n')) {
    const match = /^([a-fA-F0-9]{40}|[a-fA-F0-9]{64})\trefs\/tags\/(.+?)(\^\{\})?$/u.exec(line);

    if (!match) {
      continue;
    }

    const tag = match[2] ?? '';
    const version = parseStableTag(tag);

    if (!version) {
      continue;
    }

    if (match[3] || !peeled.has(tag)) {
      tags.set(tag, {
        version,
        tag,
        sha: (match[1] ?? '').toLowerCase(),
      });
    }

    if (match[3]) {
      peeled.add(tag);
    }
  }

  return [...tags.values()].sort((left, right) => compareSemVer(right.version, left.version));
}

/**
 * Прогресс читается из английского Git stderr, без угадывания перевода.
 * Неподходящее сообщение не становится фиктивным процентом.
 */
export function parseGitProgress(text: string): number | null {
  for (const line of text.split(/[\r\n]/u).reverse()) {
    if (line.trim().startsWith('remote:')) {
      continue;
    }

    const receiving = /Receiving objects:\s+(-?\d+)%/u.exec(line);
    const resolving = /Resolving deltas:\s+(-?\d+)%/u.exec(line);
    const value = resolving ? Math.round(90 + Number(resolving[1]) * 0.1)
      : receiving ? Math.round(Number(receiving[1]) * 0.9) : null;

    if (value !== null) {
      return Math.max(0, Math.min(100, value));
    }
  }

  return null;
}

/**
 * Сырой stderr команды остаётся вне публичного сообщения.
 * Resource/abort/deadline имеют приоритет над transport и отказом доступа.
 */
export function classifyGitFailure(result: PluginCommandResult): PluginInstallError {
  if (result.workspaceLimitExceeded) {
    return installError('workspace_limit');
  }

  if (result.aborted) {
    return installError('cancelled');
  }

  if (result.timedOut) {
    return installError('source_timeout');
  }

  const network = new RegExp(
    'could not resolve host|connection timed out|connection refused|network is unreachable'
      + '|no route to host|operation timed out',
    'i',
  );

  if (network.test(result.stderr)) {
    return installError('source_unreachable');
  }

  const unavailable = new RegExp(
    'repository not found|not found|does not appear to be a git repository'
      + '|could not read from remote repository|permission denied|authentication failed'
      + '|could not read username|terminal prompts disabled|returned error: 40[134]',
    'i',
  );

  if (unavailable.test(result.stderr)) {
    return installError('source_unavailable');
  }

  return installError('source_failed');
}

/**
 * Structured stdout должен быть полным до разбора refs или файлов.
 * Признак обрезки запрещает молчаливое использование хвоста как полного результата.
 */
export function completeGitStdout(result: PluginCommandResult): string {
  if (result.code !== 0 || result.workspaceLimitExceeded || result.aborted || result.timedOut) {
    throw classifyGitFailure(result);
  }

  if (result.stdoutTruncated) {
    throw installError('command_output_limit');
  }

  return result.stdout;
}

/**
 * Git NUL-разделители отделяют поля без эвристики кавычек, TAB и переводов строки.
 * Незаконченная пара отвергается целиком, чтобы хвост не выглядел полным списком.
 */
function nulPairs(output: string): Array<[string, string]> {
  if (!output) {
    return [];
  }

  if (!output.endsWith('\0')) {
    throw installError('command_output_limit');
  }

  const fields = output.split('\0');

  fields.pop();

  if (fields.length % 2 !== 0) {
    throw installError('source_failed');
  }

  const pairs: Array<[string, string]> = [];

  for (let index = 0; index < fields.length; index += 2) {
    const left = fields[index];
    const right = fields[index + 1];

    if (left === undefined || right === undefined) {
      throw installError('source_failed');
    }

    pairs.push([left, right]);
  }

  return pairs;
}

/**
 * История сохраняет NUL поля темы и полный SHA каждого коммита.
 * Предел 50 задаётся после проверки структуры, дополнительная запись отмечает сокращение.
 */
export function parsePluginCommits(output: string): {
  records: PluginInstallCommit[];
  truncated: boolean;
} {
  const pairs = nulPairs(output);
  const records = pairs.slice(0, 50).map(([sha, subject]) => {
    if (!/^([a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/u.test(sha)) {
      throw installError('source_failed');
    }

    return { sha: sha.toLowerCase(), subject };
  });

  return { records, truncated: pairs.length > 50 };
}

/**
 * Diff без renames возвращает пары status/path, где path содержит любые TAB/LF.
 * Сокращение до 200 файлов остаётся явным флагом для карточки проверки.
 */
export function parsePluginChangedFiles(output: string): {
  records: PluginInstallChangedFile[];
  truncated: boolean;
} {
  const pairs = nulPairs(output);
  const records = pairs.slice(0, 200).map(([status, file]) => {
    if (!/^[A-Z][0-9]*$/u.test(status) || !file) {
      throw installError('source_failed');
    }

    return { status, path: file };
  });

  return { records, truncated: pairs.length > 200 };
}
