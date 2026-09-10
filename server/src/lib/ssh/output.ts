const ANSI_RE = /[\u001b\u009b](?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g;

export interface LimitedOutput {
  text: string;
  shownBytes: number;
  totalBytes: number;
  truncated: boolean;
  notice: string;
}

/**
 * Управляющие последовательности снимаются и с результата для агента, и с эха в терминал
 * человека: вывод удалённой машины недоверенный, а в терминале он ещё и способен двигать
 * курсор — тогда чужая строка перерисовала бы рамку агентской команды.
 */
export function sanitizeSshText(value: unknown): string {
  return String(value ?? '')
    .replace(ANSI_RE, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

const GAP_MARK = '\n\u2026 \u0441\u0435\u0440\u0435\u0434\u0438\u043d\u0430 \u0443\u0434\u0430\u043b\u0435\u043d\u0430 \u2026\n';
const GAP_BYTES = Buffer.byteLength(GAP_MARK);

/**
 * Срез по границе UTF-8: обрывать многобайтовый символ нельзя ни в лимите вывода,
 * ни в бюджете эха, иначе в терминал уедет «замена символа».
 */
export function takeUtf8Prefix(buffer: Buffer, bytes: number): Buffer {
  let end = Math.min(bytes, buffer.length);

  while (end > 0 && ((buffer[end] ?? 0) & 0xc0) === 0x80) {
    end -= 1;
  }

  return buffer.subarray(0, end);
}

/**
 * Хвост той же длины и по той же границе: начало среза сдвигается вперёд, пока
 * попадает в продолжение символа, а не в его первый байт.
 */
function safeSuffix(buffer: Buffer, bytes: number): Buffer {
  let start = Math.max(0, buffer.length - bytes);

  while (start < buffer.length && ((buffer[start] ?? 0) & 0xc0) === 0x80) {
    start += 1;
  }

  return buffer.subarray(start);
}

/**
 * Срез сохраняет контекст начала и финальную ошибку, не разрывая UTF-8, и ставит
 * между половинами видимую метку разрыва. Без метки оборванная строка головы
 * склеивается с началом хвоста в одну, и агент цитирует строку, которой на сервере
 * не было: поле `notice` про срез знает, а сам текст выдаёт себя за непрерывный.
 * Метка помещается ВНУТРЬ лимита, поэтому возвращённый текст его не превышает.
 * При лимите меньше двух меток она пропускается: отдать половину крошечного
 * бюджета служебной строке хуже, чем показать больше самого вывода.
 */
export function limitSshOutput(value: unknown, limitBytes: number): LimitedOutput {
  const clean = sanitizeSshText(value);
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

  const withGap = limit > GAP_BYTES * 2;
  const budget = withGap ? limit - GAP_BYTES : limit;
  const headLimit = Math.floor(budget / 2);
  const head = takeUtf8Prefix(source, headLimit);
  const tail = safeSuffix(source, budget - headLimit);
  const text = withGap
    ? `${head.toString('utf8')}${GAP_MARK}${tail.toString('utf8')}`
    : Buffer.concat([head, tail]).toString('utf8');
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
