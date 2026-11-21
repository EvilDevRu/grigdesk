import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { parseGlibcFloor, measureElfGlibcFloor } from '../../tools/arm64Spike.mts';

const needsSection = (names: string[]) => {
  const entries = names.map((name, index) => {
    return `  0x00${index}0:   Name: ${name}  Flags: none  Version: ${index + 2}`;
  });

  return `Version needs section '.gnu.version_r' contains 1 entry:
 Addr: 0x0000000000000000  Offset: 0x000000  Link: 5 (.dynstr)
  000000: Version: 1  File: libc.so.6  Cnt: ${names.length}
${entries.join('\n')}
`;
};

const definitionSection = `Version definition section '.gnu.version_d' contains 1 entry:
 Addr: 0x0000000000000000  Offset: 0x000000  Link: 5 (.dynstr)
  000000: Rev: 1  Flags: BASE  Index: 1  Cnt: 1  Name: GLIBC_2.99
`;

test('ARM64-GLIBC: максимум по требованиям, определения исключаются (фикстура плана)', () => {
  const forward = needsSection(['GLIBC_2.9', 'GLIBC_2.28', 'GLIBC_2.38']) + definitionSection;
  const reverse = needsSection(['GLIBC_2.38', 'GLIBC_2.28', 'GLIBC_2.9']) + definitionSection;

  assert.equal(parseGlibcFloor(forward), '2.38');
  assert.equal(parseGlibcFloor(reverse), '2.38');
});

test('ARM64-GLIBC: сравнение числовое, не лексикографическое', () => {
  assert.equal(parseGlibcFloor(needsSection(['GLIBC_2.9', 'GLIBC_2.10'])), '2.10');
  assert.equal(parseGlibcFloor(needsSection(['GLIBC_2.28', 'GLIBC_2.28.1'])), '2.28.1');
});

test('ARM64-GLIBC: статический ELF без импортов не требует GLIBC', () => {
  assert.equal(parseGlibcFloor(''), null);
  assert.equal(parseGlibcFloor('There is no dynamic section in this file.\n'), null);
});

test('ARM64-GLIBC: неразобранная зависимость не даёт положительного результата', () => {
  assert.throws(() => parseGlibcFloor(needsSection(['GLIBC_2.28', 'broken-name'])),
    /glibc_floor_unparsed_dependency/u);
  assert.throws(() => parseGlibcFloor(needsSection(['GLIBC_abc'])),
    /glibc_floor_unparsed_dependency/u);
});

test('ARM64-GLIBC: версии прочих библиотек и GLIBC_PRIVATE исключаются', () => {
  const mixed = needsSection([
    'GLIBC_2.28', 'GLIBCXX_3.4.30', 'CXXABI_1.3.13', 'LIBCTF_1.0', 'LIBSFRAME_1.0', 'GLIBC_PRIVATE',
  ]);

  assert.equal(parseGlibcFloor(mixed), '2.28');
});

test('ARM64-GLIBC: фактический ELF хоста измеряется readelf', async () => {
  const floor = await measureElfGlibcFloor('/bin/true');

  assert.match(floor ?? '', /^[0-9]+\.[0-9]+/u);
});

test('ARM64-GLIBC: не-ELF отвергается до положительного результата', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'arm64-spike-'));
  const file = path.join(dir, 'not-elf.txt');

  await fs.writeFile(file, 'plain text, not an ELF\n');

  try {
    await assert.rejects(measureElfGlibcFloor(file), /glibc_floor_read_failed/u);
  }
  finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});