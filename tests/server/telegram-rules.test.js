// Правила «чат/тема → проект»: allowlist и его хранилище.
//
// Это не настройка удобства, а ГРАНИЦА БЕЗОПАСНОСТИ фазы 2 (раздел 2 плана):
// разворачивается только ссылка на чат, привязанный к проекту. Иначе произвольная
// ссылка, вписанная в описание задачи, вытянула бы содержимое любого чата, где бот
// случайно состоит. Поэтому главные проверки здесь — про отказ по умолчанию и про
// то, что правило темы не расползается на соседние темы.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  TelegramRulesStore, matchRule, normalizeRules,
} from '../../server/src/lib/telegram/rules-store.js';

const CHAT = -1002263563987; // приватный форум, тот же, что в архивных тестах
const PUB = 'atprojects';

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
  const forward = normalizeRules([rule({ project: 'общий' }), rule({ project: 'тема', threadId: 42 })]);
  const backward = normalizeRules([rule({ project: 'тема', threadId: 42 }), rule({ project: 'общий' })]);
  assert.equal(matchRule(forward, { chatId: CHAT, threadId: 42 })?.project, 'тема');
  assert.equal(matchRule(backward, { chatId: CHAT, threadId: 42 })?.project, 'тема');
  // А сообщение вне темы всё так же ведёт общее правило.
  assert.equal(matchRule(forward, { chatId: CHAT, threadId: 7 })?.project, 'общий');
});

// Ссылка на публичный чат приходит именем (`t.me/atprojects/20423`), а chatId в ней
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
  assert.deepEqual(r.autoLaunch, {
    enabled: false, route: '', minConfidence: 0.8, maxPerDay: 3, vetoMinutes: 10,
  });
  // Автомат «чат → задача» выключен по умолчанию: заведённое правило сначала
  // просто показывает поводы в разделе, а решение остаётся кнопкой человека.
  assert.deepEqual(r.autoTask, { enabled: false, minConfidence: 0.7, maxPerDay: 10 });
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
  const saved = await store.write([rule({ threadId: 42, kind: 'wish' })]);
  assert.equal(saved.length, 1);

  const again = new TelegramRulesStore({ dir, log: logStub() });
  const [r] = await again.read();
  assert.equal(r.project, 'demo');
  assert.equal(r.threadId, 42);
  assert.equal(r.kind, 'wish');
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
