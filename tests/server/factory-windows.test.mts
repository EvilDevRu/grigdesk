import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { dataHome, dataHomeExplicit, dataPath } from '../../shared/runtime/dataHome.ts';
import { factoryBinaryKind, factoryGoBinaryPath } from '../../server/src/lib/factoryGoDescriptor.ts';
import { factoryRuntimePaths } from '../../server/src/lib/factoryRuntime.ts';

test('Windows factory validates PE32+ and uses factory.exe in source and package paths', () => {
  const fixture = Buffer.alloc(64 + 24 + 112);

  fixture.writeUInt16LE(0x5a4d, 0);
  fixture.writeUInt32LE(64, 60);
  fixture.writeUInt32LE(0x4550, 64);
  fixture.writeUInt16LE(0x8664, 68);
  fixture.writeUInt16LE(112, 84);
  fixture.writeUInt16LE(0x2, 86);
  fixture.writeUInt16LE(0x20b, 88);

  assert.equal(factoryBinaryKind(fixture, 'win32', 'x64'), 'pe');
  assert.throws(() => factoryBinaryKind(fixture, 'win32', 'arm64'));
  fixture.writeUInt16LE(0xaa64, 68);
  assert.equal(factoryBinaryKind(fixture, 'win32', 'arm64'), 'pe');
  assert.throws(() => factoryBinaryKind(fixture.subarray(0, 90), 'win32', 'arm64'));

  fixture.writeUInt16LE(0x2002, 86);
  assert.throws(() => factoryBinaryKind(fixture, 'win32', 'arm64'));

  const root = path.resolve('/checkout');

  assert.equal(factoryGoBinaryPath('win32'), 'engine/bin/factory.exe');
  assert.equal(factoryRuntimePaths({
    kind: 'source',
    root,
    env: {},
    platform: 'win32',
  }).bin, path.join(root, 'bin', 'factory.exe'));
});

test('Windows data home accepts spaces and Cyrillic but rejects aliases and device names', () => {
  const home = 'C:\\Users\\Иван Петров';
  const env = { GRIGDESK_HOME: 'C:/Users/Иван Петров/.grigdesk/' };
  const input = {
    env,
    home,
    platform: 'win32',
  };
  const resolved = dataHome(input);

  assert.equal(resolved, home + '\\.grigdesk');
  assert.equal(dataHomeExplicit(input), false);
  assert.equal(dataPath(resolved, 'lock'), resolved + '\\state\\server.lock');

  for (const value of ['C:\\', 'C:relative', 'C:\\CON', 'C:\\valid\\..\\data', 'C:\\data:stream',
    '\\\\server\\share\\data', 'C:\\data ']) {
    assert.throws(() => dataHome({ ...input, env: { GRIGDESK_HOME: value } }));
  }
});
