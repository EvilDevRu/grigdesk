import type { PluginCommandResult } from '../pluginInstall/runCommand.ts';

const TRANSIENT_CURL = /\bcurl:\s*\((?:5|6|7|18|28|35|52|55|56|92|95)\)/iu;
const TRANSIENT_NETWORK = new RegExp([
  '\\b(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ESOCKETTIMEDOUT|EAI_AGAIN|ENOTFOUND|ENETUNREACH)',
  '\\b(?:UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET)\\b',
  'unexpected (?:eof|end of file)|socket hang up',
  '(?:connection|network|connect|read) (?:was )?(?:reset|refused|timed out|unreachable)',
  'could not resolve (?:host|proxy)|temporary failure in name resolution',
  '(?:failed to fetch|fetch failed|network error|network request failed)',
  '(?:HTTP(?:/[\\d.]+)?(?:\\s+error)?|status(?:\\s+code)?|returned error:)\\s*[:=]?\\s*(?:429|5\\d\\d)\\b',
  '\\bE(?:429|5\\d\\d)\\b',
].join('|'), 'iu');
const PERMANENT_FAILURE = new RegExp([
  '\\b(?:EACCES|EPERM|ENOSPC|EROFS|ENOENT)\\b',
  'permission denied|no space left on device|read-only file system|command not found',
  'certificate (?:verify failed|verification failed|has expired)|self[- ]signed certificate',
  '\\bcurl:\\s*\\((?:60|77)\\)',
].join('|'), 'iu');

/**
 * Повтор установки допустим только при явном временном сетевом отказе команды.
 * Успех, отмена, сигналы и локальные ошибки сильнее сетевых строк в диагностике.
 */
export function isTransientInstallFailure(result: PluginCommandResult): boolean {
  if (result.code === 0 || result.aborted || result.timedOut || result.signal
    || result.workspaceLimitExceeded) {
    return false;
  }

  const output = `${result.stdout}\n${result.stderr}`;

  return !PERMANENT_FAILURE.test(output)
    && (TRANSIENT_CURL.test(output) || TRANSIENT_NETWORK.test(output));
}
