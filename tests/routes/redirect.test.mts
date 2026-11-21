import assert from 'node:assert/strict';
import test from 'node:test';

import { goCandidate } from '../helpers/goCandidate.mts';
import { startHttpFixture } from '../tracker/helpers/httpFixture.mts';
import { runProcess } from '../tracker/helpers/processFixture.mts';

const executable = goCandidate('routes');
const sourcePath = '/api/routes/fixture/drafts/draft-1/publish';
const token = 'fixture-token';

for (const status of [307, 308]) {
  test(`routes publish завершает запись после HTTP ${status}`, async (t) => {
    const target = await startHttpFixture(t, (_request, response) => {
      response.end('{"extraWrite":true}');
    });
    const source = await startHttpFixture(t, (_request, response) => {
      response.writeHead(status, { Location: `${target.baseUrl}/redirected` }).end();
    });
    const args = [
      'publish', 'fixture', '--draft', 'draft-1', '--expected-revision', '1',
      '--expected-source-revision', '0', '--expected-catalog-hash', 'none', '--yes',
      '--token', token, '--base', source.baseUrl,
    ];
    const result = await runProcess(t, executable, args, { env: { PATH: '' } });

    assert.equal(result.code, 5);
    assert.deepEqual(JSON.parse(result.stdout.toString()), null);
    assert.equal(source.requests.length, 1);
    assert.equal(target.requests.length, 0);

    const request = source.requests[0]!;
    const [recovery, explanation] = result.stderr.toString().trim().split('\n');
    const hint = JSON.parse(recovery!);

    assert.equal(request.method, 'POST');
    assert.equal(request.url, sourcePath);
    assert.equal(request.headers['x-grigdesk-token'], token);
    assert.deepEqual(hint.recovery, ['publications', 'fixture', hint.operationId]);
    assert.equal(JSON.parse(request.body.toString()).operationId, hint.operationId);
    assert.equal(explanation, `сервер вернул ${status}`);
  });
}

test('routes list следует перенаправлению без передачи токена на другой origin', async (t) => {
  const target = await startHttpFixture(t, (_request, response) => {
    response.end('{"drafts":[]}');
  });
  const source = await startHttpFixture(t, (_request, response) => {
    response.writeHead(307, { Location: `${target.baseUrl}/redirected` }).end();
  });
  const args = ['list', 'fixture', '--token', token, '--base', source.baseUrl];
  const result = await runProcess(t, executable, args, { env: { PATH: '' } });

  assert.equal(result.code, 0);
  assert.equal(result.stderr.length, 0);
  assert.deepEqual(JSON.parse(result.stdout.toString()), { drafts: [] });
  assert.deepEqual(source.requests.map((request) => request.method), ['GET']);
  assert.deepEqual(target.requests.map((request) => request.method), ['GET']);
  assert.equal(source.requests[0]?.headers['x-grigdesk-token'], token);
  assert.equal(target.requests[0]?.headers['x-grigdesk-token'], undefined);
});

test('routes list сохраняет токен при перенаправлении на тот же origin', async (t) => {
  const server = await startHttpFixture(t, (request, response) => {
    if (request.url === '/redirected') {
      response.end('{"drafts":[]}');
    } else {
      response.writeHead(307, { Location: '/redirected' }).end();
    }
  });
  const result = await runProcess(t, executable,
    ['list', 'fixture', '--token', token, '--base', server.baseUrl], { env: { PATH: '' } });

  assert.equal(result.code, 0, result.stderr.toString());
  assert.deepEqual(server.requests.map((request) => request.headers['x-grigdesk-token']), [token, token]);
});
