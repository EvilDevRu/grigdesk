import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { buildHelper } from '../../../server/scripts/sea/helpers.mts';

const execute = promisify(execFile);
const SOURCE = path.resolve(import.meta.dirname, '../../..');
const PACKAGE = 'a'.repeat(64);
const TOKEN = '12345678-1234-4234-8234-123456789abc';
const metadata = {
  format: 1,
  hostContract: 1,
  version: '0.1.0',
  packagingVersion: 2,
  packageId: PACKAGE,
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
 * Установка I и извлечённый R раздельны; в PATH нет Node, а systemctl только пишет argv.
 * Маленький настоящий ELF моделирует протокол launcher, helpers собираются штатно.
 */
export async function binaryFixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'server-binary-launch-'));
  const root = path.join(temp, 'I with spaces');
  const home = path.join(temp, 'home');
  const data = path.join(temp, 'data');
  const runtime = path.join(data, 'runtimes/server/packages', PACKAGE);
  const stubs = path.join(temp, 'stubs');
  const calls = path.join(temp, 'calls');
  const lease = path.join(temp, 'lease');
  const node = path.join(runtime, 'runtime/node/bin/node');
  const binary = path.join(root, 'bin/grigdesk-server');

  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  await fs.cp(path.join(SOURCE, 'deploy'), path.join(root, 'deploy'), { recursive: true });

  for (const directory of [home, stubs, path.dirname(node), path.dirname(binary),
    path.join(runtime, 'engine/bin')]) {
    await fs.mkdir(directory, { recursive: true });
  }

  await fs.cp(path.join(SOURCE, 'bin/grigdesk-ctl'), path.join(root, 'bin/grigdesk-ctl'));
  await fs.writeFile(path.join(temp, 'metadata.json'), JSON.stringify(metadata));
  await fs.writeFile(path.join(temp, 'prepared.json'), JSON.stringify({
    packageId: PACKAGE,
    root: runtime,
    node,
    engine: path.join(runtime, 'engine/bin/factory'),
    installationBin: path.dirname(binary),
    preparationToken: TOKEN,
  }));
  await fs.writeFile(path.join(runtime, 'engine/bin/factory'), '#!/bin/bash\nexit 0\n', { mode: 0o555 });
  await fs.writeFile(node, [
    '#!/bin/bash',
    '[[ -z "${NODE_OPTIONS+x}" ]] || exit 92',
    '[[ -f "$FIXTURE_LEASE" ]] || exit 93',
    'exec "$FIXTURE_NODE" "$@"',
  ].join('\n'), { mode: 0o555 });

  for (const id of ['grigdesk-cli', 'data-home-check', 'legacy-brand']) {
    await buildHelper({
      root: SOURCE,
      manifestPath: path.join(SOURCE, 'server/build/helpers.json'),
      id,
      outDir: path.join(runtime, 'server/runtime/helpers'),
      workDir: path.join(temp, 'helper-work'),
    });
  }

  for (const command of ['bash', 'readlink', 'dirname', 'mkdir', 'rm', 'sed',
    'mktemp', 'ln', 'mv', 'chmod', 'cat', 'basename', 'head']) {
    const found = (await execute('/bin/bash', ['-c', 'command -v "$1"', '_', command])).stdout.trim();

    await fs.symlink(found, path.join(stubs, command));
  }

  const python = (await execute('/bin/bash', ['-c', 'command -v python3'])).stdout.trim();

  await fs.symlink(python, path.join(stubs, 'python-runtime'));
  await fs.writeFile(path.join(stubs, 'python3'), [
    '#!/bin/bash',
    '[[ "$*" == *"-c"* ]] || { echo forbidden-python >> "$STUB_LOG"; exit 97; }',
    'exec "${BASH_SOURCE[0]%/*}/python-runtime" "$@"',
  ].join('\n'), { mode: 0o755 });

  for (const command of ['systemctl', 'loginctl', 'npm', 'ss']) {
    await fs.writeFile(path.join(stubs, command), [
      '#!/bin/bash',
      `printf '${command} %s\\n' "$*" >> "$STUB_LOG"`,
      command === 'npm' ? 'exit 97' : 'exit 0',
    ].join('\n'), { mode: 0o755 });
  }

  const cSource = path.join(temp, 'launcher.c');

  await fs.writeFile(cSource, `
    #include <stdio.h>
    #include <stdlib.h>
    #include <string.h>
    #include <unistd.h>
    int main(int argc, char **argv) {
      if (getenv("NODE_OPTIONS")) return 91;
      FILE *log = fopen(getenv("STUB_LOG"), "a");
      fprintf(log, "elf");
      for (int i = 1; i < argc; i++) fprintf(log, " %s", argv[i]);
      fprintf(log, "\\n");
      fclose(log);
      const char *file = NULL;
      if (argc > 1 && !strcmp(argv[1], "--runtime-info")) file = getenv("FIXTURE_METADATA");
      else if (argc > 1 && !strcmp(argv[1], "--prepare")) {
        FILE *mark = fopen(getenv("FIXTURE_LEASE"), "w");
        fprintf(mark, "%d", getppid());
        fclose(mark);
        file = getenv("FIXTURE_PREPARED");
      } else if (argc > 1 && !strcmp(argv[1], "--release-preparation")) {
        unlink(getenv("FIXTURE_LEASE"));
        puts("{\\"ok\\":true}");
        return 0;
      } else {
        printf("ELF");
        for (int i = 1; i < argc; i++) printf(" [%s]", argv[i]);
        puts("");
        return 0;
      }
      FILE *input = fopen(file, "r");
      if (!input) return 94;
      int value;
      while ((value = fgetc(input)) != EOF) putchar(value);
      fclose(input);
      return 0;
    }
  `);
  await execute('cc', [cSource, '-o', binary]);

  const env = {
    PATH: stubs,
    HOME: home,
    GRIGDESK_HOME: data,
    GRIGDESK_PORT: '19001',
    GRIGDESK_B24_INSTALL_PAUSE: '0',
    // Сторож CLI читает cgroup запускающего хода; без подмены тест из агента получит отказ.
    GRIGDESK_CLI_CGROUP_FILE: path.join(home, 'cgroup'),
    FIXTURE_NODE: process.execPath,
    FIXTURE_METADATA: path.join(temp, 'metadata.json'),
    FIXTURE_PREPARED: path.join(temp, 'prepared.json'),
    FIXTURE_LEASE: lease,
    STUB_LOG: calls,
  };

  return {
    temp,
    root,
    home,
    data,
    runtime,
    binary,
    node,
    lease,
    env,
    calls: () => fs.readFile(calls, 'utf8').catch(() => ''),
    run: async (script, args = [], extra = {}) => {
      try {
        return { code: 0, ...await execute('/bin/bash', [path.join(root, script), ...args], {
          env: { ...env, ...extra },
          cwd: '/',
          timeout: 30000,
        }) };
      } catch (error) {
        return {
          code: error.code,
          stdout: error.stdout ?? '',
          stderr: error.stderr ?? '',
        };
      }
    },
  };
}

