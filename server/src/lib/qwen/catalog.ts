import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { qwenConfig, readQwenSnapshot, type QwenSnapshot } from './settings.ts';
import { qwenDiscoveryError, resolveQwenSnapshot } from './discovery.ts';
import { classifyQwenModel } from './modelClassification.ts';
import { openQwenTransport, record } from './transport.ts';
import { qwenEffortOption, qwenSelectedModel } from './modelMetadata.ts';
import { qwenPreviewModelId } from './previewModels.ts';

const catalogProblems = new Map<string, string>();

interface SelectedPreviewModel {
  id: string;
  configOptions: unknown;
  entry: Record<string, unknown>;
}

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

  if (reason.includes('Preview.2')) {
    return 'Qwen Code несовместим с этой поставкой GrigDesk. Требуется проверенный Qwen Code 1.0 Preview.2.';
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
  selected?: SelectedPreviewModel,
) {
  return snapshot.models.flatMap((model) => {
    const nativeId = qwenPreviewModelId(model);

    if (!nativeId) {
      return [];
    }

    const confirmed = selected?.id === nativeId ? selected : undefined;
    const context = record(confirmed?.entry._meta).contextLimit
      ?? record(model.entry.generationConfig).contextWindowSize;
    const effort = qwenEffortOption(confirmed?.configOptions);
    const classification = classifyQwenModel(model.entry.id);
    const nonChat = model.nonChat === true || classification !== null;

    return [{
      id: model.id,
      name: String(model.entry.name || confirmed?.entry.name || model.entry.id),
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
 * Изолированный CLI подтверждает текущий маршрут без prompt и сторонних MCP.
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
 * Preview.2 сообщает одну текущую модель в ACP, даже когда настроено несколько.
 * Проверяем старт на первом маршруте и публикуем проверенный сервером список настроек.
 */
async function loadQwenCatalog(
  config: unknown,
  discovery: Parameters<typeof resolveQwenSnapshot>[1],
) {
  const snapshot = await resolveQwenSnapshot(config, { ...discovery, refresh: true });

  const first = snapshot.models.find((model) => qwenPreviewModelId(model));

  if (!first) {
    return [];
  }

  const nativeId = qwenPreviewModelId(first);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-metadata-'));
  const cwd = qwenConfig(config).rootDir || path.join(root, 'workspace');

  await fs.mkdir(cwd, { recursive: true });

  try {
    const transport = await openQwenTransport(config, snapshot, {
      cwd,
      home: path.join(root, 'home'),
      authType: first.authType,
      mode: 'default',
      nativeModelId: nativeId,
    });

    try {
      const session = record(await transport.client.request('session/new', { cwd, mcpServers: [] }));
      const selected = qwenSelectedModel(session.configOptions);

      if (selected !== nativeId) {
        throw new Error('Qwen Preview.2: CLI не подтвердил модель для проверки каталога.');
      }

      const available = record(session.models).availableModels;
      const item = Array.isArray(available)
        ? available.map(record).find((model) => model.modelId === selected)
        : undefined;

      return projectQwenModels(snapshot, {
        id: selected,
        configOptions: session.configOptions,
        entry: item ?? {},
      });
    } finally {
      await transport.close();
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
