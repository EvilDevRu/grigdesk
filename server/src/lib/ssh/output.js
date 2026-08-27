const ANSI_RE = /[\u001b\u009b](?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g;

function sanitize(value) {
  return String(value ?? '')
    .replace(ANSI_RE, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

function safePrefix(buffer, bytes) {
  let end = Math.min(bytes, buffer.length);
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  return buffer.subarray(0, end);
}

function safeSuffix(buffer, bytes) {
  let start = Math.max(0, buffer.length - bytes);
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) {
    start += 1;
  }
  return buffer.subarray(start);
}

/** Срез сохраняет контекст начала и финальную ошибку, не разрывая UTF-8. */
export function limitSshOutput(value, limitBytes) {
  const clean = sanitize(value);
  const source = Buffer.from(clean, 'utf8');
  const totalBytes = source.length;
  const limit = Math.max(0, Number(limitBytes) || 0);
  if (totalBytes <= limit) {
    return {
      text: clean,
      shownBytes: totalBytes,
      totalBytes,
      truncated: false,
      notice: '',
    };
  }
  const headLimit = Math.floor(limit / 2);
  const tailLimit = limit - headLimit;
  const head = safePrefix(source, headLimit);
  const tail = safeSuffix(source, tailLimit);
  const text = Buffer.concat([head, tail]).toString('utf8');
  const shownBytes = Buffer.byteLength(text);
  return {
    text,
    shownBytes,
    totalBytes,
    truncated: true,
    notice: `показано ${shownBytes} из ${totalBytes}, середина удалена`,
  };
}

export const limitOutput = limitSshOutput;
export default limitSshOutput;
