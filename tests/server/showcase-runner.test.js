// Остановка detached worker проверяется на маленьком дереве node-процессов.
// Оба процесса намеренно игнорируют SIGTERM: через grace они обязаны исчезнуть
// после SIGKILL всей группы, иначе browser/model child переживёт тест и сервер.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { launchWorker, stopWorker } from '../../server/src/lib/showcase/render/runner.ts';

function alive(pid) {
  try {
    process.kill(pid, 0);
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');

    return close >= 0 && stat.slice(close + 2, close + 3) !== 'Z';
  } catch {
    return false;
  }
}

async function waitFor(probe, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = await probe();

    if (result) return result;
    await new Promise((resolve) => { setTimeout(resolve, 25); });
  }

  throw new Error('ожидаемое состояние не наступило');
}

test('stopWorker добивает всю process group после мягкой остановки', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'showcase-runner-'));
  const workerFile = path.join(root, 'stubborn-worker.mjs');
  let pids = [];

  t.after(async () => {
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Уже завершён — это ожидаемый путь.
      }
    }

    await rm(root, { recursive: true, force: true });
  });

  await writeFile(
    workerFile,
    [
      "import { spawn } from 'node:child_process';",
      "import { readFile, writeFile } from 'node:fs/promises';",
      "import path from 'node:path';",
      "const task = JSON.parse(await readFile(process.argv[2], 'utf8'));",
      "const child = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"], { stdio: 'ignore' });",
      "process.on('SIGTERM', () => {});",
      "await writeFile(path.join(task.workDir, 'pids.json'), JSON.stringify([process.pid, child.pid]));",
      "setInterval(() => {}, 1000);",
    ].join('\n'),
    'utf8',
  );

  const handle = await launchWorker({
    workDir: path.join(root, 'work'),
    task: {},
    script: { file: workerFile, marker: 'stubborn-worker.mjs' },
  });
  const pidFile = path.join(handle.workDir, 'pids.json');

  pids = await waitFor(async () => {
    const raw = await readFile(pidFile, 'utf8').catch(() => '');

    return raw ? JSON.parse(raw) : null;
  });
  assert.equal(pids[0], handle.identity.pid);
  assert.ok(pids.every(alive), 'до остановки оба процесса живы');
  assert.equal(stopWorker(handle.identity), true);

  await waitFor(() => pids.every((pid) => !alive(pid)));
  assert.ok(pids.every((pid) => !alive(pid)), 'worker и его ребёнок не пережили остановку');
});
