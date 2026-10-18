// Мост «файловая ссылка агента → панель „Код“» и главное правило рендера:
// ссылка, которая никуда не ведёт, показывается ТЕКСТОМ.
//
// Раньше просмотрщик документов принимал только .md/.markdown/.txt, а всё остальное
// резолвер молча пропускал — и markdown-рендерер всё равно рисовал синюю ссылку
// (обычный относительный путь проходит его allowlist). Клик по `chat.js` открывал
// пустую вкладку на origin GrigDesk: ссылка выглядела живой и не работала.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  chatFileLinkHref,
  codeLinkFromClick,
  codeLinkHref,
  codeRouteHref,
  looksLikeLocalPath,
  parseCodeRouteHref,
  parseCodeTarget,
} from '../../web/src/features/code/links.ts';
import { mdToHtml } from '../../web/src/shared/md.ts';

const ROOTS = [
  { project: 'grigdesk', repo: 'main', root: '/home/user/Workspace/grigdesk', main: true, branch: 'dev' },
  { project: 'grigdesk', repo: 'main', root: '/home/user/Workspace/grigdesk-t1234', main: false, branch: 'task-1234' },
  { project: 'other', repo: 'api', root: '/srv/api', main: true, branch: 'master' },
];
const resolve = (href) => chatFileLinkHref(href, { roots: ROOTS });

test('CODE-LINK-01: путь под известным деревом становится route панели', () => {
  assert.equal(
    codeRouteHref('/home/user/Workspace/grigdesk/web/src/stores/chat.js', { roots: ROOTS }),
    '#/code?project=grigdesk&repo=main'
      + '&root=%2Fhome%2Fuser%2FWorkspace%2Fgrigdesk&path=web%2Fsrc%2Fstores%2Fchat.js',
  );
  assert.deepEqual(parseCodeTarget('/srv/api/app/main.py:120', ROOTS), {
    project: 'other', repo: 'api', root: '/srv/api', path: 'app/main.py', line: 120,
  });
});

test('CODE-LINK-02: worktree выигрывает у основного дерева, а чужой путь не притягивается', () => {
  // Корни могут быть вложены друг в друга; побеждает самый длинный совпавший —
  // иначе ссылка на файл задачи открыла бы одноимённый файл основного дерева.
  const nested = [
    { project: 'grigdesk', repo: 'main', root: '/home/user/Workspace' },
    { project: 'grigdesk', repo: 'main', root: '/home/user/Workspace/grigdesk-t1234' },
  ];
  assert.equal(parseCodeTarget('/home/user/Workspace/grigdesk-t1234/server/src/app.js', nested).root,
    '/home/user/Workspace/grigdesk-t1234');

  assert.equal(parseCodeTarget('/etc/passwd', ROOTS), null);
  // Префикс имени — не вложенность.
  assert.equal(parseCodeTarget('/srv/api-backup/main.py', ROOTS), null);
});

test('CODE-LINK-03: служебные каталоги в мост не попадают', () => {
  // Сервер их всё равно закроет: ссылка-кнопка вела бы прямиком в отказ.
  assert.equal(parseCodeTarget('/home/user/Workspace/grigdesk/.git/config', ROOTS), null);
  assert.equal(parseCodeTarget('/home/user/Workspace/grigdesk/server/.state/cli-token', ROOTS), null);
});

test('CODE-LINK-04: мёртвая локальная ссылка рендерится текстом, а не синей ссылкой', () => {
  assert.equal(resolve('/var/log/unknown/app.js'), false);
  const html = mdToHtml('см. [chat.js](/var/log/unknown/app.js)', { resolveHref: resolve });
  assert.doesNotMatch(html, /<a /);
  assert.match(html, /chat\.js/);
});

test('CODE-LINK-05: у документов приоритет, у кода — свой признак клика', () => {
  // .md остаётся у просмотрщика документов, даже если лежит под известным деревом.
  assert.match(resolve('/home/user/Workspace/grigdesk/docs/grigdesk/b24.md'), /^#\/documents\?open=/);

  const html = mdToHtml('[стор](/home/user/Workspace/grigdesk/web/src/stores/chat.js)', { resolveHref: resolve });
  assert.match(html, /data-code-link="true"/);
  assert.doesNotMatch(html, /target="_blank"/);
});

test('CODE-LINK-06: внешние ссылки не трогаются, а обычный клик отдаёт цель', () => {
  assert.equal(resolve('https://example.com/x.js'), '');
  assert.equal(looksLikeLocalPath('https://example.com/x.js'), false);
  assert.equal(looksLikeLocalPath('#anchor'), false);
  const external = mdToHtml('[внешняя](https://example.com/x.js)', { resolveHref: resolve });
  assert.match(external, /target="_blank"/);

  const href = codeRouteHref('/srv/api/app/main.py:12', { roots: ROOTS });
  assert.deepEqual(parseCodeRouteHref(href), {
    project: 'other', repo: 'api', root: '/srv/api', path: 'app/main.py', line: 12,
  });
  const event = { button: 0, target: { closest: () => ({ getAttribute: () => href }) } };
  assert.deepEqual(codeLinkFromClick(event)?.path, 'app/main.py');
  // Модифицированный клик остаётся обычной навигацией браузера.
  assert.equal(codeLinkFromClick({ ...event, ctrlKey: true }), null);
});

test('CODE-LINK-08: вердикт «текстом» действует и на raw HTML санитайзера', async () => {
  // Viewer документов пропускает разметку через allowlist отдельным путём. Оба пути
  // обязаны одинаково понимать вердикт резолвера, иначе <a> из HTML останется живым.
  const { Window } = await import('../../web/node_modules/happy-dom/lib/index.js');
  const sanitizerDocument = new Window().document;
  const html = mdToHtml('<p>см. <a href="/var/log/unknown/app.js">chat.js</a></p>', {
    allowHtml: true, sanitizerDocument, resolveHref: resolve,
  });
  assert.doesNotMatch(html, /<a /);
  assert.match(html, /chat\.js/);
});

test('CODE-LINK-07: без карты деревьев мост молчит, а не выдумывает ссылку', () => {
  // Плагин «Код» выключен или /api/code/roots ещё не ответил: ссылка остаётся текстом,
  // и это честнее кнопки, которая приведёт в пустоту.
  assert.equal(codeRouteHref('/srv/api/app/main.py', { roots: [] }), '');
  assert.equal(chatFileLinkHref('/srv/api/app/main.py', { roots: [] }), false);
});

test('CODE-LINK-09: абсолютная ссылка обратно разбирается вместе с Unicode и line=0', () => {
  for (const line of [0, 27]) {
    const target = {
      project: 'мой проект',
      repo: 'web ui',
      root: '/srv/Рабочая копия',
      path: 'src/новый файл.ts',
      line,
    };
    const href = codeLinkHref(target, 'https://grigdesk.example.test/');

    assert.match(href, /^https:\/\/grigdesk\.example\.test\/#\/code\?/);
    assert.equal(new URL(href).hash.includes('line=0'), line === 0);
    assert.deepEqual(parseCodeRouteHref(href), target);
  }
});
