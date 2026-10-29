import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { glmCompatibilityHash } from '../../shared/node/glmCompatibility.ts';

const execute = promisify(execFile);
const script = path.resolve(import.meta.dirname, '../../deepseek/scripts/admissionCheck.mts');
const hostContract = fileURLToPath(new URL('../../server/deepseek-host-contract.json', import.meta.url));

/**
 * Кандидат-заглушка — настоящий исполняемый файл: отвечает на --runtime-info --json
 * metadata с входами GLM; список admission задаёт сам тест по вычисленному identity.
 */
function candidateInputs() {
  return {
    source: { commit: 'a'.repeat(40) },
    inputIdentity: {
      composition: `grigdesk-host-web-acp-v4:${'b'.repeat(64)}`,
      dependencyLock: 'c'.repeat(64),
    },
    llmPiAi: {
      piAi: { version: '0.85.1', integrity: 'sha512-x' },
      sourceHash: 'd'.repeat(64),
      patches: [] as [],
    },
  };
}

/**
 * Записывает кандидата с заданным списком admission и возвращает его путь вместе
 * с вычисленными по тем же входам identity обоих режимов для ожиданий теста.
 */
async function writeCandidate(
  directory: string,
  admitted: Array<{ mode: string; compatibility: string }>,
) {
  const host = JSON.parse(await fs.readFile(hostContract, 'utf8'));
  const inputs = candidateInputs();
  const identity = (mode: 'api' | 'coding-plan') => glmCompatibilityHash(inputs, mode, {
    profile: host.glm.profileRevision,
    policy: host.glm.policyRevision,
  });
  const info = {
    buildId: 'e'.repeat(64),
    glm: {
      inputs,
      admission: admitted,
    },
  };
  const binary = path.join(directory, 'candidate');

  await fs.writeFile(binary, [
    `#!${process.execPath}`,
    `console.log(JSON.stringify(${JSON.stringify(info)}));`,
  ].join('\n'), { mode: 0o755 });

  return {
    binary,
    identity,
    inputs,
  };
}

test('admission:check подтверждает совпавший допуск и код 3 без допуска', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-admission-'));

  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const { identity, inputs } = await writeCandidate(directory, []);
  const binary = path.join(directory, 'candidate-admitted');
  const info = {
    buildId: 'e'.repeat(64),
    glm: {
      inputs,
      admission: [{ mode: 'api', compatibility: identity('api') }],
    },
  };

  await fs.writeFile(binary, [
    `#!${process.execPath}`,
    `console.log(JSON.stringify(${JSON.stringify(info)}));`,
  ].join('\n'), { mode: 0o755 });

  const ok = await execute(process.execPath, [script, '--binary', binary,
    '--mode', 'api', '--host-contract', hostContract]);

  assert.match(ok.stdout, /ok api /u);

  // Ненулевой код promisify(execFile) отвергает: ошибка несёт stdout ребёнка.
  const missing = await execute(process.execPath, [script, '--binary', binary,
    '--mode', 'coding-plan', '--host-contract', hostContract])
    .catch((caught: unknown) => caught) as { code: number; stdout: string };

  assert.equal(missing.code, 3);
  assert.match(missing.stdout, new RegExp(`missing coding-plan ${identity('coding-plan')}`));
});

test('admission:check отвергает неверные аргументы до запуска кандидата', async () => {
  for (const args of [['--binary', 'relative', '--mode', 'api', '--host-contract', hostContract],
    ['--binary', '/abs', '--mode', 'bogus', '--host-contract', hostContract],
    ['--binary', '/abs', '--mode', 'api'],
    ['--unknown', 'value']]) {
    await assert.rejects(execute(process.execPath, [script, ...args]),
      (caught: Error & { code?: number }) => {
        assert.notEqual(caught.code, 0);

        return true;
      }, JSON.stringify(args));
  }
});
