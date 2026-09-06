import { StringDecoder } from 'node:string_decoder';

import { sanitizeSshText, takeUtf8Prefix } from './output.js';

const FRAME = '[36m';
const RESET = '[0m';
const COMMAND_MAX = 400;
const DEFAULT_LIMIT_BYTES = 64 * 1_024;

/**
 * Терминал человека принимает поток без построчной дисциплины: перевод строки без
 * возврата каретки уводит вывод лесенкой. Канал агентской команды идёт без PTY,
 * поэтому переносы приходят голыми и нормализуются здесь.
 */
function crlf(text) {
  return text.replace(/\r?\n/g, '\r\n');
}

/**
 * Команда приходит от модели и печатается человеку — это такой же недоверенный текст,
 * как и вывод сервера. Многострочность сворачивается в одну строку: рамка обязана
 * остаться одной строкой, иначе её легко спутать с настоящим приглашением оболочки.
 */
function commandLine(command) {
  const clean = sanitizeSshText(command).replace(/\s*\n\s*/g, ' ⏎ ').trim();

  return clean.length > COMMAND_MAX ? `${clean.slice(0, COMMAND_MAX)}…` : clean;
}

function frame(text) {
  return `${FRAME}${text}${RESET}\r\n`;
}

/**
 * Живое эхо одной агентской команды в терминал человека: рамка запуска, поток вывода
 * по мере поступления и строка итога. Бюджет ограничен, потому что буфер повтора
 * сессии невелик — без предела крупный вывод вытеснил бы собственную историю человека.
 */
export function createExecEcho({ limitBytes = DEFAULT_LIMIT_BYTES } = {}) {
  const limit = Math.max(0, Number(limitBytes) || 0);
  const decoder = new StringDecoder('utf8');
  let shown = 0;
  let total = 0;
  let cut = false;
  let atLineStart = true;

  function emit(text) {
    if (text) {
      atLineStart = text.endsWith('\n');
    }

    return text;
  }

  function start(command) {
    atLineStart = true;

    return `\r\n${frame(`┌─ агент ▸ ${commandLine(command)}`)}`;
  }

  function data(chunk) {
    const raw = decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    if (!raw) {
      return '';
    }

    const text = crlf(sanitizeSshText(raw));
    const buffer = Buffer.from(text, 'utf8');
    total += buffer.length;
    if (cut) {
      return '';
    }
    if (shown + buffer.length <= limit) {
      shown += buffer.length;

      return emit(text);
    }

    cut = true;
    const rest = takeUtf8Prefix(buffer, limit - shown);
    shown += rest.length;

    return emit(rest.toString('utf8'));
  }

  function finish(result) {
    const outcome = result?.ok
      ? 'код 0'
      : (Number.isInteger(result?.exitCode)
        ? `код ${result.exitCode}${result?.signal ? ` (${result.signal})` : ''}`
        : `прервано: ${result?.error || 'unknown'}`);
    const note = cut ? ` · эхо обрезано, показано ${shown} из ${total} байт` : '';
    const lead = atLineStart ? '' : '\r\n';

    return `${lead}${frame(`└─ ${outcome}${note}`)}`;
  }

  return { start, data, finish };
}

export default createExecEcho;
