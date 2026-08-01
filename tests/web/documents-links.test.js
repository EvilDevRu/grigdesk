import assert from 'node:assert/strict';
import test from 'node:test';

import {
  documentRefRouteHref,
  documentRouteHref,
  parseDocumentHref,
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

  const unsafe = mdToHtml('[опасно](safe.md)', { resolveHref: () => 'javascript:alert(1)' });
  assert.doesNotMatch(unsafe, /javascript:/);
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
