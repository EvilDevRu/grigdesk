import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { spawnPty } from '../../server/src/modules/terminal/index.ts';

function waitFor(check, message, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const value = check();
      if (value) {
        clearInterval(timer);
        resolve(value);
      } else if (Date.now() - started > timeout) {
        clearInterval(timer);
        reject(new Error(message));
      }
    }, 20);
  });
}

test('PTY helper меняет реальный stty size и не оставляет фоновый процесс', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'cockpit-pty-'));
  t.after(() => rm(home, { recursive: true, force: true }));

  const child = spawnPty({ cols: 80, rows: 24, shell: '/bin/sh', home });
  let output = '';
  child.stdout.on('data', (data) => { output += data.toString('utf8'); });
  child.stderr.on('data', (data) => { output += data.toString('utf8'); });
  t.after(() => { try { child.kill('SIGKILL'); } catch { /* уже завершён */ } });

  await waitFor(() => child.pid, 'helper не запустился');
  child.stdin.write("stty -echo; printf '__SIZE1__'; stty size; printf '__END1__\\n'\n");
  await waitFor(() => /__SIZE1__24 80\r?\n__END1__/.test(output), `неверный начальный размер: ${output}`);

  child.stdio[3].write(`${JSON.stringify({ t: 'resize', cols: 123, rows: 47 })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 60));
  child.stdin.write("printf '__SIZE2__'; stty size; printf '__END2__\\n'; sleep 30 & printf '__PID__%s__\\n' \"$!\"\n");
  await waitFor(() => /__SIZE2__47 123\r?\n__END2__/.test(output), `resize не дошёл до PTY: ${output}`);
  const pid = await waitFor(() => Number(output.match(/__PID__(\d+)__/)?.[1]) || 0, 'pid фонового процесса не получен');

  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.stdio[3].write(`${JSON.stringify({ t: 'close' })}\n`);
  await Promise.race([
    exited,
    new Promise((_, reject) => setTimeout(() => reject(new Error('helper не завершился')), 3000)),
  ]);
  await waitFor(() => {
    try { process.kill(pid, 0); return false; }
    catch (error) { return error.code === 'ESRCH'; }
  }, `фоновый процесс ${pid} остался после закрытия PTY`, 2000);
});

test('естественный exit shell тоже завершает его фоновые process groups', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'cockpit-pty-exit-'));
  t.after(() => rm(home, { recursive: true, force: true }));

  const child = spawnPty({ cols: 80, rows: 24, shell: '/bin/sh', home });
  let output = '';
  child.stdout.on('data', (data) => { output += data.toString('utf8'); });
  child.stderr.on('data', (data) => { output += data.toString('utf8'); });
  t.after(() => { try { child.kill('SIGKILL'); } catch { /* уже завершён */ } });

  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.stdin.write("sleep 30 & printf '__NATURAL_PID__%s__\\n' \"$!\"; exit 7\n");
  const pid = await waitFor(
    () => Number(output.match(/__NATURAL_PID__(\d+)__/)?.[1]) || 0,
    `pid фонового процесса не получен: ${output}`,
  );
  const code = await Promise.race([
    exited,
    new Promise((_, reject) => setTimeout(() => reject(new Error('helper не завершился')), 3000)),
  ]);
  assert.equal(code, 7);
  await waitFor(() => {
    try { process.kill(pid, 0); return false; }
    catch (error) { return error.code === 'ESRCH'; }
  }, `фоновый процесс ${pid} остался после exit shell`, 2000);
});
