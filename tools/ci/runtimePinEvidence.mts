import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { canonicalJson } from '../../shared/lib/canonicalJson.ts';
import { sha256 } from '../../shared/node/hash.ts';

export type RuntimePinMode = 'source' | 'packaged';
export interface RuntimePinOutcome {
  id: string;
  outcome: 'passed';
  barrier: string;
}

const shared = ['FD-VALID', 'FD-MISSING', 'FD-EOF', 'FD-INVALID', 'WRITER-TIMEOUT',
  'GC-RECLAIM-BEFORE-RENAME', 'GC-RECLAIM-AFTER-RENAME', 'PACKAGE-RECLAIM-BEFORE-RENAME',
  'PACKAGE-RECLAIM-AFTER-RENAME'];
const source = ['COLD-REGISTRY-BEFORE-PUBLISH', 'COLD-REGISTRY-BEFORE-MARKER', 'GC-LEGACY-RECLAIM-RED',
  'PACKAGE-LEGACY-RECLAIM-RED'];
const packaged = ['GATE-HEALTHY', 'GATE-BUSY', 'GATE-CATALOG-TIMEOUT', 'GATE-PENDING-READ-TIMEOUT',
  'GATE-FOREGROUND-INT', 'GATE-PENDING-STOP', 'GOTO-HEALTHY', 'GOTO-PENDING-STOP', 'ABANDON-PENDING-STOP',
  'BOOTSTRAP-ANSWER', 'BOOTSTRAP-PENDING-CHANNEL',
  'MIGRATION-AFTER-REGISTRY-REF', 'MIGRATION-AFTER-AUTHORITY',
  'AUTO-UNPIN', 'PIN-MISSING', 'PIN-INVALID', 'GC-BEFORE-FIRST-REF', 'GC-LOCK-CANCEL-BEFORE-PUBLISH',
  'GC-LOCK-CANCEL-AFTER-PUBLISH', 'PACKAGE-LOCK-CANCEL-BEFORE-PUBLISH', 'PACKAGE-LOCK-CANCEL-AFTER-PUBLISH'];

/**
 * Полный обязательный список одинаков для команды, receipt и проверяющих jobs.
 * Результат каждого сценария содержит имя достигнутого барьера.
 */
export function macRuntimePinLeaves(mode: RuntimePinMode): [string, string][] {
  const suites = mode === 'source' ? source : packaged;
  const prefix = mode === 'source' ? 'MAC-SOURCE-PIN-' : 'MAC-VERIFY-PIN-';

  return [...shared, ...suites].map((name) => [prefix + name, name]);
}

/**
 * Отчёт должен содержать каждый точный ID ровно один раз. Посторонний
 * исход или другой барьер не считаются доказательством native сценария.
 */
export function checkRuntimePinOutcomes(mode: RuntimePinMode, value: unknown): RuntimePinOutcome[] {
  const expected = new Map(macRuntimePinLeaves(mode));

  if (!Array.isArray(value) || value.length !== expected.size) {
    throw new Error('mac_runtime_pin_outcomes_incomplete');
  }

  for (const item of value) {
    if (!item || Object.keys(item).sort().join(',') !== 'barrier,id,outcome'
      || item.outcome !== 'passed' || !expected.has(item.id) || expected.get(item.id) !== item.barrier) {
      throw new Error('mac_runtime_pin_outcome_invalid');
    }

    expected.delete(item.id);
  }

  return value;
}

/**
 * Matches terminal runner events to exact named scenarios and private witness files.
 * A transport success cannot replace a leaf, a barrier, or the parent group.
 */
export async function collectRuntimePinOutcomes(mode: RuntimePinMode, events: unknown[],
  witness: string): Promise<RuntimePinOutcome[]> {
  const expected = new Map(macRuntimePinLeaves(mode));
  const group = mode === 'source' ? 'MAC-SOURCE-RUNTIME-PIN' : 'MAC-VERIFY-RUNTIME-PIN';
  const passed = new Set<string>();
  let groupPassed = false;

  for (const value of events) {
    const event = value as {
      type?: unknown;
      name?: unknown;
      nesting?: unknown;
      directive?: unknown;
      wrapper?: unknown;
    } | null;

    if (!event || event.type !== 'test:pass' || event.directive !== false || typeof event.name !== 'string'
      || typeof event.wrapper !== 'boolean') {
      throw new Error('mac_runtime_pin_event_invalid');
    }
    if (event.wrapper) {
      continue;
    }
    if (event.name === group && event.nesting === 0 && !groupPassed) {
      groupPassed = true;
    } else if (event.nesting === 1 && expected.has(event.name) && !passed.has(event.name)) {
      passed.add(event.name);
    } else {
      throw new Error('mac_runtime_pin_event_invalid');
    }
  }

  if (!groupPassed || passed.size !== expected.size) {
    throw new Error('mac_runtime_pin_outcomes_incomplete');
  }

  await assertRuntimePinDirectory(witness);

  const names = (await fs.readdir(witness)).sort();
  const files = [...expected.keys()].map((id) => id + '.json').sort();

  if (canonicalJson(files) !== canonicalJson(names)) {
    throw new Error('mac_runtime_pin_witness_incomplete');
  }

  const items = await Promise.all(files.map((name) => readRuntimePinJson(path.join(witness, name), true)));

  return checkRuntimePinOutcomes(mode, items);
}

/**
 * Читает один обычный ограниченный файл. Ни symlink, ни другой
 * uid/mode в приватном источнике не могут выдать evidence.
 */
export async function readRuntimePinJson(file: string, privateFile = false,
  expectedSha256?: string): Promise<unknown> {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);

  try {
    const stat = await handle.stat();

    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 512 * 1024 || privateFile
      && (stat.uid !== process.getuid!() || (stat.mode & 0o7777) !== 0o600)) {
      throw new Error('mac_runtime_pin_report_invalid');
    }

    const bytes = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);

    if (bytesRead !== stat.size) {
      throw new Error('mac_runtime_pin_report_invalid');
    }

    const content = bytes.subarray(0, bytesRead);

    if (expectedSha256 !== undefined && sha256(content) !== expectedSha256) {
      throw new Error('mac_runtime_pin_source_digest_invalid');
    }

    return JSON.parse(content.toString('utf8'));
  } finally {
    await handle.close();
  }
}

/**
 * Runner принимает только собственный физический каталог 0700.
 * Path проверяется до создания отчёта и запуска test workers.
 */
export async function assertRuntimePinDirectory(directory: string) {
  if (!path.isAbsolute(directory) || await fs.realpath(directory) !== directory) {
    throw new Error('mac_runtime_pin_report_directory_invalid');
  }

  const stat = await fs.lstat(directory);

  if (!stat.isDirectory() || stat.uid !== process.getuid!() || (stat.mode & 0o7777) !== 0o700) {
    throw new Error('mac_runtime_pin_report_directory_invalid');
  }
}
