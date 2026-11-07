// Учётка для входа на стенд: как сервер достаёт секрет по ссылке из login.json.
//
// В объявлении профиля лежит только ССЫЛКА вида «<файл>:<ключ логина>:<ключ пароля>».
// Файл живёт в каталоге профиля и читается как строки KEY=value — без исполнения:
// profile.sh и lib.sh профиля написаны на shell, и запускать их ради двух значений
// значило бы исполнять чужой код внутри сервера.
//
// Сами значения дальше сервера и исполнителя записи не уходят: ни в ответы ручек,
// ни в промпт модели, ни в журнал попытки.
import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface LoginCredentials {
  user: string;
  password: string;
}

export interface CredentialsRef {
  file: string;
  userKey: string;
  passwordKey: string;
}

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Разбор ссылки. Путь к файлу ограничен каталогом профиля: ссылка приходит из
 * объявления, которому сервер доверяет, но «../.state/…» из него всё равно не
 * должно читаться.
 */
export function parseCredentialsRef(ref: string): CredentialsRef | null {
  const [file = '', userKey = '', passwordKey = ''] = String(ref).split(':');
  const normalized = path.posix.normalize(file);

  if (!file || path.isAbsolute(file) || normalized.startsWith('..') || file.includes('\\')) {
    return null;
  }

  if (!KEY_RE.test(userKey) || !KEY_RE.test(passwordKey)) {
    return null;
  }

  return { file: normalized, userKey, passwordKey };
}

/**
 * Значение переменной из файла вида KEY=value. Кавычки обеих форм снимаются,
 * `export` впереди допускается, остальное остаётся как есть — раскрывать `$VAR`
 * и подстановки здесь незачем и опасно.
 */
export function readEnvValue(text: string, key: string): string {
  const pattern = new RegExp(`^(?:export\\s+)?${key}=(?:"([^"]*)"|'([^']*)'|([^\\s#]*))\\s*(?:#.*)?$`, 'm');
  const match = pattern.exec(text);

  return String(match?.[1] ?? match?.[2] ?? match?.[3] ?? '');
}

/**
 * Учётка по ссылке. Отсутствие файла или ключа — обычное состояние чужой
 * установки, а не поломка: вызывающий получает `null` и сам решает, что без входа
 * запись не имеет смысла.
 */
export async function readLoginCredentials(
  profileDir: string,
  ref: string,
): Promise<LoginCredentials | null> {
  const parsed = parseCredentialsRef(ref);

  if (!parsed) {
    return null;
  }

  const text = await fs.readFile(path.join(profileDir, parsed.file), 'utf8').catch(() => '');

  if (!text) {
    return null;
  }

  const user = readEnvValue(text, parsed.userKey);
  const password = readEnvValue(text, parsed.passwordKey);

  return user && password ? { user, password } : null;
}
