import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

import { PluginInstallService } from '../../../server/src/lib/packageInstall/service.ts';
import { liveGroupMembers } from '../../../server/src/lib/packageInstall/workerIdentity.ts';

export const commandSuccess = {
  code: 0,
  signal: null,
  timedOut: false,
  aborted: false,
  stdout: '',
  stderr: '',
  stdoutTruncated: false,
  stderrTruncated: false,
  workspaceLimitExceeded: false,
};

/**
 * Service, owner lock и state принадлежат одному временно созданному root.
 * Cleanup сначала закрывает сервис, а затем удаляет дерево fixture.
 */
export async function serviceFixture(t, overrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-install-service-'));
  const pluginsDir = path.join(root, 'plugins');
  const statePath = path.join(root, 'state/install.json');
  const npmCalls = [];
  const refreshCalls = [];

  await mkdir(pluginsDir);

  const { seed, bind = true, blockedClose = false, ...serviceOptions } = overrides;
  const service = new PluginInstallService({
    pluginsDir,
    statePath,
    grigDeskVersion: '1.0.0',
    reservedIds: ['code'],
    runNpm: async (cwd) => {
      npmCalls.push(cwd);
      await mkdir(path.join(cwd, 'node_modules'), { recursive: true });

      return commandSuccess;
    },
    ...serviceOptions,
  });

  if (bind) {
    service.bindRuntime({
    isLoaded: () => false,
    prepareReplace: async () => ({
      async finish() {},
    }),
    refresh: async () => {
      refreshCalls.push(true);
    },
  });
  }

  if (seed) {
    await seed({
      service,
      pluginsDir,
      statePath,
    });
  }

  await service.recover();
  t.after(async () => {
    if (blockedClose) {
      await assert.rejects(service.close(), { code: 'recovery_required' });
      assert.equal(service.commands.size, 0);
      assert.equal(service.mutations.size, 0);

      for (const worker of Object.values((await service.store.read()).workers)) {
        assert.deepEqual(await liveGroupMembers(worker.pgid), []);
      }

      // Только тест освобождает собственный fd после доказанного drain.
      // Production close намеренно удерживает lock при неподтверждённой записи.
      await service.owner?.release();
    } else {
      await service.close();
    }

    await rm(root, { recursive: true, force: true });
  });

  return {
    root,
    pluginsDir,
    statePath,
    service,
    npmCalls,
    refreshCalls,
  };
}
