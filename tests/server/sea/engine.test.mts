import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chmod, copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import test from 'node:test';

import { writeCompatibility } from '../../../server/scripts/sea/compatibility.mts';
import { loadHelpers } from '../../../server/scripts/sea/helpers.mts';
import { helperFixture, runFile, SOURCE_ROOT } from './helperFixture.mts';

test('SEA-ENGINE-01: CLI, data-home и оба моста движка исполняются без server/src TS', async (t) => {
  const fixture = await helperFixture(t, [
    'grigdesk-cli', 'data-home-check', 'legacy-brand', 'engine-runtime-usage', 'engine-codex-failure',
  ]);
  const wrapperFile = path.join(SOURCE_ROOT, 'server/build/compatibility.json');
  const wrappers = JSON.parse(await readFile(wrapperFile, 'utf8'));
  const helpers = await loadHelpers(path.join(SOURCE_ROOT, 'server/build/helpers.json'), SOURCE_ROOT);

  await writeCompatibility(fixture.root, wrappers, helpers);
  await mkdir(path.join(fixture.root, 'bin'), { recursive: true });
  await mkdir(path.join(fixture.root, 'deploy/lib'), { recursive: true });
  await copyFile(path.join(SOURCE_ROOT, 'bin/grigdesk-ctl'), path.join(fixture.root, 'bin/grigdesk-ctl'));
  await copyFile(path.join(SOURCE_ROOT, 'deploy/lib/runtime-env.sh'),
    path.join(fixture.root, 'deploy/lib/runtime-env.sh'));
  await writeFile(path.join(fixture.root, 'release.json'), JSON.stringify({ schema: 1 }));
  // Здесь проверяются helper-ы частичного R; проверку настоящего ELF делает package-test.
  // Порт readiness явно моделирует успешную проверку полного комплекта.
  await writeFile(path.join(fixture.root, 'server/grigdesk-server'),
    '#!/bin/sh\n[ "$1" = --check-startup ] || exit 99\nexit 0\n', { mode: 0o755 });
  await writeFile(path.join(fixture.root, 'VERSION'), '1.2.3');

  const stubs = path.join(fixture.temporary, 'host');

  await mkdir(stubs);
  await writeFile(path.join(stubs, 'node'), '#!/bin/sh\necho "вызван системный Node" >&2\nexit 99\n');
  await writeFile(path.join(stubs, 'systemctl'), '#!/bin/sh\nprintf "LoadState=not-found\\n"\n');
  await chmod(path.join(stubs, 'node'), 0o755);
  await chmod(path.join(stubs, 'systemctl'), 0o755);

  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ configured: true, authenticated: false }));
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const env = {
    HOME: fixture.temporary,
    GRIGDESK_HOME: path.join(fixture.temporary, 'D'),
    GRIGDESK_PORT: String((server.address() as { port: number }).port),
    PATH: `${stubs}:/usr/bin:/bin`,
  };
  const launcher = path.join(fixture.root, 'bin/grigdesk-ctl');
  const help = await runFile('/bin/bash', [launcher, '--help'], { cwd: '/', env });
  const version = await runFile('/bin/bash', [launcher, '--version'], { cwd: '/', env });
  const status = await runFile('/bin/bash', [launcher, 'server', 'status', '--json'], { cwd: '/', env });

  assert.match(help.stdout, /grigdesk-ctl/);
  assert.equal(version.stdout, 'GrigDesk 1.2.3\n');
  assert.equal(JSON.parse(status.stdout).server.state, 'ready');

  const checked = await runFile('/bin/bash', ['-c',
    'source "$1/deploy/lib/runtime-env.sh"\ngrigdesk_require_migrated "$1"\n'
      + 'grigdesk_load_runtime_env "$1"\nprintf "%s" "$GRIGDESK_EFFECTIVE_PORT"',
    'probe', fixture.root,
  ], { cwd: '/', env });

  assert.equal(checked.stdout, env.GRIGDESK_PORT);

  const runDirectory = path.join(fixture.temporary, 'run');

  await mkdir(runDirectory);
  await writeFile(path.join(runDirectory, 'meta.env'), 'SOURCE=runtime\n');
  await writeFile(path.join(runDirectory, 'events.jsonl'), JSON.stringify({
    type: 'turn.failed', error: { message: 'authentication required', code: '401' },
  }) + '\n');

  const failure = await runFile(fixture.node, [
    path.join(fixture.root, 'engine/lib/codex-failure.mjs'), runDirectory, '1',
  ], { cwd: '/', env });

  assert.equal(failure.stdout, 'provider_unavailable\n');

  const prepared = path.join(fixture.temporary, 'prepared.json');

  await writeFile(prepared, JSON.stringify({
    normalization: { provider: 'codex', normalizerDialect: 'codex-json' },
  }));

  const invalidated = await runFile(fixture.node, [
    path.join(fixture.root, 'engine/lib/runtime-usage.mjs'), 'invalidate', prepared, 'fixtureConflict',
  ], { cwd: '/', env });

  assert.equal(JSON.parse(invalidated.stdout).normalization.completeness, 'conflict');
  assert.deepEqual(JSON.parse(invalidated.stdout).normalization.diagnostics, ['fixtureConflict']);
  await assert.rejects(runFile(fixture.node, [
    path.join(fixture.root, 'engine/lib/runtime-usage.mjs'), 'unknown', 'a b', '',
  ], { cwd: '/', env }), (error: Error & { code?: number; stderr?: string }) => {
    assert.equal(error.code, 2);
    assert.match(error.stderr ?? '', /FACTORY_ERROR=inputInvalid/);

    return true;
  });

  await rename(fixture.node, `${fixture.node}.missing`);
  await assert.rejects(runFile('/bin/bash', [launcher, '--help'], { env }), /нет вложенного Node/);
});

test('SEA-ENGINE-02: внешний публикатор профиля получает вложенный Node и прежние аргументы', async (t) => {
  const fixture = await helperFixture(t, ['routes-fixture'], [{
    id: 'routes-fixture',
    entry: 'tests/server/sea/fixtures/helpers/routes.mts',
    entryKind: 'main',
    exports: ['main'],
    description: 'Проверка интерпретатора внешнего публикатора.',
  }]);
  const profile = path.join(fixture.temporary, 'profiles/fixture/routes');

  await mkdir(profile, { recursive: true });
  await writeFile(path.join(profile, 'publish.mjs'),
    'console.log(JSON.stringify({node: process.execPath, argv: process.argv.slice(2)}));\n');

  const result = await runFile(process.execPath, [fixture.entry('routes-fixture'), fixture.temporary], {
    cwd: '/',
    env: { PATH: '/nonexistent' },
    timeout: 10000,
  });
  const responses = JSON.parse(result.stdout) as Array<{
    status: number;
    body: { result: { node: string; argv: string[] } };
  }>;

  assert.deepEqual(responses.map((response) => response.status), [200, 200]);
  assert.equal(responses[0]!.body.result.node, fixture.node);
  assert.deepEqual(responses[0]!.body.result.argv, ['--validate']);
  assert.deepEqual(responses[1]!.body.result.argv, [
    '--publish', '--base-dir', path.join(fixture.temporary, 'routes'), '--expected-catalog-hash', 'null',
  ]);
});
