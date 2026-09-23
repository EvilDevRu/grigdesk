// Какой проект «Код» открывает сам.
//
// Автовыбор — это догадка панели, а не решение человека: архивный проект в неё
// попадать не должен. Но если человек открыл архивный сам (последний выбор или
// переход по ссылке), панель обязана его показать — архив ничего не прячет силой.
import assert from 'node:assert/strict';
import test from 'node:test';

import { pickCodeProject } from '../../web/src/views/code/projectChoice.ts';

const ARCHIVED_AT = '2026-09-22T10:00:00.000Z';

const PROJECTS = [
  { id: 'kopeika', repos: [{ key: 'main', dir: '/srv/kopeika' }], archivedAt: ARCHIVED_AT },
  { id: 'cockpit', repos: [{ key: 'cockpit', dir: '/srv/cockpit' }], archivedAt: null },
  { id: 'empty', repos: [], archivedAt: null },
];

test('сам панель открывает активный проект с репозиториями, а не первый в списке', () => {
  assert.equal(pickCodeProject(PROJECTS, '')?.id, 'cockpit');
});

test('явно выбранный проект открывается даже из архива', () => {
  assert.equal(pickCodeProject(PROJECTS, 'kopeika')?.id, 'kopeika');
});

test('без активных проектов с путями остаётся хоть что-нибудь', () => {
  const onlyArchived = [PROJECTS[0]];

  assert.equal(pickCodeProject(onlyArchived, '')?.id, 'kopeika');
  assert.equal(pickCodeProject([], ''), null);
});

test('проект без путей выбирается последним: открывать в нём нечего', () => {
  const noRepos = [{ id: 'empty', repos: [], archivedAt: null }, PROJECTS[1]];

  assert.equal(pickCodeProject(noRepos, '')?.id, 'cockpit');
});
