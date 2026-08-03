import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURE = path.join(ROOT, 'tests/fixtures/kimi-acp/unauthenticated-0.31.1.json');

test('versioned unauthenticated fixture фиксирует live ACP contract без prompt', async () => {
  const fixture = JSON.parse(await readFile(FIXTURE, 'utf8'));
  assert.deepEqual(fixture.compatibility, {
    cliPackage: '@moonshot-ai/kimi-code',
    cliVersion: '0.31.1',
    cliIntegrity: 'sha512-Hyly4EjzemSjla479jC47h+K98wNvRKOqGwu6mBncI/MlIafqEByUXeGl/9+DsOKdiE6fQTxkxiAcgusBay56Q==',
    nodeVersionFloor: '22.19.0',
    protocolVersion: 1,
    acpSpec: 'v0.10.x',
    acpSdkVersion: '0.23.0',
  });
  assert.equal(fixture.scenario, 'unauthenticated_no_prompt');
  assert.equal(fixture.safeguards.inheritedEnvironment, false);
  assert.equal(fixture.safeguards.credentialMaterialCopied, false);
  assert.deepEqual(fixture.termination, { afterStdinEof: 'natural', exitCode: 0, signal: null });
  assert.equal(fixture.syscallAudit.enabled, true);
  assert.deepEqual(fixture.syscallAudit.attemptedSocketCalls, []);
  assert.equal(Array.isArray(fixture.startupInventory), true);

  const clientMethods = fixture.transcript
    .filter((frame) => frame.direction === 'client_to_agent')
    .map((frame) => frame.message.method)
    .filter(Boolean);
  assert.deepEqual(clientMethods, ['initialize', 'session/list', 'session/new']);
  assert.equal(clientMethods.includes('session/prompt'), false);

  const initialize = fixture.transcript.find((frame) => frame.message.id === 1 && frame.message.result);
  assert.equal(initialize.message.result.protocolVersion, 1);
  assert.equal(initialize.message.result.agentCapabilities.loadSession, true);
  assert.deepEqual(initialize.message.result.agentCapabilities.sessionCapabilities, { list: {}, resume: {} });

  const authRequired = fixture.transcript.find((frame) => frame.message.id === 3 && frame.message.error);
  assert.equal(authRequired.message.error.code, -32000);
});
