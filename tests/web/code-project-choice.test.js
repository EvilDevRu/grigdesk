// Какой проект «Код» открывает сам.
//
// Архивный проект может открываться по ссылке, вне автоматического выбора.
import assert from 'node:assert/strict';
import test from 'node:test';

import { pickCodeProject } from '../../web/src/views/code/projectChoice.ts';

const PROJECTS = [
  { id: 'grigdesk', repos: [{ key: 'grigdesk', dir: '/srv/grigdesk' }] },
  { id: 'empty', repos: [] },
];

test('сам панель открывает активный проект с репозиториями, а не первый в списке', () => {
  assert.equal(pickCodeProject(PROJECTS, '')?.id, 'grigdesk');
});

test('сохранённый проект вне рабочего каталога уступает активному', () => {
  assert.equal(pickCodeProject(PROJECTS, 'kopeika')?.id, 'grigdesk');
  assert.equal(pickCodeProject(PROJECTS, 'empty')?.id, 'empty');
});

test('без активных проектов автооткрытия нет', () => {
  assert.equal(pickCodeProject([], ''), null);
});

test('проект без путей выбирается последним: открывать в нём нечего', () => {
  const noRepos = [PROJECTS[1], PROJECTS[0]];

  assert.equal(pickCodeProject(noRepos, '')?.id, 'grigdesk');
});
