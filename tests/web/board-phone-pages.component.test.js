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

test('BOARD-PAGES: кнопки и свайп выбирают раздел, формы остаются смонтированы', async (t) => {
  const { wrapper, browser, flushPromises, calls } = await fixture(t);

  browser.happyDOM.setWindowSize({ width: 390, height: 844 });
  await flushPromises();
  assert.equal(wrapper.findAll('.board-page-nav [role="tab"]').length, 3);
  assert.equal(wrapper.find('.board-heading .ui-pane-header__meta .ui-icon-button').exists(), true);
  assert.equal(wrapper.find('.board-heading .ui-pane-header__actions .ui-icon-button').exists(), false);
  assert.equal(wrapper.findAll('.board-heading .ui-icon-button').length, 1);

  const track = wrapper.get('.board-pages');
  const primary = wrapper.get('.col.primary').element;
  const search = wrapper.get('.col.primary input[type="search"]');

  Object.defineProperty(track.element, 'clientWidth', {
    value: 390,
    configurable: true,
  });
  await search.setValue('Первая');
  primary.scrollTop = 180;
  assert.equal(wrapper.findAll('.col.primary .trow').length, 1);

  await wrapper.get('[data-board-page-tab="related"]').trigger('click');
  assert.equal(track.element.scrollLeft, 390);
  assert.equal(wrapper.get('[data-board-page-tab="related"]').attributes('aria-selected'), 'true');
  assert.equal(primary.hasAttribute('inert'), true);
  await wrapper.get('.col.secondary input[type="search"]').setValue('Связанная');

  await wrapper.get('[data-board-page-tab="own"]').trigger('click');
  assert.equal(track.element.scrollLeft, 780);
  track.element.scrollLeft = 0;
  await track.trigger('scroll');

  assert.equal(wrapper.get('[data-board-page-tab="mine"]').attributes('aria-selected'), 'true');
  assert.equal(wrapper.get('.col.primary').element === primary, true);
  assert.equal(primary.scrollTop, 180);
  assert.equal(search.element.value, 'Первая');
  assert.equal(wrapper.get('.col.secondary input[type="search"]').element.value, 'Связанная');
  assert.deepEqual(calls.opened, []);

  await wrapper.get('[data-board-page-tab="own"]').trigger('click');
  browser.happyDOM.setWindowSize({ width: 1280, height: 900 });
  await flushPromises();
  assert.equal(wrapper.find('.board-page-nav').exists(), false);
  assert.equal(wrapper.find('.board-heading .ui-pane-header__actions .ui-icon-button').exists(), true);
  assert.equal(wrapper.findAll('.board-heading .ui-icon-button').length, 1);
  assert.equal(primary.hasAttribute('inert'), false);
  assert.equal(wrapper.get('.col.primary').element === primary, true);

  browser.happyDOM.setWindowSize({ width: 390, height: 844 });
  await flushPromises();
  assert.equal(wrapper.get('[data-board-page-tab="own"]').attributes('aria-selected'), 'true');
  assert.equal(track.element.scrollLeft, 780);
});

test('BOARD-PAGES: холодная загрузка выбирает основной список после первого ответа', async (t) => {
  const { wrapper, browser, flushPromises, stores } = await fixture(t, { pending: true });

  browser.happyDOM.setWindowSize({ width: 390, height: 844 });
  await flushPromises();
  assert.equal(wrapper.find('.board-overview [data-ui-loading]').exists(), false);
  assert.equal(wrapper.findAll('.board-page-nav [role="tab"]').length, 3);
  assert.equal(wrapper.get('[data-board-page-tab="mine"]').attributes('aria-selected'), 'true');
  assert.equal(wrapper.get('.own-tasks').element.hasAttribute('inert'), true);
  assert.equal(wrapper.find('.board-pages .board-phone-loading').exists(), true);
  assert.equal(wrapper.find('.board-pages .summary').exists(), false);
  assert.equal(wrapper.find('.board-overview [data-role="board-snapshot-status"]').exists(), false);
  assert.equal(wrapper.get('.board-phone-footer [data-role="board-snapshot-status"]').text(), 'Загрузка');

  stores.board().data = {
    tasks: [{
      id: 31,
      title: 'Загруженная задача',
    }],
    toReview: [],
    created: [],
    widgets: [],
  };
  await flushPromises();
  assert.equal(wrapper.get('[data-board-page-tab="mine"]').attributes('aria-selected'), 'true');
  assert.equal(wrapper.get('.col.primary').element.hasAttribute('inert'), false);
  assert.equal(wrapper.findAll('.board-page-nav [role="tab"]').length, 3);
  assert.equal(wrapper.get('.col.secondary .empty').exists(), true);
  assert.equal(wrapper.get('#board-review-tab').attributes('aria-selected'), 'true');
  assert.equal(wrapper.get('#board-related-list').attributes('aria-labelledby'), 'board-review-tab');
  assert.equal(wrapper.find('.board-overview [data-role="board-snapshot-status"]').exists(), false);
  assert.equal(wrapper.find('.board-phone-footer time').exists(), true);
});

test('BOARD-PAGES: ответ трекера не уводит с внутренних задач, выбранных во время загрузки', async (t) => {
  const { wrapper, browser, flushPromises, stores } = await fixture(t, { pending: true });

  browser.happyDOM.setWindowSize({ width: 390, height: 844 });
  await flushPromises();

  const track = wrapper.get('.board-pages');
  const own = wrapper.get('.own-tasks').element;

  Object.defineProperty(track.element, 'clientWidth', {
    value: 390,
    configurable: true,
  });
  await wrapper.get('[data-board-page-tab="own"]').trigger('click');
  own.scrollTop = 120;
  stores.board().data = {
    tasks: [],
    toReview: [],
    created: [{
      id: 21,
      title: 'Связанная задача',
    }],
    widgets: [],
  };
  await flushPromises();
  assert.equal(wrapper.get('[data-board-page-tab="own"]').attributes('aria-selected'), 'true');
  assert.equal(wrapper.get('.own-tasks').element === own, true);
  assert.equal(own.scrollTop, 120);
  assert.equal(track.element.scrollLeft, 780);
  assert.equal(wrapper.find('.board-phone-loading').exists(), false);
});

test('BOARD-PAGES: пустой контроль сохраняет вкладку, отключение трекера выбирает доступный', async (t) => {
  const { wrapper, browser, flushPromises, stores } = await fixture(t);

  browser.happyDOM.setWindowSize({ width: 390, height: 844 });
  await flushPromises();
  assert.equal(wrapper.find('.board-page-nav').exists(), true);

  const track = wrapper.get('.board-pages');

  Object.defineProperty(track.element, 'clientWidth', {
    value: 390,
    configurable: true,
  });
  await wrapper.get('[data-board-page-tab="related"]').trigger('click');
  stores.board().data.created.push({
    id: 22,
    title: 'Ещё поручение',
    timerElapsed: 0,
  });
  await flushPromises();
  assert.equal(wrapper.get('[data-board-page-tab="related"]').attributes('aria-selected'), 'true');

  stores.board().data.created = [];
  await flushPromises();
  assert.equal(wrapper.findAll('.board-page-nav [role="tab"]').length, 3);
  assert.equal(wrapper.get('[data-board-page-tab="related"]').attributes('aria-selected'), 'true');
  assert.equal(track.element.scrollLeft, 390);

  const ownStore = wrapper.vm.$pinia._s.get('grigdesk-tasks');

  assert.ok(ownStore);
  ownStore.trackerConfigured = false;
  await flushPromises();
  assert.equal(wrapper.find('.board-page-nav').exists(), false);
  assert.equal(wrapper.get('.own-tasks').element.hasAttribute('inert'), false);
  assert.equal(track.element.scrollLeft, 0);
});

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
  assert.equal(css('.own-tasks').overflowY, 'auto');
  assert.equal(css('.board-heading').marginTop, '0px');
  assert.equal(css('.board-heading .ui-pane-header__layout').paddingRight, '12px');
  assert.notEqual(css('.board-heading .ui-icon-button').marginLeft, 'calc(10px + 12px)');
  assert.equal(wrapper.find('[data-role="board-new-task"]').exists(), true);
  assert.equal(css('[data-role="board-new-task"]').height, '32px');
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
});
