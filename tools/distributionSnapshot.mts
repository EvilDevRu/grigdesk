import fs from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

import { sha256 } from '../shared/node/hash.ts';

const execute = promisify(execFile);

export interface SourceSnapshot {
  commit: string;
  cloneRoot: string;
  sourceDigest: string;
}

/**
 * Отпечаток источника: HEAD, бинарный diff и опись untracked с SHA каждого файла.
 * Одинаковые отпечатки до и после копирования доказывают неизменность входа.
 */
export async function sourceFingerprint(root: string, signal?: AbortSignal): Promise<string> {
  const commit = (await execute('git', ['rev-parse', 'HEAD'], { cwd: root, signal }))
    .stdout.trim();
  const diff = (await execute('git', ['diff', '--binary', 'HEAD'], {
    cwd: root,
    maxBuffer: 512 * 1024 * 1024,
    signal,
  })).stdout;
  const untracked = (await execute('git',
    ['ls-files', '-z', '--others', '--exclude-standard'], {
      cwd: root,
      maxBuffer: 64 * 1024 * 1024,
      signal,
    }))
    .stdout.split('\0').filter(Boolean);
  const inventory: {
    path: string;
    size: number;
    mode: number;
    sha256: string
  }[] = [];
  const physicalRoot = await fs.realpath(root);

  for (const relative of untracked.sort()) {
    signal?.throwIfAborted();

    const file = path.join(root, relative);
    const physicalParent = await fs.realpath(path.dirname(file));

    if (physicalParent !== physicalRoot && !physicalParent.startsWith(physicalRoot + path.sep)) {
      throw new Error('snapshot_untracked_outside_tree:' + relative);
    }

    const stat = await fs.lstat(file);

    if (stat.isDirectory()) {
      inventory.push({
        path: relative,
        size: 0,
        mode: stat.mode & 0o777,
        sha256: ''
      });

      continue;
    }

    if (!stat.isFile()) {
      throw new Error('snapshot_untracked_entry_invalid:' + relative);
    }

    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes: Buffer;

    try {
      const opened = await handle.stat();

      if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev) {
        throw new Error('source_changed_retry');
      }

      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }

    inventory.push({
      path: relative,
      size: bytes.length,
      mode: stat.mode & 0o777,
      sha256: sha256(bytes)
    });
  }

  return createHash('sha256').update(commit).update(diff)
    .update(createHash('sha256').update(JSON.stringify(inventory)).digest()).digest('hex');
}

/**
 * Клон без hardlink-ов получает tracked-состояние коммита, diff и копии untracked.
 * Изменение источника во время копирования даёт source_changed_retry до сборки.
 */
export async function createSourceSnapshot(input: {
  root: string;
  runDir: string;
  signal?: AbortSignal;
}): Promise<SourceSnapshot> {
  const { signal } = input;
  const before = await sourceFingerprint(input.root, signal);
  const commit = (await execute('git', ['rev-parse', 'HEAD'], { cwd: input.root, signal }))
    .stdout.trim();
  const cloneRoot = path.join(input.runDir, 'source-clone');

  await fs.mkdir(input.runDir, { recursive: true, mode: 0o700 });
  await execute('git', ['clone', '--no-hardlinks', input.root, cloneRoot], { signal });
  await execute('git', ['checkout', '--detach', commit], { cwd: cloneRoot, signal });

  const diff = (await execute('git', ['diff', '--binary', 'HEAD'], {
    cwd: input.root,
    maxBuffer: 512 * 1024 * 1024,
    signal,
  })).stdout;

  if (diff.length > 0) {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('git', ['apply', '--binary', '-'], { cwd: cloneRoot, signal });
      const fail = (error: Error) => reject(error);

      child.on('error', fail);
      child.stdin.on('error', fail);
      child.stderr.setEncoding('utf8');
      child.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error('snapshot_apply_failed'));
        }
      });
      child.stdin.end(diff);
    });
  }

  const untracked = (await execute('git',
    ['ls-files', '-z', '--others', '--exclude-standard'], {
      cwd: input.root,
      maxBuffer: 64 * 1024 * 1024,
      signal,
    }))
    .stdout.split('\0').filter(Boolean);
  const physicalRoot = await fs.realpath(input.root);

  for (const relative of untracked) {
    signal?.throwIfAborted();

    const source = path.join(input.root, relative);
    const stat = await fs.lstat(source);

    if (stat.isSymbolicLink() || !stat.isFile() && !stat.isDirectory()) {
      throw new Error('snapshot_untracked_entry_invalid:' + relative);
    }

    if (stat.isFile()) {
      const physical = await fs.realpath(path.dirname(source));

      if (physical !== physicalRoot && !physical.startsWith(physicalRoot + path.sep)) {
        throw new Error('snapshot_untracked_outside_tree:' + relative);
      }
    }

    const target = path.join(cloneRoot, relative);

    if (stat.isDirectory()) {
      await fs.mkdir(target, { recursive: true, mode: 0o700 });

      continue;
    }

    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });

    const handle = await fs.open(source, constants.O_RDONLY | constants.O_NOFOLLOW);

    try {
      const opened = await handle.stat();

      if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev) {
        throw new Error('source_changed_retry');
      }

      await fs.writeFile(target, await handle.readFile(), { flag: 'wx', mode: stat.mode & 0o777 });
    } finally {
      await handle.close();
    }
  }

  const after = await sourceFingerprint(input.root, signal);

  if (before !== after) {
    throw new Error('source_changed_retry');
  }

  return {
    commit,
    cloneRoot,
    sourceDigest: before
  };
}
