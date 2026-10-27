import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decodeProviderInstallSnapshot,
  isProviderInstallJob,
  isProviderInstallPreparation,
  isProviderInstallSnapshot,
} from '../../shared/chat/providerInstallContracts.ts';

/**
 * Канонический job фикстуры: только известные поля старого контракта.
 * Каждый кейс меняет ровно одно поле, чтобы отказ был отнесён к нему.
 */
function job(overrides = {}) {
  return {
    id: 'job-1',
    providerId: 'claude',
    operation: 'update',
    status: 'succeeded',
    stage: 'models',
    before: '1.0.0',
    after: '2.0.0',
    outcome: 'updated',
    error: null,
    warnings: [],
    outputTail: 'готово',
    command: 'npm i -g @anthropic-ai/claude-code@latest',
    fallbackCommand: 'npm i -g @anthropic-ai/claude-code@latest',
    loginCommand: 'claude login',
    startedAt: 1,
    updatedAt: 2,
    finishedAt: 3,
    ...overrides,
  };
}

function snapshot(overrides = {}) {
  return {
    revision: 1,
    active: null,
    recent: { claude: job() },
    blockedReason: null,
    ...overrides,
  };
}

const terminal = (overrides = {}) => ({
  status: 'ready',
  reason: null,
  binDirectory: '/home/user/.local/bin',
  shell: 'bash',
  ...overrides,
});

test('старый job без terminal остаётся валидным', () => {
  assert.equal(isProviderInstallJob(job()), true);
  assert.equal(isProviderInstallSnapshot(snapshot()), true);
});

test('terminal принимается только с известным enum и типами', () => {
  assert.equal(isProviderInstallJob(job({ terminal: terminal() })), true);
  assert.equal(isProviderInstallJob(job({
    terminal: terminal({
      status: 'conflict',
      reason: 'terminal_command_conflict',
      shell: 'other',
    }),
  })), true);
  assert.equal(isProviderInstallJob(job({
    terminal: terminal({ status: 'needs_setup', reason: 'terminal_setup_required' }),
  })), true);

  for (const broken of [
    terminal({ status: 'done' }),
    terminal({ status: 'ready', reason: 3 }),
    terminal({ binDirectory: '' }),
    terminal({ binDirectory: 'relative/bin' }),
    terminal({ shell: 'zsh' }),
    {
      status: 'ready',
      reason: null,
      binDirectory: '/x',
    },
    { ...terminal(), extra: true },
  ]) {
    assert.equal(isProviderInstallJob(job({ terminal: broken })), false, JSON.stringify(broken));
  }
});

test('migration описывает только пару путей', () => {
  assert.equal(isProviderInstallJob(job({ migration: { from: '/d/bin/x', to: '/p/bin/x' } })), true);

  for (const broken of [
    { from: '/d/bin/x' },
    { from: '', to: '/p/bin/x' },
    {
      from: '/d/bin/x',
      to: '/p/bin/x',
      extra: true,
    },
    'migration',
  ]) {
    assert.equal(isProviderInstallJob(job({ migration: broken })), false, JSON.stringify(broken));
  }
});

test('стадия terminal расширяет allowlist без ослабления прочих стадий', () => {
  assert.equal(isProviderInstallJob(job({ stage: 'terminal' })), true);

  for (const stage of ['download-install', 'version', 'models']) {
    assert.equal(isProviderInstallJob(job({ stage })), true);
  }

  assert.equal(isProviderInstallJob(job({ stage: 'shell' })), false);
  assert.equal(isProviderInstallSnapshot(snapshot({ recent: { claude: job({ stage: 'shell' }) } })), false);
});

test('снимок с неверным terminal не декодируется целиком', () => {
  const broken = snapshot({
    recent: { claude: job({ terminal: terminal({ status: 'ready', shell: 'fish' }) }) },
  });

  assert.throws(() => decodeProviderInstallSnapshot(broken), /Некорректный снимок/u);

  const accepted = snapshot({
    recent: { claude: job({ terminal: terminal() }) },
  });

  assert.equal(decodeProviderInstallSnapshot(accepted).revision, 1);
});

test('preparation DTO строго проверяется целиком', () => {
  const preparation = {
    token: 'opaque-token',
    expiresAt: 1_700_000_300_000,
    providerId: 'codex',
    operation: 'install',
    command: 'npm i -g @openai/codex@latest --prefix /home/user/.local',
    prefix: '/home/user/.local',
    shellChanges: [{
      file: '/home/user/.bashrc',
      action: 'update',
      block: [
        '# >>> GrigDesk external CLI PATH >>>',
        'export PATH="/home/user/.local/bin:$PATH"',
        '# <<< GrigDesk external CLI PATH <<<',
        '',
      ].join('\n'),
    }],
    terminalSetup: 'bash',
    warnings: [{ code: 'npm_prefix_nvm_scoped', message: 'Копия уйдёт из PATH при смене версии Node' }],
  };

  assert.equal(isProviderInstallPreparation(preparation), true);
  assert.equal(isProviderInstallPreparation({ ...preparation, prefix: null }), true);
  assert.equal(isProviderInstallPreparation({ ...preparation, shellChanges: [] }), true);
  assert.equal(isProviderInstallPreparation({ ...preparation, warnings: [] }), true);

  for (const broken of [
    { ...preparation, token: '' },
    { ...preparation, expiresAt: Number.NaN },
    { ...preparation, operation: 'reinstall' },
    { ...preparation, command: '' },
    { ...preparation, prefix: 42 },
    { ...preparation, terminalSetup: 'zsh' },
    { ...preparation, shellChanges: [{
      file: '/x',
      action: 'rewrite',
      block: '',
    }] },
    { ...preparation, shellChanges: [{ file: '/x', action: 'update' }] },
    { ...preparation, shellChanges: [{
      file: '',
      action: 'update',
      block: 'x',
    }] },
    { ...preparation, warnings: [{ code: 'x' }] },
    { ...preparation, warnings: ['строка'] },
    { ...preparation, extra: true },
  ]) {
    assert.equal(isProviderInstallPreparation(broken), false, JSON.stringify(broken).slice(0, 120));
  }
});
