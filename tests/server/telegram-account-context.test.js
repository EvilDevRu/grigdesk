import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createTelegramAccountContextFactory,
} from '../../server/src/lib/telegram/accountContext.ts';
import { TelegramArchiveStore } from '../../server/src/lib/telegram/archiveStore.ts';

const ACCOUNT_REF = 'acc_telegram_context_0001';
const BOT_ID = '8123456789';
const TOKEN = `${BOT_ID}:AAHrEaLLyLoNgSeCrEtPaRt_x1y2z3w4v5u6`;
const CHAT = -1001000000042;
const T0 = 1_786_172_400;

const message = (over = {}) => ({
  chatId: CHAT,
  chatUsername: '',
  chatTitle: 'Команда Альфа · разработка',
  chatType: 'supergroup',
  isForum: true,
  messageId: 100,
  threadId: 42,
  replyToMessageId: null,
  mediaGroupId: null,
  date: T0,
  editedAt: null,
  from: { id: 42, name: 'Аня', username: 'anya' },
  text: 'кнопка не нажимается',
  media: [],
  ...over,
});

async function fixture(t, {
  credentialLease = { accountRef: ACCOUNT_REF, botId: BOT_ID, token: TOKEN },
} = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tg-context-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let nowMs = 1_800_000_000_000;
  const accountContextFor = createTelegramAccountContextFactory({
    dir,
    now() { nowMs += 1; return nowMs; },
    log: { warn() {}, error() {}, info() {} },
    botApi: { async getFile() {}, async downloadFile() {}, async callBotApi() {} },
  });
  const context = await accountContextFor({ accountRef: ACCOUNT_REF, botId: BOT_ID, credentialLease });
  return { dir, accountDir: path.join(dir, 'accounts', ACCOUNT_REF), accountContextFor, context };
}

test('context использует только точный account namespace и immutable credential snapshot', async (t) => {
  const { accountDir, context } = await fixture(t);
  assert.deepEqual(context.paths, {
    accountDir,
    stateFile: path.join(accountDir, 'state.json'),
    archiveDir: path.join(accountDir, 'archive'),
    rulesFile: path.join(accountDir, 'rules.json'),
    botSettingsFile: path.join(accountDir, 'bot-settings.json'),
    inboxStateFile: path.join(accountDir, 'inbox-state.json'),
  });
  assert.equal(context.botId, BOT_ID);
  assert.deepEqual(context.credentials, { botId: BOT_ID, token: TOKEN });
  assert.equal(Object.isFrozen(context.credentials), true);
  assert.equal(context.inboxState.file, context.paths.inboxStateFile);
  assert.equal(context.rules.file, context.paths.rulesFile);
  assert.equal(context.archive.root, context.paths.archiveDir);
  assert.equal(typeof context.botApi.callBotApi, 'function');
});

test('credential snapshot обязан принадлежать verified bot', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tg-context-owner-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const factory = createTelegramAccountContextFactory({ dir });
  await assert.rejects(
    () => factory({
      accountRef: ACCOUNT_REF,
      botId: BOT_ID,
      credentialLease: { accountRef: ACCOUNT_REF, botId: '9123456789', token: TOKEN },
    }),
    (error) => error.code === 'telegram_account_context_invalid',
  );
  await assert.rejects(
    () => factory({
      accountRef: ACCOUNT_REF,
      botId: BOT_ID,
      credentialLease: {
        accountRef: 'acc_telegram_context_other',
        botId: BOT_ID,
        token: TOKEN,
      },
    }),
    (error) => error.code === 'telegram_account_context_invalid',
  );
});

test('botSettings пишет owner-bound public metadata без token', async (t) => {
  const { context } = await fixture(t);
  await context.botSettings.setServiceChatId(555000111);
  assert.deepEqual(await context.botSettings.setBot({
    username: 'support_bot',
    canReadAllGroupMessages: true,
    connectedAtMs: 1_800_000_000_010,
  }), {
    botId: Number(BOT_ID),
    username: 'support_bot',
    canReadAllGroupMessages: true,
    connectedAtMs: 1_800_000_000_010,
    serviceChatId: 555000111,
    pultChatId: null,
    pultUserId: null,
    pultConfirmedAtMs: null,
  });
  assert.equal((await context.botSettings.setServiceChatId(null)).serviceChatId, null);
  const serialized = await readFile(context.paths.botSettingsFile, 'utf8');
  assert.equal(serialized.includes(TOKEN), false);
  assert.equal(JSON.parse(serialized).accountRef, ACCOUNT_REF);
});

test('pollState сохраняет и читает строгий canonical state.json', async (t) => {
  const { context } = await fixture(t);
  await context.pollState.write({ offset: 43, updatedAtMs: 1_800_000_000_001 });
  assert.deepEqual(await context.pollState.read(), { offset: 43, updatedAtMs: 1_800_000_000_001 });
  assert.deepEqual(JSON.parse(await readFile(context.paths.stateFile, 'utf8')), {
    version: 1,
    offset: 43,
    updatedAtMs: 1_800_000_000_001,
  });
});

test('account-aware rules fail-closed на corrupt/symlink allowlist', async (t) => {
  const { context } = await fixture(t);
  await mkdir(path.dirname(context.paths.rulesFile), { recursive: true });
  await writeFile(context.paths.rulesFile, '{broken\n');
  await assert.rejects(
    () => context.rules.read(),
    (error) => error.code === 'telegram_rules_invalid',
  );

  const target = path.join(path.dirname(context.paths.rulesFile), 'outside-rules.json');
  await writeFile(target, '[]\n');
  await rm(context.paths.rulesFile);
  await symlink(target, context.paths.rulesFile);
  await assert.rejects(
    () => context.rules.read(),
    (error) => error.code === 'telegram_rules_invalid',
  );
  assert.equal(await readFile(target, 'utf8'), '[]\n');
});

test('sequenced archive не превращает row без inbox position в backlog и marker читает только metadata', async (t) => {
  const { accountDir, context } = await fixture(t);
  const unsequenced = new TelegramArchiveStore({
    dir: accountDir,
    log: { warn() {}, error() {}, info() {} },
  });
  await unsequenced.append(message({ messageId: 1, text: 'история до включения Inbox' }));

  const firstMarker = await context.createActivationMarker({ nowMs: (T0 + 10) * 1000 });
  assert.deepEqual(firstMarker, { schema: 1, afterSeq: 0, afterOccurredAt: T0 + 10 });

  const unsequencedEdit = await context.archive.append(message({
    messageId: 1,
    text: 'правка старой истории',
    editedAt: T0 + 20,
  }));
  const fresh = await context.archive.append(message({
    messageId: 2,
    date: T0 + 30,
    text: 'новое обращение',
  }));
  assert.equal(unsequencedEdit.firstSeq, null);
  assert.equal(fresh.firstSeq, 2);
  assert.equal(await context.archive.head(), 2);

  const positions = await context.archive.listInboxPositions({ afterSeq: 0, limit: 10 });
  assert.deepEqual(positions.map((position) => [position.seq, position.messageId]), [[2, 2]]);
  assert.equal((await context.archive.readInboxPosition(positions[0])).text, 'новое обращение');
});

test('sequenced archive после cold restart восстанавливает head и latest semantic snapshot', async (t) => {
  const { accountContextFor, context } = await fixture(t);
  await context.archive.append(message({ messageId: 10, text: 'первая версия' }));
  await context.archive.append(message({
    messageId: 10,
    text: 'исправленная версия',
    editedAt: T0 + 1,
  }));
  await context.archive.append(message({ messageId: 11, date: T0 + 2, text: 'соседнее' }));

  const restarted = await accountContextFor({
    accountRef: ACCOUNT_REF,
    botId: BOT_ID,
    credentialLease: { accountRef: ACCOUNT_REF, botId: BOT_ID, token: TOKEN },
  });
  assert.equal(await restarted.archive.head(), 3);
  const positions = await restarted.archive.listInboxPositions({ afterSeq: 0, limit: 10 });
  assert.deepEqual(positions.map(({ seq, revisionSeq, messageId }) => (
    [seq, revisionSeq, messageId]
  )), [
    [1, 2, 10],
    [3, 3, 11],
  ]);
  assert.equal((await restarted.archive.readInboxPosition(positions[0])).text, 'исправленная версия');
});

test('partial sequence journal после cold restart fail-closed', async (t) => {
  const { accountContextFor, context } = await fixture(t);
  await context.archive.append(message({ messageId: 20 }));
  await writeFile(
    path.join(context.paths.archiveDir, '.inbox-sequence.ndjson'),
    '{"schemaVersion":1',
    { flag: 'a' },
  );

  const restarted = await accountContextFor({
    accountRef: ACCOUNT_REF,
    botId: BOT_ID,
    credentialLease: { accountRef: ACCOUNT_REF, botId: BOT_ID, token: TOKEN },
  });
  await assert.rejects(
    () => restarted.archive.head(),
    (error) => error.code === 'telegram_archive_position_invalid',
  );
  await assert.rejects(
    () => restarted.archive.listInboxPositions({ afterSeq: 0, limit: 10 }),
    (error) => error.code === 'telegram_archive_position_invalid',
  );
});
