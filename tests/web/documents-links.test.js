import assert from 'node:assert/strict';
import test from 'node:test';

import {
  documentLinkFromClick,
  documentRefAssetHref,
  documentRefRouteHref,
  documentRouteHref,
  parseDocumentHref,
  parseDocumentRouteHref,
} from '../../web/src/features/documents/links.js';
import { mdToHtml } from '../../web/src/shared/md.js';

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
      source: 'cockpit',
      basePath: 'docs/spec/current.md',
    }),
    '#/documents?source=cockpit&path=docs%2Fnotes%2Ftodo.md&anchor=later',
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
  const href = '#/documents?source=cockpit&path=README.md&line=12';
  assert.deepEqual(parseDocumentRouteHref(href), {
    open: '', source: 'cockpit', path: 'README.md', line: 12, anchor: '',
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
    documentRefAssetHref('../assets/logo.png', { source: 'cockpit', basePath: 'docs/start/README.md' }),
    '/api/documents/asset?source=cockpit&path=docs%2Fassets%2Flogo.png',
  );
  assert.equal(
    documentRefAssetHref('../../../outside.png', { source: 'cockpit', basePath: 'README.md' }),
    '',
  );
  assert.equal(
    documentRefAssetHref('diagram.svg', { source: 'cockpit', basePath: 'README.md' }),
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
