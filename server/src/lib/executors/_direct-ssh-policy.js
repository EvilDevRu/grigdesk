import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIRECT_CLIENTS = new Set([
  'ssh',
  'slogin',
  'scp',
  'sftp',
  'autossh',
  'ssh-copy-id',
]);
const SHELLS = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh']);
const SIMPLE_WRAPPERS = new Set(['command', 'exec', 'nohup']);

export const DIRECT_SSH_HOOK_MATCHER = '^Bash$';
export const DIRECT_SSH_HOOK_PATH = fileURLToPath(
  new URL('./_direct-ssh-policy-hook.js', import.meta.url),
);
export const DIRECT_SSH_HOOK_COMMAND = `${process.execPath} ${DIRECT_SSH_HOOK_PATH}`;
export const CLAUDE_DIRECT_SSH_DENY = Object.freeze([
  'Bash(ssh:*)',
  'Bash(slogin:*)',
  'Bash(scp:*)',
  'Bash(sftp:*)',
  'Bash(autossh:*)',
  'Bash(ssh-copy-id:*)',
]);

export const DIRECT_SSH_CONFIRM_TEXT =
  'Агент сможет запускать прямые SSH-клиенты с правами процесса Cockpit. '
  + 'Режим прав Bash не заменяет этот запрет. '
  + 'Подтверждений и журнала SSH-инструмента не будет.';

/**
 * Общая декларация опасного тумблера. Способ обеспечения по-прежнему объявляет
 * каждый адаптер полем directSshPolicy, а здесь совпадает только смысл настройки.
 */
export function directSshSetting({ hint, note, extraConfirmation = '' } = {}) {
  return {
    id: 'blockDirectSsh',
    kind: 'toggle',
    label: 'Запретить прямой SSH',
    hint: hint || 'Закрывает прямой SSH для кооперативного агента; это не same-uid изоляция.',
    ...(note ? { note } : {}),
    value: true,
    confirm: {
      off: {
        text: `${DIRECT_SSH_CONFIRM_TEXT}${extraConfirmation ? ` ${extraConfirmation}` : ''}`,
        label: 'Разрешить прямой SSH',
        danger: true,
      },
    },
  };
}

function executableName(token) {
  return path.posix.basename(String(token || '').replaceAll('\\', '/')).toLowerCase();
}

/**
 * Разбирает только структуру, нужную policy: слова, кавычки и границы shell-команд.
 * Подстановки не исполняются. Незакрытая кавычка помечает ввод неразобранным.
 */
function shellSegments(command) {
  const segments = [[]];
  let word = '';
  let quote = '';
  let escaped = false;

  const pushWord = () => {
    if (!word) return;
    segments.at(-1).push(word);
    word = '';
  };

  for (const char of String(command || '')) {
    if (escaped) {
      word += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = '';
      else word += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/u.test(char)) {
      pushWord();
      if (char === '\n' && segments.at(-1).length) segments.push([]);
      continue;
    }
    if (';&|()'.includes(char)) {
      pushWord();
      if (segments.at(-1).length) segments.push([]);
      continue;
    }
    word += char;
  }
  if (escaped) word += '\\';
  pushWord();

  return quote ? null : segments.filter((segment) => segment.length);
}

function isAssignment(token) {
  return /^[A-Za-z_][A-Za-z0-9_]*=/u.test(String(token || ''));
}

function skipOptions(tokens, start, optionsWithValue = new Set()) {
  let index = start;
  while (index < tokens.length && String(tokens[index]).startsWith('-')) {
    const option = String(tokens[index]);
    index += 1;
    if (optionsWithValue.has(option) && index < tokens.length) index += 1;
  }
  return index;
}

/** Снимает обычные префиксы запуска, не принимая решения по имени вендора или CLI. */
function commandIndex(tokens) {
  let index = 0;
  while (index < tokens.length) {
    while (isAssignment(tokens[index])) index += 1;
    const name = executableName(tokens[index]);
    if (SIMPLE_WRAPPERS.has(name)) {
      index = skipOptions(tokens, index + 1);
      continue;
    }
    if (name === 'env') {
      index = skipOptions(tokens, index + 1, new Set(['-u', '--unset', '-C', '--chdir']));
      while (isAssignment(tokens[index])) index += 1;
      continue;
    }
    if (name === 'sudo') {
      index = skipOptions(
        tokens,
        index + 1,
        new Set(['-u', '--user', '-g', '--group', '-h', '--host', '-C', '--close-from']),
      );
      continue;
    }
    break;
  }
  return index;
}

function isRemoteRsyncOperand(token) {
  const value = String(token || '');
  if (!value || value.startsWith('-')) return false;
  if (/^rsync:\/\//iu.test(value)) return true;

  const colon = value.indexOf(':');
  if (colon <= 0) return false;
  const host = value.slice(0, colon);
  return !host.includes('/') && !host.includes('\\');
}

function rsyncUsesSsh(tokens) {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = String(tokens[index] || '');
    let transport = '';
    if (token === '-e' || token === '--rsh') transport = String(tokens[index + 1] || '');
    else if (token.startsWith('--rsh=')) transport = token.slice('--rsh='.length);
    else if (/^-e\S/u.test(token)) transport = token.slice(2);
    if (!transport) continue;

    const first = shellSegments(transport)?.[0] || [];
    const name = executableName(first[commandIndex(first)]);
    if (DIRECT_CLIENTS.has(name) || name === 'sshpass') return true;
  }
  return false;
}

function shellScriptOf(tokens, start) {
  for (let index = start; index < tokens.length - 1; index += 1) {
    const option = String(tokens[index] || '');
    if (/^-[A-Za-z]*c[A-Za-z]*$/u.test(option)) return String(tokens[index + 1] || '');
  }
  return '';
}

function segmentUsesDirectSsh(tokens, depth) {
  const index = commandIndex(tokens);
  const name = executableName(tokens[index]);
  if (DIRECT_CLIENTS.has(name)) return true;

  const rest = tokens.slice(index + 1);
  if (name === 'sshpass') {
    return rest.some((token) => DIRECT_CLIENTS.has(executableName(token)));
  }
  if (name === 'rsync') {
    return rest.some(isRemoteRsyncOperand) || rsyncUsesSsh(rest);
  }
  if (SHELLS.has(name) && depth < 4) {
    const script = shellScriptOf(tokens, index + 1);
    return script ? isDirectSshCommand(script, depth + 1) : false;
  }
  return false;
}

/**
 * Определяет прямой SSH-клиент по basename команды, обычным wrappers и удалённому
 * rsync. Это барьер кооперативного агента, а не интерпретатор shell и не sandbox.
 */
export function isDirectSshCommand(command, depth = 0) {
  if (typeof command !== 'string' || !command || command.includes('\0')) return false;
  const segments = shellSegments(command);
  if (!segments) return false;
  return segments.some((tokens) => segmentUsesDirectSsh(tokens, depth));
}
