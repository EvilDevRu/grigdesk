import assert from 'node:assert/strict';
import test from 'node:test';

import { MobileEventStream } from '../../server/src/lib/mobile/facade/events.ts';

test('MC-22…25: ready/heartbeat, trailing throttle, ресурсный сигнал и уборка slow consumer', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });

  let listener;
  let subscriptions = 0;
  const frames = [];
  let blocked = false;
  let closed = 0;
  const stream = new MobileEventStream({
    subscribe: (value) => {
      listener = value;
      subscriptions += 1;

      return () => {
        subscriptions -= 1;
      };
    },
    write: (value) => {
      frames.push(value);

      return !blocked;
    },
    end: () => {
      closed += 1;
    },
  });

  assert.equal(frames[0], 'event: ready\ndata: {"api":1}\n\n');

  for (let index = 0; index < 10; index += 1) {
    listener('chat-step', {
      chatKey: 'one',
      text: 'Не раскрывать содержимое',
    });
  }

  listener('chat-step', { chatKey: 'two' });
  t.mock.timers.tick(1000);
  assert.equal(frames.filter((value) => value.includes('"kind":"progress"')).length, 2);
  assert.ok(frames.every((value) => !value.includes('Не раскрывать')));
  listener('chat-store', {
    id: 'one',
    messages: ['Секрет'],
  });
  listener('chat-done', { chatKey: 'one' });
  listener('chat-permission-done', {});
  listener('state-change', {});
  listener('state-change', {});
  t.mock.timers.tick(2000);
  assert.equal(frames.filter((value) => value.startsWith('event: tasks')).length, 1);
  assert.ok(frames.some((value) => value === 'event: waiting\ndata: {}\n\n'));
  assert.ok(frames.some((value) => value.includes('"kind":"message"')));
  t.mock.timers.tick(12000);
  assert.ok(frames.some((value) => value === 'event: heartbeat\ndata: {}\n\n'));
  blocked = true;
  listener('chat-queued', { chatKey: 'one' });
  assert.equal(subscriptions, 0);
  assert.equal(closed, 1);
  stream.close();
  assert.equal(closed, 1);

  const before = frames.length;

  t.mock.timers.tick(60000);
  assert.equal(frames.length, before);
});
