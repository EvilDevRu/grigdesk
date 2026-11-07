import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
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
  'tests/README.md',
];

/**
 * Собирает Markdown выбранных точек входа для проверки поставки.
 * Игнорируемые Git документы отсеиваются до чтения содержимого.
 */
function markdownFiles(entry) {
  const absolute = path.join(ROOT, entry);

  if (!existsSync(absolute)) {
    return [];
  }

  if (!statSync(absolute).isDirectory()) {
    return [absolute];
  }

  return readdirSync(absolute, { withFileTypes: true }).flatMap((item) => {
    const child = path.join(entry, item.name);

    return item.isDirectory()
      ? markdownFiles(child)
      : item.name.endsWith('.md') ? [path.join(ROOT, child)] : [];
  });
}

/**
 * Какие из путей репозиторий игнорирует. Спрашиваем у самого git, одним вызовом:
 * список игнорируемого живёт в `.gitignore`, а не во втором списке внутри теста.
 * Нет git или это не репозиторий (распакованный архив) — проверяем всё, как раньше.
 */
function ignoredByGit(paths) {
  if (!paths.length) {
    return new Set();
  }

  try {
    const out = execFileSync('git', ['check-ignore', '--stdin', '-z'], {
      cwd: ROOT,
      input: `${paths.join('\0')}\0`,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    return new Set(out.split('\0').filter(Boolean));
  } catch {
    // Код 1 — «ничего не игнорируется», это норма и не ошибка.
    return new Set();
  }
}

/**
 * Собирает якоря заголовков GitHub Markdown и явно объявленных HTML-якорей.
 * Повтор заголовка получает суффикс; примеры внутри fenced code заголовками не становятся.
 */
function markdownAnchors(source) {
  const prose = source.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/gu, '');
  const anchors = new Set();
  const used = new Set();

  for (const match of prose.matchAll(/^ {0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/gmu)) {
    const label = match[1].replace(/!?\[([^\]]*)\]\([^)]*\)/gu, '$1').replace(/<[^>]*>/gu, '');
    const base = label.toLowerCase().replace(/[^\p{L}\p{N}_\s-]/gu, '').replace(/\s/gu, '-');
    let anchor = base;
    let suffix = 0;

    while (used.has(anchor)) {
      suffix += 1;
      anchor = `${base}-${suffix}`;
    }

    used.add(anchor);
    anchors.add(anchor);
  }

  for (const match of prose.matchAll(/<(?:a|h[1-6])\b[^>]*\b(?:id|name)=["']([^"']+)["']/giu)) {
    anchors.add(match[1]);
  }

  return anchors;
}

test('якоря учитывают русский текст, код в заголовке, повторы и исключают fenced-примеры', () => {
  const text = '# Проверка `API`\n## Проверка `API`\n```md\n# Ложный заголовок\n```\n<a id="manual"></a>';

  assert.deepEqual([...markdownAnchors(text)], ['проверка-api', 'проверка-api-1', 'manual']);
});

// Дерево обходится с ДИСКА, поэтому в него попадали и локальные рабочие заметки
// (`/docs/plans/` — игнорируемые черновики планов). Ссылки внутри чужих черновиков
// роняли весь offline suite, хотя к репозиторию отношения не имеют: у каждого в
// команде черновики свои, а красный прогон читается как поломка репозитория.
const found = ENTRIES.flatMap(markdownFiles);
const ignoredFiles = ignoredByGit(found.map((file) => path.relative(ROOT, file)));
const files = found.filter((file) => !ignoredFiles.has(path.relative(ROOT, file)));

test('документация использует переносимые Markdown-ссылки', async () => {
  const failures = [];
  const targets = [];
  const sources = new Map();

  for (const file of files) {
    const source = await readFile(file, 'utf8');
    const relativeFile = path.relative(ROOT, file);

    sources.set(relativeFile, source);

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

      if (!target || /^[a-z][a-z+.-]*:/i.test(target)) {
        continue;
      }

      const clean = decodeURIComponent(target.split('#', 1)[0].split('?', 1)[0]);
      const resolved = clean ? path.resolve(path.dirname(file), clean) : file;

      if (!existsSync(resolved)) {
        failures.push(`${relativeFile}: нет цели ${target}`);
        continue;
      }

      targets.push({
        from: relativeFile,
        target,
        path: path.relative(ROOT, resolved),
        fragment: decodeURIComponent(target.split('#').slice(1).join('#')),
      });
    }
  }

  // Зеркальная беда: файл на месте, но репозиторий его игнорирует — значит он есть
  // только на этой машине, и у всех остальных ссылка ведёт в пустоту. Локально такое
  // не заметно вообще ничем, поэтому ловим здесь.
  const ignoredTargets = ignoredByGit(targets.map((item) => item.path));

  for (const item of targets) {
    if (ignoredTargets.has(item.path)) {
      failures.push(`${item.from}: цель ${item.target} вне репозитория (git её игнорирует)`);
      continue;
    }

    if (item.fragment && sources.has(item.path)
      && !markdownAnchors(sources.get(item.path)).has(item.fragment)) {
      failures.push(`${item.from}: нет якоря ${item.target}`);
    }
  }

  assert.deepEqual(failures, []);
});
