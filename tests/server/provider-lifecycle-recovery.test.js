import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { artifactsPath } from '../../shared/runtime/dataHome.ts';

import { ProviderInstallService } from '../../server/src/lib/providerInstall/service.ts';
import { isProviderInstallSnapshot } from '../../shared/chat/providerInstallContracts.ts';

const job = {
  id: 'job',
  providerId: 'codex',
  operation: 'uninstall',
  stage: 'download-install',
  status: 'running',
  before: '1.0.0',
  after: '',
  outcome: null,
  error: null,
  warnings: [],
  outputTail: '',
  command: 'npm uninstall',
  fallbackCommand: '',
  loginCommand: '',
  startedAt: 1,
  updatedAt: 2,
  finishedAt: null,
  affectedProviderIds: ['codex'],
  targets: [{
    providerId: 'codex',
    installationId: null,
    phase: 'download-install',
    outcome: null,
    error: null,
  }],
};

/**
 * Перезапуск после destructive intent не повторяет uninstall и не разрешает второй writer.
 * Старому клиенту возвращается валидная блокировка без выдуманного update job.
 */
for (const method of ['npm', 'native']) {
  test(`recovery ${method} удерживает обслуживание после прерывания удаления`, async (t) => {
    const base = path.join(artifactsPath({ env: process.env, home: '/tmp' }),
      'external-cli-lifecycle/recovery-tests');

    await fs.mkdir(base, { recursive: true });

    const directory = await fs.mkdtemp(path.join(base, 'case-'));
    const statePath = path.join(directory, 'state.json');

    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    await fs.writeFile(statePath, JSON.stringify({
      revision: 2,
      active: null,
      recent: {},
      blockedReason: null,
      worker: null,
      lifecycle: {
        schemaVersion: 2,
        revision: 2,
        active: job,
        recent: {},
        blockedReason: null,
      },
      lifecycleRecovery: {
        ...(method === 'native' ? { kind: 'native', providerId: 'codex' } : {}),
        backup: path.join(directory, 'backup'),
        packageRoot: path.join(directory, 'package'),
        alias: path.join(directory, 'bin/codex'),
        operation: 'uninstall',
      },
    }));

    const service = new ProviderInstallService({
      statePath,
      config: {},
      env: { HOME: directory },
      adaptersOf: async () => new Map(),
      latestOf: () => undefined,
      refreshModels: async () => {},
      invalidate: async () => {},
      broadcast: () => {},
      runCommand: async () => {
        assert.fail('Recovery не должен повторять installer или удаление');
      },
    });
    const snapshot = await service.current();

    assert.equal(isProviderInstallSnapshot(snapshot), true);
    assert.equal(snapshot.active, null);
    assert.equal(snapshot.blockedReason?.code, 'lifecycle_recovery_required');
    await assert.rejects(service.start('codex', 'install'), { code: 'lifecycle_recovery_required' });

    const resolved = await service.resolveLifecycleRecovery();

    assert.equal(resolved.blockedReason, null);
  });
}
