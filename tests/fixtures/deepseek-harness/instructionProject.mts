import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export async function createInstructionProject(t: { after: (fn: () => unknown) => void }) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-deepseek-instructions-'));
  const root = path.join(parent, 'project');
  const sub = path.join(root, 'sub');
  const docs = path.join(root, 'docs');
  t.after(async () => {
    await Promise.all([
      fs.chmod(root, 0o700).catch(() => {}),
      fs.chmod(sub, 0o700).catch(() => {}),
      fs.chmod(docs, 0o700).catch(() => {}),
    ]);
    await fs.rm(parent, { recursive: true, force: true });
  });
  await Promise.all([
    fs.mkdir(path.join(root, '.git'), { recursive: true }),
    fs.mkdir(sub, { recursive: true }),
    fs.mkdir(docs, { recursive: true }),
  ]);
  await fs.writeFile(path.join(root, 'AGENTS.md'), 'Корневые инструкции без импортов.\n');
  await fs.writeFile(path.join(root, 'CLAUDE.md'), [
    '# Root',
    '@docs/a.md',
    '@CLAUDE.local.md',
    '@outside-link.md',
    '@docs/large.md',
    '@docs/binary.bin',
    '```text',
    '@docs/fenced.md',
    '```',
    '',
  ].join('\n'));
  await fs.writeFile(path.join(sub, 'CLAUDE.md'), '@../docs/b.md\n@../docs/a.md\n');
  await fs.writeFile(path.join(docs, 'a.md'), 'A-V1\n@c.md\n');
  await fs.writeFile(path.join(docs, 'c.md'), 'C-V1\n@a.md\n');
  await fs.writeFile(path.join(docs, 'b.md'), 'B-V1\n');
  await fs.writeFile(path.join(docs, 'fenced.md'), 'FENCED-MUST-NOT-APPEAR\n');
  await fs.writeFile(path.join(docs, 'large.md'), 'L'.repeat(70 * 1024));
  await fs.writeFile(path.join(docs, 'binary.bin'), Buffer.from([0x41, 0x00, 0x42]));
  const outside = path.join(parent, 'outside.md');
  await fs.writeFile(outside, 'OUTSIDE-MUST-NOT-APPEAR\n');
  await fs.symlink(outside, path.join(root, 'outside-link.md'));
  return { parent, root, sub, docs };
}
