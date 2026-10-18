import { parseEnv } from 'node:util';

import { dataHome, envFilePath } from '../../shared/runtime/dataHome.ts';
import type { DataHomeEnv } from '../../shared/runtime/dataHome.ts';
import { resolveRuntimeSettings } from '../../shared/runtime/runtimeSettings.ts';
import type { Settings } from '../../shared/runtime/runtimeSettings.ts';
import { B24Error } from './errors.ts';

export interface Connection {
  baseUrl: string;
  token: string;
}

export interface ConfigIO {
  getHome(): string;
  readText(file: string): Promise<string | null>;
}

const ADDRESS_ERROR = 'Некорректный адрес GrigDesk: нужен HTTP(S) URL без учётных данных и query.';
const PORT_ERROR = 'Некорректный порт GrigDesk: нужно целое число от 1 до 65535.';
const TOKEN_ERROR = 'Некорректный токен GrigDesk.';

/**
 * Проверяет адрес GrigDesk и убирает конечные слэши перед добавлением /api/b24.
 * Учётные данные, query, fragment и чужие протоколы отвергаются до HTTP.
 */
function baseUrlOf(value: string): string {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new B24Error(1, ADDRESS_ERROR);
  }

  const plain = url.username === '' && url.password === '' && url.search === '' && url.hash === ''
    && !value.includes('?') && !value.includes('#');

  if (!['http:', 'https:'].includes(url.protocol) || !plain) {
    throw new B24Error(1, ADDRESS_ERROR);
  }

  return url.href.replace(/\/+$/, '');
}

/**
 * Токен окружения передаётся без изменений, но не может быть пробельным.
 * CR, LF и NUL сломали бы заголовок, поэтому такой токен отвергается.
 */
function checkedToken(token: string): string {
  if (token.trim() === '' || /[\r\n\0]/.test(token)) {
    throw new B24Error(1, TOKEN_ERROR);
  }

  return token;
}

/**
 * Переводит отказ общей логики папки и настроек в код 1 с её русским текстом.
 * Неизвестные ошибки чтения остаются у вызывающего.
 */
function settingsFailure(error: unknown): B24Error {
  return error instanceof B24Error ? error : new B24Error(1, (error as Error).message);
}

/**
 * Читает выбранный файл настроек как данные: ENOENT — пустой набор.
 * Любой другой отказ называет только путь файла.
 */
async function readSettingsFile(env: DataHomeEnv, home: string, io: ConfigIO): Promise<Settings> {
  let file: string;

  try {
    dataHome({
      env,
      home,
    });
    file = envFilePath({
      env,
      home,
    });
  } catch (error) {
    throw settingsFailure(error);
  }

  let text: string | null;

  try {
    text = await io.readText(file);
  } catch {
    throw new B24Error(1, `Не удалось прочитать настройки: ${file}.`);
  }

  try {
    return resolveRuntimeSettings({
      env,
      file: text === null ? {} : parseEnv(text),
      home,
    });
  } catch (error) {
    throw settingsFailure(error);
  }
}

/**
 * Читает токен из файла настроек; отсутствие и отказ чтения дают одну ошибку.
 * Значение обрезается только здесь, токен окружения не меняется.
 */
async function readToken(file: string, io: ConfigIO): Promise<string> {
  let text: string | null;

  try {
    text = await io.readText(file);
  } catch {
    text = null;
  }

  const token = text?.trim() ?? '';

  if (token === '') {
    throw new B24Error(1, `Нет токена: ${file}.`);
  }

  return checkedToken(token);
}

/**
 * Вычисляет адрес и токен GrigDesk в фиксированном порядке контракта b24.
 * Явные GRIGDESK_URL и GRIGDESK_TOKEN не трогают папку данных и файлы.
 */
export async function resolveConnection(env: DataHomeEnv, io: ConfigIO): Promise<Connection> {
  const explicitUrl = env.GRIGDESK_URL ?? '';
  const explicitToken = env.GRIGDESK_TOKEN ?? '';

  if (explicitUrl !== '' && explicitToken !== '') {
    return {
      baseUrl: baseUrlOf(explicitUrl),
      token: checkedToken(explicitToken),
    };
  }

  const home = env.HOME || io.getHome();
  const settings = await readSettingsFile(env, home, io);
  let baseUrl: string;

  if (explicitUrl !== '') {
    baseUrl = baseUrlOf(explicitUrl);
  } else if (Number.isInteger(settings.port) && settings.port >= 1 && settings.port <= 65535) {
    baseUrl = `http://localhost:${settings.port}`;
  } else {
    throw new B24Error(1, PORT_ERROR);
  }

  const token = explicitToken !== ''
    ? checkedToken(explicitToken)
    : await readToken(settings.cliTokenPath, io);

  return {
    baseUrl,
    token,
  };
}
