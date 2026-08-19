import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ChatHistoryStore } from '../../server/src/lib/chat/history-store.js';
import {
  resolveLegacyModel,
  resolveModelRef,
} from '../../server/src/lib/chat/model-ref.js';

const registry = {
  claude: [{
    id: 'claude-opus-5',
    aliases: ['opus'],
    modelRefAliases: ['claude-opus-5[1m]'],
    tier: 100,
  }],
  codex: [{ id: 'gpt-5.6-sol', family: 'sol', tier: 100 }],
  other: [{ id: 'shared', tier: 1 }],
  duplicate: [{ id: 'shared', tier: 1 }],
};

async function tempStore(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-chat-schema-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return {
    root,
    store: new ChatHistoryStore({
      chatsDir: path.join(root, 'chats'),
      registryProvider: async () => registry,
      now: () => Date.UTC(2026, 7, 1),
    }),
  };
}

test('modelRef разрешается строго внутри указанного provider без fallback', () => {
  assert.deepEqual(resolveModelRef({ provider: 'codex', model: 'gpt-5.6-sol' }, registry).modelRef,
    { provider: 'codex', model: 'gpt-5.6-sol' });
  assert.equal(resolveModelRef({ provider: 'claude', model: 'gpt-5.6-sol' }, registry).error, 'unknown_model');
  assert.equal(resolveModelRef({ provider: 'missing', model: 'anything' }, registry).error, 'unknown_provider');
});

test('versioned modelRef канонизирует только retired exact id внутри своего provider', () => {
  assert.deepEqual(
    resolveModelRef({ provider: 'claude', model: 'claude-opus-5[1m]' }, registry).modelRef,
    { provider: 'claude', model: 'claude-opus-5' },
  );
  assert.equal(
    resolveModelRef({ provider: 'claude', model: 'opus' }, registry).error,
    'unknown_model',
    'динамический rollout alias не является versioned pin',
  );
  assert.equal(
    resolveModelRef({ provider: 'codex', model: 'claude-opus-5[1m]' }, registry).error,
    'unknown_model',
    'retired alias не пробивает provider boundary',
  );
});

test('сохранённый schema-2 ref на свёрнутый [1m] мигрирует в канонический id', async (t) => {
  const { root, store } = await tempStore(t);
  const monthDir = path.join(root, 'chats', '2026-08');
  await fs.mkdir(monthDir, { recursive: true });
  await fs.writeFile(path.join(monthDir, 'retired-1m.json'), JSON.stringify({
    schema: 2,
    id: 'retired-1m',
    modelRef: { provider: 'claude', model: 'claude-opus-5[1m]' },
    model: 'claude-opus-5[1m]',
    messages: [],
    createdAt: Date.UTC(2026, 7, 1),
    updatedAt: Date.UTC(2026, 7, 1),
  }));

  const chat = await store.readOne('retired-1m');
  assert.deepEqual(chat.modelRef, { provider: 'claude', model: 'claude-opus-5' });
  assert.equal(chat.model, 'claude-opus-5', 'rollback dual-write тоже становится каноническим');
  assert.deepEqual(chat.modelRefState, { state: 'resolved' });
});

test('неоднозначный legacy model требует явного перевыбора provider', () => {
  const result = resolveLegacyModel('shared', registry);
  assert.equal(result.error, 'ambiguous_model');
  assert.deepEqual(result.candidates, [
    { provider: 'other', model: 'shared' },
    { provider: 'duplicate', model: 'shared' },
  ]);
});

test('legacy store мигрирует atomically, получает server-owned surface и rollback backup', async (t) => {
  const { root, store } = await tempStore(t);
  const chatsDir = path.join(root, 'chats');
  const monthDir = path.join(chatsDir, '2026-08');
  await fs.mkdir(monthDir, { recursive: true });
  const fixture = JSON.parse(await fs.readFile(
    new URL('../fixtures/chat-schema/legacy-chat-store.json', import.meta.url),
    'utf8',
  ));
  await fs.writeFile(path.join(monthDir, 'legacy-claude.json'), JSON.stringify(fixture.sessions[0]));
  await fs.writeFile(path.join(chatsDir, 'meta.json'), JSON.stringify({
    activeId: fixture.activeId,
    defModel: fixture.defModel,
    defEffort: fixture.defEffort,
    defMode: fixture.defMode,
  }));

  const state = await store.read();
  const chat = state.sessions[0];
  assert.equal(chat.schema, 2);
  assert.equal(chat.surface, 'chats');
  assert.equal(chat.revision, 0);
  assert.deepEqual(chat.modelRef, { provider: 'claude', model: 'claude-opus-5' });
  assert.equal(chat.model, 'claude-opus-5', 'legacy model dual-write сохраняет rollback reader');
  assert.deepEqual(chat.sessionBindingState, {
    state: 'legacy_unbound',
    reason: 'missing_server_identity',
  });
  assert.deepEqual(state.defModelRef, { provider: 'claude', model: 'claude-opus-5' });

  const backupsRoot = path.join(chatsDir, '.migration-backups');
  const backups = await fs.readdir(backupsRoot);
  assert.equal(backups.length, 1);
  const backupDir = path.join(backupsRoot, backups[0]);
  const backupChat = JSON.parse(await fs.readFile(
    path.join(backupDir, '2026-08', 'legacy-claude.json'),
    'utf8',
  ));
  assert.equal(backupChat.model, 'opus');
  assert.equal(backupChat.schema, undefined);

  // Симуляция старого reader-а: новые поля игнорируются, legacy model/session/messages читаются.
  const rollbackView = (({ id, model, sessionId, messages }) => ({ id, model, sessionId, messages }))(chat);
  assert.equal(rollbackView.model, 'claude-opus-5');
  assert.equal(rollbackView.sessionId, 'legacy-display-session');
  assert.equal(rollbackView.messages.length, 2);
});

test('surface и binding-поля не принимаются от клиента, stale PUT не откатывает modelRef', async (t) => {
  const { store } = await tempStore(t);
  const base = {
    id: 'chat-cas',
    modelRef: { provider: 'claude', model: 'claude-opus-5' },
    model: 'claude-opus-5',
    messages: [{ role: 'user', text: 'one' }],
    createdAt: Date.UTC(2026, 7, 1),
    updatedAt: Date.UTC(2026, 7, 1, 1),
  };
  const first = await store.saveOne(base);
  assert.equal(first.chat.revision, 1);
  assert.equal(first.chat.surface, 'chats');

  const current = await store.saveOne({
    ...first.chat,
    modelRef: { provider: 'codex', model: 'gpt-5.6-sol' },
    model: 'gpt-5.6-sol',
    messages: [...first.chat.messages, { role: 'assistant', text: 'two' }],
    updatedAt: Date.UTC(2026, 7, 1, 2),
    surface: 'embedded',
    binding: { sessionId: 'forged' },
  });
  assert.equal(current.chat.revision, 2);
  assert.equal(current.chat.surface, 'chats');
  assert.equal(current.chat.binding, undefined);
  assert.deepEqual(current.chat.modelRef, { provider: 'codex', model: 'gpt-5.6-sol' });

  const stale = await store.saveOne({
    ...base,
    revision: 1,
    modelRef: { provider: 'claude', model: 'claude-opus-5' },
    messages: [...base.messages, { role: 'user', text: 'из старого окна' }],
    updatedAt: Date.UTC(2026, 7, 1, 3),
  });
  assert.equal(stale.stale, true);
  assert.deepEqual(stale.chat.modelRef, { provider: 'codex', model: 'gpt-5.6-sol' });
  assert.ok(stale.chat.messages.some((message) => message.text === 'из старого окна'));
});

test('ambiguous legacy record сохраняет явное состояние и не получает modelRef', async (t) => {
  const { store } = await tempStore(t);
  await store.saveOne({
    id: 'ambiguous',
    model: 'shared',
    messages: [],
    createdAt: Date.UTC(2026, 7, 1),
    updatedAt: Date.UTC(2026, 7, 1),
  });
  const chat = await store.readOne('ambiguous');
  assert.equal(chat.modelRef, undefined);
  assert.equal(chat.modelRefState.state, 'ambiguous_model');
  assert.equal(chat.modelRefState.candidates.length, 2);
});
