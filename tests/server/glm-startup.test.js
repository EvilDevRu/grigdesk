import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { startGlmProcess } from '../../server/src/lib/glm/launch.ts';
import { resolveDeepSeekRuntimeAsync } from '../../server/src/lib/deepseek/runtimeProcess.ts';
import { writeDeepSeekBinaryStub } from '../helpers/deepseekBinaryStub.mts';
import { runtimeInfoFixture } from '../helpers/deepseekMetadataFixture.mts';

/**
 * Metadata double допускается только в unit startup: настоящий production owner запускает child.
 * HTTP авторизация намеренно не отвечает; child выходит после подтверждённого начала fetch.
 */
test('GLM отвергает startup сразу при выходе ELF во время авторизации', { timeout: 10000 }, async (t) => {
  let marker;
  const authentication = createServer((_request, _response) => {
    void fs.writeFile(marker, 'request received');
  });

  await new Promise((resolve) => authentication.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    authentication.closeAllConnections();
    await new Promise((resolve) => authentication.close(resolve));
  });

  const url = `http://127.0.0.1:${authentication.address().port}/?token=synthetic-startup`;
  const info = runtimeInfoFixture();
  const { root, binary } = await writeDeepSeekBinaryStub(t, [
    'if (process.argv.includes("--runtime-info")) {',
    `  console.log(${JSON.stringify(JSON.stringify(info))}); process.exit(0);`,
    '}',
    `console.log(${JSON.stringify(`dsh web: ${url}`)});`,
    'const fs = require("node:fs");',
    'const marker = process.env.STARTUP_MARKER;',
    'setInterval(() => { if (fs.existsSync(marker)) process.exit(7); }, 10);',
  ].join('\n'));

  marker = path.join(root, 'auth-started');

  const launchDir = path.join(root, 'launch');
  const abort = new AbortController();
  const runtime = await resolveDeepSeekRuntimeAsync({ deepseekBin: binary, deepseekCacheDir: root });

  await fs.mkdir(launchDir);

  const started = performance.now();
  const startup = startGlmProcess({
    runtime,
    launch: { launchDir, overlayPath: path.join(launchDir, 'overlay.yaml') },
    cwd: root,
    env: { STARTUP_MARKER: marker },
    signal: abort.signal,
  });
  let timer;

  try {
    const outcome = await Promise.race([
      startup.then(() => 'resolved', () => 'rejected'),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve('deadline'), 1500);
      }),
    ]);

    await fs.access(marker);
    assert.equal(outcome, 'rejected', 'Завершившийся ELF должен прервать ещё ожидающую авторизацию');
    assert.ok(performance.now() - started < 1500);
  } finally {
    clearTimeout(timer);
    abort.abort();
    await startup.catch(() => {});
  }
});

for (const failure of ['early-exit', 'spawn-error']) {
  test(`GLM завершает startup при ${failure} без ожидания URL`, { timeout: 10000 }, async (t) => {
    const info = runtimeInfoFixture();
    const { root, binary } = await writeDeepSeekBinaryStub(t, [
      'if (process.argv.includes("--runtime-info")) {',
      `  console.log(${JSON.stringify(JSON.stringify(info))}); process.exit(0);`,
      '}',
      'process.exit(7);',
    ].join('\n'));
    const runtime = await resolveDeepSeekRuntimeAsync({ deepseekBin: binary, deepseekCacheDir: root });
    const launchDir = path.join(root, 'launch');
    const abort = new AbortController();

    await fs.mkdir(launchDir);

    const started = performance.now();
    const startup = startGlmProcess({
      runtime,
      launch: { launchDir, overlayPath: path.join(launchDir, 'overlay.yaml') },
      // Отсутствующий cwd вызывает настоящий ENOENT spawn после успешного metadata probe.
      cwd: failure === 'spawn-error' ? path.join(root, 'missing-cwd') : root,
      env: {},
      signal: abort.signal,
    });
    const timer = setTimeout(() => abort.abort(), 1500);

    try {
      // Нештатный выход и отказ spawn сохраняют существующий строгий исход cleanup.
      // Каталог диагностики остаётся, но promise больше не может ждать URL бесконечно.
      await assert.rejects(startup, { code: 'deepseek_binary_cleanup' });
      assert.ok(performance.now() - started < 1500);
      assert.ok((await fs.stat(launchDir)).isDirectory());
    } finally {
      clearTimeout(timer);
      abort.abort();
      await startup.catch(() => {});
    }
  });
}
