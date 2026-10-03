import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { createInstructionProject } from '../fixtures/deepseek-harness/instructionProject.mts';
import { expandInstructionImports } from '../../server/src/lib/deepseek/instructions.ts';

test('раскрывает цепочку root→cwd, дедуплицирует realpath и объясняет безопасные пропуски', async (t) => {
  const f = await createInstructionProject(t);
  const result = await expandInstructionImports({ projectRoot: f.root, cwd: f.sub });

  assert.match(result.context, /## Импорт docs\/a\.md \(из CLAUDE\.md\)/u);
  assert.match(result.context, /A-V1/u);
  assert.match(result.context, /C-V1/u);
  assert.match(result.context, /B-V1/u);
  assert.doesNotMatch(result.context, /FENCED-MUST-NOT-APPEAR|OUTSIDE-MUST-NOT-APPEAR/u);
  assert.equal(result.context.split('A-V1').length - 1, 1);
  assert.ok(result.sources.some((entry) => entry.target === 'a.md'
    && entry.status === 'skipped: cycle'));
  assert.ok(result.sources.some((entry) => entry.target === 'CLAUDE.local.md'
    && entry.status === 'skipped: missing'));
  assert.ok(result.sources.some((entry) => entry.target === 'outside-link.md'
    && entry.status === 'skipped: outside_root'));
  assert.ok(result.sources.some((entry) => entry.target === 'docs/large.md'
    && entry.status === 'skipped: too_large'));
  assert.ok(result.sources.some((entry) => entry.target === 'docs/binary.bin'
    && entry.status === 'skipped: binary'));
  assert.ok(result.sources.some((entry) => entry.target === '../docs/a.md'
    && entry.status === 'skipped: duplicate'));
});

test('лимиты глубины, одного файла и общего объёма применяются до добавления контекста', async (t) => {
  const f = await createInstructionProject(t);
  await fs.writeFile(path.join(f.docs, 'a.md'), 'AAAA\n@c.md\n');
  await fs.writeFile(path.join(f.docs, 'c.md'), 'CCCC\n@d.md\n');
  await fs.writeFile(path.join(f.docs, 'd.md'), 'DDDD\n@e.md\n');
  await fs.writeFile(path.join(f.docs, 'e.md'), 'EEEE\n');
  const result = await expandInstructionImports({
    projectRoot: f.root,
    cwd: f.sub,
    limits: { maxDepth: 2, maxFileBytes: 1024, maxTotalBytes: 24 },
  });

  assert.match(result.context, /AAAA/u);
  assert.ok(result.sources.some((entry) => entry.target === 'd.md'
    && entry.status === 'skipped: depth'));
  assert.ok(result.sources.some((entry) => entry.target === 'docs/large.md'
    && entry.status === 'skipped: too_large'));
  assert.ok(Buffer.byteLength(result.context, 'utf8') > 0);
});

test('отклоняет cwd за пределами projectRoot', async (t) => {
  const f = await createInstructionProject(t);
  await assert.rejects(expandInstructionImports({
    projectRoot: f.root,
    cwd: f.parent,
  }), /внутри projectRoot/u);
});

test('импорт файла инструкций, который DSH читает сам, не дублируется в контексте', async (t) => {
  const f = await createInstructionProject(t);

  await fs.writeFile(path.join(f.root, 'CLAUDE.local.md'), 'LOCAL-NATIVE-MARK\n');

  const result = await expandInstructionImports({ projectRoot: f.root, cwd: f.sub });

  assert.doesNotMatch(result.context, /LOCAL-NATIVE-MARK/u);
  assert.doesNotMatch(result.context, /CLAUDE\.local\.md/u);
  assert.ok(result.sources.some((entry) => entry.target === 'CLAUDE.local.md'
    && entry.status === 'skipped: native'));
  assert.match(result.context, /A-V1/u);
});
