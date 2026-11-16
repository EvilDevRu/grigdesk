import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { qwenConfig, readQwenSnapshot, type QwenSnapshot } from './settings.ts';
import { qwenDiscoveryError, resolveQwenSnapshot } from './discovery.ts';
import { classifyQwenModel } from './modelClassification.ts';
import { openQwenTransport, record } from './transport.ts';
import { qwenEffortOption } from './modelMetadata.ts';

const catalogProblems = new Map<string, string>();

/**
 * Отказ native-каталога относится к конкретному доступу и не раскрывает вывод CLI.
 * Повреждённый источник настроек также не выдаётся за готовое подключение.
 */
export function qwenCatalogError(config: unknown): string | undefined {
  try {
    return catalogProblems.get(readQwenSnapshot(config).fingerprint);
  } catch {
    return 'Qwen: не удалось прочитать настройки моделей. Проверьте конфигурацию Qwen Code.';
  }
}

/**
 * В карточку попадают собственные пояснения, а не stderr с возможными секретами.
 * Ошибка API уже очищена discovery и сохраняет сервис и HTTP-код отказа.
 */
function catalogProblem(config: unknown, error: unknown): string {
  const discovery = qwenDiscoveryError(config);

  if (discovery) {
    return discovery;
  }

  const reason = error instanceof Error ? error.message : '';

  if (reason.includes('несовместимый протокол обязательного guard')) {
    return 'Qwen Code несовместим с GrigDesk. Обновите или переустановите Qwen Code в разделе «Обзор».';
  }

  if (reason.includes('песочница bwrap')) {
    return 'Qwen: недоступна песочница для запуска. На сервере Linux требуется установленный bwrap.';
  }

  return 'Qwen Code не смог загрузить модели. Нажмите «Перепроверить». '
    + 'Если ошибка повторится, обновите или переустановите Qwen Code в разделе «Обзор».';
}

/**
 * Публичная metadata не содержит endpoint или конфигурацию доступа.
 * Неизвестные контекст и усилие остаются неизвестными, без выдуманных ступеней.
 * CLI не объявляет линию замены моделей: общее семейство скрыло бы весь каталог,
 * оставив одну случайную модель вместо Qwen, GLM и других доступных маршрутов.
 * Нечат-пригодность объявляют данные: явная модальность сервиса и таблица семейств;
 * неизвестная модель остаётся чатовой.
 */
export function projectQwenModels(
  snapshot: QwenSnapshot,
  available?: unknown,
  optionsByModel: ReadonlyMap<string, unknown> = new Map(),
) {
  const native = Array.isArray(available) ? available.map(record) : null;

  return snapshot.models.flatMap((model) => {
    const confirmed = native?.find((entry) => entry.modelId === model.id);

    if (native && !confirmed) {
      return [];
    }

    const context = record(confirmed?._meta).contextLimit
      ?? record(model.entry.generationConfig).contextWindowSize;
    const effort = qwenEffortOption(optionsByModel.get(model.id));
    const classification = classifyQwenModel(model.entry.id);
    const nonChat = model.nonChat === true || classification !== null;

    return [{
      id: model.id,
      name: String(confirmed?.name || model.entry.name || model.entry.id),
      ...(typeof context === 'number' && context > 0 ? { context } : { contextUnverified: true }),
      efforts: effort?.levels ?? [],
      ...(model.createdAt ? { createdAt: model.createdAt } : {}),
      ...(nonChat ? {
        nonChat: true,
        nonChatReason: model.nonChatReason || classification?.reason || '',
      } : {}),
    }];
  });
}

/**
 * Изолированный CLI сообщает свои native ids без prompt и сторонних MCP.
 * Одноразовая metadata-сессия не пишет models.json или настройки владельца.
 */
export async function qwenCatalog(
  config: unknown,
  discovery: Parameters<typeof resolveQwenSnapshot>[1] = {},
) {
  const source = readQwenSnapshot(config);

  try {
    const models = await loadQwenCatalog(config, discovery);

    if (!models.length) {
      catalogProblems.set(source.fingerprint,
        'Qwen Code не вернул модели. Проверьте сервис и ключ на вкладке «Доступ», '
        + 'затем нажмите «Перепроверить».');
    } else {
      catalogProblems.delete(source.fingerprint);
    }

    return models;
  } catch (error) {
    catalogProblems.set(source.fingerprint, catalogProblem(config, error));

    throw error;
  } finally {
    while (catalogProblems.size > 16) {
      catalogProblems.delete(catalogProblems.keys().next().value!);
    }
  }
}

/**
 * Ошибка чтения или подтверждения моделей передаётся общей обёртке каталога.
 * Временная metadata-сессия завершается при любом исходе без пользовательского prompt.
 */
async function loadQwenCatalog(
  config: unknown,
  discovery: Parameters<typeof resolveQwenSnapshot>[1],
) {
  const snapshot = await resolveQwenSnapshot(config, { ...discovery, refresh: true });

  if (!snapshot.models.length) {
    return [];
  }

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-metadata-'));
  const cwd = qwenConfig(config).rootDir || path.join(root, 'workspace');

  await fs.mkdir(cwd, { recursive: true });

  try {
    const transport = await openQwenTransport(config, snapshot, {
      cwd,
      home: path.join(root, 'home'),
      authType: snapshot.models[0]!.authType,
      mode: 'default',
    });

    try {
      const session = record(await transport.client.request('session/new', { cwd, mcpServers: [] }));
      const available = record(session.models).availableModels;
      const options = new Map<string, unknown>();

      if (Array.isArray(session.configOptions) && Array.isArray(available)) {
        const currentId = record(session.models).currentModelId;

        for (const entry of available.map(record)) {
          if (typeof entry.modelId !== 'string'
            || !snapshot.models.some((model) => model.id === entry.modelId)) {
            continue;
          }

          const selected = entry.modelId === currentId ? session : record(await transport.client.request(
            'session/set_config_option', {
              sessionId: session.sessionId,
              configId: 'model',
              value: entry.modelId,
            },
          ));

          options.set(entry.modelId, selected.configOptions);
        }
      }

      return projectQwenModels(snapshot, available, options);
    } finally {
      await transport.close();
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
