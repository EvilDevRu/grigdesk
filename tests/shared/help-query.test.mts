import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeHelpBundle, parseHelpInput } from '../../shared/help/helpContracts.ts';
import { queryHelp } from '../../shared/help/helpQuery.ts';
import { helpHref, helpArticleForContext } from '../../shared/help/helpLinks.ts';
import { localeCorpus } from '../helpers/helpLocale.mts';

const overview = {
  id: 'overview',
  file: 'README.md',
  title: 'Начало',
  section: 'Основы',

  keywords: [],
  routes: [],
  markdown: '# Начало\n[Разговоры](chats.md)'
};
const chats = {
  id: 'chats',
  file: 'chats.md',
  title: 'Рабочая папка',
  section: 'Разговоры',

  keywords: ['папка', 'директория'],
  routes: ['/chats'],
  markdown: '# Рабочая папка\nВыбрать папку.'
};
const bundle = decodeHelpBundle({
  format: 1,
  version: '0.1.0',
  commit: 'a'.repeat(40),

  revision: 'b'.repeat(64),
  locale: 'ru',
  articles: [overview, chats]
});

test('HELP-Q1: поиск ранжирует, пустой запрос не выгружает статьи, ссылки замкнуты', () => {
  const found = queryHelp(bundle, {
    action: 'search', query: 'РАБОЧАЯ папка'
  });

  assert.equal('items' in found && found.items[0]?.id, 'chats');
  assert.deepEqual(queryHelp(bundle, {
    action: 'search', query: ''
  }), {
    ok: true,
    version: '0.1.0',
    commit: 'a'.repeat(40),
    revision: 'b'.repeat(64),

    locale: 'ru',
    items: [],
  });
  assert.equal(helpHref(bundle, 'overview', './chats.md'), '#/help/chats');
  assert.equal(helpHref(bundle, 'overview', '../chat/private.md'), false);
  assert.equal(helpHref(bundle, 'overview', 'javascript:alert(1)'), false);
  assert.equal(helpHref(bundle, 'overview', '//example.com/help'), false);
  assert.equal(helpHref(bundle, 'overview', 'https://user:pass@example.com/help'), false);
  assert.equal(helpHref(bundle, 'overview', 'https://example.com/help'), 'https://example.com/help');
  assert.equal(helpArticleForContext(bundle, '/chats'), 'chats');
  assert.equal(helpArticleForContext(bundle, '/unknown'), 'overview');
});
test('HELP-Q2: Unicode read порциями восстанавливает текст без разрыва emoji', () => {
  const text = 'а'.repeat(11999) + '😀' + 'б'.repeat(12001);
  const corpus = {
    ...bundle, articles: [overview, {
      ...chats, markdown: text
    }]
  };
  const parts: string[] = [];
  let offset = 0;

  for (; ;) {
    const page = queryHelp(corpus, {
      action: 'read',
      id: 'chats',
      offset
    });

    assert.equal(page.ok, true);
    assert.ok('text' in page);
    parts.push(page.text);
    assert.equal(page.offset, offset);

    if (page.nextOffset === null) {
      break;
    }

    offset = page.nextOffset;
  }

  assert.equal(parts.join(''), text);
  assert.equal(parts[0]?.endsWith('😀'), true);
  assert.equal(queryHelp(corpus, {
    action: 'read', id: 'missing'
  }).ok, false);
});
test('HELP-Q3: неизвестные поля, невалидные смещения и неоднозначные документы отвергнуты', () => {
  for (const input of [{
    action: 'read', id: '../../secret'
  }, {
    action: 'read',
    id: 'chats',
    offset: -1
  },
  {
    action: 'read',
    id: 'chats',
    path: '/etc/passwd'
  }, {
    action: 'search', query: 'x'.repeat(257)
  },
  {
    action: 'write', id: 'chats'
  }]) {
    assert.throws(() => parseHelpInput(input));
  }

  assert.throws(() => decodeHelpBundle({
    ...bundle, articles: [overview, overview]
  }));
  assert.throws(() => decodeHelpBundle({
    ...bundle, format: 2
  }));
});

// Общая фикстура подписывает самостоятельные корпуса, не вызывая новый compiler.

test('HELP-Q-L1: EN format1, identity, поиск и Unicode paging используют выбранный корпус', () => {
  const english = decodeHelpBundle(localeCorpus('en'));

  assert.deepEqual(parseHelpInput({
    action: 'read',
    id: 'chats',
    locale: 'en',
  }), {
    action: 'read',
    id: 'chats',
    offset: 0,
    locale: 'en',
  });
  assert.deepEqual(parseHelpInput({ action: 'index' }), { action: 'index' });

  for (const input of [
    { action: 'index', locale: 'en' },
    {
      action: 'search',
      query: 'working directory',
      locale: 'en',
    },
    {
      action: 'read',
      id: 'chats',
      locale: 'en',
    },
  ]) {
    const result = queryHelp(english, input);

    assert.equal(result.ok, true);
    assert.equal('locale' in result && result.locale, 'en');
    assert.equal('revision' in result && result.revision, english.revision);
    assert.equal('commit' in result && result.commit, english.commit);
    assert.equal('version' in result && result.version, english.version);
  }

  const text = 'a'.repeat(11999) + '😀' + 'b'.repeat(12001);
  const long = { ...english, articles: [{ ...english.articles[0]!, markdown: text }] };
  const first = queryHelp(long, {
    action: 'read',
    id: 'overview',
    locale: 'en',
  });

  assert.ok('text' in first && 'nextOffset' in first);
  assert.equal(first.text.endsWith('😀'), true);

  const second = queryHelp(long, {
    action: 'read',
    id: 'overview',
    locale: 'en',
    offset: first.nextOffset,
  });

  assert.ok('text' in second);
  assert.ok('nextOffset' in second);

  const third = queryHelp(long, {
    action: 'read',
    id: 'overview',
    locale: 'en',
    offset: second.nextOffset,
  });

  assert.ok('text' in third);
  assert.equal(first.text + second.text + third.text, text);
  assert.deepEqual(queryHelp(english, { action: 'index', locale: 'ru' }), {
    ok: false, error: 'help_locale_unavailable',
  });

  for (const locale of ['de', '../en', ['en'], null]) {
    assert.throws(() => parseHelpInput({ action: 'index', locale }), /help_input_invalid/u);
  }
});
