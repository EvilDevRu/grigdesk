import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { inspectInstalledServer } from '../../shared/node/installedServer.ts';
import { installedFixture } from '../helpers/installedUpdateFixture.mjs';

/**
 * Сервер установки может быть не запущен или поднят откуда угодно: осмотр обязан
 * распознавать незапущенный сервер по отказу порта, не требуя CLI-токен.
 */
test('INSPECT-STOPPED: незапущенный сервер распознаётся без CLI-токена', async (t) => {
  const box = await installedFixture(t);

  await fs.rm(path.join(box.receipt.dataHome, 'state', 'cli-token'), { force: true });

  const owner = await inspectInstalledServer(box.receipt);

  assert.equal(owner.kind, 'stopped');
  assert.equal(owner.running, false);
});

/**
 * Живой порт с отсутствующим токеном установки не превращается в сырой ENOENT:
 * человек получает диагностический код вместо трассировки файловой ошибки.
 */
test('INSPECT-TOKEN: живой порт без токена установки даёт release_server_token_unreadable', async (t) => {
  const box = await installedFixture(t);
  const server = createServer((request, response) => {
    response.end('{}');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const { port } = server.address();

  await fs.rm(path.join(box.receipt.dataHome, 'state', 'cli-token'), { force: true });
  await fs.writeFile(path.join(box.receipt.dataHome, '.env'), `GRIGDESK_PORT=${port}\n`, { mode: 0o600 });

  await assert.rejects(inspectInstalledServer(box.receipt), /release_server_token_unreadable/u);
});
