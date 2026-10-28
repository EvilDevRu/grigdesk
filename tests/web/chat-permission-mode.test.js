import assert from 'node:assert/strict';
import test from 'node:test';

import { effectivePermissionMode, permissionModeRequest } from '../../web/src/shared/chatPermissionMode.ts';
import { chatStoreFixture, setChatProviders } from './helpers/chat-store.js';

const modes = [{ id: 'default' }, { id: 'auto' }, { id: 'read-only' }];

test('UI и отправка используют default для нового чата и чужого сохранённого plan', () => {
  assert.equal(effectivePermissionMode('', modes), 'default');
  assert.equal(effectivePermissionMode(undefined, modes), 'default');
  assert.equal(effectivePermissionMode('plan', modes), 'default');
  assert.equal(effectivePermissionMode('read-only', modes), 'read-only');
  assert.equal(effectivePermissionMode('auto', modes), 'auto');
});

test('прежний manual fallback других адаптеров сохраняется', () => {
  assert.equal(effectivePermissionMode('', [{ id: 'plan' }, { id: 'manual' }]), 'manual');
  assert.equal(effectivePermissionMode('auto', []), '');
});

test('объявленный auto default не меняется из-за порядка меню', () => {
  assert.equal(effectivePermissionMode('', [{ id: 'plan' }, { id: 'auto' }], {
    defaultPermissionMode: 'auto', permissionModeSelectionPolicy: 'preserve-explicit',
  }), 'auto');
});

test('явный недоступный plan сохраняется при пустом или устаревшем каталоге', () => {
  const policy = { defaultPermissionMode: 'auto', permissionModeSelectionPolicy: 'preserve-explicit' };

  assert.equal(effectivePermissionMode('plan', [{ id: 'auto' }], policy), 'plan');
  assert.equal(effectivePermissionMode('plan', [], policy), 'plan');
});

const provider = {
  id: 'codex',
  defaultPermissionMode: 'auto',
  permissionModeSelectionPolicy: 'preserve-explicit',
  permissionModesRequiringExplicitSelection: ['bypassPermissions'],
  modes: [{ id: 'auto' }, { id: 'dontAsk' }, {
    id: 'bypassPermissions',
    persistAsDefault: false,
    requiresExplicitSelection: true,
  }],
};

test('bypass мигрирует без маркера, сохраняется только для точного chatId', () => {
  const modeSelection = {
    provider: 'codex',
    id: 'bypassPermissions',
    revision: 1,
    chatId: 'one'
  };

  assert.deepEqual(permissionModeRequest({ id: 'one', mode: 'bypassPermissions' }, provider),
    { mode: 'auto' });
  assert.equal(permissionModeRequest({
    id: 'one',
    mode: 'bypassPermissions',
    modeSelection
  }, provider).mode,
    'bypassPermissions');
  assert.deepEqual(permissionModeRequest({
    id: 'clone',
    mode: 'bypassPermissions',
    modeSelection
  }, provider),
    { mode: 'auto' });
  assert.throws(() => permissionModeRequest({ id: 'one', mode: 'plan' }, provider), /недоступен/u);

  const unavailable = { ...provider, modes: [{ id: 'auto' }] };

  assert.deepEqual(permissionModeRequest({ id: 'one', mode: 'bypassPermissions' }, unavailable),
    { mode: 'auto' });
  assert.throws(() => permissionModeRequest({
    id: 'one',
    mode: 'bypassPermissions',
    modeSelection
  },
    unavailable), /недоступен/u);
});

test('store хранит bypass только в выбранном чате, новый чат и pending input не наследуют его',
  async () => {
    const chat = await chatStoreFixture({ sessions: [{
      id: 'one',
      model: 'gpt-fixture',
      modelRef: { provider: 'codex', model: 'gpt-fixture' },
      mode: 'auto',
      messages: []
    }] });

    setChatProviders({ modelOf: () => ({
      id: 'gpt-fixture',
      model: { id: 'gpt-fixture' },
      provider
    }) });
    chat.defMode = 'auto';
    chat.setMode('one', 'bypassPermissions');

    const current = chat.sessions.find((session) => session.id === 'one');

    assert.equal(chat.defMode, 'auto');
    assert.deepEqual({ ...current.modeSelection }, {
      provider: 'codex',
      id: 'bypassPermissions',
      revision: 1,
      chatId: 'one',
    });

    const pending = {
      role: 'user',
      text: 'fixture',
      turnId: 'fixture-turn',
      outbox: {
      mode: 'bypassPermissions', modeSelection: { ...current.modeSelection },
    }
    };

    chat.setMode('one', 'dontAsk');
    assert.throws(() => chat._turnRequest(current, pending), /изменился/u);
    assert.equal(chat.defMode, 'dontAsk');
    chat.defMode = 'bypassPermissions';

    const id = chat.newSession();
    const created = chat.sessions.find((session) => session.id === id);

    assert.equal(created.mode, 'auto');
    assert.equal(created.modeSelection, undefined);
    chat.$dispose();
  });
