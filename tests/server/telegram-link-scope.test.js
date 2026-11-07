// Граница доступа хука на чтение: какую ссылку вообще позволено разворачивать.
//
// Это ALLOWLIST (раздел 2 плана): без правила — отказ, всегда. Иначе произвольная
// ссылка, вписанная в описание задачи, вытягивала бы содержимое любого чата, где
// бот случайно состоит.
//
// Здесь проверяется ТОЛЬКО граница — ни сети, ни архива в тесте нет. Сам резолв
// (архив → пересылка → отказ с причиной) живёт в telegram-resolve.test.js.
import assert from 'node:assert/strict';
import test from 'node:test';

import { parseTelegramLinks } from '../../server/src/lib/telegram/links.ts';
import { normalizeRules } from '../../server/src/lib/telegram/rulesStore.ts';
import {
  checkScope, scopeLinks, targetOfLink, targetOfMessage,
} from '../../server/src/lib/telegram/linkScope.ts';

const BUGS = -1001234567890; // приватная группа «баги», привязана к проекту
const OTHER = -1009876543210; // чат, про который правил нет вовсе

/** Правила как их отдаёт хранилище — то есть уже прошедшие нормализацию. */
const rules = (...list) => normalizeRules(list);

const one = (text) => {
  const links = parseTelegramLinks(text);
  assert.equal(links.length, 1, `ожидалась одна ссылка в «${text}»`);
  return links[0];
};

/** Сообщение в форме архива (см. lib/telegram/updates.js). */
const message = (over = {}) => ({
  chatId: BUGS,
  chatUsername: '',
  chatTitle: 'GrigDesk · баги',
  threadId: null,
  messageId: 42,
  date: 1_770_000_000,
  text: 'кнопка «сохранить» не жмётся',
  ...over,
});

test('чат без правила не разворачивается: not_allowed', () => {
  const list = rules({ project: 'alpha', chatId: BUGS });

  const priv = checkScope(list, targetOfLink(one(`https://t.me/c/9876543210/42`)));
  assert.equal(priv.allowed, false);
  assert.equal(priv.reason, 'not_allowed');
  assert.equal(priv.rule, null);
  // Причина обязана быть словами: нераскрытая ссылка показывается человеку с ней.
  assert.match(priv.message, /не привязан/i);

  const pub = checkScope(list, targetOfLink(one('https://t.me/example_random/7')));
  assert.equal(pub.allowed, false);
  assert.equal(pub.reason, 'not_allowed');
});

test('пустой список правил закрывает всё, а не открывает', () => {
  const verdict = checkScope([], targetOfLink(one(`https://t.me/c/1234567890/42`)));
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, 'not_allowed');
});

test('привязанный чат разворачивается, и видно, чьё это правило', () => {
  const list = rules({ project: 'alpha', chatId: BUGS, kind: 'bug' });
  const verdict = checkScope(list, targetOfLink(one(`https://t.me/c/1234567890/42`)));

  assert.equal(verdict.allowed, true);
  assert.equal(verdict.reason, null);
  assert.equal(verdict.rule.project, 'alpha');
  // Правило нужно дальше целиком: по нему собирается черновик задачи.
  assert.equal(verdict.rule.kind, 'bug');
});

test('привязка одного проекта не открывает чат другому', () => {
  const list = rules({ project: 'alpha', chatId: BUGS });
  const target = targetOfLink(one(`https://t.me/c/1234567890/42`));

  const own = checkScope(list, target, { project: 'alpha' });
  assert.equal(own.allowed, true);

  const foreign = checkScope(list, target, { project: 'beta' });
  assert.equal(foreign.allowed, false);
  assert.equal(foreign.reason, 'not_allowed');
  // Отказ называет оба проекта — иначе человек не поймёт, чего не хватает.
  assert.match(foreign.message, /alpha/);
  assert.match(foreign.message, /beta/);
  // Правило возвращается и при отказе: по нему видно, кому чат всё-таки принадлежит.
  assert.equal(foreign.rule.project, 'alpha');
});

test('проект неизвестен — хватает любой привязки', () => {
  // Задачу трекера открывают и до того, как её запустили по какому-либо проекту:
  // профиля у неё тогда нет. Граница при этом остаётся — чат обязан быть
  // привязан хоть к чему-то, просто сверять его не с чем.
  const list = rules({ project: 'alpha', chatId: BUGS });
  const verdict = checkScope(list, targetOfLink(one(`https://t.me/c/1234567890/42`)));

  assert.equal(verdict.allowed, true);
  assert.equal(verdict.rule.project, 'alpha');
});

test('тема форума решает доступ сама: своя тема — свой проект', () => {
  const list = rules(
    { project: 'alpha', chatId: BUGS }, // весь чат
    { project: 'beta', chatId: BUGS, threadId: 7 }, // отдельная тема
  );

  const inThread = targetOfLink(one(`https://t.me/c/1234567890/7/42`));
  assert.equal(checkScope(list, inThread, { project: 'beta' }).allowed, true);
  // Тема отдана другому проекту — общая привязка чата её больше не покрывает.
  assert.equal(checkScope(list, inThread, { project: 'alpha' }).allowed, false);

  // А соседняя тема своего правила не имеет и остаётся за общим правилом чата.
  const neighbour = targetOfLink(one(`https://t.me/c/1234567890/9/42`));
  assert.equal(checkScope(list, neighbour, { project: 'alpha' }).allowed, true);
  assert.equal(checkScope(list, neighbour, { project: 'beta' }).allowed, false);
});

test('имя чата сверяется без учёта регистра и «собаки»', () => {
  const list = rules({ project: 'alpha', username: '@Example_Team' });
  const verdict = checkScope(list, targetOfLink(one('https://t.me/example_TEAM/1287')));
  assert.equal(verdict.allowed, true);
});

test('решает фактический чат резолва, а не форма ссылки', () => {
  // За `t.me/<имя>/<N>` стоит и пост канала, и сообщение группы обсуждения —
  // это разные чаты. Совпадения по имени из ссылки мало: доступ решает тот чат,
  // в котором сообщение нашлось на самом деле.
  const list = rules({ project: 'alpha', username: 'example_team' });
  const link = one('https://t.me/example_team/900');
  assert.equal(link.ambiguous, true);
  assert.equal(checkScope(list, targetOfLink(link)).allowed, true);

  // Сообщение оказалось в группе обсуждения — у неё свой id и своего правила нет.
  const discuss = message({ chatId: OTHER, chatUsername: '', messageId: 900 });
  const verdict = checkScope(list, targetOfMessage(discuss));
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, 'not_allowed');

  // Обратный случай: чат привязан по id, а ссылка пришла публичной формой.
  // Найденное сообщение знает обе стороны адреса, поэтому правило совпадает.
  const byId = rules({ project: 'alpha', chatId: BUGS });
  const found = message({ chatId: BUGS, chatUsername: 'example_team', messageId: 900 });
  assert.equal(checkScope(byId, targetOfMessage(found)).allowed, true);
});

test('тема берётся из найденного сообщения, а не из ссылки', () => {
  // Ссылку на сообщение внутри темы копируют и без номера темы; молчание ссылки
  // не должно открывать тему, отданную другому проекту.
  const list = rules(
    { project: 'alpha', chatId: BUGS },
    { project: 'beta', chatId: BUGS, threadId: 7 },
  );
  const link = one(`https://t.me/c/1234567890/42`);
  assert.equal(link.threadId, null);
  assert.equal(checkScope(list, targetOfLink(link), { project: 'alpha' }).allowed, true);

  const found = message({ threadId: 7 });
  assert.equal(checkScope(list, targetOfMessage(found), { project: 'alpha' }).allowed, false);
  assert.equal(checkScope(list, targetOfMessage(found), { project: 'beta' }).allowed, true);
});

test('scopeLinks: у каждой ссылки свой вердикт, у отказа — причина словами', () => {
  const list = rules({ project: 'alpha', chatId: BUGS });
  const text = [
    'Повтор описан тут https://t.me/c/1234567890/42',
    'а вот это уже из другого чата https://t.me/c/9876543210/7',
  ].join('\n');

  const scoped = scopeLinks(parseTelegramLinks(text), { rules: list, project: 'alpha' });
  assert.equal(scoped.length, 2);

  assert.equal(scoped[0].allowed, true);
  assert.equal(scoped[0].link.messageId, 42);
  assert.equal(scoped[0].rule.project, 'alpha');

  assert.equal(scoped[1].allowed, false);
  assert.equal(scoped[1].reason, 'not_allowed');
  assert.ok(scoped[1].message, 'у отказа обязан быть текст для человека');
  // Ссылка остаётся при вердикте: её показывают человеку вместе с причиной.
  assert.equal(scoped[1].link.chatId, OTHER);
});
