import assert from 'node:assert/strict';
import test from 'node:test';

import {
  InboxMessageValidationError,
  validateInboxMessage,
} from '../../server/src/lib/inbox/message.ts';

const CHANNEL = 'telegram';
const ACCOUNT = 'acc_message_contract_01';

const message = (over = {}) => ({
  schema: 1,
  channel: CHANNEL,
  accountRef: ACCOUNT,
  source: { id: '-100:source/#', title: 'Баги', threadId: '42' },
  id: '20425',
  parentId: null,
  groupId: null,
  occurredAt: 1_786_172_400,
  editedAt: null,
  author: { id: '42', name: 'Имя' },
  text: '',
  attachments: [{
    ref: 'server/file:id',
    dedupeKey: 'server/unique:id',
    kind: 'image',
    displayLabel: 'фото',
    name: '',
    size: null,
  }],
  service: false,
  ...over,
});

const validate = (raw) => validateInboxMessage(raw, {
  expectedChannel: CHANNEL,
  expectedAccountRef: ACCOUNT,
});

test('normalized InboxMessage v1 принимает exact schema и явно сохраняет null', () => {
  const raw = message();
  const result = validate(raw);
  assert.deepEqual(result, raw);
  assert.notEqual(result, raw);
  assert.notEqual(result.source, raw.source);
  assert.notEqual(result.attachments, raw.attachments);
});

test('validator требует trusted channel + accountRef и не доверяет полям сообщения', () => {
  assert.throws(() => validateInboxMessage(message()), InboxMessageValidationError);
  assert.throws(() => validate(message({ channel: 'github' })), /доверенный канал/);
  assert.throws(() => validate(message({ accountRef: 'acc_other_account_01' })), /account context/);
});

test('exact schema отвергает забытый nullable field и channel-native metadata', () => {
  const withoutParent = message();
  delete withoutParent.parentId;
  assert.throws(() => validate(withoutParent), /поля должны в точности/);

  const native = message({ chatUsername: 'secret' });
  assert.throws(() => validate(native), /поля должны в точности/);

  const nativeAttachment = message();
  nativeAttachment.attachments[0].fileId = 'telegram-secret';
  assert.throws(() => validate(nativeAttachment), /attachments\[0\].*поля/);
});

test('все identifiers в общем слое — только непустые строки', () => {
  assert.throws(() => validate(message({ id: 20425 })), /нестроковые id/);
  assert.throws(() => validate(message({ id: '' })), /размер должен быть/);
  assert.throws(() => validate(message({ parentId: undefined })), /нестроковые id/);

  const numericSource = message();
  numericSource.source.id = -100;
  assert.throws(() => validate(numericSource), /нестроковые id/);

  const numericAuthor = message();
  numericAuthor.author.id = 42;
  assert.throws(() => validate(numericAuthor), /нестроковые id/);
});

test('timestamps, attachments и boolean проходят строгие type/size checks', () => {
  assert.throws(() => validate(message({ occurredAt: 1.5 })), /Unix seconds/);
  assert.throws(() => validate(message({ editedAt: -1 })), /Unix seconds/);
  assert.throws(() => validate(message({ service: 0 })), /boolean/);

  const badSize = message();
  badSize.attachments[0].size = -1;
  assert.throws(() => validate(badSize), /size/);

  const badOpaque = message();
  badOpaque.attachments[0].ref = '';
  assert.throws(() => validate(badOpaque), /attachments\[0\].ref/);
});
