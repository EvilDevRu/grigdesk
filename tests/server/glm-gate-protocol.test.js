import assert from 'node:assert/strict';
import test from 'node:test';
import { glmGateHash, parseGlmGateProof } from '../../shared/node/glmGateProtocol.ts';

const binding = {
  format: 1,
  consumer: 'chat',
  launchId: 'launch',
  policyHash: 'a'.repeat(64),
  sessionId: 'session',
  agentId: 'agent',
  turn: 1,
  callId: 'call',
  name: 'write',
  sha256: glmGateHash({ file_path: '/fixture', content: 'ok' }),
};
const proof = {
  ...binding,
  decision: 'allow',
  kind: 'edit',
  reason: ''
};

test('GLM gate принимает только точный дескриптор текущего execution', () => {
  assert.deepEqual(parseGlmGateProof(JSON.stringify(proof), binding), proof);

  for (const key of ['launchId', 'policyHash', 'sessionId', 'agentId', 'turn', 'callId', 'name', 'sha256']) {
    assert.throws(() => parseGlmGateProof(JSON.stringify({ ...proof, [key]: 'wrong' }), binding));
  }
  for (const value of ['', '{}', JSON.stringify(proof) + JSON.stringify(proof), 'x'.repeat(20000)]) {
    assert.throws(() => parseGlmGateProof(value, binding));
  }

  assert.throws(() => parseGlmGateProof(JSON.stringify({ ...proof, extra: true }), binding));
  assert.throws(() => parseGlmGateProof(JSON.stringify({ ...proof, decision: 'ask' }), binding));
});
test('GLM gate связывает порядок JSON-ключей, но сохраняет содержимое аргументов', () => {
  assert.equal(glmGateHash({ b: 2, a: [1, 2] }), glmGateHash({ a: [1, 2], b: 2 }));
  assert.notEqual(glmGateHash({ a: [1, 2] }), glmGateHash({ a: [2, 1] }));
});

test('GLM gate отвергает дубликаты ключей и корректно типизированный чужой turn', () => {
  const duplicate = JSON.stringify(proof).replace('"format":1', '"format":1,"format":1');

  assert.throws(() => parseGlmGateProof(duplicate, binding));
  assert.throws(() => parseGlmGateProof(JSON.stringify({ ...proof, turn: 2 }), binding));
});
