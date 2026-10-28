import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { installBinary } from '../../deepseek/scripts/installSteps.mts';
import { glmCompatibilityIdentity } from '../../server/src/lib/glm/contract.ts';
import { copyInstallCandidate, removeInstallStage } from '../../deepseek/scripts/installFiles.mts';
import { sha256File } from '../../shared/node/hash.ts';
import { runtimeInfoFixture } from '../helpers/deepseekMetadataFixture.mts';
import {
  deepSeekTestArtifactsRoot, ensureTestAdmittedDeepSeekBinary, ensureTestUnadmittedDeepSeekBinary,
} from '../helpers/deepseekBinary.mts';

const artifacts = path.join(deepSeekTestArtifactsRoot(), 's16');
const run = promisify(execFile);
const cli = fileURLToPath(new URL('../../deepseek/scripts/install.mts', import.meta.url));

/**
 * Stub исполняется как настоящий файл и сообщает полностью совместимый контракт.
 * Синтетический admission относится только к этим байтам тестовой поставки.
 */
async function fixture(t: TestContext) {
  await fs.mkdir(artifacts, { recursive: true, mode: 0o700 });

  const root = await fs.mkdtemp(path.join(artifacts, 'install-'));
  const binary = path.join(root, 'candidate');
  const info = runtimeInfoFixture();

  assert.ok(info.glm.inputs.llmPiAi);
  info.glm.admission[0]!.compatibility = glmCompatibilityIdentity({
    ...info.glm.inputs,
    llmPiAi: info.glm.inputs.llmPiAi,
  }, 'api');

  const hostContract = path.join(root, 'host.json');

  await writeStub(binary, info);
  t.after(() => removeInstallStage(root));
  await fs.copyFile(new URL('../../server/deepseek-host-contract.json', import.meta.url), hostContract);

  return {
    root,
    info,
    options: {
      binary,
      hostContract,
      target: path.join(root, 'deepseek'),
      releasesDir: path.join(root, 'releases'),
    },
  };
}

/**
 * Metadata и verify идут через реальные execFile с закрытым окружением.
 * Дополнительное поведение позволяет воспроизвести отказ или подмену во время проб.
 */
async function writeStub(
  binary: string,
  info: unknown,
  behavior = '',
): Promise<void> {
  const script = `#!${process.execPath}
const info = ${JSON.stringify(info)};
${behavior}
if (process.argv.includes('--runtime-info')) console.log(JSON.stringify(info));
else if (process.argv.includes('--verify')) {
  console.log(JSON.stringify({ verified: true, packageId: info.packageId, glmPlugin: true }));
} else process.exitCode = 2;
`;

  await fs.writeFile(binary, script, { mode: 0o755 });
}

test('первая установка публикует проверенные байты и не предполагает старую память', async (t) => {
  const { options, info } = await fixture(t);
  const before = await sha256File(options.binary);
  const result = await installBinary(options);

  assert.deepEqual(result, {
    packageId: info.packageId,
    sha256: before,
    previous: null,
    memory: 'unknown',
  });
  assert.equal(await sha256File(options.target), before);
  assert.equal(await sha256File(options.binary), before);
});

test('A→B сохраняет проверенную A, откат проходит те же пробы и возвращает память', async (t) => {
  const { options, info } = await fixture(t);
  const a = await installBinary(options);
  const next = {
    ...info,
    packageId: '2'.repeat(64),
    journal: { write: 3, read: [2, 3] },
  };

  await writeStub(options.binary, next);

  const b = await installBinary(options);

  assert.equal(b.packageId, next.packageId);
  assert.equal(b.memory, 'continues');
  assert.equal(b.previous, path.join(options.releasesDir, a.sha256, 'deepseek'));
  assert.equal(await sha256File(b.previous!), a.sha256);
  assert.equal(await sha256File(options.target), b.sha256);

  const rollback = await installBinary({ ...options, binary: b.previous! });

  assert.equal(rollback.sha256, a.sha256);
  assert.equal(rollback.packageId, a.packageId);
  assert.equal(rollback.memory, 'resets');
  assert.equal(await sha256File(rollback.previous!), b.sha256);
});

test('отказы metadata, verify, bridge, host и GLM admission сохраняют A', async (t) => {
  const { options, info } = await fixture(t);
  const a = await installBinary(options);
  const failures = [
    { info, behavior: "if (process.argv.includes('--runtime-info')) process.exit(9);" },
    { info, behavior: "if (process.argv.includes('--verify')) process.exit(9);" },
    { info: { ...info, capabilities: { ...info.capabilities, settingsAcp: false } } },
    { info: { ...info, hostContract: 2 } },
    { info: { ...info, glm: { ...info.glm, admission: [] } } },
    { info: { ...info, glm: { ...info.glm, admission: [{ mode: 'coding-plan',
      compatibility: info.glm.admission[0]!.compatibility }] } } },
    { info: { ...info, glm: { ...info.glm, admission: [{ mode: 'api',
      compatibility: '0'.repeat(64) }] } } },
    { info: { ...info, glm: { ...info.glm, inputs: { ...info.glm.inputs, llmPiAi: null } } } },
    { info, behavior: "if (process.argv.includes('--verify')) { console.log('{}'); process.exit(0); }" },
    { info, behavior: "if (process.argv.includes('--verify')) { console.log(JSON.stringify({"
      + " verified:true, glmPlugin:true, packageId:'0'.repeat(64) })); process.exit(0); }" },
  ];

  for (const [index, failure] of failures.entries()) {
    await writeStub(options.binary, failure.info, failure.behavior);
    await assert.rejects(installBinary(options), `отказ ${index}`);
    assert.equal(await sha256File(options.target), a.sha256);
  }
});

test('оборванная копия и отказ публикации оставляют A и её сохранённые байты', async (t) => {
  const { options, info } = await fixture(t);
  const a = await installBinary(options);

  await writeStub(options.binary, { ...info, packageId: '3'.repeat(64) });
  await assert.rejects(installBinary(options, {
    copy: async (_source, target) => {
      await fs.writeFile(target, 'partial');

      throw new Error('Имитирован обрыв записи');
    },
  }), /обрыв записи/u);
  assert.equal(await sha256File(options.target), a.sha256);

  await assert.rejects(installBinary(options, {
    publish: async () => {
      throw new Error('Имитирован отказ rename');
    },
  }), /отказ rename/u);
  assert.equal(await sha256File(options.target), a.sha256);
  assert.equal(await sha256File(path.join(options.releasesDir, a.sha256, 'deepseek')), a.sha256);

  const recovered = await installBinary(options);

  assert.equal(recovered.packageId, '3'.repeat(64));
  assert.equal(await sha256File(recovered.previous!), a.sha256);
});

test('публикуется проверенная копия, даже если исходный candidate заменён после копирования', async (t) => {
  const { options, info } = await fixture(t);
  const digest = await sha256File(options.binary);
  const result = await installBinary(options, {
    copy: async (source, target) => {
      await copyInstallCandidate(source, target);
      await fs.writeFile(source, 'SOURCE_WAS_REPLACED');
    },
  });

  assert.equal(result.packageId, info.packageId);
  assert.equal(result.sha256, digest);
  assert.equal(await sha256File(options.target), digest);
});

test('ссылку target и чужой обычный файл установщик не перезаписывает', async (t) => {
  const { options } = await fixture(t);
  const foreign = path.join(path.dirname(options.target), 'foreign');

  await fs.writeFile(foreign, 'foreign');
  await fs.symlink(foreign, options.target);
  await assert.rejects(installBinary(options));
  assert.equal(await fs.readFile(foreign, 'utf8'), 'foreign');
  assert.equal(await fs.readlink(options.target), foreign);
  await fs.unlink(options.target);
  await fs.writeFile(options.target, 'foreign regular file');
  await assert.rejects(installBinary(options));
  assert.equal(await fs.readFile(options.target, 'utf8'), 'foreign regular file');
});

test('два установщика сериализуются, сохраняя целую цепочку A→B→C', async (t) => {
  const { options, info } = await fixture(t);
  const a = await installBinary(options);
  const candidateC = path.join(path.dirname(options.binary), 'candidate-c');

  await writeStub(options.binary, { ...info, packageId: '4'.repeat(64) });
  await writeStub(candidateC, { ...info, packageId: '5'.repeat(64) });

  let publishedB = false;
  let copying!: () => void;
  let continueFirst!: () => void;
  const entered = new Promise<void>((resolve) => {
    copying = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    continueFirst = resolve;
  });
  const first = installBinary(options, {
    copy: async (source, target) => {
      await copyInstallCandidate(source, target);
      copying();
      await gate;
    },
    publish: async (source, target) => {
      await fs.rename(source, target);
      publishedB = true;
    },
  });

  await entered;

  const second = installBinary({ ...options, binary: candidateC }, {
    copy: async (source, target) => {
      assert.equal(publishedB, true, 'вторая копия начинается после публикации первой');
      await copyInstallCandidate(source, target);
    },
  });

  continueFirst();

  const [b, c] = await Promise.all([first, second]);

  assert.equal(await sha256File(b.previous!), a.sha256);
  assert.equal(await sha256File(c.previous!), b.sha256);
  assert.equal(await sha256File(options.target), c.sha256);
  assert.equal(c.packageId, '5'.repeat(64));
});

test('работающий A отвечает после атомарной установки B', async (t) => {
  const { options, info } = await fixture(t);

  await writeStub(options.binary, info, `
if (process.argv.includes('--hold')) {
  process.stdin.on('data', () => console.log(info.packageId));
  console.log('READY');
}
`);

  const a = await installBinary(options);
  const child = spawn(options.target, ['--hold'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = once(child, 'close');

  t.after(async () => {
    child.kill('SIGTERM');
    await closed;
  });
  assert.equal(String((await once(child.stdout, 'data'))[0]).trim(), 'READY');
  await writeStub(options.binary, { ...info, packageId: '6'.repeat(64) });

  const b = await installBinary(options);
  const answer = once(child.stdout, 'data');

  child.stdin.write('ping\n');
  assert.equal(String((await answer)[0]).trim(), a.packageId);
  assert.equal(child.exitCode, null);
  assert.equal(await sha256File(b.previous!), a.sha256);
  assert.equal(await sha256File(options.target), b.sha256);
});

test('изменение staged bytes или прав во время verify запрещает публикацию', async (t) => {
  const { options, info } = await fixture(t);
  const a = await installBinary(options);

  for (const mutation of [
    "require('node:fs').appendFileSync(__filename, '\\n//changed');",
    '',
  ]) {
    await writeStub(options.binary, info, `
if (process.argv.includes('--verify')) {
  require('node:fs').chmodSync(__filename, 0o777);
  ${mutation}
}
`);
    await assert.rejects(installBinary(options));
    assert.equal(await sha256File(options.target), a.sha256);
  }
});

test('CLI требует аргументы и предупреждает только о несовместимой памяти', async (t) => {
  const { options, info } = await fixture(t);
  const args = ['--binary', options.binary, '--target', options.target,
    '--host-contract', options.hostContract, '--releases-dir', options.releasesDir];
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const first = await run('npm', ['--prefix', path.join(root, 'deepseek'),
    'run', '--silent', 'install:binary', '--', ...args]);

  assert.equal(first.stderr, '');
  assert.equal(JSON.parse(first.stdout).memory, 'unknown');
  await writeStub(options.binary, {
    ...info,
    packageId: '7'.repeat(64),
    journal: { write: 3, read: [3] },
  });

  const next = await run(process.execPath, [cli, ...args]);

  assert.equal(JSON.parse(next.stdout).memory, 'resets');
  assert.equal(next.stderr.trim(), 'чаты DeepSeek/GLM начнут память заново, лента сохранится');

  const continued = await run(process.execPath, [cli, ...args]);

  assert.equal(JSON.parse(continued.stdout).memory, 'continues');
  assert.equal(continued.stderr, '');

  for (const missing of ['--binary', '--target', '--host-contract']) {
    const invalid = [...args];
    const index = invalid.indexOf(missing);

    invalid.splice(index, 2);
    await assert.rejects(run(process.execPath, [cli, ...invalid]), { code: 2 });
  }
});

test('потребитель задаёт host-contract; deploy helper передаёт его и не меняет A при отказе', async (t) => {
  const { options, info } = await fixture(t);
  const a = await installBinary(options);
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const host = JSON.parse(await fs.readFile(options.hostContract, 'utf8'));

  host.hostContract = 2;
  await fs.writeFile(options.hostContract, JSON.stringify(host));
  await writeStub(options.binary, { ...info, packageId: '9'.repeat(64) });
  await assert.rejects(run('bash', [
    path.join(root, 'deploy/lib/deepseek-cli.sh'), root, options.binary, options.target,
    options.hostContract, options.releasesDir,
  ]), { code: 1 });
  assert.equal(await sha256File(options.target), a.sha256);
});

test('пробы исполняют staged copy без ключей и loader-переменных', async (t) => {
  const { options, info, root } = await fixture(t);
  const log = path.join(root, 'probes.jsonl');
  const names = ['DEEPSEEK_API_KEY', 'ZAI_API_KEY', 'ZAI_CODING_API_KEY', 'NODE_OPTIONS', 'LD_PRELOAD'];
  const saved = names.map((name) => process.env[name]);

  for (const name of names) {
    process.env[name] = 'SYNTHETIC_MUST_NOT_REACH_PROBE';
  }

  try {
    await writeStub(options.binary, info, `
require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify({
  file: __filename, args: process.argv.slice(2), keys: Object.keys(process.env), home: process.env.HOME,
}) + '\\n');
`);
    await installBinary(options);
  } finally {
    for (const [index, name] of names.entries()) {
      if (saved[index] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = saved[index];
      }
    }
  }

  const calls = (await fs.readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));

  assert.equal(calls.length, 2);
  assert.equal(calls[0].file, calls[1].file);
  assert.notEqual(calls[0].file, options.binary);
  assert.notEqual(calls[0].file, options.target);
  assert.ok(calls[0].args.includes('--runtime-info'));
  assert.ok(calls[1].args.includes('--verify'));

  for (const call of calls) {
    assert.ok(call.file.startsWith(path.join(root, '.deepseek-install-')));
    assert.equal(call.home, path.join(path.dirname(call.file), 'home'));
    assert.ok(names.every((name) => !call.keys.includes(name)));
    assert.ok(!call.keys.includes('GRIGDESK_ENV_FILE'));
  }
});

test('пробы и backup прежней поставки не могут изменить проверенную новую копию', async (t) => {
  const { options, info } = await fixture(t);

  await writeStub(options.binary, info, `
if (require('node:path').basename(__filename) === 'previous') {
  const next = require('node:path').join(require('node:path').dirname(__filename), 'deepseek');
  require('node:fs').chmodSync(next, 0o755);
  require('node:fs').appendFileSync(next, '\\n//late-change');
}
`);

  const a = await installBinary(options);

  await writeStub(options.binary, { ...info, packageId: '8'.repeat(64) });
  await assert.rejects(installBinary(options), /Проверенная копия DeepSeek изменилась/u);
  assert.equal(await sha256File(options.target), a.sha256);
});

test('настоящий ELF проходит staged verify; отдельный ELF без admission отвергается', async (t) => {
  const { options } = await fixture(t);
  const candidate = await ensureTestAdmittedDeepSeekBinary();
  const result = await installBinary({ ...options, binary: candidate.binary });
  const actual = JSON.parse((await run(options.target, ['--runtime-info', '--json'], {
    env: { PATH: '' },
  })).stdout);

  assert.equal(result.packageId, candidate.info.packageId);
  assert.equal(actual.packageId, candidate.info.packageId);
  assert.equal(await sha256File(options.target), await sha256File(candidate.binary));
  assert.equal(result.memory, 'unknown');

  const unadmitted = await ensureTestUnadmittedDeepSeekBinary();

  assert.deepEqual(unadmitted.info.glm.admission, []);
  await assert.rejects(installBinary({ ...options, binary: unadmitted.binary }), {
    code: 'deepseek_glm_unadmitted',
  });
  assert.equal(await sha256File(options.target), result.sha256);
});
