import assert from 'node:assert/strict';
import test from 'node:test';

import { verifyRuntimePorts } from '../../server/src/binary/verify.ts';

const runtime = {
  node: '24.21.0',
  abi: '137',
  platform: 'linux',
  arch: 'x64',
};

test('SB-VERIFY: full проверяет каждый native и ELF, warm ни один из них', async () => {
  const calls = [];
  const ports = {
    hashElf: async () => {
      calls.push('elf');

      return 'a'.repeat(64);
    },
    checkNode: async () => {
      calls.push('node');

      return runtime;
    },
    loadNative: async (file) => {
      calls.push(file);
    },
  };
  const native = ['cpu-features.node', 'sshcrypto.node'];

  await verifyRuntimePorts({ full: false, native }, ports);
  assert.deepEqual(calls, []);
  await verifyRuntimePorts({ full: true, native }, ports);
  assert.deepEqual(calls, ['node', 'cpu-features.node', 'sshcrypto.node', 'elf']);
});

test('SB-VERIFY: неверный ABI, второй native и hash stream error запрещают success', async () => {
  const ports = {
    checkNode: async () => runtime,
    loadNative: async () => {},
    hashElf: async () => 'a'.repeat(64),
  };
  const input = { full: true, native: ['first.node', 'second.node'] };

  await assert.rejects(verifyRuntimePorts(input, {
    ...ports, checkNode: async () => ({ ...runtime, abi: '127' }),
  }), /ABI|runtime/);
  await assert.rejects(verifyRuntimePorts(input, {
    ...ports,
    loadNative: async (file) => {
      if (file === 'second.node') {
        throw new Error('fixture native rejected');
      }
    },
  }), /native rejected/);
  await assert.rejects(verifyRuntimePorts(input, {
    ...ports,
    hashElf: async () => {
      throw new Error('fixture hash stream error');
    },
  }), /hash stream/);
});
