import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Маленький child пишет две порции на каждый поток и ждёт файлового разрешения.
 * Проверка до разрешения отличает потоковый вывод от буфера, возвращённого при выходе.
 */
export async function streamProbe(t, moduleUrl, symbol, code) {
  const api = await import(moduleUrl.href);

  assert.equal(typeof api[symbol], 'function', `Не реализована проверяемая потоковая граница ${symbol}`);

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ctl-stream-output-'));
  const release = path.join(root, 'release');
  const prefix = path.join(root, 'stage-');
  const script = path.join(root, 'runner.mts');
  const source = [
    'const fs = require("node:fs");',
    'process.stdout.write("first-out\\n");',
    'process.stderr.write("first-err\\n");',
    `const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) {`,
    'clearInterval(timer); process.stdout.write("last-out\\n" + "x".repeat(131072), () => {',
    `process.stderr.write("last-err\\n" + "y".repeat(131072), () => process.exit(${code})); }); } }, 20);`,
  ].join('\n');
  const invocation = symbol === 'loggedStage'
    ? `await api.loggedStage({ name: 'probe', file: process.execPath, args: ['-e', source],
      cwd: ${JSON.stringify(root)}, env: {}, prefix: ${JSON.stringify(prefix)}, streamOutput: true });`
    : `await api.run(process.execPath, ['-e', source], {
      outDir: ${JSON.stringify(root)}, cacheDir: ${JSON.stringify(root)}, env: {},
    });`;

  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(script, [
    `import * as api from ${JSON.stringify(moduleUrl.href)};`,
    `const source = ${JSON.stringify(source)};`,
    `try { ${invocation} }`,
    'catch (error) { console.error(error.message); process.exitCode = Number(error.code) || 23; }',
  ].join('\n'));

  const child = spawn(process.execPath, [script], {
    env: { ...process.env, GRIGDESK_CTL_BUILD_OBSERVED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let stdout = '';
  let stderr = '';
  let closed = false;
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (status) => {
      closed = true;
      resolve(status);
    });
  });

  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  t.after(() => {
    if (!closed && child.pid) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        assert.equal(error.code, 'ESRCH');
      }
    }
  });

  const end = Date.now() + 4000;

  while ((!stdout.includes('first-out') || !stderr.includes('first-err')) && !closed && Date.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, 15));
  }

  assert.match(stdout, /first-out/u, 'stdout должен поступить до выхода стадии');
  assert.match(stderr, /first-err/u, 'stderr должен поступить до выхода стадии');
  assert.equal(closed, false);
  await fs.writeFile(release, '');
  assert.equal(await done, code);
  assert.ok(stdout.includes('last-out\n' + 'x'.repeat(131072)));
  assert.ok(stderr.includes('last-err\n' + 'y'.repeat(131072)));

  return {
    root,
    prefix,
    stdout,
    stderr,
  };
}
