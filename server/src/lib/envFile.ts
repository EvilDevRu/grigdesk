// Общая точечная правка env-файлов GrigDesk: корневого `.env` и любого другого файла
// формата `KEY=VALUE`. Один файл читают сразу три стороны: systemd (EnvironmentFile юнита),
// `node --env-file` (bin/grigdesk-ctl, deploy/restart.sh) и человек руками. Поэтому правка консервативна:
//   - меняются только строки названных переменных, остальные байты файла остаются как были;
//   - значение пишется без кавычек и только из символов, которые оба парсера читают одинаково;
//   - файл, где границу строки парсеры могут понять по-разному (многострочные значения,
//     перенос через `\`, незнакомый синтаксис), не правится вовсе — отказ с номером строки;
//   - запись атомарная (временный файл рядом + rename) с сохранением прав и проверкой,
//     что за время правки файл не поменял кто-то другой.
// Применять ли новые значения к окружению процесса — решает вызывающий: `applyEnvChanges`.
import { randomBytes } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';

import { withPathLock } from './pathLock.ts';

export type EnvFileErrorCode =
  | 'env_changes_invalid'
  | 'env_name_invalid'
  | 'env_value_invalid'
  | 'env_file_unsupported'
  | 'env_file_not_regular'
  | 'env_file_too_large'
  | 'env_file_conflict';

// Ошибка правки называет переменную и строку файла, но никогда не несёт значение:
// в .env лежат ключи, а сообщение уходит в журнал и в окно браузера.
export class EnvFileError extends Error {
  readonly code: EnvFileErrorCode;
  readonly line: number | null;

  constructor(code: EnvFileErrorCode, message: string, line: number | null = null) {
    super(message);
    this.name = 'EnvFileError';
    this.code = code;
    this.line = line;
  }
}

// Строка значения задаёт переменную, null удаляет её из файла.
export type EnvFileChanges = Readonly<Record<string, string | null>>;

export interface EnvFileUpdate {
  path: string;
  changed: string[];
}

// Физическая строка файла: текст без перевода строки, сам перевод и имя присваивания.
interface EnvLine {
  text: string;
  eol: string;
  key: string | null;
}

// Снимок файла до правки: по нему же проверяется, что файл не меняли параллельно.
interface EnvSnapshot {
  bytes: Buffer | null;
  mode: number;
}

const NAME_RE = /^[A-Z_][A-Z0-9_]*$/;
// Без пробелов, кавычек, `#`, `$`, `\` и `;`: systemd и Node читают такие символы по-разному.
const VALUE_RE = /^[A-Za-z0-9._~+/=:@%,-]*$/;
const ALLOWED_VALUE_CHARS = 'латиница, цифры и . _ ~ + / = : @ % , -';
const MAX_VALUE_LENGTH = 8192;
const MAX_FILE_BYTES = 1024 * 1024;
const CONFLICT_ATTEMPTS = 3;
const BOM = String.fromCharCode(0xfeff);

const COMMENT_RE = /^\s*(?:[#;]|$)/;
const ASSIGNMENT_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;
// После закрывающей кавычки допустимы только пробелы и простой комментарий.
const QUOTED_TAIL_RE = /^\s*(?:#[^"'`\\]*)?$/;

/**
 * Имя переменной, которое писатель согласен записать: латиница в верхнем регистре,
 * цифры и `_`. Тем же правилом пользуются декларации ключей исполнителей.
 */
export function isEnvName(name: string): boolean {
  return NAME_RE.test(name);
}

// Отсутствие файла — штатное состояние: его ещё не создали или он удалён.
function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

function unsupported(line: number, reason: string): EnvFileError {
  return new EnvFileError(
    'env_file_unsupported',
    `Строка ${line} файла окружения: ${reason}. Исправьте её вручную, тогда правка из GrigDesk заработает.`,
    line,
  );
}

/**
 * Значение в кавычках обязано закрыться на той же строке и одинаково для обоих парсеров.
 * Node берёт первую такую же кавычку, systemd пропускает экранированную, поэтому
 * экранирование перед закрывающей кавычкой и кавычки в хвосте считаются неоднозначными.
 */
function quotedValueIsSingleLine(value: string, quote: string): boolean {
  const closing = value.indexOf(quote, 1);

  if (closing < 0 || value[closing - 1] === '\\') {
    return false;
  }

  return QUOTED_TAIL_RE.test(value.slice(closing + 1));
}

/**
 * Определяет имя присваивания в строке или null для комментария и пустой строки.
 * Строка, чья граница неоднозначна для systemd и Node, делает весь файл неподдержанным:
 * иначе правка соседней переменной могла бы попасть внутрь чужого многострочного значения.
 */
function classifyLine(text: string, line: number): string | null {
  if (text.includes('\r') || text.includes('\0')) {
    throw unsupported(line, 'служебный символ внутри строки');
  }

  if (text.endsWith('\\')) {
    throw unsupported(line, 'перенос значения через обратную косую черту');
  }

  if (COMMENT_RE.test(text)) {
    return null;
  }

  const [, key, raw] = ASSIGNMENT_RE.exec(text) ?? [];

  if (!key) {
    throw unsupported(line, 'это не комментарий и не присваивание KEY=VALUE');
  }

  const value = (raw ?? '').trimStart();
  const quote = value[0];

  if ((quote === '"' || quote === "'" || quote === '`') && !quotedValueIsSingleLine(value, quote)) {
    throw unsupported(line, 'значение в кавычках продолжается на следующих строках');
  }

  return key;
}

/**
 * Делит текст на физические строки, сохраняя у каждой её собственный перевод строки.
 * Неизменённые строки потом собираются обратно байт в байт, включая CRLF и хвост без `\n`.
 */
function parseLines(text: string): EnvLine[] {
  const parts = text.split('\n');
  const lines: EnvLine[] = [];

  parts.forEach((raw, index) => {
    const last = index === parts.length - 1;

    if (last && raw === '') {
      return;
    }

    const crlf = !last && raw.endsWith('\r');
    const body = crlf ? raw.slice(0, -1) : raw;

    lines.push({
      text: body,
      eol: last ? '' : crlf ? '\r\n' : '\n',
      key: classifyLine(body, index + 1),
    });
  });

  return lines;
}

/**
 * Проверяет набор правок до чтения файла: имена в верхнем регистре, значения из
 * безопасного алфавита. Сообщение об ошибке называет переменную, но не значение.
 */
function validateChanges(changes: unknown): Map<string, string | null> {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
    throw new EnvFileError('env_changes_invalid', 'Правка окружения должна быть объектом KEY → значение.');
  }

  const planned = new Map<string, string | null>();

  for (const [name, value] of Object.entries(changes)) {
    if (!isEnvName(name)) {
      throw new EnvFileError('env_name_invalid', `Недопустимое имя переменной окружения: ${name}.`);
    }

    if (value !== null && typeof value !== 'string') {
      throw new EnvFileError('env_value_invalid', `Значение ${name} должно быть строкой.`);
    }

    if (typeof value === 'string' && (value.length > MAX_VALUE_LENGTH || !VALUE_RE.test(value))) {
      throw new EnvFileError(
        'env_value_invalid',
        `Значение ${name} нельзя записать в .env без искажений: допустимы ${ALLOWED_VALUE_CHARS}.`,
      );
    }

    planned.set(name, value);
  }

  return planned;
}

// Перевод строки для новых строк — тот, что преобладает в файле.
function dominantEol(lines: EnvLine[]): string {
  const crlf = lines.filter((line) => line.eol === '\r\n').length;
  const lf = lines.filter((line) => line.eol === '\n').length;

  return crlf > lf ? '\r\n' : '\n';
}

/**
 * Строка уже задаёт то же значение — переписывать её незачем. Равной считается только
 * точная запись без хвоста: `KEY=val # заметка` Node читает как `val`, а systemd — с хвостом.
 */
function lineHasValue(text: string, name: string, value: string): boolean {
  const assignment = text.trim().replace(/^export\s+/, '');

  return [`${name}=${value}`, `${name}="${value}"`, `${name}='${value}'`].includes(assignment);
}

/**
 * Убирает все присваивания имени: оставь хоть одно — после удаления ожило бы оно.
 * Комментарии вида `# KEY=…` не трогаются. Возвращает, была ли такая строка.
 */
function removeAssignments(lines: EnvLine[], name: string): boolean {
  let removed = false;

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index]?.key === name) {
      lines.splice(index, 1);
      removed = true;
    }
  }

  return removed;
}

/**
 * Задаёт значение: меняет последнее присваивание (оно действует и у systemd, и у Node)
 * или дописывает новое в конец файла. Возвращает, изменилась ли хоть одна строка.
 */
function setAssignment(lines: EnvLine[], name: string, value: string): boolean {
  const text = `${name}=${value}`;
  const current = lines.findLast((line) => line.key === name);

  if (current) {
    if (lineHasValue(current.text, name, value)) {
      return false;
    }

    current.text = text;

    return true;
  }

  const eol = dominantEol(lines);
  const tail = lines.at(-1);

  if (tail && !tail.eol) {
    tail.eol = eol;
  }

  lines.push({
    text,
    eol,
    key: name,
  });

  return true;
}

/**
 * Применяет правки к строкам по порядку набора. Возвращает только имена, чьи строки
 * действительно изменились: по пустому списку вызывающий понимает, что писать незачем.
 */
function applyToLines(lines: EnvLine[], planned: Map<string, string | null>): string[] {
  const changed: string[] = [];

  for (const [name, value] of planned) {
    const touched = value === null ? removeAssignments(lines, name) : setAssignment(lines, name, value);

    if (touched) {
      changed.push(name);
    }
  }

  return changed;
}

/**
 * Собирает новый текст файла. BOM и переводы строк неизменённых строк сохраняются;
 * байты, которые нельзя без потерь прочитать как UTF-8, делают файл неподдержанным.
 */
function planText(bytes: Buffer | null, planned: Map<string, string | null>): {
  text: string;
  changed: string[];
} {
  const source = bytes ? bytes.toString('utf8') : '';

  if (bytes && !Buffer.from(source, 'utf8').equals(bytes)) {
    throw new EnvFileError(
      'env_file_unsupported',
      'Файл окружения не в кодировке UTF-8: правка из GrigDesk отключена.',
    );
  }

  const bom = source.startsWith(BOM) ? BOM : '';
  const lines = parseLines(source.slice(bom.length));
  const changed = applyToLines(lines, planned);

  return {
    text: bom + lines.map((line) => line.text + line.eol).join(''),
    changed,
  };
}

/**
 * Реальный путь файла: правка идёт в цель ссылки, а сама ссылка остаётся ссылкой.
 * Висячая ссылка — отказ: rename заменил бы её обычным файлом.
 */
async function resolveTarget(envPath: string): Promise<string> {
  try {
    return await fs.realpath(envPath);
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
  }

  const stat = await fs.lstat(envPath).catch(() => null);

  if (stat?.isSymbolicLink()) {
    throw new EnvFileError('env_file_not_regular', `Ссылка ${envPath} ведёт на несуществующий файл.`);
  }

  return path.resolve(envPath);
}

/**
 * Читает файл, не следуя ссылкам, и проверяет, что его можно заменить без побочных
 * эффектов: обычный файл нашего пользователя, без жёстких ссылок, разумного размера.
 */
async function readSnapshot(target: string): Promise<EnvSnapshot> {
  let handle: fs.FileHandle;

  try {
    handle = await fs.open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (isMissing(error)) {
      return { bytes: null, mode: 0o600 };
    }

    throw error;
  }

  try {
    const stat = await handle.stat();

    if (!stat.isFile() || stat.nlink > 1) {
      throw new EnvFileError(
        'env_file_not_regular',
        `${target} — не обычный файл или у него есть жёсткие ссылки.`,
      );
    }

    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw new EnvFileError('env_file_not_regular', `${target} принадлежит другому пользователю.`);
    }

    if (stat.size > MAX_FILE_BYTES) {
      throw new EnvFileError('env_file_too_large', `${target} больше ${MAX_FILE_BYTES} байт.`);
    }

    return { bytes: await handle.readFile(), mode: stat.mode & 0o777 };
  } finally {
    await handle.close();
  }
}

/**
 * Текущие байты файла или null, если его нет. Нужны для сверки перед заменой
 * и для чтения значений; прочие ошибки чтения поднимаются вызывающему.
 */
async function readBytes(target: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(target);
  } catch (error) {
    if (isMissing(error)) {
      return null;
    }

    throw error;
  }
}

function sameBytes(left: Buffer | null, right: Buffer | null): boolean {
  return left === null || right === null ? left === right : left.equals(right);
}

/**
 * Каталог синхронизируется после rename, чтобы новая запись пережила сброс питания.
 * Файловые системы без fsync каталога не считаются ошибкой правки.
 */
async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, fsConstants.O_RDONLY).catch(() => null);

  if (!handle) {
    return;
  }

  try {
    await handle.sync();
  } catch {
    // fsync каталога поддерживают не все файловые системы.
  } finally {
    await handle.close();
  }
}

/**
 * Пишет текст во временный файл рядом с целью, выставляет права и сбрасывает его на диск.
 * Уникальное имя и флаг `wx` не дают задеть чужой файл; при сбое временный файл удаляется.
 */
async function writeTempFile(target: string, text: string, mode: number): Promise<string> {
  const suffix = `${process.pid}-${randomBytes(6).toString('hex')}`;
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${suffix}.tmp`);
  const handle = await fs.open(tmp, 'wx', 0o600);

  try {
    await handle.writeFile(text, 'utf8');
    await handle.chmod(mode);
    await handle.sync();

    return tmp;
  } catch (error) {
    await fs.unlink(tmp).catch(() => undefined);

    throw error;
  } finally {
    await handle.close();
  }
}

/**
 * Подменяет файл новым текстом через rename, если он не изменился со снимка.
 * Права берутся у прежнего файла. Конфликт даёт false, и цель остаётся нетронутой.
 */
async function replaceFile(target: string, text: string, snapshot: EnvSnapshot): Promise<boolean> {
  const tmp = await writeTempFile(target, text, snapshot.mode);
  let replaced = false;

  try {
    if (sameBytes(await readBytes(target), snapshot.bytes)) {
      await fs.rename(tmp, target);
      replaced = true;
    }
  } finally {
    if (!replaced) {
      await fs.unlink(tmp).catch(() => undefined);
    }
  }

  if (replaced) {
    await syncDirectory(path.dirname(target));
  }

  return replaced;
}

/**
 * Точечно задаёт и удаляет переменные в env-файле. Возвращает реальный путь и имена,
 * чьи строки действительно изменились; без изменений файл не переписывается.
 * Параллельную правку другим процессом распознаёт и повторяет чтение, затем отказывает.
 */
export async function updateEnvFile(envPath: string, changes: EnvFileChanges,
  options: { expected?: Readonly<Record<string, string | null>> } = {}): Promise<EnvFileUpdate> {
  const planned = validateChanges(changes);
  const target = await resolveTarget(envPath);

  return withPathLock(target, async () => {
    for (let attempt = 0; attempt < CONFLICT_ATTEMPTS; attempt += 1) {
      const snapshot = await readSnapshot(target);
      const { text, changed } = planText(snapshot.bytes, planned);
      const current = parseEnv(snapshot.bytes?.toString('utf8') ?? '');

      for (const [name, expected] of Object.entries(options.expected ?? {})) {
        if ((current[name] ?? null) !== expected) {
          throw new EnvFileError('env_file_conflict', 'Настройка изменилась после подготовки правки.');
        }
      }

      if (!changed.length) {
        return { path: target, changed };
      }

      if (await replaceFile(target, text, snapshot)) {
        return { path: target, changed };
      }
    }

    throw new EnvFileError('env_file_conflict', `${target} меняется параллельно; повторите правку позже.`);
  });
}

/**
 * Проверяет будущую правку тем же парсером и алфавитом, что атомарный писатель.
 * Сухой прогон переноса получает результат без открытия или изменения файлов.
 */
export function previewEnvFile(bytes: Buffer | null, changes: EnvFileChanges): {
  text: string;
  changed: string[];
} {
  return planText(bytes, validateChanges(changes));
}

/**
 * Значения файла так, как их видит `node --env-file`. Нет файла — пустой объект.
 * Нужен для сведений «задано ли в файле»; значения наружу не отдаются.
 */
export async function readEnvFile(envPath: string): Promise<Record<string, string>> {
  const bytes = await readBytes(envPath);

  return bytes ? parseEnv(bytes.toString('utf8')) as Record<string, string> : {};
}

/**
 * Переносит уже записанные правки в окружение процесса, чтобы они действовали без
 * перезапуска. Вызывать только после успешного `updateEnvFile` с тем же набором.
 */
export function applyEnvChanges(changes: EnvFileChanges, env: NodeJS.ProcessEnv = process.env): void {
  for (const [name, value] of Object.entries(changes)) {
    if (value === null) {
      delete env[name];
    } else {
      env[name] = value;
    }
  }
}

/**
 * Переименовывает ключи на месте, сохраняя кавычки, пробелы и комментарии.
 * Две формы допустимы лишь с одинаковыми значениями; секреты не попадают в ошибку.
 */
export function renameEnvKeys(content: Buffer, names: Readonly<Record<string, string>>): string {
  const source = previewEnvFile(content, {}).text;
  const bom = source.startsWith(BOM) ? BOM : '';
  const lines = parseLines(source.slice(bom.length));

  for (const [oldKey, newKey] of Object.entries(names)) {
    if (!isEnvName(oldKey) || !isEnvName(newKey) || oldKey === newKey) {
      throw new EnvFileError('env_name_invalid', 'Недопустимое переименование ключа.');
    }

    const oldLines = lines.filter((line) => line.key === oldKey);
    const newLines = lines.filter((line) => line.key === newKey);
    const values = new Set([...oldLines, ...newLines].map((line) => parseEnv(line.text)[line.key!]));

    if (oldLines.length && values.size > 1) {
      throw new EnvFileError('env_file_conflict', `Разные значения у ${oldKey} и ${newKey}.`);
    }

    if (newLines.length) {
      removeAssignments(lines, oldKey);
    } else {
      for (const line of oldLines) {
        line.text = line.text.replace(/^(\s*(?:export\s+)?)\w+(\s*=)/, `$1${newKey}$2`);
        line.key = newKey;
      }
    }
  }

  return bom + lines.map((line) => line.text + line.eol).join('');
}

/**
 * Меняет только значение указанной строки, сохраняя обрамление и хвост комментария.
 * Сложное экранирование отклоняется, чтобы перенос пути не изменил смысл настройки.
 */
function rewriteAssignment(line: EnvLine, next: string): string {
  const assignment = /^(\s*(?:export\s+)?\w+\s*=\s*)(.*)$/.exec(line.text)!;
  const raw = assignment[2]!;
  const quote = ['"', "'", '`'].includes(raw[0] ?? '') ? raw[0]! : '';
  const start = quote.length;
  const end = quote ? raw.indexOf(quote, 1) : (raw.indexOf('#') < 0 ? raw.length : raw.indexOf('#'));
  const literal = raw.slice(start, end).trimEnd();
  const value = parseEnv(line.text)[line.key!];

  if (literal !== value || next.includes('\n') || (quote && next.includes(quote))) {
    throw new EnvFileError('env_file_unsupported', `Неоднозначная запись ${line.key}.`);
  }

  return assignment[1] + raw.slice(0, start) + next + raw.slice(start + literal.length);
}

/**
 * Подготавливает перенос абсолютных значений без записи файла и без потери комментариев.
 * Возвращает только текст; права и резервную копию обеспечивает вызывающая транзакция.
 */
export function rewriteEnvValues(
  content: Buffer, rewrite: (value: string) => string, defaults: Readonly<Record<string, string>> = {},
): string {
  const source = previewEnvFile(content, {}).text;
  const bom = source.startsWith(BOM) ? BOM : '';
  const lines = parseLines(source.slice(bom.length));
  const result: string[] = [];

  for (const line of lines) {
    if (!line.key) {
      result.push(line.text + line.eol);
      continue;
    }

    const value = parseEnv(line.text)[line.key]!;
    const next = rewrite(value);

    if (defaults[line.key] === next) {
      const raw = line.text.slice(line.text.indexOf('=') + 1).trimStart();
      const quoted = ['"', "'", '`'].includes(raw[0] ?? '');
      const tail = quoted ? raw.slice(raw.indexOf(raw[0]!, 1) + 1) : raw;
      const comment = tail.indexOf('#');

      if (comment >= 0) {
        result.push(tail.slice(comment) + line.eol);
      }

      continue;
    }

    result.push((next === value ? line.text : rewriteAssignment(line, next)) + line.eol);
  }

  return bom + result.join('');
}
