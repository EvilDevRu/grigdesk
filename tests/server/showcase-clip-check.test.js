import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { checkSceneClip } from '../../server/src/lib/showcase/render/clipCheck.ts';
import { artifactsPath } from '../../shared/runtime/dataHome.ts';

const execute = promisify(execFile);

/**
 * Небольшой настоящий WebM воспроизводит сильное сжатие статичного интерфейса.
 * FFmpeg создаёт кадры без браузера; тест удаляет только свою временную папку.
 */
async function clipFixture(t, filter) {
  const artifacts = artifactsPath({ env: process.env, home: os.homedir() });

  await mkdir(artifacts, { recursive: true });

  const directory = await mkdtemp(path.join(artifacts, 'showcase-clip-check-'));

  t.after(() => rm(directory, { recursive: true, force: true }));

  const file = path.join(directory, 'scene.webm');

  await execute('ffmpeg', [
    '-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', filter,
    '-t', '0.6', '-an', '-c:v', 'libvpx-vp9', file,
  ], { timeout: 15000 });

  return file;
}

test('короткий сжатый WebM с настоящей картинкой проходит проверку', async (t) => {
  const file = await clipFixture(t,
    'color=c=black:s=160x120:r=5,drawbox=x=40:y=30:w=80:h=60:color=white:t=fill');
  const info = await stat(file);

  assert.ok(info.size > 0 && info.size < 12000, 'фикстура воспроизводит небольшой валидный клип');

  const result = await checkSceneClip(file);

  assert.equal(result.ok, true, result.reason);
  assert.ok(result.durationMs >= 200);
  assert.ok(result.sampledFrames > result.flatFrames);
});

test('сильно сжатая однотонная запись остаётся отказом', async (t) => {
  const file = await clipFixture(t, 'color=c=black:s=160x120:r=5');
  const result = await checkSceneClip(file);

  assert.equal(result.ok, false);
  assert.match(result.reason, /все кадры однотонные/u);
});
