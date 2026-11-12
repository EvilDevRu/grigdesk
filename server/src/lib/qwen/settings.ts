import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse, type ParseError } from 'jsonc-parser';

import { isRecord } from '../../../../shared/lib/objects.ts';

export interface QwenConfig {
  rootDir?: string;
  dataHome?: string;
  qwenBin?: string;
  qwenHome?: string;
  qwenRuntimeHome?: string;
  artifactsDir?: string;
}

export interface QwenModel {
  id: string;
  authType: string;
  entry: Record<string, unknown>;
}

export interface QwenSnapshot {
  models: QwenModel[];
  settings: Record<string, unknown>;
  fingerprint: string;
  envKeys: string[];
}

export const qwenConfig = (value: unknown): QwenConfig => isRecord(value) ? value : {};

export const qwenBin = (value: unknown): string =>
  qwenConfig(value).qwenBin || process.env.GRIGDESK_QWEN_BIN || 'qwen';

/**
 * Имена доступа не могут менять загрузчик, команду или окружение хоста.
 * Такой же предикат применяется к настройкам, карточке и доставке ключей этапа.
 */
export function safeQwenEnvKey(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]*$/.test(value)
    && !/^(?:PATH|HOME|SHELL|ENV|BASH_ENV|IFS|CDPATH|TMPDIR|USER|LOGNAME|PWD|OLDPWD)$/.test(value)
    && !/^(?:NODE_|LD_|DYLD_|GRIGDESK_|FACTORY_|QWEN_CODE_|NPM_)/i.test(value)
    && !/^(?:QWEN_HOME|QWEN_RUNTIME_DIR|QWEN_CONVERSATIONS_DIR)$/.test(value);
}

/**
 * Слои читаются по содержимому, без доверия к mtime; повреждение даёт явный отказ.
 * modelProviders заменяется целиком, как в native settings CLI, а ключи не копируются.
 */
export function readQwenSnapshot(value: unknown): QwenSnapshot {
  const config = qwenConfig(value);
  const home = config.qwenHome || process.env.GRIGDESK_QWEN_HOME || process.env.QWEN_HOME
    || path.join(os.homedir(), '.qwen');
  const files = [
    process.env.QWEN_CODE_SYSTEM_DEFAULTS_PATH || '/etc/qwen-code/system-defaults.json',
    path.join(home, 'settings.json'),
    path.join(config.rootDir || process.cwd(), '.qwen/settings.json'),
    process.env.QWEN_CODE_SYSTEM_SETTINGS_PATH || '/etc/qwen-code/settings.json',
  ];
  const inputs: unknown[] = [];
  let providers: Record<string, unknown> = {};
  let preferredModel: string | undefined;
  let preferredAuthType: string | undefined;

  for (const file of files) {
    let text = '';

    try {
      text = readFileSync(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }

    inputs.push([file, text]);

    if (!text) {
      continue;
    }

    const errors: ParseError[] = [];
    const layer: unknown = parse(text, errors, { allowTrailingComma: true });

    if (errors.length || !isRecord(layer)) {
      throw new Error('Qwen: повреждён JSON конфигурации моделей');
    }

    if (Object.hasOwn(layer, 'modelProviders')) {
      providers = isRecord(layer.modelProviders) ? layer.modelProviders : {};
    }

    if (isRecord(layer.model) && typeof layer.model.name === 'string') {
      preferredModel = layer.model.name;
    }

    const auth = isRecord(layer.security) && isRecord(layer.security.auth) ? layer.security.auth : {};

    if (typeof auth.selectedType === 'string') {
      preferredAuthType = auth.selectedType;
    }
  }

  const models: QwenModel[] = [];
  const envKeys = new Set(['DASHSCOPE_API_KEY']);
  const sanitized: Record<string, unknown[]> = {};

  for (const [authType, entries] of Object.entries(providers)) {
    if (!Array.isArray(entries)) {
      continue;
    }

    for (const entry of entries) {
      if (!isRecord(entry) || typeof entry.id !== 'string' || !entry.id
        || !safeQwenEnvKey(entry.envKey)) {
        continue;
      }

      envKeys.add(entry.envKey);

      const { apiKey: _secret, ...safe } = entry;
      const model = {
        id: `${entry.id}(${authType})`,
        authType,
        entry: safe,
      };

      if (!models.some((old) => old.id === model.id)) {
        models.push(model);
        (sanitized[authType] ??= []).push(safe);
      }
    }
  }

  // Выбранный доступный маршрут CLI становится default-предпочтением раннера.
  // При одинаковом bare id тип авторизации сохраняет точный маршрут модели.
  const preferred = models.findIndex((model) => model.entry.id === preferredModel
    && (!preferredAuthType || model.authType === preferredAuthType));

  if (preferred > 0) {
    models.unshift(...models.splice(preferred, 1));
  }

  const settings = {
    modelProviders: sanitized,
    // Прямые имена MCP проходят final guard; скрывающий их ToolCall-мост не выдаётся.
    // При отключённом поиске CLI объявляет разрешённые MCP-инструменты сразу.
    tools: { toolSearch: { enabled: false } },
    telemetry: { enabled: false },
    general: { enableAutoUpdate: false },
    security: { auth: { selectedType: models[0]?.authType || 'openai' } },
    model: { name: models[0]?.entry.id || '' },
  };
  const fingerprint = createHash('sha256').update(JSON.stringify([
    inputs, qwenBin(config), [...envKeys].map((key) => [key, process.env[key] || '']),
  ])).digest('hex');

  return {
    models,
    settings,
    fingerprint,
    envKeys: [...envKeys],
  };
}

/**
 * Проекция credentials сохраняет динамические имена как данные интерфейса.
 * Ошибка конфигурации не скрывает возможность задать основной ключ через окно.
 */
export function qwenCredentials(config: unknown) {
  let names = ['DASHSCOPE_API_KEY'];

  try {
    names = readQwenSnapshot(config).envKeys;
  } catch {
    // Повреждённый источник диагностируется каталогом, writer остаётся доступен.
  }

  return names.map((env) => ({
    env,
    kind: 'secret',
    label: env === 'DASHSCOPE_API_KEY' ? 'Ключ API' : env,
    ...(env === 'DASHSCOPE_API_KEY' ? { hint: 'Ключ API сервиса модели.' } : {}),
  }));
}
