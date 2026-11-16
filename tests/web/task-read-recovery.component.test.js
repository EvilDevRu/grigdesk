import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';

import { mountTrackerCard, STOCK_CAPS } from './helpers/trackerCard.js';

process.env.NODE_ENV = 'test';

/**
 * Microtask и продолжения Vue завершаются без движения управляемых часов recovery.
 * Настоящий immediate не зависит от подменённого setTimeout.
 */
async function settle(card) {
  await card.flushPromises();
  await setImmediate();
  await card.flushPromises();
}

test('CARD-READ: детали сохраняются, один повтор восстанавливает их без потери черновика', async (t) => {
  let broken = false;
  let title = 'Прежняя задача';
  const card = await mountTrackerCard(t, {
    read: ({ url, task }) => {
      if (url === '/api/tracker/task/42') {
        if (broken) {
          throw new TypeError('network lost');
        }

        return { ...task, title };
      }
    },
  });

  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() + 1000 });
  await card.wrapper.get('[data-task-section="comments"]').trigger('click');
  await card.wrapper.get('textarea.comment-text').setValue('Мой черновик');
  broken = true;
  await card.wrapper.get('button[aria-label="Обновить задачу"]').trigger('click');
  await settle(card);
  assert.match(card.wrapper.text(), /Прежняя задача/u);
  assert.match(card.wrapper.get('[data-role="task-read-status"]').text(), /последние полученные/u);

  const before = card.calls.filter((call) => call.url === '/api/tracker/task/42').length;

  t.mock.timers.tick(999);
  await settle(card);
  assert.equal(card.calls.filter((call) => call.url === '/api/tracker/task/42').length, before);
  broken = false;
  title = 'Восстановленная задача';
  t.mock.timers.tick(1);
  await settle(card);
  assert.equal(card.calls.filter((call) => call.url === '/api/tracker/task/42').length, before + 1);
  assert.match(card.wrapper.text(), /Восстановленная задача/u);
  assert.equal(card.wrapper.find('[data-role="task-read-status"]').exists(), false);
  assert.equal(card.wrapper.get('textarea.comment-text').element.value, 'Мой черновик');
  t.mock.timers.tick(120000);
  await settle(card);
  assert.equal(card.calls.filter((call) => call.url === '/api/tracker/task/42').length, before + 1);
});

test('CARD-METADATA: первый отказ каталога восстанавливает возможности без переоткрытия', async (t) => {
  let broken = true;
  const card = await mountTrackerCard(t, {
    beforeMount: () => t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() + 1000 }),
    read: ({ url }) => {
      if (broken && url === '/api/trackers') {
        throw new TypeError('metadata network lost');
      }
    },
  });

  // Первая ошибка уже произошла под управляемыми часами, реального retry-таймера нет.
  await card.wrapper.get('button[aria-label="Обновить задачу"]').trigger('click');
  await settle(card);

  const before = card.calls.filter((call) => call.url === '/api/trackers').length;

  broken = false;
  t.mock.timers.tick(1000);
  await settle(card);
  assert.ok(card.calls.filter((call) => call.url === '/api/trackers').length > before);
  assert.equal(card.wrapper.find('[data-role="task-edit-open"]').exists(), true);
  assert.equal(card.wrapper.find('[data-role="task-metadata-status"]').exists(), false);
});

for (const end of ['close', 'unmount', 'auth', 'epoch']) {
  test(`CARD-CLOSE: ${end} отменяет запланированный повтор`, async (t) => {
    let broken = false;
    const card = await mountTrackerCard(t, {
      read: ({ url }) => {
        if (broken && url === '/api/tracker/task/42') {
          throw new TypeError('network lost');
        }
      },
    });

    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() + 1000 });
    broken = true;
    await card.wrapper.get('button[aria-label="Обновить задачу"]').trigger('click');
    await settle(card);

    if (end === 'close') {
      card.ui.close();
    } else if (end === 'unmount') {
      card.wrapper.unmount();
    } else if (end === 'auth') {
      card.auth.authenticated = false;
    } else {
      card.listeners.forEach((listener) => listener('trackers-changed', { revision: 2 }));
    }

    await settle(card);

    const before = card.calls.filter((call) => call.url === '/api/tracker/task/42').length;

    t.mock.timers.tick(120000);
    await settle(card);
    assert.equal(card.calls.filter((call) => call.url === '/api/tracker/task/42').length, before);
  });
}

test('CARD-METADATA-BARRIER: retry metadata снимает revision barrier без раннего task GET', async (t) => {
  let phase = 'initial';
  const card = await mountTrackerCard(t, {
    presentation: 'document',
    read: ({ url, task, metadata }) => {
      if (url === '/api/trackers' && phase !== 'initial') {
        if (phase === 'failed') {
          throw new TypeError('metadata network lost');
        }

        return { ...metadata, revision: 2 };
      }
      if (url === '/api/tracker/task/42' && phase === 'restored') {
        return { ...task, title: 'Карточка после подтверждения' };
      }
    },
  });

  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() + 1000 });

  const before = card.calls.filter((call) => call.url === '/api/tracker/task/42').length;

  phase = 'failed';
  card.listeners.forEach((listener) => listener('trackers-changed', { revision: 2 }));
  await settle(card);
  assert.equal(card.calls.filter((call) => call.url === '/api/tracker/task/42').length, before);
  phase = 'restored';
  t.mock.timers.tick(1000);
  await settle(card);
  assert.ok(card.calls.filter((call) => call.url === '/api/tracker/task/42').length > before);
  assert.match(card.wrapper.text(), /Карточка после подтверждения/u);
  assert.equal(card.wrapper.find('[data-role="task-metadata-status"]').exists(), false);
});

test('CARD-METADATA-LASTGOOD: обсуждение и черновик видимы, recovery перечитывает page', async (t) => {
  let broken = false;
  let revision = 1;
  const card = await mountTrackerCard(t, {
    read: ({ url }) => {
      if (url === '/api/trackers' && broken) {
        throw new TypeError('metadata network lost');
      }
      if (url.endsWith('/comments')) {
        return { comments: [{ mid: revision, text: `Последнее обсуждение ${revision}` }] };
      }
    },
  });

  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() + 1000 });
  await card.wrapper.get('[data-task-section="comments"]').trigger('click');
  await card.wrapper.get('textarea.comment-text').setValue('Мой черновик');
  broken = true;
  await card.wrapper.get('button[aria-label="Обновить задачу"]').trigger('click');
  await settle(card);
  assert.equal(card.wrapper.get('#task-panel-comments').isVisible(), true);
  assert.match(card.wrapper.get('.comlist').text(), /Последнее обсуждение 1/u);
  assert.equal(card.wrapper.get('textarea.comment-text').element.value, 'Мой черновик');
  assert.equal(card.wrapper.get('[data-role="task-metadata-status"]').isVisible(), true);

  const before = card.calls.filter((call) => call.url?.endsWith('/comments')).length;

  broken = false;
  revision = 2;
  t.mock.timers.tick(1000);
  await settle(card);
  assert.ok(card.calls.filter((call) => call.url?.endsWith('/comments')).length > before);
  assert.match(card.wrapper.get('.comlist').text(), /Последнее обсуждение 2/u);
  assert.equal(card.wrapper.get('textarea.comment-text').element.value, 'Мой черновик');
});

test('CARD-BODY-TIMEOUT: AbortError deadline без отмены consumer восстанавливается', async (t) => {
  let timedOut = false;
  const card = await mountTrackerCard(t, {
    read: ({ url, task }) => {
      if (url === '/api/tracker/task/42') {
        if (timedOut) {
          throw new DOMException('body deadline', 'AbortError');
        }

        return { ...task, title: 'Живая карточка' };
      }
    },
  });

  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() + 1000 });
  timedOut = true;
  await card.wrapper.get('button[aria-label="Обновить задачу"]').trigger('click');
  await settle(card);

  const before = card.calls.filter((call) => call.url === '/api/tracker/task/42').length;

  timedOut = false;
  t.mock.timers.tick(1000);
  await settle(card);
  assert.equal(card.calls.filter((call) => call.url === '/api/tracker/task/42').length, before + 1);
  assert.equal(card.wrapper.find('[data-role="task-read-status"]').exists(), false);
});



for (const continuation of ['refresh', 'lifecycle']) {
  test(`CARD-PENDING-UNMOUNT: ${continuation} не запускает GET после cleanup`, async (t) => {
    const card = await mountTrackerCard(t, { metadataMode: 'held' });
    const trackers = card.pinia._s.get('trackers');
    const otherConsumer = trackers.load(true);

    try {
      if (continuation === 'refresh') {
        await card.wrapper.get('button[aria-label="Обновить задачу"]').trigger('click');
      } else {
        card.auth.authenticated = false;
        await settle(card);
        card.auth.authenticated = true;
        await settle(card);
      }

      await settle(card);
      card.wrapper.unmount();
      assert.equal(card.ui.taskId, '42');

      const before = card.calls.filter((call) => call.method === 'GET'
        && !call.url.startsWith('/api/trackers')).length;

      card.heldMetadata.resolve(card.metadata);
      await otherConsumer;
      await settle(card);
      assert.equal(trackers.catalog?.revision, 1);
      assert.equal(card.calls.filter((call) => call.method === 'GET'
        && !call.url.startsWith('/api/trackers')).length, before);
    } finally {
      card.heldMetadata.resolve(card.metadata);
      await otherConsumer;
      await settle(card);
    }
  });
}

test('CARD-PAGE: ошибка сохраняет обсуждение и расширения, успех заменяет их вместе', async (t) => {
  let broken = false;
  let revision = 1;
  const card = await mountTrackerCard(t, {
    capabilities: {
      create: true,
      timer: true,
      comments: true,
      attachments: false,
      widgets: false,
      editing: true,
      complete: true,
      delete: false,
      renew: true,
      users: true,
      projects: true,
      checklist: false,
      tags: true,
      review: false,
    },
    read: ({ url }) => {
      if (url.endsWith('/comments')) {
        if (broken) {
          throw new TypeError('page network lost');
        }

        return {
          comments: [{ mid: revision, text: `Обсуждение ${revision}` }],
          tags: [`Тег ${revision}`],
          subtasks: [{ id: revision + 100, title: `Подзадача ${revision}` }],
        };
      }
    },
  });

  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() + 1000 });
  await card.wrapper.get('[data-task-section="comments"]').trigger('click');
  broken = true;
  await card.wrapper.get('button[aria-label="Обновить задачу"]').trigger('click');
  await settle(card);
  assert.match(card.wrapper.get('.comlist').text(), /Обсуждение 1/u);
  assert.match(card.wrapper.get('[data-role="task-tags"]').text(), /Тег 1/u);
  assert.match(card.wrapper.get('[data-role="task-subtasks"]').text(), /Подзадача 1/u);
  assert.match(card.wrapper.get('[data-role="task-page-status"]').text(), /последние полученные/u);
  revision = 2;
  broken = false;
  t.mock.timers.tick(1000);
  await settle(card);
  assert.match(card.wrapper.get('.comlist').text(), /Обсуждение 2/u);
  assert.match(card.wrapper.get('[data-role="task-tags"]').text(), /Тег 2/u);
  assert.match(card.wrapper.get('[data-role="task-subtasks"]').text(), /Подзадача 2/u);
  assert.equal(card.wrapper.find('[data-role="task-page-status"]').exists(), false);
});

test('CARD-PAGE-FIRST: первый отказ не показывает «Комментариев нет»', async (t) => {
  const card = await mountTrackerCard(t, { pageMode: 'error' });

  await card.wrapper.get('[data-task-section="comments"]').trigger('click');
  await settle(card);
  assert.match(card.wrapper.get('[data-role="task-page-status"]').text(), /Не удалось/u);
  assert.doesNotMatch(card.wrapper.get('#task-panel-comments').text(), /Комментариев нет/u);
});

for (const stop of ['close', 'auth']) {
  test(`CARD-PAGE-CANCEL: ${stop} снимает повтор обсуждения`, async (t) => {
    let broken = false;
    const card = await mountTrackerCard(t, {
      read: ({ url }) => {
        if (broken && url.endsWith('/comments')) {
          throw new TypeError('page network lost');
        }
      },
    });

    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() + 1000 });
    broken = true;
    await card.wrapper.get('button[aria-label="Обновить задачу"]').trigger('click');
    await settle(card);

    if (stop === 'close') {
      card.ui.close();
    } else {
      card.auth.authenticated = false;
    }

    await settle(card);

    const before = card.calls.filter((call) => call.url?.endsWith('/comments')).length;

    t.mock.timers.tick(120000);
    await settle(card);
    assert.equal(card.calls.filter((call) => call.url?.endsWith('/comments')).length, before);
  });
}

test('CARD-PAGE-TAGS: tags без comments показывают stale/retry прямо на описании', async (t) => {
  let broken = false;
  let empty = false;
  const card = await mountTrackerCard(t, {
    capabilities: {
      ...STOCK_CAPS,
      comments: false,
      tags: true,
    },
    read: ({ url }) => {
      if (url.endsWith('/comments')) {
        if (broken) {
          throw new TypeError('page network lost');
        }

        return {
          comments: [],
          tags: empty ? [] : ['Последний тег'],
          subtasks: empty ? [] : [{ id: 43, title: 'Последняя подзадача' }],
        };
      }
    },
  });

  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() + 1000 });
  broken = true;
  await card.wrapper.get('button[aria-label="Обновить задачу"]').trigger('click');
  await settle(card);
  assert.equal(card.wrapper.find('[data-task-section="comments"]').exists(), false);
  assert.match(card.wrapper.get('[data-role="task-tags"]').text(), /Последний тег/u);
  assert.match(card.wrapper.get('[data-role="task-subtasks"]').text(), /Последняя подзадача/u);

  const status = card.wrapper.get('[data-role="task-page-status"]');

  assert.equal(status.isVisible(), true);
  assert.ok(status.get('time').attributes('datetime'));
  broken = false;
  empty = true;
  await status.get('button').trigger('click');
  await settle(card);
  assert.equal(card.wrapper.find('[data-role="task-page-status"]').exists(), false);
  assert.doesNotMatch(card.wrapper.text(), /Последний тег|Последняя подзадача/u);
});

for (const terminal of ['detail403', 'page403', 'metadata403', '401', 'revoked']) {
  test(`CARD-TERMINAL: ${terminal} очищает server content/cache и допускает безопасное восстановление`,
    async (t) => {
      let deny = false;
      const card = await mountTrackerCard(t, {
        capabilities: STOCK_CAPS,
        detail: { title: 'PRIVATE-TITLE', description: 'PRIVATE-DESCRIPTION' },
        pageData: {
          comments: [{ mid: 1, text: 'PRIVATE-COMMENT' }],
          tags: ['PRIVATE-TAG'],
          subtasks: [{ id: 43, title: 'PRIVATE-SUBTASK' }],
        },
        read: ({ url }) => {
          const selected = terminal === 'detail403' ? url === '/api/tracker/task/42'
            : terminal === 'page403' ? url.endsWith('/comments')
              : terminal === 'metadata403' && url === '/api/trackers';

          if (deny && selected) {
            throw Object.assign(new Error('forbidden'), { name: 'ApiError', status: 403 });
          }
        },
      });

      t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() + 1000 });
      await card.wrapper.get('[data-task-section="comments"]').trigger('click');
      await card.wrapper.get('textarea.comment-text').setValue('Мой собственный черновик');
      assert.match(card.wrapper.text(), /PRIVATE-TITLE/u);
      card.shell.present = true;
      card.shell.status = 'online';
      await settle(card);
      deny = true;

      if (terminal === '401' || terminal === 'revoked') {
        card.shell.status = 'offline';
        card.auth.authenticated = false;
        await settle(card);
        assert.match(card.wrapper.text(), /PRIVATE-TITLE/u);

        if (terminal === '401') {
          card.auth.logReason = '401';
        } else {
          card.shell.status = 'revoked';
        }
      } else {
        await card.wrapper.get('button[aria-label="Обновить задачу"]').trigger('click');
      }

      await settle(card);
      assert.doesNotMatch(card.wrapper.text(), /PRIVATE-/u);
      assert.equal(Object.keys(card.tasks.details).length, 0);

      const before = card.calls.filter((call) => call.method === 'GET').length;

      t.mock.timers.tick(120000);
      await settle(card);
      assert.equal(card.calls.filter((call) => call.method === 'GET').length, before);
      deny = false;
      card.shell.status = 'online';
      card.auth.logReason = 'shell-online';
      card.auth.authenticated = true;
      await settle(card);
      await card.wrapper.get('button[aria-label="Обновить задачу"]').trigger('click');
      await settle(card);
      assert.match(card.wrapper.text(), /PRIVATE-TITLE/u);
      assert.equal(card.wrapper.get('textarea.comment-text').element.value, 'Мой собственный черновик');
    });
}

for (const channel of ['detail', 'page', 'metadata']) {
  test(`CARD-STATUS-RETRY: ${channel} 403 восстанавливается кнопкой ошибки`, async (t) => {
    let phase = 'ready';
    const gate = Promise.withResolvers();
    const card = await mountTrackerCard(t, {
      capabilities: STOCK_CAPS,
      read: ({ url, task }) => {
        const selected = channel === 'detail' ? url === '/api/tracker/task/42'
          : channel === 'page' ? url.endsWith('/comments') : url === '/api/trackers';

        if (phase === 'denied' && selected) {
          throw Object.assign(new Error('forbidden'), { name: 'ApiError', status: 403 });
        }
        if (phase === 'restored' && url === '/api/trackers') {
          return gate.promise;
        }
        if (phase === 'restored' && url === '/api/tracker/task/42') {
          return { ...task, title: 'Доступ возвращён' };
        }
        if (phase === 'restored' && url.endsWith('/comments')) {
          return { comments: [{ mid: 10, text: 'Прочитано после возврата прав' }] };
        }
      },
    });

    await card.wrapper.get('[data-task-section="comments"]').trigger('click');
    await card.wrapper.get('textarea.comment-text').setValue('Мой черновик');
    phase = 'denied';
    await card.wrapper.get('button[aria-label="Обновить задачу"]').trigger('click');
    await settle(card);

    const role = channel === 'detail' ? 'task-read-status'
      : channel === 'page' ? 'task-page-status' : 'task-metadata-status';
    const before = card.calls.length;

    phase = 'restored';

    try {
      await card.wrapper.get(`[data-role="${role}"] button`).trigger('click');
      await settle(card);
      assert.equal(card.wrapper.get(`[data-role="${role}"] button`).element.disabled, true);
      gate.resolve(card.metadata);
      await settle(card);
      assert.equal(card.calls.slice(before).find((call) => call.method === 'GET')?.url, '/api/trackers');
      assert.match(card.wrapper.text(), /Доступ возвращён/u);
      assert.match(card.wrapper.get('.comlist').text(), /Прочитано после возврата прав/u);
      assert.equal(card.wrapper.get('textarea.comment-text').element.value, 'Мой черновик');
      assert.equal(card.calls.slice(before).filter((call) => call.method === 'POST').length, 0);
      assert.equal(card.wrapper.find(`[data-role="${role}"]`).exists(), false);
    } finally {
      gate.resolve(card.metadata);
      await settle(card);
    }
  });
}

test('UNKNOWN-POST: комментарий доставлен, ответ потерян, readback не дублирует запись', async (t) => {
  let delivered = false;
  const card = await mountTrackerCard(t, {
    read: ({ url }) => {
      if (url.endsWith('/comments') && delivered) {
        return { comments: [{ mid: 99, text: 'Доставленный комментарий' }] };
      }
    },
    mutation: ({ method, url }) => {
      if (method === 'POST' && url.endsWith('/comment')) {
        delivered = true;

        throw new TypeError('response lost');
      }

      return { ok: true };
    },
  });

  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() + 1000 });
  await card.wrapper.get('[data-task-section="comments"]').trigger('click');
  await card.wrapper.get('textarea.comment-text').setValue('Доставленный комментарий');

  const send = card.wrapper.get('#task-panel-comments .comment button');

  await send.trigger('click');
  await settle(card);
  assert.equal(delivered, true);
  assert.match(card.wrapper.get('.comlist').text(), /Доставленный комментарий/u);
  assert.match(card.wrapper.get('.malerts').text(), /неизвестен/u);
  assert.equal(card.wrapper.get('textarea.comment-text').element.value, 'Доставленный комментарий');
  t.mock.timers.tick(120000);
  await settle(card);
  assert.equal(
    card.calls.filter((call) => call.method === 'POST' && call.url.endsWith('/comment')).length,
    1,
  );
  assert.match(card.wrapper.get('.malerts').text(), /неизвестен/u);
});

test('CARD-METADATA-READONLY: last-good виден, но команда не уходит до подтверждения', async (t) => {
  let broken = false;
  const card = await mountTrackerCard(t, {
    read: ({ url }) => {
      if (broken && url === '/api/trackers') {
        throw new TypeError('metadata network lost');
      }
    },
  });

  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() + 1000 });
  await card.wrapper.get('[data-task-section="comments"]').trigger('click');
  await card.wrapper.get('textarea.comment-text').setValue('Нельзя отправлять вслепую');
  broken = true;
  await card.wrapper.get('button[aria-label="Обновить задачу"]').trigger('click');
  await settle(card);
  await card.wrapper.get('#task-panel-comments .comment button').trigger('click');
  await settle(card);
  assert.equal(
    card.calls.filter((call) => call.method === 'POST' && call.url.endsWith('/comment')).length,
    0,
  );
  assert.match(card.wrapper.text(), /Подключение не подтверждено/u);
  assert.equal(card.wrapper.get('textarea.comment-text').element.value, 'Нельзя отправлять вслепую');
});
