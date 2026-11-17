import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { prepareQwenIdleBridge } from '../../server/src/lib/qwen/idleBridge.ts';

for (const version of ['0.27.2', '0.27.3', '0.28.0']) {
  test(`idle bridge: неизвестный исходник ${version} не получает допуск автоуборки`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'qwen-idle-unknown-'));
    const chunks = path.join(root, 'chunks');
    const staging = path.join(root, 'staging');
    const entry = path.join(root, 'cli-entry.js');
    const source = 'var Session=class{}; async extMethodInternal(method,params){ }';

    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(chunks);
    await mkdir(staging);
    await writeFile(entry, 'synthetic entry');
    await writeFile(path.join(root, 'package.json'), JSON.stringify({
      name: '@qwen-code/qwen-code',
      version,
    }));
    await writeFile(path.join(chunks, 'acpAgent-SYNTHETIC.js'), source);

    const bridge = await prepareQwenIdleBridge(entry, staging);

    assert.equal(bridge, null);
    assert.equal(await readFile(path.join(chunks, 'acpAgent-SYNTHETIC.js'), 'utf8'), source);
    assert.equal(await readFile(entry, 'utf8'), 'synthetic entry');
  });
}
