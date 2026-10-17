import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TelegramContractError,
  isTelegramPolicyFingerprint,
  parseTelegramChats,
  parseTelegramRules,
  parseTelegramStatus,
} from '../../shared/telegram/telegramContracts.ts';
import { api } from '../../web/src/shared/apiClient.ts';
import { telegramApi, telegramPluginDisabled } from '../../web/src/shared/telegramApi.ts';

const FINGERPRINT = `telegram-rules-v1:${'a1b2c3d4'.repeat(8)}`;

const BOT = {
  configured: true,
  botId: 8_123_456_789,
  username: 'example_inbox_bot',
  tokenHint: '…v5u6',
  canReadAllGroupMessages: false,
  connectedAt: 1_754_560_800_000,
  privacyHint: 'Режим приватности включён.',
};
const RULE = {
  project: 'cockpit',
  chatId: -1_001_000_000_042,
  username: null,
  title: 'Общий чат',
  threadId: null,
  kind: 'bug',
  draft: 'manual',
  notifyTaskCreated: false,
  agentSearch: false,
  b24: { responsibleId: null, groupId: 7, priority: 1 },
  autoTask: { enabled: false, minConfidence: 0.7, maxPerDay: 10 },
  autoLaunch: {
    enabled: false, route: '', minConfidence: 0.8, maxPerDay: 3, vetoMinutes: 10,
  },
};

test('токен бота не проходит через границу — наружу выходит только маска', () => {
  const status = parseTelegramStatus({
    bot: { ...BOT, token: '8123456789:секрет', tokenHint: '…v5u6' },
    poll: null,
    pult: null,
  });

  assert.equal(status.bot.tokenHint, '…v5u6');
  assert.equal(JSON.stringify(status).includes('секрет'), false);
});

test('состояние подключения закрыто перечислением', () => {
  assert.equal(parseTelegramStatus({ bot: BOT, connection: 'degraded' }).connection, 'degraded');
  assert.throws(
    () => parseTelegramStatus({ bot: BOT, connection: 'думает' }),
    /telegramStatus\.connection/,
  );
});

test('отпечаток правил проверяется по форме прямо в контракте', () => {
  const rules = parseTelegramRules({ rules: [RULE], policyFingerprint: FINGERPRINT });

  assert.equal(rules.policyFingerprint, FINGERPRINT);
  assert.equal(isTelegramPolicyFingerprint(FINGERPRINT), true);
  assert.equal(isTelegramPolicyFingerprint('telegram-rules-v1:коротко'), false);
  assert.throws(
    () => parseTelegramRules({ rules: [], policyFingerprint: 'нет' }),
    /telegramRules\.policyFingerprint/,
  );
});

test('вид правила и ступень приоритета портала — закрытые наборы', () => {
  assert.throws(
    () => parseTelegramRules({ rules: [{ ...RULE, kind: 'вопрос' }], policyFingerprint: FINGERPRINT }),
    /telegramRules\.rules\[0\]\.kind/,
  );
  assert.throws(
    () => parseTelegramRules({
      rules: [{ ...RULE, b24: { ...RULE.b24, priority: 7 } }],
      policyFingerprint: FINGERPRINT,
    }),
    /telegramRules\.rules\[0\]\.b24\.priority/,
  );
});

test('услышанный чат переживает отсутствие необязательных полей', () => {
  const [chat] = parseTelegramChats({ chats: [{ id: -100, title: 'Группа' }] });

  assert.deepEqual({ messages: chat.messages, lastAt: chat.lastAt }, {
    messages: null,
    lastAt: null,
  });
});

test('выключенный плагин отличается от поломки сети', () => {
  assert.equal(telegramPluginDisabled({ status: 404, data: { error: 'plugin_disabled' } }), true);
  assert.equal(telegramPluginDisabled({ status: 404, data: { error: 'not_found' } }), false);
  assert.equal(telegramPluginDisabled({ status: 500 }), false);
});

test('адаптер кодирует id чата и подтверждает форму каждого ответа', async (t) => {
  const seen = [];

  t.mock.method(api, 'get', async (url) => {
    seen.push(['GET', url]);

    return url.endsWith('/topics') ? { topics: [] } : { bot: BOT };
  });
  t.mock.method(api, 'put', async (url) => {
    seen.push(['PUT', url]);

    return { ok: true, rules: [RULE], policyFingerprint: FINGERPRINT };
  });

  await telegramApi.status();
  await telegramApi.topics('-100/42');
  await telegramApi.saveRules([RULE], 8_123_456_789, FINGERPRINT);

  const chatId = encodeURIComponent('-100/42');

  assert.deepEqual(seen, [
    ['GET', '/api/telegram/status'],
    ['GET', `/api/telegram/chats/${chatId}/topics`],
    ['PUT', '/api/telegram/rules'],
  ]);
});

test('сохранение без нового отпечатка не становится успехом на экране', async (t) => {
  t.mock.method(api, 'put', async () => ({ ok: true, rules: [RULE] }));

  await assert.rejects(
    telegramApi.saveRules([RULE], 8_123_456_789, FINGERPRINT),
    TelegramContractError,
  );
});
