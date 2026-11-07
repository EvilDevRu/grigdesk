process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { mountBoardView } from './helpers/board-view.js';
import { webFile } from './helpers/compile-vue.js';

test('PHONE-DENSITY: отдельная страница доски сохраняет общий ряд поиска/фильтров', async (t) => {
  const { wrapper, browser } = await mountBoardView(t, {
    prefix: 'phone-density',
    tasks: [{
      id: 11,
      title: 'Длинная задача с сохранёнными сведениями',
      group: 'Проект',
      timerElapsed: 90,
    }],
  });
  const source = await readFile(webFile('src/views/BoardView.vue'), 'utf8');
  const tokens = await readFile(webFile('src/styles/tokens.css'), 'utf8');
  const cssText = tokens + '\n' + source.match(/<style scoped>([\s\S]*?)<\/style>/u)[1];
  const style = browser.document.createElement('style');

  browser.happyDOM.setWindowSize({ width: 390, height: 844 });
  style.textContent = cssText;
  browser.document.head.append(style);
  t.after(() => style.remove());

  const css = (selector) => browser.getComputedStyle(wrapper.get(selector).element);

  assert.equal(css('.col.primary').paddingTop, '0px');
  assert.equal(css('.col.primary').borderTopWidth, '0px');
  assert.equal(css('.colhead .search').gridColumn, '1');
  assert.equal(css('.colhead .filter-toggle').gridRow, '1');
  assert.equal(css('.tasks .trow').paddingTop, '8px');
  assert.equal(css('.tasks .trow').paddingLeft, '12px');
  assert.equal(css('.task-triage').gridRow, '2');
  assert.match(wrapper.get('.trow').text(), /Длинная задача/u);
  assert.match(wrapper.get('.task-meta').text(), /Проект/u);

  browser.happyDOM.setWindowSize({ width: 1280, height: 900 });
  style.textContent = cssText;
  assert.equal(css('.col.primary').paddingTop, '18px');
  assert.equal(css('.col.primary').borderTopWidth, '1px');
});
