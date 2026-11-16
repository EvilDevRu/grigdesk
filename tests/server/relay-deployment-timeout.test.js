import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { command, upload } from '../../server/src/lib/mobile/relayDeployment/sshClient.ts';
import { relayDeploymentSsh } from './helpers/relayDeploymentSsh.js';

for (const kind of ['exec', 'sftp']) {
  for (const opening of ['missing', 'delayed']) {
    test(`RD-TIMEOUT: ${kind} ${opening} ограничивает открытие канала и закрывает свой SSH`, {
      timeout: 10000,
    }, async (t) => {
      const ssh = await relayDeploymentSsh(t, {
        [`${kind}Open`]: opening,
        [`${kind}DelayMs`]: opening === 'delayed' ? 300 : 0,
      });
      const session = await ssh.transport.connect(ssh.input);
      const closed = new Promise((resolve) => session.once('close', resolve));
      const operation = kind === 'exec'
        ? command(session, 'printf unexpected', 50)
        : upload(session, '/tmp/unexpected', Buffer.from('fixture'), 50);

      await assert.rejects(operation, {
        message: kind === 'exec' ? 'ssh_command_timeout' : 'ssh_upload_timeout',
      });
      await closed;
      assert.equal(ssh.commands.length, 0, 'Задержанный exec не должен начать системные изменения');
      assert.equal(ssh.writes.length, 0, 'Задержанный SFTP не должен записать файл');
    });
  }
}

for (const kind of ['exec', 'sftp']) {
  test(`RD-TIMEOUT: поздний ${kind} после окончания срока закрывается без использования`, async () => {
    const client = new EventEmitter();
    const channel = kind === 'exec' ? new PassThrough() : new EventEmitter();
    let opened;
    let closed = false;
    let destroyed = false;

    channel.on('close', () => {
      closed = true;
    });
    channel.end = () => channel.emit('close');

    const session = {
      client,
      exec: () => new Promise((resolve) => {
        opened = resolve;
      }),
      sftp: () => new Promise((resolve) => {
        opened = resolve;
      }),
      destroy: () => {
        destroyed = true;
        client.emit('close');
      },
    };
    const operation = kind === 'exec'
      ? command(session, 'fixture', 10)
      : upload(session, '/tmp/fixture', Buffer.from('fixture'), 10);

    await assert.rejects(operation, /ssh_.*_timeout/u);
    assert.equal(destroyed, true);
    opened(channel);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closed, true);
  });
}
