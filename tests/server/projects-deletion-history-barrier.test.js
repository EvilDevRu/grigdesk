import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { ChatHistoryStore } from '../../server/src/lib/chat/historyStore.ts';
import {
  pdFixture, pdHistoryApp, pdSeedHistory, pdAssertHistory, pdChat, pdDeferred,
  pdHistoryBytes, PD_CHOICE, PD_PNG,
} from './helpers/projects-deletion.js';

test('PD-H0: архив сохраняет содержимое разговора', async (t) => {
  const f = await pdFixture(t, { source: 'prefs' });
  const h = await pdHistoryApp(t, f);
  const ref = await pdSeedHistory(h, f);
  const external = path.join(f.root, 'external');

  await fs.mkdir(external);
  await fs.writeFile(path.join(external, 'secret.md'), 'Внешний файл');
  await fs.writeFile(path.join(external, 'image.png'), PD_PNG);
  await fs.symlink(path.join(external, 'secret.md'), path.join(f.main, 'escape.md'));
  await fs.symlink(path.join(external, 'image.png'), path.join(f.main, 'escape.png'));

  const history = new ChatHistoryStore({ chatsDir: h.config.chatsDir });

  await history.read();

  const before = await pdHistoryBytes(h);

  await f.service.archive('demo', 1);
  assert.deepEqual(await pdHistoryBytes(h), before);
  await pdAssertHistory(h, f, ref);
  await assert.rejects(
    () => h.reader.resolveAbsolute(path.join(external, 'secret.md'), 'chat:legacy'),
    { code: 'document_outside_roots' },
  );
  await assert.rejects(h.reader.read({ source: 'chat:legacy:0', path: 'escape.md' }));

  const escaped = await h.app.inject('/api/chat/legacy/image?path=escape.png');

  assert.equal(escaped.statusCode === 403 || escaped.statusCode === 404, true);


  const turn = await h.app.inject({

    method: 'POST',
    url: '/api/chat',

    payload: {
      chatKey: 'legacy',
      modelRef: {
        provider: 'test-provider',
        model: 'test-model'
      },
      message: 'Дальше'
    },

  });

  assert.equal(turn.statusCode, 200, turn.body);
  assert.deepEqual(h.runs, [{ cwd: f.main, extraDirs: [f.extra, h.config.artifactsDir] }]);
});

test('PD-H0-legacy-interleaving: архив между записями legacy сохраняет оба разговора', async (t) => {
  const f = await pdFixture(t, { source: 'prefs' });
  const h = await pdHistoryApp(t, f);
  const chatsDir = h.config.chatsDir;
  const legacyPath = h.config.chatStoreLegacyPath;
  const legacy = { sessions: [pdChat('first'), pdChat('second')], activeId: 'first' };

  await fs.writeFile(legacyPath, JSON.stringify(legacy));
  await fs.writeFile(path.join(f.main, 'image.png'), PD_PNG);
  await fs.writeFile(path.join(f.main, 'document.md'), '# Старый документ\n');

  const history = new ChatHistoryStore({ chatsDir, legacyPath });
  const entered = pdDeferred();
  const release = pdDeferred();
  const saveOne = history.saveOne.bind(history);
  let commits = 0;

  history.saveOne = async (...args) => {
    const result = await saveOne(...args);

    commits += 1;

    if (commits === 1) {
      entered.resolve();
      await release.promise;
    }

    return result;
  };

  const reading = history.read();

  try {
    await entered.promise;
    await f.service.archive('demo', 1);
  } finally {
    release.resolve();
  }

  await reading;

  const reopened = await new ChatHistoryStore({ chatsDir, legacyPath }).read();

  assert.deepEqual(reopened.sessions.map((chat) => chat.id).sort(), ['first', 'second']);
  assert.deepEqual(reopened.sessions.map((chat) => chat.messages[0].text).sort(),
    ['first сообщение 0', 'second сообщение 0']);
  assert.equal(reopened.sessions.every((chat) => chat.workdir.projectId === PD_CHOICE.projectId), true);
  assert.equal(await fs.stat(legacyPath).then(() => true, () => false), false);

  for (const id of ['first', 'second']) {
    const image = await h.app.inject(`/api/chat/${id}/image?path=image.png`);
    const resolved = await h.reader.resolveAbsolute(path.join(f.main, 'document.md'), `chat:${id}`);

    assert.equal(image.statusCode, 200, image.body);
    assert.equal(image.rawPayload.equals(PD_PNG), true);
    assert.equal((await h.reader.read(resolved.ref)).content, '# Старый документ\n');
  }

});
