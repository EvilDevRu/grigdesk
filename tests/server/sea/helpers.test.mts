import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { makeGlb } from '../helpers/studio3dGlb.js';
import { helperFixture, runFile } from './helperFixture.mts';

test('SEA-HELPERS-01: перенесённый helper читает ресурс и запускает соседний helper', async (t) => {
  const fixture = await helperFixture(t, ['runtime-fixture', 'direct-ssh-policy-hook'], [{
    id: 'runtime-fixture',
    entry: 'tests/server/sea/fixtures/helpers/runtime.mts',
    entryKind: 'main',
    exports: ['main'],
    description: 'Проба packaged-контекста и ресурсов.',
  }]);
  const resource = path.join(fixture.root, 'tests/server/sea/fixtures/helpers/runtime.txt');

  await mkdir(path.dirname(resource), { recursive: true });
  await writeFile(resource, 'ресурс текущего комплекта');

  const moved = path.join(fixture.temporary, 'relocated R with space');

  await rename(fixture.root, moved);

  const result = await runFile(path.join(moved, 'runtime/node/bin/node'), [
    path.join(moved, 'server/runtime/helpers/runtime-fixture.mjs'), 'a b', '',
  ], {
    cwd: '/',
    env: { PATH: '/nonexistent' },
    timeout: 10000,
  });
  const report = JSON.parse(result.stdout);

  assert.equal(report.kind, 'packaged');
  assert.equal(report.root, moved);
  assert.equal(report.resource, 'ресурс текущего комплекта');
  assert.deepEqual(report.args, ['a b', '']);
  assert.deepEqual(report.nested, {
    code: 0,
    stdout: '',
    stderr: '',
  });
});

test('SEA-HELPERS-02: собранный 3D worker читает fd и публикует настоящий GLB', async (t) => {
  const fixture = await helperFixture(t, ['studio3d-analysis-worker']);
  const input = path.join(fixture.temporary, 'input.glb');

  await writeFile(input, makeGlb({ triangles: 2, size: [1, 2, 1] }));

  const source = await open(input, 'r');
  const directory = await open(fixture.temporary, 'r');

  t.after(() => source.close());
  t.after(() => directory.close());

  const child = spawn(fixture.node, [fixture.entry('studio3d-analysis-worker'), JSON.stringify({
    operation: 'rewrite',
    sourcePath: input,
    outputDirectory: fixture.temporary,
    outputName: 'result.glb',
    wrap: { scale: 2 },
  })], {
    cwd: '/',
    env: { PATH: '/nonexistent' },
    stdio: ['ignore', 'pipe', 'pipe', source.fd, directory.fd],
  });
  let output = '';

  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });

  const [code] = await once(child, 'close');
  const result = JSON.parse(output);

  assert.equal(code, 0);
  assert.equal(result.ok, true);
  assert.deepEqual(result.stats.size, [2, 4, 2]);
  assert.equal((await readFile(path.join(fixture.temporary, 'result.glb'))).readUInt32LE(0), 0x46546c67);
});

test('SEA-HELPERS-03: собранный supervisor запускает leader самого helper-а', {
  timeout: 15000,
}, async (t) => {
  const fixture = await helperFixture(t, ['plugin-command-supervisor']);
  const child = fork(fixture.entry('plugin-command-supervisor'), [], {
    execPath: fixture.node,
    execArgv: [],
    env: { PATH: '/nonexistent' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  let outcome: { code?: number } | undefined;

  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
    }
  });
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.on('message', (message: { type: string; code?: number }) => {
    if (message.type === 'worker') {
      child.send({
        type: 'ack',
        command: {
          file: fixture.node,
          args: ['-e', "process.stdout.write('leader-ok'); process.exit(3)"],
          cwd: fixture.temporary,
          env: { PATH: '/nonexistent' },
        },
      });
    }

    if (message.type === 'result') {
      outcome = message;
    }
  });
  child.send({ type: 'start', commandId: 'fixture' });
  await once(child, 'close');

  assert.equal(outcome?.code, 3);
  assert.equal(output, 'leader-ok');
});

test('SEA-HELPERS-04: ingest выполняется один раз и сохраняет результат без модели', async (t) => {
  const fixture = await helperFixture(t, ['media-ingest-worker']);
  const bin = path.join(fixture.temporary, 'host-tools');
  const work = path.join(fixture.temporary, 'work');
  const file = path.join(fixture.temporary, 'input.wav');
  const status = path.join(fixture.temporary, 'status.json');
  const script = path.join(fixture.root, 'server/src/lib/media/transcribe.py');

  await mkdir(bin);
  await mkdir(path.dirname(script), { recursive: true });
  await writeFile(file, 'synthetic audio');
  await writeFile(path.join(bin, 'ffprobe'), '#!/bin/sh\n'
    + 'printf \'{"format":{"duration":1},"streams":[{"codec_type":"audio"}]}\'\n');
  await writeFile(path.join(bin, 'ffmpeg'), '#!/bin/sh\nfor output do :; done\nprintf wav > "$output"\n');
  await chmod(path.join(bin, 'ffprobe'), 0o755);
  await chmod(path.join(bin, 'ffmpeg'), 0o755);
  await writeFile(script, 'import json\n'
    + 'with open(__file__ + ".calls", "a") as calls:\n    calls.write("call\\n")\n'
    + 'print(json.dumps({"duration": 1, "text": "fixture", '
    + '"segments": [{"start": 0, "end": 1, "text": "fixture"}]}))\n');
  await writeFile(status, JSON.stringify({
    jobId: 'fixture',
    status: 'running',
    filePath: file,
    workDir: work,
    speech: {
      scenario: 'video',
      model: 'small',
      device: 'cpu',
    },
    runtime: { pythonPath: '/usr/bin/python3' },
  }));

  await runFile(fixture.node, [fixture.entry('media-ingest-worker'), status], {
    cwd: '/',
    env: {
      HOME: fixture.temporary,
      GRIGDESK_HOME: path.join(fixture.temporary, 'D'),
      PATH: bin,
    },
    timeout: 10000,
  });

  const job = JSON.parse(await readFile(status, 'utf8'));

  assert.equal(job.status, 'done', String(job.error));
  assert.equal(job.result.transcript.text, 'fixture');
  assert.equal(typeof job.finishedAt, 'number');
  assert.equal(await readFile(`${script}.calls`, 'utf8'), 'call\n');
});
