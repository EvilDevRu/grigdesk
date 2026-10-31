import { B24Adapter } from '../../../server/src/adapters/b24.ts';
import { TrackerRegistry } from '../../../server/src/lib/trackers/registry.ts';
import { createSerialQueue } from '../../../server/src/lib/trackers/serialQueue.ts';
import { TrackerSettingsStore } from '../../../server/src/lib/trackers/settingsStore.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { customClientModule, customDriverModule } from './trackerCustomPackage.js';

/**
 * Барьер проходит через настоящий фасад, registry и host.serial кастомного пакета.
 * Подменены только сетевые методы клиента; очередь и допуск остаются продуктовыми.
 */
export async function legacyQueueAdapter(operation, t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-tracker-queue-'));
  const { B24Client } = await customClientModule();
  const { default: createCustomTracker } = await customDriverModule();
  const host = {
    credentials: { read: () => ({
      baseUrl: 'https://portal.example.test',
      login: 'user',
      password: 'secret',
    }) },
    cookiePath: path.join(root, 'cookies.json'),
    dataDir: root,
    serial: createSerialQueue(),
    logger: { info: () => {}, warn: () => {} },
  };
  const registry = new TrackerRegistry({ directory: path.join(root, 'drivers'), host: () => host });
  const selection = new TrackerSettingsStore(path.join(root, 'selection.json'), true);

  t.after(async () => {
    await registry.close();
    await rm(root, { recursive: true, force: true });
  });
  t.mock.method(B24Client.prototype, 'taskDetails', () => operation('detail', true, true));
  t.mock.method(B24Client.prototype, 'completeTask', () => operation('complete'));
  t.mock.method(B24Client.prototype, 'discoverUserId', async () => 7);
  t.mock.method(B24Client.prototype, 'apiGet', async () => ({
    data: { todayData: { queueResult: await operation('dashboard') } },
  }));
  t.mock.method(B24Client.prototype, 'raw', async () => ({ text: async () => '' }));

  registry.register(createCustomTracker(host), 'Кастомный Б24');
  await registry.activate('b24-custom');

  const adapter = new B24Adapter({ registry, selection });

  // Проекция сохраняет прежние маркеры результата после перехода dashboard на объект DTO.
  // Она выполняется после реального вызова фасада, а не заменяет работу общей очереди.
  return {
    taskDetail: (id) => adapter.taskDetail(id),
    getDashboard: async () => (await adapter.getDashboard()).today.queueResult,
    completeTask: (id) => adapter.completeTask(id),
  };
}
