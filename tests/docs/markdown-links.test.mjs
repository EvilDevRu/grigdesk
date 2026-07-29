import assert from 'node:assert/strict';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ENTRIES = [
  'README.md',
  'CLAUDE.md',
  'docs',
  'engine/README.md',
  'engine/CLAUDE.md',
  'plugins/README.md',
  'tests/README.md',
];

function markdownFiles(entry) {
  const absolute = path.join(ROOT, entry);
  if (!existsSync(absolute)) return [];
  if (!statSync(absolute).isDirectory()) return [absolute];
  return readdirSync(absolute, { withFileTypes: true }).flatMap((item) => {
    const child = path.join(entry, item.name);
    return item.isDirectory()
      ? markdownFiles(child)
      : item.name.endsWith('.md') ? [path.join(ROOT, child)] : [];
  });
}

const files = ENTRIES.flatMap(markdownFiles);

test('документация использует переносимые Markdown-ссылки', async () => {
  const failures = [];

  for (const file of files) {
    const source = await import('node:fs/promises').then(({ readFile }) => readFile(file, 'utf8'));
    const relativeFile = path.relative(ROOT, file);
    const prose = source
      .replace(/```[\s\S]*?```/g, '')
      .replace(/~~~[\s\S]*?~~~/g, '')
      .replace(/`[^`\n]*`/g, '');

    for (const match of prose.matchAll(/\[\[([^\]\n]+)\]\]/g)) {
      failures.push(`${relativeFile}: wiki-ссылка [[${match[1]}]]`);
    }

    for (const match of prose.matchAll(/!?\[[^\]\n]*\]\(([^)\n]+)\)/g)) {
      const raw = match[1].trim();
      const target = raw.startsWith('<')
        ? raw.slice(1, raw.indexOf('>'))
        : raw.split(/\s+/, 1)[0];
      if (!target || target.startsWith('#') || /^[a-z][a-z+.-]*:/i.test(target)) continue;

      const clean = decodeURIComponent(target.split('#', 1)[0].split('?', 1)[0]);
      const resolved = path.resolve(path.dirname(file), clean);
      if (!existsSync(resolved)) failures.push(`${relativeFile}: нет цели ${target}`);
    }
  }

  assert.deepEqual(failures, []);
});
