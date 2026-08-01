// Тумблеры «Настройки → Доступ»: чем кокпит отвечает наружу.
//
// Проверяем ровно две вещи, которые ломаются молча: безопасный дефолт (чистая установка
// не открывает ни одного способа зайти извне) и то, что ключи режимов переживают запись —
// PrefsStore.write отбрасывает всё, чего нет в DEFAULTS, и опечатка в имени просто исчезнет.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { PrefsStore } from '../../server/src/lib/prefs-store.js';

test('ACCESS-01: режимы доступа по умолчанию выключены и переживают запись', async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-access-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const prefs = new PrefsStore({ prefsPath: path.join(temp, 'prefs.json') });

  // Пустая установка отвечает только на своей машине — это правильная граница по умолчанию.
  assert.equal(prefs.read().accessLocalHttps, false);
  assert.equal(prefs.read().accessGateway, false);

  prefs.write({ accessLocalHttps: true });
  assert.equal(prefs.read().accessLocalHttps, true);
  assert.equal(prefs.read().accessGateway, false, 'режимы независимы');

  prefs.write({ accessGateway: true });
  assert.equal(prefs.read().accessLocalHttps, true, 'частичный патч не гасит соседний режим');
  assert.equal(prefs.read().accessGateway, true);

  prefs.write({ accessLocalHttps: false });
  assert.equal(prefs.read().accessLocalHttps, false);
});
