import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { executeBundle } from '../../tools/bundleSteps.mts';
import { streamProbe } from './helpers/streamProbe.js';

const names = ['server', 'b24', 'relay', 'deepseek', 'window'];
const steps = [...names, 'verify', 'pack', 'publish'].map((name) => `bundle.${name}`);

/**
 * Каждый callback действительно создаёт новый исполняемый файл во временном outDir.
 * Tar работает только с этим маленьким payload; публикация и отказы наблюдаются на диске.
 */
async function bundleFixture(t, failStage) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ctl-bundle-progress-'));
  const events = [];
  const calls = [];
  const builders = {};
  const failure = Object.assign(new Error('Синтетический отказ'), { code: 23 });

  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'bin'), { recursive: true });
  await fs.mkdir(path.join(root, 'deploy/lib'), { recursive: true });
  await fs.writeFile(path.join(root, 'VERSION'), '9.8.7\n');
  await fs.writeFile(path.join(root, 'bin/grigdesk-ctl'), '#!/bin/bash\nexit 0\n');
  await fs.writeFile(path.join(root, 'deploy/lib/runtime-env.sh'), '# изолированный payload\n');
  await fs.mkdir(path.join(root, 'release'));
  await fs.writeFile(path.join(root, 'release/previous'), 'прежняя поставка');

  for (const name of names) {
    builders[name] = async (input) => {
      assert.equal(events.at(-1)?.id, `bundle.${name}`, 'start должен предшествовать реальному builder');
      assert.equal(events.at(-1)?.type, 'start');
      calls.push(name);

      if (failStage === name) {
        throw failure;
      }

      const output = path.join(input.outDir, name);

      await fs.writeFile(output, `#!/bin/bash\n# ${name}\nexit 0\n`, { mode: 0o755 });

      return output;
    };
  }

  const options = {
    root,
    env: { PATH: process.env.PATH },
    builders,
    readSourceState: async () => ({ commit: '1'.repeat(40), dirty: false }),
    onStep: (event) => events.push({
      type: event.type,
      id: event.id,
      ...(event.type === 'end' ? { code: event.code } : {}),
    }),
    verifyDeepSeek: async () => {
      calls.push('verify');
      assert.equal(events.at(-1)?.id, 'bundle.verify');

      if (failStage === 'verify') {
        throw failure;
      }
    },
    verifyDeepSeekCompatibility: async () => {
      calls.push('compatibility');
      assert.equal(events.at(-1)?.id, 'bundle.verify');
    },
    audit: async () => {
      assert.equal(events.at(-1)?.id, 'bundle.pack');

      if (failStage === 'pack') {
        throw failure;
      }
    },
    fs: {
      ...fs,
      /**
       * Наблюдает границу атомарной публикации, не заменяя саму операцию rename.
       * Отказ внедряется только при установке нового комплекта, сохраняя восстановление резерва.
       */
      async rename(from, to) {
        if (to === path.join(root, 'release')) {
          assert.equal(events.at(-1)?.id, 'bundle.publish');

          if (failStage === 'publish' && path.basename(from) === 'release') {
            throw failure;
          }
        }

        return fs.rename(from, to);
      },
    },
  };

  return {
    root,
    events,
    calls,
    options,
  };
}

test('BUNDLE-EVENTS: observer обрамляет прежние реальные фазы по порядку', async (t) => {
  const box = await bundleFixture(t);

  await executeBundle(box.options);
  assert.deepEqual(box.events, steps.flatMap((id) => [
    { type: 'start', id },
    {
      type: 'end',
      id,
      code: 0,
    },
  ]));
  assert.deepEqual(box.calls, [...names, 'verify', 'compatibility']);
  assert.ok((await fs.stat(path.join(box.root, 'release.tar.gz'))).isFile());
});

for (const stage of [...names, 'verify', 'pack', 'publish']) {
  test(`BUNDLE-EVENTS: отказ ${stage} не создаёт success или будущие события`, async (t) => {
    const box = await bundleFixture(t, stage);

    await assert.rejects(executeBundle(box.options));

    const index = steps.indexOf(`bundle.${stage}`);

    assert.deepEqual(box.events, [
      ...steps.slice(0, index).flatMap((id) => [{ type: 'start', id }, {
        type: 'end',
        id,
        code: 0,
      }]),
      { type: 'start', id: steps[index] },
      {
        type: 'end',
        id: steps[index],
        code: 23,
      },
    ]);
    assert.equal(await fs.readFile(path.join(box.root, 'release/previous'), 'utf8'), 'прежняя поставка');
  });
}

for (const code of [0, 23]) {
  test(`BUNDLE-STREAM: большой вывод поступает до завершения и сохраняется при коде ${code}`, async (t) => {
    await streamProbe(t, new URL('../../tools/bundle.mts', import.meta.url), 'run', code);
  });
}
