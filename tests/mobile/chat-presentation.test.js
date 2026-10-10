import assert from 'node:assert/strict';
import test from 'node:test';

import { compileModule, webFile } from './helpers/compile-vue.js';
import { installBrowser } from './helpers/ui.js';

process.env.NODE_ENV = 'test';

test('Markdown безопасен; раскрытие действий переживает SSE', async (t) => {
  const browser = installBrowser();
  const { mount } =
    await import('../../mobile/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs');
  const { UiMarkdown, ChatActivity, groupMessages, activityStatus } =
    await compileModule(webFile('../tests/mobile/helpers/testApp.ts'));
  const markdown = mount(UiMarkdown, {
    props: {
      text: '**Ответ**\n\n- Первый\n- Второй\n\n| Вид | Итог |\n| --- | --- |\n| Планшет | Готово |\n\n' +
        '<img src=x onerror=alert(1)>\n\n[Сайт](https://example.invalid) ' +
        '[Опасная ссылка](javascript:alert%281%29)\n\n`код`',
    },
  });

  t.after(async () => {
    markdown.unmount();
    await browser.happyDOM.abort();
  });
  assert.equal(markdown.find('strong').text(), 'Ответ');
  assert.equal(markdown.findAll('li').length, 2);
  assert.equal(markdown.findAll('td').length, 2);
  assert.equal(markdown.findAll('img,script,iframe').length, 0);
  assert.match(markdown.text(), /<img src=x/);
  assert.equal(markdown.findAll('a').length, 1);
  assert.equal(markdown.find('a').attributes('rel'), 'noopener noreferrer');
  assert.equal(markdown.find('code').text(), 'код');

  const activity = {
    items: [{
      id: 'tool-1',
      kind: 'tool',
      title: 'Read',
      text: 'README.md',
      result: '',
      state: 'running',
      at: 1,
    }],
    omitted: 0,
  };
  const feed = mount(ChatActivity, { props: { activity, live: true } });

  t.after(() => feed.unmount());
  assert.equal(feed.find('.activity-toggle').attributes('aria-expanded'), 'true');
  await feed.find('.activity-step').trigger('click');
  assert.match(feed.find('.activity-detail').text(), /Выполняется/);
  await feed.setProps({ activity: {
    ...activity,
    items: [{
      ...activity.items[0],
      result: 'Текст прочитан',
      state: 'done',
    }],
  } });
  assert.match(feed.find('.activity-detail').text(), /Текст прочитан/);
  assert.equal(feed.find('.activity-step').attributes('aria-expanded'), 'true');
  await feed.find('.activity-toggle').trigger('click');
  assert.equal(feed.find('.activity-items').exists(), false);

  assert.equal(activityStatus(activity), 'Читаю…');
  assert.equal(activityStatus({ ...activity, items: [{ ...activity.items[0], state: 'done' }] }),
    'Агент работает…');
  assert.equal(activityStatus(activity, true), 'Жду вашего ответа');

  const messages = [
    {
      id: 'request',
      role: 'user',
      turnId: 'first',
    },
    {
      id: 'reply',
      role: 'assistant',
      turnId: 'first',
    },
    {
      id: 'clarification',
      role: 'user',
      turnId: 'first',
    },
    {
      id: 'final',
      role: 'assistant',
      turnId: 'first',
    },
    {
      id: 'next-request',
      role: 'user',
      turnId: 'second',
    },
    {
      id: 'next-final',
      role: 'assistant',
      turnId: 'second',
    },
    {
      id: 'legacy-final',
      role: 'assistant',
      turnId: null,
    },
  ];
  const groups = groupMessages(messages);

  assert.deepEqual(groups.map((group) => group.messages.map((message) => message.id)), [
    ['request'], ['reply', 'clarification', 'final'], ['next-request'], ['next-final'], ['legacy-final'],
  ]);
  assert.equal(groups[0].turn, false);
  assert.equal(groups[1].turn, true);
  assert.deepEqual(groups.flatMap((group) => group.messages), messages);
});
