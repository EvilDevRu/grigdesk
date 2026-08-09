// Совместимость prefs раздела «Настройки → Доступ».
//
// accessLocalHttps — намерение поднять локальный TLS после рестарта; accessGateway — прежний
// маркер визарда, а НЕ выключатель туннелей. Оба ключа обязаны пережить частичную запись:
// PrefsStore.write отбрасывает всё, чего нет в DEFAULTS, и опечатка просто исчезнет.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { PrefsStore } from '../../server/src/lib/prefs-store.js';

test('ACCESS-01: prefs локального TLS и совместимости шлюза переживают запись', async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-access-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const prefs = new PrefsStore({ prefsPath: path.join(temp, 'prefs.json') });

  // Ни локальный state-сертификат, ни старое раскрытие визарда не выбираются автоматически.
  assert.equal(prefs.read().accessLocalHttps, false);
  assert.equal(prefs.read().accessGateway, false);

  prefs.write({ accessLocalHttps: true });
  assert.equal(prefs.read().accessLocalHttps, true);
  assert.equal(prefs.read().accessGateway, false, 'частичный патч не трогает соседний ключ');

  prefs.write({ accessGateway: true });
  assert.equal(prefs.read().accessLocalHttps, true, 'частичный патч не гасит соседний режим');
  assert.equal(prefs.read().accessGateway, true);

  prefs.write({ accessLocalHttps: false });
  assert.equal(prefs.read().accessLocalHttps, false);
});
