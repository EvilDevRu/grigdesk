import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('RL-24/RL-25: Docker запускает supervisor с ограничениями и секретами вне образа', async () => {
  const dockerfile = await readFile(new URL('../../relay/Dockerfile', import.meta.url), 'utf8');
  const compose = await readFile(new URL('../../relay/compose.yaml', import.meta.url), 'utf8');

  for (const expected of ['FROM node:24-alpine', 'USER node', 'src/supervisor.ts']) {
    assert.equal(dockerfile.includes(expected), true);
  }

  assert.equal(dockerfile.includes('npm install'), false);

  for (const expected of [
    'restart: unless-stopped',
    'init: true',
    'read_only: true',
    'no-new-privileges:true',
    'mem_limit: 256m',
    'pids_limit: 128',
    'driver: local',
    'max-size: "1m"',
    'max-file: "1"',
    '${RELAY_ENV_FILE:-relay.env}',
    '${RELAY_PUBLISH_PORT:-443}:7443',
  ]) {
    assert.equal(compose.includes(expected), true, expected);
  }
});
