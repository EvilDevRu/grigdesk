import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readQwenSnapshot, qwenConfig, type QwenSnapshot } from './settings.ts';
import { openQwenTransport, record } from './transport.ts';

/**
 * Публичная metadata не содержит endpoint или конфигурацию доступа.
 * Неизвестные контекст и усилие остаются неизвестными, без выдуманных ступеней.
 */
export function projectQwenModels(snapshot: QwenSnapshot, available?: unknown) {
  const native = Array.isArray(available) ? available.map(record) : null;

  return snapshot.models.flatMap((model) => {
    const confirmed = native?.find((entry) => entry.modelId === model.id);

    if (native && !confirmed) {
      return [];
    }

    const context = record(model.entry.generationConfig).contextWindowSize;

    return [{
      id: model.id,
      name: String(confirmed?.name || model.entry.name || model.entry.id),
      family: 'default',
      ...(typeof context === 'number' && context > 0 ? { context } : { contextUnverified: true }),
      efforts: [] as string[],
    }];
  });
}

/**
 * Изолированный CLI сообщает свои native ids без prompt и сторонних MCP.
 * Одноразовая metadata-сессия не пишет models.json или настройки владельца.
 */
export async function qwenCatalog(config: unknown) {
  const snapshot = readQwenSnapshot(config);

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

      return projectQwenModels(snapshot, record(session.models).availableModels);
    } finally {
      await transport.close();
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
