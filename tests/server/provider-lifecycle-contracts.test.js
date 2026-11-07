import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isProviderLifecycleMigrationPreparation, isProviderLifecycleSnapshot,
} from '../../shared/chat/providerLifecycleContracts.ts';

const target = (providerId) => ({
  providerId,
  installationId: null,
  phase: 'activation',
  outcome: null,
  error: null,
});

const job = {
  id: 'job',
  providerId: 'first',
  operation: 'migrate',
  stage: 'activation',
  status: 'running',
  before: '1.0.0',
  after: '',
  outcome: null,
  error: null,
  warnings: [],
  outputTail: '',
  command: 'reviewed command',
  fallbackCommand: '',
  loginCommand: '',
  startedAt: 100,
  updatedAt: 100,
  finishedAt: null,
  affectedProviderIds: ['first', 'second'],
  targets: ['first', 'second'].map((providerId) => target(providerId)),
};
const snapshot = {
  schemaVersion: 2,
  revision: 1,
  active: job,
  recent: {},
  blockedReason: null,
};
const done = {
  ...job,
  status: 'succeeded',
  outcome: 'migrated',
  finishedAt: 200,
};

test('v2 допускает aggregate recent только у затронутых providers', () => {
  assert.equal(isProviderLifecycleSnapshot(snapshot), true);
  assert.equal(isProviderLifecycleSnapshot({
    ...snapshot,
    active: null,
    recent: { second: done },
  }), true);
  assert.equal(isProviderLifecycleSnapshot({
    ...snapshot,
    active: null,
    recent: { stranger: done },
  }), false);
  assert.equal(isProviderLifecycleSnapshot({
    ...snapshot,
    active: {
      ...job,
      operation: 'wipe',
    },
  }), false);
  assert.equal(isProviderLifecycleSnapshot({
    ...snapshot,
    active: {
      ...job,
      affectedProviderIds: ['second'],
    },
  }), false);
});

test('v2 проверяет типы, конечные числа, состояния и связь targets', () => {
  const patches = [
    { revision: NaN },
    { active: { ...job, targets: [] } },
    { active: { ...job, affectedProviderIds: ['first', 'first'] } },
    { active: { ...job, stage: 'unknown' } },
    { active: { ...job, startedAt: '100' } },
    {
      active: {
        ...job,
        status: 'succeeded',
        finishedAt: null,
      },
    },
    { active: null, recent: { first: job } },
  ];

  for (const patch of patches) {
    assert.equal(isProviderLifecycleSnapshot({
      ...snapshot,
      ...patch,
    }), false);
  }
});

const migrationTarget = (providerId, digit) => ({
  providerId,
  sourceIds: [String(digit).repeat(64)],
  removeIds: [String(digit).repeat(64)],
  targetMethod: 'npm',
  fromVersion: '1.0.0',
  targetVersion: '1.0.0',
  command: 'npm install --global example',
  prefix: '/home/user/.npm-global',
  footprint: [{
    path: '/home/user/.npm-global/lib/cli',
    action: 'install',
    reason: 'example',
  }],
  warnings: [],
});
const migration = {
  schemaVersion: 2,
  token: 'token',
  expiresAt: 200,
  operation: 'migrate',
  affectedProviderIds: ['first', 'second'],
  cleanupOwnedShell: true,
  shellChanges: [{
    file: '/home/user/.bashrc',
    action: 'remove',
    block: '# block',
  }],
  warnings: [],
  targets: [migrationTarget('first', 1), migrationTarget('second', 2)],
};

test('migration preview проверяет цели, sourceIds и общий блок', () => {
  assert.equal(isProviderLifecycleMigrationPreparation(migration), true);

  const patches = [
    { targets: [] },
    { affectedProviderIds: ['first'] },
    { targets: [{ ...migration.targets[0], removeIds: ['f'.repeat(64)] }, migration.targets[1]] },
    { targets: [{ ...migration.targets[0], prefix: 'relative' }, migration.targets[1]] },
    { targets: [{ ...migration.targets[0], targetMethod: 'native' }, migration.targets[1]] },
    {
      shellChanges: [{
        file: '/home/user/.bashrc',
        action: 'update',
        block: '',
      }],
    },
  ];

  for (const patch of patches) {
    assert.equal(isProviderLifecycleMigrationPreparation({
      ...migration,
      ...patch,
    }), false);
  }
});
