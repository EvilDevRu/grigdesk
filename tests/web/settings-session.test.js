import assert from 'node:assert/strict';
import test from 'node:test';

import { createSettingsSession } from '../../web/src/features/settings/session.ts';
import { settingsResource, settingsSession } from './helpers/settings-session.js';

test('DR01: ввод не пишет, baseline неизменен, возврат к исходному снимает dirty', async () => {
  const resource = settingsResource('prefs', { enabled: false });
  const session = await settingsSession(resource);

  session.setField('prefs', 'enabled', true);

  assert.equal(session.getSnapshot().dirtyCount, 1);
  assert.equal(session.getValue('prefs', 'enabled'), true);
  assert.deepEqual(session.getBaseline('prefs'), { enabled: false });
  assert.equal(resource.calls.writes.length, 0);

  session.setField('prefs', 'enabled', false);

  assert.equal(session.getSnapshot().dirtyCount, 0);
  assert.equal(session.getIntent('prefs', 'enabled'), undefined);

  const unloaded = createSettingsSession();

  unloaded.begin();
  unloaded.register(resource.adapter, resource.fields);

  assert.throws(() => unloaded.setField('prefs', 'enabled', true), /сначала.*загруз/i);
});

test('DR02: две страницы используют один ресурс и сохраняют непрозрачные ключи', async () => {
  const resource = settingsResource('prefs', { 'x.y': false, 'z/w': 0 }, {
    fields: [
      {
        key: 'x.y',
        address: { pageId: 'automation.chats', fieldPath: ['x.y'] },
      },
      {
        key: 'z/w',
        address: { pageId: 'automation.context', fieldPath: ['z/w'] },
      },
    ],
  });
  const session = await settingsSession(resource);

  session.setField('prefs', 'x.y', true);
  session.setField('prefs', 'z/w', 4);
  await session.load('prefs');

  assert.equal(session.getSnapshot().dirtyCount, 2);
  assert.equal(session.getSnapshot().resources.length, 1);
  assert.deepEqual(session.getIntent('prefs', 'x.y'), { op: 'set', value: true });
  assert.equal(resource.calls.reads.length, 1);
});

test('DR03: переход страницы сохраняет ввод, новое открытие очищает сессию', async () => {
  const resource = settingsResource('prefs', { count: 0 });
  const session = await settingsSession(resource);
  const previousId = session.getSnapshot().sessionId;

  session.setField('prefs', 'count', 9);
  await session.load('prefs');

  assert.equal(session.getValue('prefs', 'count'), 9);

  session.dispose('close');
  session.begin();
  session.register(resource.adapter, resource.fields);
  await session.load('prefs');

  assert.equal(session.getSnapshot().sessionId > previousId, true);
  assert.equal(session.getValue('prefs', 'count'), 0);
  assert.equal(session.getSnapshot().dirtyCount, 0);
});

test('DR04: null, false, 0, пустая строка, set и unset различаются', async () => {
  const resource = settingsResource('native', { key: 'исходное' }, { supportsUnset: true });
  const session = await settingsSession(resource);

  for (const value of [null, false, 0, '']) {
    session.setField('native', 'key', value);

    assert.deepEqual(session.getIntent('native', 'key'), { op: 'set', value });
    assert.equal(session.getSnapshot().dirtyCount, 1);
  }

  session.unsetField('native', 'key');

  assert.deepEqual(session.getIntent('native', 'key'), { op: 'unset' });

  const ordinary = await settingsSession(settingsResource('prefs', { key: 'исходное' }));

  assert.throws(() => ordinary.unsetField('prefs', 'key'), /сброс.*не поддерж/i);
});

test('DR05: invalid со скрытой страницы сохраняется и возвращает адрес первого поля', async () => {
  const address = {
    pageId: 'automation.context',
    fieldPath: ['count'],
  };
  const resource = settingsResource('prefs', { count: 1, enabled: false }, {
    fields: [
      { key: 'count', address },
      {
        key: 'enabled',
        address: { pageId: 'automation.chats', fieldPath: ['enabled'] },
      },
    ],
    validate: (intents) => typeof intents.get('count')?.value === 'string'
      ? [{ key: 'count', message: 'Введите число' }]
      : [],
  });
  const session = await settingsSession(resource);

  session.setField('prefs', 'count', 'не число');
  session.setField('prefs', 'enabled', true);

  assert.deepEqual(session.validate(), [{
    resourceId: 'prefs',
    key: 'count',
    address,
    message: 'Введите число',
  }]);
  assert.equal(session.getValue('prefs', 'count'), 'не число');
  assert.equal(resource.calls.writes.length, 0);
});

test('DR06: снимок обновляет untouched, сохраняет dirty и ошибку, отмечает конфликт', async () => {
  const resource = settingsResource('prefs', { dirty: 1, untouched: 1 }, {
    validate: () => [{ key: 'dirty', message: 'Нужна правка' }],
  });
  const session = await settingsSession(resource);

  session.setField('prefs', 'dirty', 'ошибка');
  session.validate();
  session.acceptSnapshot('prefs', { dirty: 2, untouched: 3 });

  const fields = session.getSnapshot().resources[0]?.fields ?? [];
  const dirty = fields.find((field) => field.key === 'dirty');

  assert.equal(session.getValue('prefs', 'untouched'), 3);
  assert.equal(session.getValue('prefs', 'dirty'), 'ошибка');
  assert.equal(dirty?.error, 'Нужна правка');
  assert.deepEqual(dirty?.conflict, { present: true, serverValue: 2 });
  assert.deepEqual(session.getBaseline('prefs'), { dirty: 1, untouched: 3 });
});

test('DR07: взять актуальное или оставить моё обновляют baseline и намерение', async () => {
  for (const choice of ['take-current', 'keep-mine']) {
    const session = await settingsSession(settingsResource('prefs', { count: 1 }));

    session.setField('prefs', 'count', 9);
    session.acceptSnapshot('prefs', { count: 2 });
    session.resolveConflict('prefs', 'count', choice);

    assert.deepEqual(session.getBaseline('prefs'), { count: 2 });
    assert.equal(session.getValue('prefs', 'count'), choice === 'take-current' ? 2 : 9);
    assert.equal(session.getSnapshot().dirtyCount, choice === 'take-current' ? 0 : 1);
    assert.equal(session.getSnapshot().resources[0]?.fields[0]?.conflict, undefined);
  }
});

test('DR08: позднее чтение и снимок предыдущего sessionId игнорируются', async () => {
  const deferred = Promise.withResolvers();
  const old = settingsResource('prefs', { count: 1 }, { read: () => deferred.promise });
  const session = createSettingsSession();
  const previousId = session.begin();

  session.register(old.adapter, old.fields);

  const pending = session.load('prefs');
  const fresh = settingsResource('prefs', { count: 2 });

  session.begin();
  session.register(fresh.adapter, fresh.fields);
  await session.load('prefs');
  deferred.resolve({ count: 99 });
  await pending;

  assert.equal(old.calls.reads[0]?.aborted, true);
  assert.equal(session.acceptSnapshot('prefs', { count: 88 }, previousId), false);
  assert.equal(session.getValue('prefs', 'count'), 2);
});

test('DR09: discard очищает ошибки, секрет и удаление без записи; state не содержит секрет', async () => {
  const resource = settingsResource('credentials', { mode: 'api' }, {
    fields: [
      {
        key: 'mode',
        address: { pageId: 'agents.providers', fieldPath: ['mode'] },
      },
      {
        key: 'token',
        secret: true,
        address: { pageId: 'agents.providers', fieldPath: ['token'] },
      },
    ],
    validate: () => [{ key: 'token', message: 'Проверьте ключ' }],
  });
  const session = await settingsSession(resource);

  session.setField('credentials', 'token', 'synthetic-private-marker');
  session.validate();

  assert.equal(session.getSnapshot().dirtyCount, 1);
  assert.equal(session.getSnapshot().resources[0]?.fields[1]?.hasSecretDraft, true);
  assert.equal(JSON.stringify(session.getSnapshot()).includes('synthetic-private-marker'), false);
  assert.equal(JSON.stringify(session).includes('synthetic-private-marker'), false);

  session.discard();

  assert.equal(session.getIntent('credentials', 'token'), undefined);
  assert.equal(session.getSnapshot().dirtyCount, 0);
  assert.deepEqual(session.validate(), []);

  session.setField('credentials', 'token', null, true);
  session.discard();

  assert.equal(session.getIntent('credentials', 'token'), undefined);
  assert.equal(resource.calls.writes.length, 0);
});

test('DR10: baseline, адреса и намерения владеют копиями вложенных значений', async () => {
  const resource = settingsResource('prefs', { nested: { enabled: false, items: [1] } });
  const session = await settingsSession(resource);
  const snapshot = { nested: { enabled: true, items: [2] } };

  session.acceptSnapshot('prefs', snapshot);
  snapshot.nested.items.push(3);

  assert.deepEqual(session.getBaseline('prefs'), { nested: { enabled: true, items: [2] } });

  const edited = { items: [4], enabled: true };

  session.setField('prefs', 'nested', edited);
  edited.items.push(5);

  const exported = session.getValue('prefs', 'nested');

  exported.items.push(6);

  assert.deepEqual(session.getValue('prefs', 'nested'), { items: [4], enabled: true });

  session.setField('prefs', 'nested', { items: [2], enabled: true });

  assert.equal(session.getSnapshot().dirtyCount, 0);
});

test('DR04: возврат к уже исходному unset снимает намерение override', async () => {
  const resource = settingsResource('native', {}, {
    supportsUnset: true,
    fields: [{ key: 'optional', address: { pageId: 'agents.providers', fieldPath: ['optional'] } }],
  });
  const session = await settingsSession(resource);

  session.setField('native', 'optional', null);
  session.unsetField('native', 'optional');

  assert.equal(session.getSnapshot().dirtyCount, 0);
  assert.equal(session.getIntent('native', 'optional'), undefined);
});

test('DR06: отмена спорного ввода принимает последнее внешнее значение', async () => {
  const session = await settingsSession(settingsResource('prefs', { count: 1 }));

  session.setField('prefs', 'count', 9);
  session.acceptSnapshot('prefs', { count: 2 });
  session.setField('prefs', 'count', 1);

  assert.equal(session.getSnapshot().dirtyCount, 0);
  assert.equal(session.getValue('prefs', 'count'), 2);
  assert.equal(session.getSnapshot().resources[0]?.fields[0]?.conflict, undefined);
});

test('DR06: удаление поля схемы сохраняет адрес и ввод до явного отказа от него', async () => {
  const resource = settingsResource('native', { count: 1 });
  const session = await settingsSession(resource);

  session.setField('native', 'count', 9);
  session.register(resource.adapter, []);

  assert.equal(session.getValue('native', 'count'), 9);
  assert.equal(session.getSnapshot().resources[0]?.fields[0]?.unavailable, 'Поле больше недоступно');
  assert.equal(session.validate()[0]?.address.fieldPath[0], 'count');

  session.discardField('native', 'count');

  assert.equal(session.getSnapshot().dirtyCount, 0);
  assert.equal(session.getSnapshot().resources[0]?.fields.length, 0);
});

test('DR02: непрозрачный ключ не становится свойством прототипа baseline', async () => {
  const values = Object.fromEntries([['__proto__', { enabled: false }]]);
  const resource = settingsResource('native', values);
  const session = await settingsSession(resource);

  assert.equal(Object.hasOwn(session.getBaseline('native'), '__proto__'), true);
  assert.deepEqual(session.getValue('native', '__proto__'), { enabled: false });

  session.setField('native', '__proto__', { enabled: true });
  session.acceptSnapshot('native', Object.fromEntries([['__proto__', { enabled: true }]]));
  session.resolveConflict('native', '__proto__', 'take-current');

  assert.equal(session.getSnapshot().dirtyCount, 0);
  assert.equal(Object.hasOwn(session.getBaseline('native'), '__proto__'), true);
});

test('DR07: оставленный unset уже совпадает с внешним сбросом и больше не dirty', async () => {
  const session = await settingsSession(settingsResource('native', { value: 1 }, { supportsUnset: true }));

  session.unsetField('native', 'value');
  session.acceptSnapshot('native', {});
  session.resolveConflict('native', 'value', 'keep-mine');

  assert.equal(session.getSnapshot().dirtyCount, 0);
  assert.equal(session.getIntent('native', 'value'), undefined);
});
