import assert from 'node:assert/strict';
import test from 'node:test';

import { chatFileLinkHref } from '../../web/src/features/code/links.ts';
import {
  documentLinkFromClick,
  documentRefAssetHref,
  documentRefRouteHref,
  documentRouteHref,
  parseDocumentHref,
  parseDocumentRouteHref,
} from '../../web/src/features/documents/links.ts';
import { mdToHtml } from '../../web/src/shared/md.ts';

test('DOC-WEB-01: абсолютная MD/TXT-ссылка превращается во внутренний route', () => {
  assert.equal(
    documentRouteHref('/home/user/project/docs/plan.md'),
    '#/documents?open=%2Fhome%2Fuser%2Fproject%2Fdocs%2Fplan.md',
  );
  assert.deepEqual(parseDocumentHref('/home/user/readme.txt:42'), {
    path: '/home/user/readme.txt', line: 42, anchor: '',
  });
});

test('DOC-WEB-04: внутри viewer ссылка остаётся стабильным source/path ref', () => {
  assert.equal(
    documentRefRouteHref('../notes/todo.md#later', {
      source: 'grigdesk',
      basePath: 'docs/spec/current.md',
    }),
    '#/documents?source=grigdesk&path=docs%2Fnotes%2Ftodo.md&anchor=later',
  );
});

test('DOC-WEB-05: Markdown renderer применяет link resolver, но повторно проверяет URL', () => {
  const html = mdToHtml('[план](/srv/repo/plan.md)', { resolveHref: documentRouteHref });
  assert.match(html, /href="#\/documents\?open=%2Fsrv%2Frepo%2Fplan\.md"/);
  assert.match(html, /data-document-link="true"/);
  assert.doesNotMatch(html, /target="_blank"/);

  const unsafe = mdToHtml('[опасно](safe.md)', { resolveHref: () => 'javascript:alert(1)' });
  assert.doesNotMatch(unsafe, /javascript:/);
});

test('DOC-WEB-06: обычный клик по route документа предназначен для модального viewer-а', () => {
  const href = '#/documents?source=grigdesk&path=README.md&line=12';
  assert.deepEqual(parseDocumentRouteHref(href), {
    open: '',
    scope: '',
    source: 'grigdesk',
    path: 'README.md',
    line: 12,
    anchor: '',
  });
  const event = {
    button: 0,
    target: { closest: () => ({ getAttribute: () => href }) },
  };
  assert.equal(documentLinkFromClick(event), href);
  assert.equal(documentLinkFromClick({ ...event, ctrlKey: true }), '');
});

test('DOC-WEB-07: относительная картинка остаётся внутри source документа', () => {
  assert.equal(
    documentRefAssetHref('../assets/logo.png', { source: 'grigdesk', basePath: 'docs/start/README.md' }),
    '/api/documents/asset?source=grigdesk&path=docs%2Fassets%2Flogo.png',
  );
  assert.equal(
    documentRefAssetHref('../../../outside.png', { source: 'grigdesk', basePath: 'README.md' }),
    '',
  );
  assert.equal(
    documentRefAssetHref('diagram.svg', { source: 'grigdesk', basePath: 'README.md' }),
    '',
  );
});

test('DOC-WEB-02: относительная ссылка документа разрешается от открытого файла', () => {
  assert.deepEqual(parseDocumentHref('../notes/todo.md#later', {
    basePath: '/srv/repo/docs/spec/current.md',
  }), {
    path: '/srv/repo/docs/notes/todo.md', line: 0, anchor: 'later',
  });
});

test('DOC-WEB-03: внешние URL, каталоги и неподдержанные типы не перехватываются', () => {
  for (const href of ['https://example.com/a.md', 'mailto:a@example.com', '/srv/repo', '/srv/repo/data.json']) {
    assert.equal(documentRouteHref(href), '');
  }
});

test('DOC-WEB-08: ссылка из чата несёт область чата, документ внутри неё — тоже', () => {
  const href = chatFileLinkHref('/srv/game/docs/hero.md', { roots: [], scope: 'chat:abc_1' });

  assert.equal(href, '#/documents?open=%2Fsrv%2Fgame%2Fdocs%2Fhero.md&scope=chat%3Aabc_1');
  assert.equal(parseDocumentRouteHref(href).scope, 'chat:abc_1');
  assert.equal(
    documentRefRouteHref('/srv/game/docs/other.md', { source: 'chat:abc_1:0', basePath: 'docs/hero.md' }),
    '#/documents?open=%2Fsrv%2Fgame%2Fdocs%2Fother.md&scope=chat%3Aabc_1',
  );
});

test('DOC-WEB-09: повреждённая область не попадает в route', () => {
  assert.equal(
    documentRouteHref('/srv/plan.md', { scope: 'chat:../x' }),
    '#/documents?open=%2Fsrv%2Fplan.md',
  );
  assert.equal(parseDocumentRouteHref('#/documents?open=%2Fa.md&scope=%3Cx%3E').scope, '');
  assert.equal(
    documentRefRouteHref('/srv/plan.md', { source: 'grigdesk', basePath: 'README.md' }),
    '#/documents?open=%2Fsrv%2Fplan.md',
  );
});
