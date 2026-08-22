// Правила «чат/тема → проект»: allowlist и его хранилище.
//
// Это не настройка удобства, а ГРАНИЦА БЕЗОПАСНОСТИ фазы 2 (раздел 2 плана):
// разворачивается только ссылка на чат, привязанный к проекту. Иначе произвольная
// ссылка, вписанная в описание задачи, вытянула бы содержимое любого чата, где бот
// случайно состоит. Поэтому главные проверки здесь — про отказ по умолчанию и про
// то, что правило темы не расползается на соседние темы.
import assert from 'node:assert/strict';
import {
  link, lstat, mkdtemp, readFile, rm, symlink, utimes, writeFile, mkdir,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  TelegramRulesStore, matchRule, normalizeRules, telegramRulesPolicyFingerprint,
} from '../../server/src/lib/telegram/rules-store.js';

const CHAT = -1001000000042; // явно синтетический приватный форум
const PUB = 'example_team';
const ACCOUNT_A = 'acc_telegram_rules_owner_a';
const ACCOUNT_B = 'acc_telegram_rules_owner_b';
const BOT_A = '8123456789';
const BOT_B = '9123456789';

function logStub() {
  const warns = [];
  return { warns, info() {}, warn(a, b) { warns.push(typeof a === 'string' ? a : b || ''); }, error() {} };
}

const rule = (over = {}) => ({ project: 'demo', chatId: CHAT, threadId: null, ...over });

async function tmpDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tg-rules-'));
  test.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const strictStore = (dir, over = {}) => new TelegramRulesStore({
  dir,
  accountRef: ACCOUNT_A,
  botId: BOT_A,
  log: logStub(),
  strictRead: true,
  ...over,
});

// --- разрешающий поиск: закрыто по умолчанию ---

test('без правил не разрешён ни один чат', () => {
  assert.equal(matchRule([], { chatId: CHAT, threadId: 12 }), null);
  assert.equal(matchRule([], { username: PUB, threadId: null }), null);
});

test('правило чужого чата не разрешает наш', () => {
  const rules = normalizeRules([rule({ chatId: -100777 })]);
  assert.equal(matchRule(rules, { chatId: CHAT, threadId: null }), null);
});

test('правило на весь чат покрывает и общий чат, и любую тему', () => {
  const rules = normalizeRules([rule()]);
  assert.equal(matchRule(rules, { chatId: CHAT, threadId: null })?.project, 'demo');
  assert.equal(matchRule(rules, { chatId: CHAT, threadId: 42 })?.project, 'demo');
});

test('правило темы не разрешает ни соседнюю тему, ни общий чат', () => {
  const rules = normalizeRules([rule({ threadId: 42 })]);
  assert.equal(matchRule(rules, { chatId: CHAT, threadId: 42 })?.project, 'demo');
  assert.equal(matchRule(rules, { chatId: CHAT, threadId: 43 }), null);
  assert.equal(matchRule(rules, { chatId: CHAT, threadId: null }), null);
});

test('тема сильнее общего правила чата, и порядок в файле на это не влияет', () => {
  const forward = normalizeRules([
    rule({ project: 'общий', notifyTaskCreated: false }),
    rule({ project: 'тема', threadId: 42, notifyTaskCreated: true }),
  ]);
  const backward = normalizeRules([
    rule({ project: 'тема', threadId: 42, notifyTaskCreated: true }),
    rule({ project: 'общий', notifyTaskCreated: false }),
  ]);
  assert.equal(matchRule(forward, { chatId: CHAT, threadId: 42 })?.project, 'тема');
  assert.equal(matchRule(backward, { chatId: CHAT, threadId: 42 })?.project, 'тема');
  assert.equal(matchRule(forward, { chatId: CHAT, threadId: 42 })?.notifyTaskCreated, true);
  assert.equal(matchRule(backward, { chatId: CHAT, threadId: 42 })?.notifyTaskCreated, true);
  // А сообщение вне темы всё так же ведёт общее правило.
  assert.equal(matchRule(forward, { chatId: CHAT, threadId: 7 })?.project, 'общий');
  assert.equal(matchRule(forward, { chatId: CHAT, threadId: 7 })?.notifyTaskCreated, false);
});

// Ссылка на публичный чат приходит именем (`t.me/example_team/42`), а chatId в ней
// нет вовсе. Без поиска по имени такую ссылку нечем сопоставить с правилом —
// и весь хук на чтение для публичных чатов молча не работал бы.
test('публичный чат разрешается по имени, регистр и «собака» не мешают', () => {
  const rules = normalizeRules([{ project: 'demo', username: `@${PUB}` }]);
  assert.equal(matchRule(rules, { username: PUB })?.project, 'demo');
  assert.equal(matchRule(rules, { username: PUB.toUpperCase() })?.project, 'demo');
  assert.equal(matchRule(rules, { username: 'other' }), null);
});

// Опечатка в имени даёт правило-мертвяк: оно сохранится и не совпадёт никогда,
// а понять, почему ссылка не разворачивается, будет не по чему.
test('мусор вместо имени чата отвергается сразу', () => {
  assert.throws(() => normalizeRules([{ project: 'demo', username: 'ат чат' }]), /имя чата/i);
  assert.throws(() => normalizeRules([{ project: 'demo', username: 'ab' }]), /имя чата/i);
});

test('правило по имени и по id — про один чат: совпадает любая известная сторона', () => {
  const rules = normalizeRules([{ project: 'demo', chatId: CHAT, username: PUB }]);
  assert.equal(matchRule(rules, { chatId: CHAT })?.project, 'demo');
  assert.equal(matchRule(rules, { username: PUB })?.project, 'demo');
});

test('пустая цель не разрешается ничем', () => {
  const rules = normalizeRules([rule(), { project: 'demo', username: PUB }]);
  assert.equal(matchRule(rules, {}), null);
  assert.equal(matchRule(rules, { chatId: null, username: '' }), null);
});

// --- нормализация: что вообще можно сохранить ---

test('дефолты проставляются целиком, чтобы поздние фазы не читали undefined', () => {
  const [r] = normalizeRules([rule()]);
  assert.equal(r.kind, 'bug');
  assert.equal(r.draft, 'manual');
  assert.deepEqual(r.b24, { responsibleId: null, groupId: null, priority: 1 });
  assert.equal(r.notifyTaskCreated, false, 'старое правило остаётся молчащим');
  assert.equal(r.agentSearch, false, 'старое правило закрыто для поиска агента');
  assert.deepEqual(r.autoLaunch, {
    enabled: false, route: '', minConfidence: 0.8, maxPerDay: 3, vetoMinutes: 10,
  });
  // Автомат «чат → задача» выключен по умолчанию: заведённое правило сначала
  // просто показывает поводы в разделе, а решение остаётся кнопкой человека.
  assert.deepEqual(r.autoTask, { enabled: false, minConfidence: 0.7, maxPerDay: 10 });
});

test('agentSearch — отдельный opt-in и не сужает human allowlist', () => {
  const [humanOnly, forAgent] = normalizeRules([
    rule({ threadId: 41 }),
    rule({ threadId: 42, agentSearch: true }),
  ]);
  assert.equal(humanOnly.agentSearch, false);
  assert.equal(forAgent.agentSearch, true);
  assert.equal(matchRule([humanOnly], { chatId: CHAT, threadId: 41 })?.project, 'demo');
  assert.equal(matchRule([forAgent], { chatId: CHAT, threadId: 42 })?.project, 'demo');
});

test('canonical policy fingerprint стабилен и включает agentSearch', () => {
  const legacy = telegramRulesPolicyFingerprint([rule()]);
  const explicitDeny = telegramRulesPolicyFingerprint([rule({ agentSearch: false })]);
  const allowed = telegramRulesPolicyFingerprint([rule({ agentSearch: true })]);

  assert.match(legacy, /^telegram-rules-v1:[0-9a-f]{64}$/u);
  assert.equal(legacy, explicitDeny, 'отсутствующее поле равно явному deny');
  assert.notEqual(legacy, allowed, 'opt-in обязан менять policy fingerprint');
  assert.notEqual(
    legacy,
    telegramRulesPolicyFingerprint([rule()], { accountRef: 'acc_telegram_policy_0001' }),
    'account owner обязан входить в fingerprint внешней policy',
  );

  const reorderedKeys = {
    threadId: null,
    chatId: CHAT,
    project: 'demo',
  };
  assert.equal(legacy, telegramRulesPolicyFingerprint([reorderedKeys]));
});

test('пороги автозадач зажимаются, а не принимаются как есть', () => {
  const [r] = normalizeRules([rule({
    autoTask: { enabled: true, minConfidence: 42, maxPerDay: -3 },
  })]);
  assert.equal(r.autoTask.enabled, true);
  assert.equal(r.autoTask.minConfidence, 1);
  assert.equal(r.autoTask.maxPerDay, 0);
  // Маршрута автозадачам не нужно: они создают задачу в трекере, а не запускают
  // конвейер, — поэтому включённый тумблер сам по себе законен.
  assert.doesNotThrow(() => normalizeRules([rule({ autoTask: { enabled: true } })]));
});

test('подтверждение созданной задачи — отдельный opt-in каждого правила', () => {
  const [enabled, disabled] = normalizeRules([
    rule({ threadId: 41, notifyTaskCreated: true }),
    rule({ threadId: 42, notifyTaskCreated: false }),
  ]);
  assert.equal(enabled.notifyTaskCreated, true);
  assert.equal(disabled.notifyTaskCreated, false);
});

test('стёртое поле порога — это дефолт, а не «бери всё»', () => {
  // В форме всё строки, и очищенное поле приезжает пустой строкой. Число из неё
  // выходит нулём, а нулевой порог уверенности означает «заводи задачу по любому
  // разбору» — самое опасное значение из возможных. Пустота обязана читаться как
  // «не задано» и падать на осторожный дефолт.
  const [r] = normalizeRules([rule({
    autoTask: { enabled: true, minConfidence: '', maxPerDay: '' },
  })]);
  assert.equal(r.autoTask.minConfidence, 0.7);
  assert.equal(r.autoTask.maxPerDay, 10);

  // Ноль, набранный руками, — осознанный выбор и остаётся нулём: «не заводить
  // задач в этом чате, пока не подниму потолок».
  const [z] = normalizeRules([rule({ autoTask: { enabled: true, maxPerDay: 0 } })]);
  assert.equal(z.autoTask.maxPerDay, 0);

  // То же у автозапуска: там пустое окно вето значило бы «запускать немедленно».
  const [l] = normalizeRules([rule({
    autoLaunch: { enabled: true, route: 'feature', minConfidence: null, vetoMinutes: '' },
  })]);
  assert.equal(l.autoLaunch.minConfidence, 0.8);
  assert.equal(l.autoLaunch.vetoMinutes, 10);
});

test('id из формы приходят строками и становятся числами', () => {
  const [r] = normalizeRules([{
    project: 'demo',
    chatId: String(CHAT),
    threadId: '42',
    b24: { responsibleId: '17', groupId: '3', priority: '2' },
  }]);
  assert.equal(r.chatId, CHAT);
  assert.equal(r.threadId, 42);
  assert.deepEqual(r.b24, { responsibleId: 17, groupId: 3, priority: 2 });
});

test('тема «0» и пустая строка — это весь чат, а не тема номер ноль', () => {
  assert.equal(normalizeRules([rule({ threadId: 0 })])[0].threadId, null);
  assert.equal(normalizeRules([rule({ threadId: '' })])[0].threadId, null);
});

test('чужие поля в файл не попадают', () => {
  const [r] = normalizeRules([{ ...rule(), token: 'секрет', b24: { priority: 1, hack: 1 } }]);
  assert.equal(r.token, undefined);
  assert.equal(r.b24.hack, undefined);
});

test('правило без проекта и правило без адреса чата не сохраняются', () => {
  assert.throws(() => normalizeRules([{ chatId: CHAT }]), /проект/i);
  assert.throws(() => normalizeRules([{ project: 'demo' }]), /чат/i);
});

test('номер правила назван в тексте отказа — иначе в списке из десяти его не найти', () => {
  assert.throws(() => normalizeRules([rule(), { project: 'demo' }]), /2/);
});

// Молчаливая подстановка дефолта здесь опаснее отказа: человек выбрал «пожелание»,
// сохранилась «ошибка», и правило поедет не туда — а сообщения об этом не было.
test('вид и режим черновика вне словаря — отказ, а не тихая подмена', () => {
  assert.throws(() => normalizeRules([rule({ kind: 'idea' })]), /bug|wish/);
  assert.throws(() => normalizeRules([rule({ draft: 'sometimes' })]), /manual|auto/);
});

test('два правила на один и тот же адрес — отказ с указанием адреса', () => {
  assert.throws(() => normalizeRules([rule(), rule({ project: 'другой' })]), new RegExp(String(CHAT)));
  // Разные темы одного чата — это разные адреса, они законны.
  assert.doesNotThrow(() => normalizeRules([rule({ threadId: 1 }), rule({ threadId: 2 })]));
});

test('автозапуск без маршрута не включается: запускать нечего', () => {
  assert.throws(() => normalizeRules([rule({ autoLaunch: { enabled: true } })]), /маршрут/i);
  assert.doesNotThrow(() => normalizeRules([rule({ autoLaunch: { enabled: true, route: 'feature' } })]));
});

test('пороги автозапуска зажимаются в разумные границы', () => {
  const [r] = normalizeRules([rule({
    autoLaunch: { enabled: false, route: '', minConfidence: 42, maxPerDay: -3, vetoMinutes: -1 },
  })]);
  assert.equal(r.autoLaunch.minConfidence, 1);
  assert.equal(r.autoLaunch.maxPerDay, 0);
  assert.equal(r.autoLaunch.vetoMinutes, 0);
});

// Опечатка в id проекта иначе всплыла бы только в фазе 4, когда правило молча
// перестало бы создавать задачи, — а список проектов кокпит и так знает сам.
test('неизвестный проект отвергается, когда список проектов передан', () => {
  assert.throws(() => normalizeRules([rule({ project: 'опечатка' })], { projects: ['demo'] }), /опечатка/);
  assert.doesNotThrow(() => normalizeRules([rule()], { projects: ['demo'] }));
  // Списка нет — проверять нечем, и это не повод ронять сохранение.
  assert.doesNotThrow(() => normalizeRules([rule({ project: 'опечатка' })]));
});

test('не список — понятный отказ, а не падение на .map', () => {
  assert.throws(() => normalizeRules(null), /списк/i);
  assert.throws(() => normalizeRules({ rules: [] }), /списк/i);
});

// --- хранилище ---

test('файла нет — пустой список, а не ошибка', async () => {
  const store = new TelegramRulesStore({ dir: await tmpDir(), log: logStub() });
  assert.deepEqual(await store.read(), []);
  assert.equal(await store.ruleFor({ chatId: CHAT }), null);
});

test('записанное читается обратно тем же', async () => {
  const dir = await tmpDir();
  const store = new TelegramRulesStore({ dir, log: logStub() });
  const saved = await store.write([rule({
    threadId: 42,
    kind: 'wish',
    notifyTaskCreated: true,
  })]);
  assert.equal(saved.length, 1);

  const again = new TelegramRulesStore({ dir, log: logStub() });
  const [r] = await again.read();
  assert.equal(r.project, 'demo');
  assert.equal(r.threadId, 42);
  assert.equal(r.kind, 'wish');
  assert.equal(r.notifyTaskCreated, true);
  assert.equal((await again.ruleFor({ chatId: CHAT, threadId: 42 })).project, 'demo');
});

test('записи временного файла рядом не остаётся', async () => {
  const dir = await tmpDir();
  const store = new TelegramRulesStore({ dir, log: logStub() });
  await store.write([rule()]);
  const raw = await readFile(path.join(dir, 'rules.json'), 'utf8');
  assert.match(raw, /"project": "demo"/);
  await assert.rejects(readFile(path.join(dir, 'rules.json.tmp'), 'utf8'));
});

test('битый файл не роняет раздел, но и не стирается сам собой', async () => {
  const dir = await tmpDir();
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'rules.json'), '{ это не json', 'utf8');
  const log = logStub();
  const store = new TelegramRulesStore({ dir, log });
  assert.deepEqual(await store.read(), []);
  assert.equal(log.warns.length, 1);
  assert.match(await readFile(path.join(dir, 'rules.json'), 'utf8'), /не json/);
});

test('правку файла руками подхватываем без перезапуска', async () => {
  const dir = await tmpDir();
  const store = new TelegramRulesStore({ dir, log: logStub() });
  await store.write([rule()]);
  assert.equal((await store.read()).length, 1);

  await writeFile(
    path.join(dir, 'rules.json'),
    JSON.stringify({ rules: [rule({ project: 'правленный' })] }),
    'utf8',
  );
  assert.equal((await store.read())[0].project, 'правленный');
});

test('отказ валидации не портит уже сохранённое', async () => {
  const dir = await tmpDir();
  const store = new TelegramRulesStore({ dir, log: logStub() });
  await store.write([rule()]);
  await assert.rejects(store.write([{ chatId: CHAT }]), /проект/i);
  assert.equal((await store.read()).length, 1);
});

test('agentSearch меняется только отдельным CAS и переживает human-правку exact scope', async () => {
  const dir = await tmpDir();
  const store = new TelegramRulesStore({ dir, log: logStub() });
  await store.write([rule()]);
  const before = await store.readPolicySnapshot();

  await assert.rejects(
    store.writeHumanCas([rule({ agentSearch: true })], {
      expectedPolicyFingerprint: before.policyFingerprint,
    }),
    (error) => error?.code === 'telegram_rules_invalid' && error?.statusCode === 400,
  );

  const after = await store.setAgentSearch({
    rule: { project: 'demo', chatId: CHAT, username: null, threadId: null },
    enabled: true,
    expectedPolicyFingerprint: before.policyFingerprint,
  });
  assert.equal(after.rules[0].agentSearch, true);
  assert.notEqual(after.policyFingerprint, before.policyFingerprint);

  await assert.rejects(
    store.writeHumanCas([rule({ project: 'старая форма' })], {
      expectedPolicyFingerprint: before.policyFingerprint,
    }),
    (error) => error?.code === 'telegram_rules_stale' && error?.statusCode === 409,
  );
  assert.equal((await store.read())[0].agentSearch, true);

  const edited = await store.writeHumanCas([rule({ title: 'Новая подпись' })], {
    expectedPolicyFingerprint: after.policyFingerprint,
  });
  assert.equal(edited.rules[0].title, 'Новая подпись');
  assert.equal(edited.rules[0].agentSearch, true, 'несвязанная human-правка не снимает opt-in');
});

test('strict store пишет exact owner-bound schema v2 и публикует доказательство владельца', async () => {
  const dir = await tmpDir();
  const store = new TelegramRulesStore({
    dir,
    accountRef: ACCOUNT_A,
    botId: BOT_A,
    log: logStub(),
    strictRead: true,
  });

  await store.write([rule({ agentSearch: true })]);
  const raw = JSON.parse(await readFile(path.join(dir, 'rules.json'), 'utf8'));
  assert.deepEqual(Object.keys(raw).sort(), [
    'accountRef', 'botId', 'channel', 'rules', 'schemaVersion', 'updatedAtMs',
  ]);
  assert.equal(raw.schemaVersion, 2);
  assert.equal(raw.channel, 'telegram');
  assert.equal(raw.accountRef, ACCOUNT_A);
  assert.equal(raw.botId, BOT_A);
  assert.equal(raw.rules[0].agentSearch, true);

  const cold = new TelegramRulesStore({
    dir,
    accountRef: ACCOUNT_A,
    botId: BOT_A,
    log: logStub(),
    strictRead: true,
  });
  const snapshot = await cold.readPolicySnapshot();
  assert.equal(snapshot.ownerBound, true);
  assert.equal(snapshot.rules[0].agentSearch, true);
});

test('legacy ownerless rules остаются human-only до нового explicit agentSearch CAS', async () => {
  const dir = await tmpDir();
  await writeFile(path.join(dir, 'rules.json'), JSON.stringify({
    updatedAt: 1,
    rules: [rule({ agentSearch: true })],
  }));
  const store = new TelegramRulesStore({
    dir,
    accountRef: ACCOUNT_A,
    botId: BOT_A,
    log: logStub(),
    strictRead: true,
  });

  const legacy = await store.readPolicySnapshot();
  assert.equal(legacy.ownerBound, false);
  assert.equal(legacy.rules[0].agentSearch, false, 'ownerless opt-in нельзя наследовать');

  const rebound = await store.setAgentSearch({
    rule: { project: 'demo', chatId: CHAT, username: null, threadId: null },
    enabled: true,
    expectedPolicyFingerprint: legacy.policyFingerprint,
  });
  assert.equal(rebound.ownerBound, true);
  assert.equal(rebound.rules[0].agentSearch, true);
  const raw = JSON.parse(await readFile(path.join(dir, 'rules.json'), 'utf8'));
  assert.equal(raw.schemaVersion, 2);
  assert.equal(raw.accountRef, ACCOUNT_A);
  assert.equal(raw.botId, BOT_A);
});

test('owner-bound rules нельзя пересадить другому Telegram account или bot', async () => {
  const sourceDir = await tmpDir();
  const targetDir = await tmpDir();
  const source = new TelegramRulesStore({
    dir: sourceDir,
    accountRef: ACCOUNT_A,
    botId: BOT_A,
    log: logStub(),
    strictRead: true,
  });
  await source.write([rule({ agentSearch: true })]);
  await writeFile(
    path.join(targetDir, 'rules.json'),
    await readFile(path.join(sourceDir, 'rules.json')),
  );

  for (const owner of [
    { accountRef: ACCOUNT_B, botId: BOT_A },
    { accountRef: ACCOUNT_A, botId: BOT_B },
  ]) {
    const transplanted = new TelegramRulesStore({
      dir: targetDir,
      ...owner,
      log: logStub(),
      strictRead: true,
    });
    await assert.rejects(
      () => transplanted.readPolicySnapshot(),
      (error) => error?.code === 'telegram_rules_invalid',
    );
  }
});

test('malformed owner-bound schema не понижается до permissive legacy parser', async () => {
  const dir = await tmpDir();
  await writeFile(path.join(dir, 'rules.json'), JSON.stringify({
    schemaVersion: 2,
    channel: 'telegram',
    accountRef: ACCOUNT_A,
    botId: BOT_A,
    updatedAtMs: 1,
    rules: [rule({ agentSearch: true })],
    injected: true,
  }));
  const store = new TelegramRulesStore({
    dir,
    accountRef: ACCOUNT_A,
    botId: BOT_A,
    log: logStub(),
    strictRead: true,
  });
  await assert.rejects(
    () => store.readPolicySnapshot(),
    (error) => error?.code === 'telegram_rules_invalid',
  );
});

test('strict rules отвергает ancestor symlink и hardlink replay', async () => {
  const sourceDir = await tmpDir();
  const source = strictStore(sourceDir);
  await source.write([rule({ agentSearch: true })]);

  const parent = await tmpDir();
  const linkedDir = path.join(parent, 'linked-account');
  await symlink(sourceDir, linkedDir, 'dir');
  await assert.rejects(
    () => strictStore(linkedDir).readPolicySnapshot(),
    (error) => error?.code === 'telegram_rules_invalid',
  );

  const hardlinkDir = await tmpDir();
  await link(path.join(sourceDir, 'rules.json'), path.join(hardlinkDir, 'rules.json'));
  assert.equal((await lstat(path.join(sourceDir, 'rules.json'))).nlink, 2);
  await assert.rejects(
    () => strictStore(hardlinkDir).readPolicySnapshot(),
    (error) => error?.code === 'telegram_rules_invalid',
  );
});

test('strict policy не доверяет metadata cache после равнодлинной in-place правки', async () => {
  const dir = await tmpDir();
  const store = strictStore(dir);
  await store.write([rule({ agentSearch: true })]);
  assert.equal((await store.readPolicySnapshot()).rules[0].agentSearch, true);

  const file = path.join(dir, 'rules.json');
  const before = await lstat(file);
  const bytes = await readFile(file, 'utf8');
  const denied = bytes.replace('"agentSearch": true', '"agentSearch":false');
  assert.equal(Buffer.byteLength(denied), Buffer.byteLength(bytes));
  await writeFile(file, denied);
  await utimes(file, before.atime, before.mtime);

  const current = await store.readPolicySnapshot();
  assert.equal(current.rules[0].agentSearch, false);
});

test('inner v2 rules требуют canonical disk types и canonical botId string', async () => {
  const templateDir = await tmpDir();
  await strictStore(templateDir).write([rule()]);
  const template = JSON.parse(await readFile(path.join(templateDir, 'rules.json'), 'utf8'));

  const malformedRules = [
    { ...template.rules[0], project: 123 },
    { ...template.rules[0], chatId: [CHAT] },
    { ...template.rules[0], autoTask: { ...template.rules[0].autoTask, enabled: 'false' } },
    { ...template.rules[0], autoLaunch: { ...template.rules[0].autoLaunch, enabled: 'false' } },
  ];
  for (const malformed of malformedRules) {
    const dir = await tmpDir();
    await writeFile(path.join(dir, 'rules.json'), JSON.stringify({
      ...template,
      rules: [malformed],
    }));
    await assert.rejects(
      () => strictStore(dir).readPolicySnapshot(),
      (error) => error?.code === 'telegram_rules_invalid',
    );
  }

  const numericBotDir = await tmpDir();
  await writeFile(path.join(numericBotDir, 'rules.json'), JSON.stringify({
    ...template,
    botId: Number(BOT_A),
  }));
  await assert.rejects(
    () => strictStore(numericBotDir).readPolicySnapshot(),
    (error) => error?.code === 'telegram_rules_invalid',
  );
});

test('два strict store одного path сериализуют CAS, а read не отдаёт mutable cache', async () => {
  const dir = await tmpDir();
  const first = strictStore(dir);
  const second = strictStore(dir);
  await first.write([
    rule({ threadId: 41 }),
    rule({ threadId: 42 }),
  ]);
  const before = await first.readPolicySnapshot();

  const attempts = await Promise.allSettled([
    first.setAgentSearch({
      rule: { project: 'demo', chatId: CHAT, username: null, threadId: 41 },
      enabled: true,
      expectedPolicyFingerprint: before.policyFingerprint,
    }),
    second.setAgentSearch({
      rule: { project: 'demo', chatId: CHAT, username: null, threadId: 42 },
      enabled: true,
      expectedPolicyFingerprint: before.policyFingerprint,
    }),
  ]);
  assert.deepEqual(attempts.map(({ status }) => status).sort(), ['fulfilled', 'rejected']);
  assert.equal(attempts.find(({ status }) => status === 'rejected').reason.code, 'telegram_rules_stale');

  const leaked = await first.read();
  leaked[0].agentSearch = !leaked[0].agentSearch;
  const authoritative = await first.readPolicySnapshot();
  assert.notEqual(authoritative.rules[0].agentSearch, leaked[0].agentSearch);
});
