import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let storageModule;
let storageModuleError;
try {
  storageModule = await import('../../../server/src/lib/search/storage.js');
} catch (error) {
  storageModuleError = error;
}

/**
 * Тесты зависят только от экспортируемой границы хранилища, но допускают оба
 * естественных имени фабрики, чтобы не фиксировать внутреннюю организацию модуля.
 */
export function knowledgeStorageFactory() {
  assert.ok(
    storageModule,
    `Хранилище знаний ещё не реализовано: ${storageModuleError?.message || 'модуль не загружен'}`,
  );
  const factory = storageModule.openKnowledgeStorage
    || storageModule.createKnowledgeStorage
    || storageModule.default;
  assert.equal(typeof factory, 'function', 'storage.js обязан экспортировать фабрику хранилища');
  return factory;
}

/** Создаёт полностью изолированную БД и гарантированно убирает её после теста. */
export async function knowledgeFixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-knowledge-'));
  const dbPath = options.dbPath || path.join(root, 'state', 'knowledge.db');
  const factory = knowledgeStorageFactory();
  const storage = await factory({
    dbPath,
    seedSamples: options.seedSamples ?? false,
  });

  t.after(async () => {
    await storage.close?.();
    await rm(root, { recursive: true, force: true });
  });

  return { root, dbPath, storage };
}

export function record(overrides = {}) {
  return {
    project: 'cockpit-test',
    repository: 'main',
    kind: 'fact',
    title: 'Проверяемая запись',
    body: 'Подробный текст проверяемого факта.',
    tags: ['тест'],
    ...overrides,
  };
}
