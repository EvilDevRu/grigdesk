import { readFile } from 'node:fs/promises';

import { GLM_GATE_REVISION, glmGateHash } from '../../../shared/node/glmGateProtocol.ts';

/**
 * Wire-double читает только созданный тестом overlay, без запуска настоящего gate.
 * Enforcement проверяют отдельно тесты ELF; здесь воспроизводится его протокол событий.
 */
export async function glmNativeProtocol(args) {
  const index = args.indexOf('--patch');
  const overlay = index < 0 ? '' : await readFile(args[index + 1], 'utf8');

  if (!overlay.includes('grigdesk:glm-gate')) {
    return null;
  }

  const field = (name) => JSON.parse(overlay.match(new RegExp(`^\\s+${name}: (.+)$`, 'm'))[1]);
  const policyHash = glmGateHash(JSON.parse(await readFile(field('policyFile'), 'utf8')));
  const launchId = field('launchId');
  let sessionId = '';

  return {
    ready(id) {
      sessionId = id;

      return {
        revision: GLM_GATE_REVISION,
        launchId,
        policyHash,
        sessionId,
        agentId: 'fake-agent',
      };
    },
    proof(turn, callId, name, input) {
      return {
        format: 1,
        consumer: 'chat',
        launchId,
        policyHash,
        sessionId,
        agentId: 'fake-agent',
        turn,
        callId,
        name,
        sha256: glmGateHash(input),
        decision: 'allow',
        kind: 'other',
        reason: '',
      };
    },
  };
}
