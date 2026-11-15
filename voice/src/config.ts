import path from 'node:path';

import { QWEN_SERVICES } from './args.ts';
import type { QwenService } from './args.ts';
import { VoiceError } from './contract.ts';

export interface VoiceInputs {
  service?: string | null;
  apiKey?: string | null;
  dir?: string | null;
}

export interface VoiceConfig {
  qwenService: QwenService;
  qwenApiKey: string | null;
  qwenBaseUrl: string;
  voiceDir: string;
}

export type VoiceEnv = Readonly<Record<string, string | undefined>>;

/**
 * Выбирает первый непустой явный источник без файловых fallback.
 * Сохраняет исходное значение до проверки управляющих символов ключа.
 */
function firstValue(values: readonly (string | null | undefined)[]): string | null {
  for (const value of values) {
    if (value !== null && value !== undefined && value.trim() !== '') {
      return value;
    }
  }

  return null;
}

/**
 * Проверяет только форму адреса API, не выполняя сетевую пробу.
 * Credentials, query и fragment запрещены, чтобы адрес не стал скрытым источником доступа.
 */
function normalizeBaseUrl(value: string): string {
  let url: URL;

  try {
    url = new URL(value.trim());
  } catch {
    throw new VoiceError('Некорректный GRIGDESK_VOICE_QWEN_BASE_URL.', 2);
  }

  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new VoiceError('Адрес Qwen должен быть HTTP(S) без имени пользователя и пароля.', 2);
  }

  if (url.search || url.hash) {
    throw new VoiceError('Адрес Qwen не должен содержать query или fragment.', 2);
  }

  return url.toString().replace(/\/+$/u, '');
}

/**
 * Разрешает конфигурацию только из аргументов и уже переданного окружения процесса.
 * Не читает хранилища сервера и не сохраняет ключ на диск.
 */
export function resolveVoiceConfig(
  inputs: VoiceInputs,
  env: VoiceEnv,
  home: string,
): VoiceConfig {
  const service = firstValue([inputs.service, env.GRIGDESK_VOICE_QWEN_SERVICE]) ?? 'model-studio';
  const qwenService = QWEN_SERVICES.find((known) => known === service.trim());

  if (!qwenService) {
    throw new VoiceError('Неизвестный сервис Qwen: выберите model-studio или qwencloud-token.', 2);
  }

  const rawKey = firstValue([
    inputs.apiKey,
    env.GRIGDESK_VOICE_QWEN_API_KEY,
    qwenService === 'qwencloud-token' ? env.TOKEN_PLAN_API_KEY : null,
    env.DASHSCOPE_API_KEY,
  ]);

  if (rawKey !== null && /[\r\n\u0000]/u.test(rawKey)) {
    throw new VoiceError('Ключ Qwen содержит недопустимые управляющие символы.');
  }

  const baseUrl = firstValue([env.GRIGDESK_VOICE_QWEN_BASE_URL])
    ?? (qwenService === 'qwencloud-token'
      ? 'https://token-plan.maas.qwencloudapi.com' : 'https://dashscope-intl.aliyuncs.com');
  const directory = firstValue([inputs.dir, env.GRIGDESK_VOICE_DIR])
    ?? path.join(home, '.grigdesk', 'voice');

  return {
    qwenService,
    qwenApiKey: rawKey?.trim() ?? null,
    qwenBaseUrl: normalizeBaseUrl(baseUrl),
    voiceDir: path.resolve(directory),
  };
}

/**
 * Короткая подпись ключа предназначена для явно разрешённого диагностического вывода.
 * Ключ длиной до двух символов скрывается целиком, а пустое значение остаётся пустым.
 */
export function maskSecret(value: string): string {
  if (value === '') {
    return '';
  }

  if (value.length <= 2) {
    return '***';
  }

  return `***${value.slice(-2)}`;
}

/**
 * Последняя граница диагностики удаляет все известные явные ключи целиком.
 * Literal split не интерпретирует ключ как регулярное выражение или шаблон подстановки.
 */
export function redactSecrets(message: string, secrets: readonly (string | null | undefined)[]): string {
  let result = message;
  const values = new Set<string>();

  for (const secret of secrets) {
    if (secret) {
      values.add(secret);

      if (secret.trim()) {
        values.add(secret.trim());
      }
    }
  }

  for (const secret of [...values].sort((left, right) => right.length - left.length)) {
    result = result.split(secret).join('[ключ скрыт]');
  }

  return result;
}
