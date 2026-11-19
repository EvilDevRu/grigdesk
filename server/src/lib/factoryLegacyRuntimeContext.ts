import { createHash } from 'node:crypto';
import { createReadStream, fstatSync } from 'node:fs';
import path from 'node:path';

import { runtimeError } from '../binary/leases.ts';
import { readFactoryRuntimeAttempt, type FactoryRuntimeRoots, type FactoryRuntimeSelection }
  from './factoryRuntimePins.ts';

interface LegacyRuntimeContext extends FactoryRuntimeRoots {
  format: 1;
  uid: number;
  cacheDir: string;
  task: string;
  attempt: string;
  profile: string;
  attemptSha256: string;
  helper: string;
  selected: FactoryRuntimeSelection;
}

type DecisionIdentity = Pick<LegacyRuntimeContext, 'task' | 'attempt' | 'profile' | 'controlRoot'>;
type DecisionInput = Omit<LegacyRuntimeContext, 'format' | 'uid' | 'attemptSha256' | 'helper' | 'selected'>;

const contextLimit = 16 * 1024;
const contextFields = ['format', 'uid', 'cacheDir', 'task', 'attempt', 'profile',
  'controlRoot', 'stateRoot', 'profileRoot', 'attemptSha256', 'helper', 'selected'].sort().join(',');
const runtimeFields = ['packageId', 'runtimeRoot', 'engineHome', 'engineBin', 'node'].sort().join(',');

function runtimeWriter(selection: FactoryRuntimeSelection): string {
  return path.join(selection.runtimeRoot, selection.packageId === null
    ? 'server/scripts/factoryRuntimePin.mts'
    : 'server/runtime/helpers/factory-runtime-pin.mjs');
}

/**
 * Binds the host's source or packaged runtime to the exact trusted attempt bytes.
 * Only these fields are written to the one-shot child descriptor.
 */
export async function legacyRuntimeContext(
  input: DecisionInput,
  selection: FactoryRuntimeSelection,
): Promise<string> {
  const record = await readFactoryRuntimeAttempt(input, input.task, input.attempt);

  if (record.profile !== input.profile) {
    throw runtimeError('factory_runtime_attempt_invalid');
  }

  const context: LegacyRuntimeContext = {
    ...input,
    format: 1,
    uid: process.getuid!(),
    attemptSha256: createHash('sha256').update(record.bytes).digest('hex'),
    helper: runtimeWriter(selection),
    selected: {
      packageId: selection.packageId,
      runtimeRoot: selection.runtimeRoot,
      engineHome: selection.engineHome,
      engineBin: selection.engineBin,
      node: selection.node,
    },
  };
  const json = JSON.stringify(context);

  if (Buffer.byteLength(json) > contextLimit) {
    throw runtimeError('factory_runtime_context_invalid');
  }

  return json;
}

/**
 * Checks the required descriptor before any writer effect.
 * Internal Node descriptors or redirection to a file cannot replace the channel.
 */
export function assertLegacyRuntimeContextFd(): void {
  let descriptor;

  try {
    descriptor = fstatSync(3);
  } catch (error) {
    throw runtimeError((error as NodeJS.ErrnoException).code === 'EBADF'
      ? 'factory_runtime_context_missing' : 'factory_runtime_context_invalid');
  }

  if (!descriptor.isFIFO() && !descriptor.isSocket()) {
    throw runtimeError('factory_runtime_context_missing');
  }
}

/**
 * Reads only FD 3, requires EOF, and distinguishes a missing descriptor,
 * an empty channel, and a wrong identity before invoking the mutation port.
 */
export async function readLegacyRuntimeContext(
  expected: DecisionIdentity,
  signal: AbortSignal,
): Promise<LegacyRuntimeContext> {
  assertLegacyRuntimeContextFd();

  const stream = createReadStream('', {
    fd: 3,
    autoClose: true,
    signal,
    highWaterMark: contextLimit + 1,
  });
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of stream) {
    size += (chunk as Buffer).length;

    if (size > contextLimit) {
      throw runtimeError('factory_runtime_context_invalid');
    }

    chunks.push(chunk as Buffer);
  }

  if (size === 0) {
    throw runtimeError('factory_runtime_context_eof');
  }

  let value: LegacyRuntimeContext;

  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw runtimeError('factory_runtime_context_invalid');
  }

  if (!value || Object.keys(value).sort().join(',') !== contextFields
    || value.format !== 1 || value.uid !== process.getuid!()
    || Object.entries(expected).some(([key, item]) => value[key as keyof LegacyRuntimeContext] !== item)
    || !/^[a-f0-9]{64}$/u.test(value.attemptSha256)
    || !value.selected || Object.keys(value.selected).sort().join(',') !== runtimeFields
    || value.selected.packageId !== null && !/^[a-f0-9]{64}$/u.test(value.selected.packageId)
    || [value.cacheDir, value.controlRoot, value.stateRoot, value.profileRoot, value.helper,
      value.selected.runtimeRoot, value.selected.engineHome, value.selected.engineBin, value.selected.node]
      .some((item) => typeof item !== 'string' || !path.isAbsolute(item) || path.resolve(item) !== item)
    || value.helper !== runtimeWriter(value.selected)) {
    throw runtimeError('factory_runtime_context_invalid');
  }

  return value;
}
