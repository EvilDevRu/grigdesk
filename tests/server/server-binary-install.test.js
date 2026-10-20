import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { installBinary } from '../../server/scripts/binary/installSteps.mts';
import { copyInstallCandidate } from '../../server/scripts/binary/installFiles.mts';
import {
  approveInstall, previousInstall, savePrevious,
} from '../../server/scripts/binary/installOwnership.mts';
import { sha256File } from '../../shared/node/hash.ts';

const run = promisify(execFile);
const info = {
  format: 1,
  hostContract: 1,
  version: '0.1.0',
  packagingVersion: 2,
  packageId: 'a'.repeat(64),
  runtime: {
    node: '24.21.0',
    abi: '137',
    platform: 'linux',
    arch: 'x64',
  },
  capabilities: ['api', 'ipc', 'helpers', 'engine'],
  engine: { protocol: 'route-v2', sha256: 'b'.repeat(64) },
  payload: {
    sha256: 'c'.repeat(64),
    size: 12,
    entryCount: 1,
  },
};

/**
 * Маленький ELF-подобный файл проверяет копирование независимо от сборки SEA.
 * Пробы через порт читают только закрытый staged inode с настоящей файловой системы.
 */
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'server-install-'));
  const bin = path.join(root, 'bin with spaces');

  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(bin);
  await fs.writeFile(path.join(root, 'candidate'), Buffer.from('\x7fELF-candidate-A'), { mode: 0o755 });

  return {
    root,
    options: {
      binary: path.join(root, 'candidate'),
      target: path.join(bin, 'grigdesk-server'),
      releasesDir: path.join(root, 'data/runtimes/server/releases'),
    },
  };
}

/**
 * Тестовый metadata/verify сохраняет argv и окружение настоящего protocol port.
 * Источник и опубликованный target не исполняются ни на одном этапе установки.
 */
function probes(calls = [], metadata = info) {
  return async (binary, args, context) => {
    calls.push({
      binary,
      args,
      ...context,
    });
    assert.equal((await fs.readFile(binary)).subarray(0, 4).toString(), '\x7fELF');

    return args.includes('--runtime-info') ? metadata
      : {
        ok: true,
        verified: true,
        packageId: metadata.packageId,
        elfSha256: await sha256File(binary),
        runtime: metadata.runtime,
        filesVerified: 1,
        nativeBindingsVerified: 2,
      };
  };
}

test('SB23-copy: закрытая staged копия и отдельный probe HOME/D до публикации', async (t) => {
  const { options } = await fixture(t);
  const calls = [];
  const digest = await sha256File(options.binary);
  const result = await installBinary(options, { probe: probes(calls) });

  assert.equal(calls.length, 2, 'runtime-info и verify запускаются на staged snapshot');
  assert.equal(result.packageId, info.packageId);
  assert.equal(result.sha256, digest);

  for (const call of calls) {
    assert.notEqual(call.binary, options.binary);
    assert.notEqual(call.binary, options.target);
    assert.equal(call.env.PATH, '');
    assert.ok(!call.env.NODE_OPTIONS);
    assert.ok(!call.env.LD_PRELOAD);
    assert.ok(!call.env.ZAI_API_KEY);
    assert.ok(!call.env.HOME.startsWith(path.dirname(options.target)));
    assert.ok(!call.env.GRIGDESK_HOME.startsWith(path.dirname(options.target)));
    assert.ok(!call.env.GRIGDESK_HOME.startsWith(path.dirname(call.binary)));
    assert.equal(await fs.stat(call.env.HOME).catch(() => null), null);
  }
});

test('SB23-copy: metadata/verify отказ и staged tamper сохраняют старые байты', async (t) => {
  const { options } = await fixture(t);
  const digest = await sha256File(options.binary);

  await fs.copyFile(options.binary, options.target);

  for (const probe of [
    probes([], { ...info, hostContract: 2 }),
    async () => {
      throw new Error('probe failed');
    },
    async (binary, args, context) => {
      const result = await probes()(binary, args, context);

      if (args.includes('--verify')) {
        await fs.chmod(binary, 0o755);
        await fs.appendFile(binary, 'tamper');
      }

      return result;
    },
    async (_binary, args) => args.includes('--runtime-info') ? info : { verified: false },
  ]) {
    await assert.rejects(installBinary(options, { probe }));
    assert.equal(await sha256File(options.target), digest);
  }
});

test('SB23-receipt: private target binding, approved A/B и SHA backup без исполнения', async (t) => {
  const { options, root } = await fixture(t);
  const receipt = `${options.target}.grigdesk-server.json`;
  const empty = await previousInstall(options.target, root);

  assert.deepEqual(empty?.receipt, {
    format: 1,
    target: options.target,
    approved: [],
  });
  await approveInstall(empty, 'a'.repeat(64), root);
  assert.equal((await fs.stat(receipt)).mode & 0o777, 0o600);

  const digest = await sha256File(options.binary);

  await fs.copyFile(options.binary, options.target);
  await assert.rejects(previousInstall(options.target, root), /чужой target/u);
  await fs.rm(path.join(root, 'previous'), { force: true });
  await fs.writeFile(receipt, JSON.stringify({
    format: 1,
    target: options.target,
    approved: [digest],
  }));

  const old = await previousInstall(options.target, root);
  const backup = await savePrevious(old, options.releasesDir);

  assert.equal(backup, path.join(options.releasesDir, digest, 'grigdesk-server'));
  assert.equal(await sha256File(backup), digest);
  await approveInstall(old, 'b'.repeat(64), root);
  assert.deepEqual(JSON.parse(await fs.readFile(receipt, 'utf8')).approved, [digest, 'b'.repeat(64)]);
  await fs.chmod(receipt, 0o644);
  await assert.rejects(previousInstall(options.target, root), /receipt/u);
});

test('SB23-publish: A→B→A, отказ rename и retry после receipt сохраняют approved bytes', async (t) => {
  const { options } = await fixture(t);
  const a = await installBinary(options, { probe: probes() });

  assert.equal(await fs.readFile(options.target, 'utf8').catch(() => null), '\x7fELF-candidate-A');
  await fs.writeFile(options.binary, '\x7fELF-candidate-B');
  await assert.rejects(installBinary(options, {
    probe: probes(),
    publish: async () => {
      throw new Error('rename failure');
    },
  }), /rename failure/u);
  assert.equal(await sha256File(options.target), a.sha256);

  const b = await installBinary(options, { probe: probes([], { ...info, packageId: 'b'.repeat(64) }) });

  assert.equal(await sha256File(b.previous), a.sha256);

  const rollback = await installBinary({ ...options, binary: b.previous }, { probe: probes() });

  assert.equal(rollback.sha256, a.sha256);
  assert.equal(await sha256File(rollback.previous), b.sha256);
  assert.equal((await fs.stat(options.target)).mode & 0o777, 0o555);
  assert.deepEqual((await fs.readdir(path.dirname(options.target))).sort(), [
    'grigdesk-server', 'grigdesk-server.grigdesk-server.json',
  ]);
});

test('SB23-publish: snapshot и отказ unknown target/links/receipt', async (t) => {
  const { options, root } = await fixture(t);
  const digest = await sha256File(options.binary);

  await installBinary(options, {
    probe: probes(),
    copy: async (source, target) => {
      await copyInstallCandidate(source, target);
      await fs.writeFile(source, '\x7fELF-changed');
    },
  });
  assert.equal(await sha256File(options.target), digest);
  await fs.rm(options.target);
  await fs.symlink(options.binary, options.target);
  await assert.rejects(installBinary(options, { probe: probes() }));
  assert.equal(await fs.readlink(options.target), options.binary);
  await fs.rm(options.target);
  await fs.copyFile(options.binary, options.target);
  await assert.rejects(installBinary(options, { probe: probes() }), /чужой target/u);
  await fs.rm(`${options.target}.grigdesk-server.json`);
  await fs.symlink(path.join(root, 'absent'), `${options.target}.grigdesk-server.json`);
  await assert.rejects(installBinary(options, { probe: probes() }), /receipt/u);
});

test('SB23-publish: copy/backup/changed-target отказы сохраняют A', async (t) => {
  const { options } = await fixture(t);
  const a = await installBinary(options, { probe: probes() });

  await fs.writeFile(options.binary, '\x7fELF-candidate-B');
  await assert.rejects(installBinary(options, {
    probe: probes(),
    copy: async (_source, target) => {
      await fs.writeFile(target, 'partial');

      throw new Error('copy failed');
    },
  }), /copy failed/u);
  assert.equal(await sha256File(options.target), a.sha256);
  await fs.mkdir(path.join(options.releasesDir, a.sha256), { recursive: true, mode: 0o700 });
  await fs.symlink(options.binary, path.join(options.releasesDir, a.sha256, 'grigdesk-server'));
  await assert.rejects(installBinary(options, { probe: probes() }), /резерв|Резерв/u);
  assert.equal(await sha256File(options.target), a.sha256);
});

test('SB23-publish: два установщика сохраняют цепочку A→B→C без смешанных backup', async (t) => {
  const { options, root } = await fixture(t);
  const a = await installBinary(options, { probe: probes() });
  const candidateC = path.join(root, 'candidate-c');

  await fs.writeFile(options.binary, '\x7fELF-candidate-B');
  await fs.writeFile(candidateC, '\x7fELF-candidate-C');

  let enter;
  let resume;
  const entered = new Promise((resolve) => {
    enter = resolve;
  });
  const gate = new Promise((resolve) => {
    resume = resolve;
  });
  let published = false;
  const first = installBinary(options, {
    probe: probes(),
    copy: async (source, target) => {
      await copyInstallCandidate(source, target);
      enter();
      await gate;
    },
    publish: async (source, target) => {
      await fs.rename(source, target);
      published = true;
    },
  });

  await entered;

  const second = installBinary({ ...options, binary: candidateC }, {
    probe: probes(),
    copy: async (source, target) => {
      assert.equal(published, true);
      await copyInstallCandidate(source, target);
    },
  });

  resume();

  const [b, c] = await Promise.all([first, second]);

  assert.equal(await sha256File(b.previous), a.sha256);
  assert.equal(await sha256File(c.previous), b.sha256);
  assert.equal(await sha256File(options.target), c.sha256);
});

test('SB23-process: работающий маленький ELF A отвечает после A→B', async (t) => {
  const { options, root } = await fixture(t);
  const source = path.join(root, 'hold.c');

  await fs.writeFile(source, '#include <stdio.h>\nint main(){char b[8]; puts("READY"); '
    + 'fflush(stdout); while(fgets(b,8,stdin)){puts("A");fflush(stdout);} return 0;}\n');
  await run('cc', [source, '-o', options.binary]);
  await installBinary(options, { probe: probes() });

  const child = spawn(options.target, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = once(child, 'close');

  t.after(async () => {
    child.kill('SIGTERM');
    await closed;
  });
  assert.equal(String((await once(child.stdout, 'data'))[0]).trim(), 'READY');
  await fs.writeFile(options.binary, '\x7fELF-B');
  await installBinary(options, { probe: probes() });

  const answer = once(child.stdout, 'data');

  child.stdin.write('ping\n');
  assert.equal(String((await answer)[0]).trim(), 'A');
  assert.equal(child.exitCode, null);
});

test('SB23-probe-process: настоящий ELF stub получает private HOME/D без credentials/loaders', async (t) => {
  const { options, root } = await fixture(t);
  const source = path.join(root, 'probe.c');
  const log = path.join(root, 'probe-env.jsonl');
  const body = `
    #include <stdio.h>
    #include <stdlib.h>
    #include <string.h>
    #include <unistd.h>
    int main(int argc, char **argv) {
      if (getenv("NODE_OPTIONS") || getenv("LD_PRELOAD") || getenv("ZAI_API_KEY")) return 9;
      FILE *log = fopen(${JSON.stringify(log)}, "a");
      fprintf(log, "{\\"binary\\":\\"%s\\",\\"home\\":\\"%s\\",\\"data\\":\\"%s\\"}\\n",
        argv[0], getenv("HOME"), getenv("GRIGDESK_HOME"));
      fclose(log);
      if (!strcmp(argv[1], "--runtime-info")) puts(${JSON.stringify(JSON.stringify(info))});
      else if (!strcmp(argv[1], "--verify")) {
        char command[128], digest[65];
        snprintf(command, sizeof(command), "/usr/bin/sha256sum /proc/%d/exe", getpid());
        FILE *pipe = popen(command, "r");
        if (!pipe || fscanf(pipe, "%64s", digest) != 1) return 10;
        pclose(pipe);
        printf("{\\"ok\\":true,\\"verified\\":true,\\"packageId\\":\\"${info.packageId}\\","
          "\\"elfSha256\\":\\"%s\\",\\"runtime\\":${JSON.stringify(info.runtime).replaceAll('"', '\\"')},"
          "\\"filesVerified\\":1,\\"nativeBindingsVerified\\":2}\\n", digest);
      } else return 2;
      return 0;
    }
  `;

  await fs.writeFile(source, body);
  await run('cc', [source, '-o', options.binary]);

  const names = ['NODE_OPTIONS', 'LD_PRELOAD', 'ZAI_API_KEY'];
  const saved = names.map((name) => process.env[name]);

  try {
    for (const name of names) {
      process.env[name] = 'SYNTHETIC_MUST_NOT_REACH_PROBES';
    }

    const result = await installBinary(options);

    assert.equal(result.sha256, await sha256File(options.binary));
  } finally {
    for (const [index, name] of names.entries()) {
      if (saved[index] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = saved[index];
      }
    }
  }

  const calls = (await fs.readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));

  assert.equal(calls.length, 2);
  assert.equal(calls[0].binary, calls[1].binary);

  for (const call of calls) {
    assert.notEqual(call.binary, options.binary);
    assert.notEqual(call.binary, options.target);
    assert.ok(!call.home.startsWith(root));
    assert.ok(!call.data.startsWith(root));
    assert.equal(await fs.stat(call.home).catch(() => null), null);
  }
});

test('SB23-cli: обязательные, повторные и чужие флаги отвергаются до эффектов', async (t) => {
  const { options } = await fixture(t);
  const cli = new URL('../../server/scripts/installBinary.mts', import.meta.url).pathname;

  for (const args of [
    [], ['--binary', options.binary], ['--target', options.target],
    ['--binary', options.binary, '--target', options.target, '--eval', '1'],
    ['--binary', options.binary, '--target', options.target, '--binary', options.binary],
  ]) {
    await assert.rejects(run(process.execPath, [cli, ...args]), { code: 2 });
    assert.deepEqual(await fs.readdir(path.dirname(options.target)), []);
  }
});

test('SB23-backup-link: symlink releases отклоняется до создания каталогов за ссылкой', async (t) => {
  const { options, root } = await fixture(t);
  const a = await installBinary(options, { probe: probes() });
  const outside = path.join(root, 'outside');

  await fs.mkdir(outside, { mode: 0o700 });
  await fs.mkdir(path.dirname(options.releasesDir), { recursive: true });
  await fs.symlink(outside, options.releasesDir);
  await fs.writeFile(options.binary, '\x7fELF-B');
  await assert.rejects(installBinary(options, { probe: probes() }));
  assert.deepEqual(await fs.readdir(outside), [], 'backup не создаётся через ссылку releases');
  assert.equal(await sha256File(options.target), a.sha256);
});

test('SB23-real: candidate S22 проходит настоящий staged verify', async (t) => {
  const pointer = new URL('../../../s23-real-candidate.json', import.meta.url);
  const value = await fs.readFile(pointer, 'utf8').catch(() => null);

  if (!value) {
    t.skip('WAIT: B ещё не опубликовала candidate S22');

    return;
  }

  const { options } = await fixture(t);
  const candidate = JSON.parse(value);
  const result = await installBinary({ ...options, binary: candidate.binary });

  t.diagnostic(`S23-real packageId=${result.packageId} sha256=${result.sha256}`);
  assert.equal(result.packageId, candidate.packageId);
  assert.equal(result.sha256, await sha256File(candidate.binary));
  assert.equal(await sha256File(options.target), result.sha256);

  if (candidate.sha256 !== undefined) {
    assert.equal(result.sha256, candidate.sha256);
  }
});
