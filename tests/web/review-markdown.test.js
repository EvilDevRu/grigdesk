import assert from 'node:assert/strict';
import test from 'node:test';

import {
  reviewMarkdownHtml,
  reviewTranslationRows,
} from '../../web/src/shared/review-chip.js';

test('UI-SEC-01: GitHub-комментарий не исполняет raw HTML и опасные ссылки', () => {
  const html = reviewMarkdownHtml([
    '<script>globalThis.pwned = true</script>',
    '',
    '<img src=x onerror="globalThis.pwned = true">',
    '',
    '[опасная ссылка](javascript:alert(1))',
    '![опасная картинка](data:text/html,boom)',
    '[нормальная ссылка](https://example.test/review)',
  ].join('\n'));

  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /<img[^>]+onerror/i);
  assert.doesNotMatch(html, /href="javascript:/i);
  assert.doesNotMatch(html, /src="data:/i);
  assert.match(html, /href="https:\/\/example\.test\/review"/);
  assert.match(html, /rel="noopener noreferrer"/);
});

test('UI-SEC-02: поля переводчика проходят через тот же безопасный renderer', () => {
  const remark = {
    translation: {
      request: '**Исправить** проверку',
      recommendation: 'Стоит сделать',
      why: '<img src=x onerror=alert(1)>',
      change: 'Форма покажет ошибку',
      risks: ['Может измениться текст', '[схема](javascript:alert(1))'],
      decisionNeeded: 'Подтвердить формулировку',
    },
  };
  const rows = reviewTranslationRows(remark);

  assert.deepEqual(rows.map((row) => row.label), [
    'Что просит ревьюер',
    'Стоит ли делать',
    'Почему',
    'Что изменится',
    'Риски',
    'Что решить',
  ]);
  for (const row of rows) {
    const html = reviewMarkdownHtml(row.value);
    assert.doesNotMatch(html, /<img[^>]+onerror/i);
    assert.doesNotMatch(html, /href="javascript:/i);
  }
});

test('переводчик понимает snake_case во время миграции контракта', () => {
  const rows = reviewTranslationRows({
    translation: {
      what_reviewer_wants: 'Упростить условие',
      should_do: 'Не стоит',
      why: 'Поведение требуется контрактом',
      expected_change: 'Ничего',
      risk: 'Регрессия',
      decision_needed: 'Ничего',
    },
  });

  assert.deepEqual(rows.map((row) => row.value), [
    'Упростить условие',
    'Не стоит',
    'Поведение требуется контрактом',
    'Ничего',
    'Регрессия',
    'Ничего',
  ]);
});

test('карточка читает строгий server contract sections', () => {
  const rows = reviewTranslationRows({
    translation: {
      decisionId: 'PRODUCT_DECISION',
      sections: {
        reviewerRequest: { text: 'Выбрать поведение' },
        recommendation: { text: 'Нужно решение' },
        reason: { text: 'Допустимы два варианта' },
        expectedChange: { text: 'Изменится обработка' },
        risks: { text: 'Риск совместимости' },
        decisionNeeded: { text: 'Выбери вариант' },
      },
    },
  });

  assert.deepEqual(rows.map((row) => row.value), [
    'Выбрать поведение',
    'Нужно решение',
    'Допустимы два варианта',
    'Изменится обработка',
    'Риск совместимости',
    'Выбери вариант',
  ]);
});
