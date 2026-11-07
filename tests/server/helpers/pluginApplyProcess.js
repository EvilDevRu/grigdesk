import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CHILD = fileURLToPath(new URL('../fixtures/plugin-apply-process.mjs', import.meta.url));

/**
 * Parent убивает только собственный fork после подтверждённого удерживаемого barrier.
 * Каждый вызов запускает отдельный process с новым store, без памяти прежнего apply.
 */
export async function runApplyChild(fixture, { operation = 'apply', barrierAt = null, now = null } = {}) {
  const control = path.join(fixture.root, `control-${randomUUID()}.json`);

  await writeFile(control, JSON.stringify({
    roots: fixture.roots,
    statePath: fixture.statePath,
    intent: fixture.intent,
    operation,
    barrierAt,
    now,
  }), { mode: 0o600 });

  const child = fork(CHILD, [control], {
    execArgv: [],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let barrier = null;
  let answer = null;
  let safeFailure = null;
  let stderr = '';

  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-2048);
  });
  child.on('message', (message) => {
    if (message.type === 'barrier') {
      barrier = message;
      child.kill('SIGKILL');
    } else if (message.type === 'result') {
      answer = message;
    } else if (message.type === 'failure') {
      safeFailure = message.code;
    }
  });

  const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);

  try {
    const exit = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });

    if (barrierAt !== null) {
      assert.equal(barrier?.index, barrierAt, 'child дошёл до выбранного IPC barrier');
      assert.equal(barrier.held, true);
      assert.equal(exit.signal, 'SIGKILL', 'свой процесс действительно аварийно остановлен');

      return { barrier, exit };
    }

    assert.equal(safeFailure, null, 'child не отказал до проверяемого результата');
    assert.equal(exit.code, 0, stderr.replaceAll(fixture.root, '<fixture>'));
    assert.ok(answer, 'IPC outcome доставлен до exit');

    return answer;
  } finally {
    clearTimeout(timer);

    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  }
}
