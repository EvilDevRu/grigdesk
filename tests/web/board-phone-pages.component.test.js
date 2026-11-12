process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { mountBoardView } from './helpers/board-view.js';
import { webFile } from './helpers/compile-vue.js';
import { LOCAL_TASK } from './helpers/grigdesk-task-card.js';

/**
 * Все три раздела получают реальные формы и управляемые снимки только для чтения.
 * Нажатия и свайп не должны отправлять операции или открывать карточки автоматически.
 */
async function fixture(t, options = {}) {
  return mountBoardView(t, {
    prefix: 'board-phone-pages',
    tasks: [
      {
        id: 11,
        title: 'Первая задача',
        timerElapsed: 0,
      },
      {
        id: 12,
        title: 'Вторая задача',
        timerElapsed: 0,
      },
    ],
    created: [{
      id: 21,
      title: 'Связанная задача',
      timerElapsed: 0,
    }],
    ownApi: {
      async get(url) {
        if (url === '/api/grigdesk-tasks') {
          return {
            tasks: [LOCAL_TASK],
            revision: 1,
            trackerConfigured: true,
          };
        }

        return {
          projects: [],
          tasks: [],
        };
      },
    },
    ...options,
  });
}

test('BOARD-PAGES: общий список и внешние роли сохраняют swipe, aria и формы', async (t) => {
  const { wrapper, browser, flushPromises } = await fixture(t);

  browser.happyDOM.setWindowSize({ width: 390, height: 844 });
  await flushPromises();

  const track = wrapper.get('.board-pages');
  const primary = wrapper.get('.col.primary').element;

  Object.defineProperty(track.element, 'clientWidth', { value: 390, configurable: true });
  assert.equal(wrapper.findAll('.board-page-nav [role="tab"]').length, 2);
  assert.equal(wrapper.find('[data-board-page-tab="own"]').exists(), false);
  assert.equal(wrapper.findAll('.col.primary .trow')
    .filter((row) => /Первая задача|Вторая задача/u.test(row.text())).length, 2);
  await wrapper.get('.col.primary input[type="search"]').setValue('Первая');
  await wrapper.get('[data-board-page-tab="related"]').trigger('click');
  assert.equal(primary.hasAttribute('inert'), true);
  assert.equal(track.element.scrollLeft, 390);
  track.element.scrollLeft = 0;
  await track.trigger('scroll');
  assert.equal(primary.hasAttribute('inert'), false);
  assert.equal(wrapper.get('.col.primary input[type="search"]').element.value, 'Первая');
  assert.equal(wrapper.findAll('.col.primary .trow').length, 1);
});

for (const width of [390, 1280]) {
  test(`OWN-REMOVED-BOARD: ширина ${width}, внешние роли и настройки без own`, async (t) => {
    const { wrapper, browser, flushPromises } = await fixture(t);

    browser.happyDOM.setWindowSize({ width, height: 900 });
    await flushPromises();
    assert.doesNotMatch(wrapper.text(), /Своя задача|Проект Бета/u);
    assert.equal(wrapper.find('.task-internal-flag').exists(), false);
    assert.equal(wrapper.find('[data-board-page-tab="own"]').exists(), false);
    assert.equal(wrapper.find('[data-option-value="grigdesk"]').exists(), false);
    assert.equal(wrapper.findAll('.col.primary .trow').length, 2);
    assert.equal(wrapper.find('[data-board-page-tab="related"]').exists(), width <= 600);
    assert.equal(wrapper.find('.col.secondary').exists(), true);
    await wrapper.get('#board-created-tab').trigger('click');
    assert.match(wrapper.get('.col.secondary').text(), /Связанная задача/u);
    assert.equal(wrapper.find('[aria-label="Настройки трекеров"]').exists(), true);
  });
}

test('BOARD-PAGES: CSS оставляет вертикальную прокрутку внутри страницы и desktop-раскладку', async (t) => {
  const { wrapper, browser, flushPromises } = await fixture(t);
  const source = await readFile(webFile('src/views/BoardView.vue'), 'utf8');
  const layers = ['tokens', 'base', 'components/foundation', 'components/actions', 'components/patterns'];
  const cssText = (await Promise.all(layers.map((name) =>
    readFile(webFile(`src/styles/${name}.css`), 'utf8')))).join('\n')
    + '\n' + source.match(/<style scoped>([\s\S]*?)<\/style>/u)[1];
  const style = browser.document.createElement('style');

  browser.happyDOM.setWindowSize({ width: 390, height: 844 });
  browser.document.documentElement.setAttribute('data-ui-touch', '');
  await flushPromises();
  assert.equal(wrapper.find('.board-pages').exists(), true);
  style.textContent = cssText;
  browser.document.head.append(style);
  t.after(() => style.remove());

  const css = (selector) => browser.getComputedStyle(wrapper.get(selector).element);

  assert.equal(css('.board-pages').display, 'grid');
  assert.equal(css('.board').paddingLeft, '10px');
  assert.equal(css('.board').paddingTop, '0px');
  assert.equal(css('.board').backgroundColor, '#151b24');
  assert.equal(css('.board-pages').scrollSnapType, 'x mandatory');
  assert.equal(css('.col.primary').overflowY, 'auto');
  assert.equal(css('.col.secondary').overflowY, 'auto');
  assert.equal(wrapper.find('.own-tasks').exists(), false);
  assert.equal(css('.board-heading').marginTop, '0px');
  assert.equal(css('.board-heading .ui-pane-header__layout').paddingRight, '12px');
  assert.notEqual(css('.board-heading .ui-icon-button').marginLeft, 'calc(10px + 12px)');
  assert.equal(wrapper.find('[data-role="board-new-task"]').exists(), true);
  assert.equal(css('[data-role="board-new-task"]').height, 'auto');
  assert.equal(css('[data-role="board-new-task"]').minHeight, '32px');
  assert.equal(css('[data-board-page-tab="mine"]').minHeight, '32px');
  assert.equal(css('.board-page-nav').overflowX, 'visible');
  assert.equal(css('[data-board-page-tab="mine"]').fontSize, '12px');
  assert.equal(css('.board-page-count').height, '18px');
  assert.equal(css('[data-board-page-tab="mine"] .board-page-count').backgroundColor,
    css('[data-board-page-tab="related"] .board-page-count').backgroundColor);
  assert.equal(wrapper.find('.filter-toggle-label').exists(), true);
  assert.equal(css('.filter-toggle').width, '44px');
  assert.equal(css('.filter-toggle-label').display, 'none');
  assert.equal(wrapper.get('.filter-toggle').attributes('aria-label'), 'Фильтры задач');
  assert.equal(css('.trisegment').gridTemplateColumns, 'repeat(3, minmax(0, 1fr))');
  assert.equal(css('.trisegment button:last-child').gridColumn, 'auto');
  assert.equal(css('.trisegment button').whiteSpace, 'normal');
  await wrapper.get('.filter-toggle').trigger('click');
  await wrapper.get('[data-option-value="unrated"]').trigger('click');
  assert.equal(wrapper.get('.filter-toggle').attributes('aria-label'), 'Фильтры задач, активно: 1');
  assert.equal(css('.filter-count').display, 'none');
  assert.notEqual(css('[data-option-value="all"]').backgroundColor,
    css('[data-option-value="unrated"]').backgroundColor);

  browser.happyDOM.setWindowSize({ width: 1280, height: 900 });
  await flushPromises();
  style.textContent = cssText;
  assert.equal(css('.board-pages').display, 'flex');
  assert.equal(css('.cols').display, 'flex');
  assert.notEqual(css('.board-pages').scrollSnapType, 'x mandatory');
  assert.notEqual(css('.filter-toggle-label').display, 'none');

  await wrapper.get('.filter-toggle').trigger('click');
  assert.equal(wrapper.get('.filter-toggle').attributes('aria-expanded'), 'false');
  assert.equal(css('.filterbar').display, 'none');
  assert.equal(css('.show-filter').display, 'flex');
  assert.equal(Boolean(wrapper.get('.favfilter').element.closest('#board-task-filters')), false);
  assert.equal(Boolean(wrapper.get('.newfilter').element.closest('#board-task-filters')), false);
  assert.equal(wrapper.find('.board-heading [data-role="board-snapshot-status"]').exists(), true);
});
