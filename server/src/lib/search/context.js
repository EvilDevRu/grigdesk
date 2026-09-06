import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

/**
 * Считает UTF-8 байты корневых инструкций и транзитивного @-каскада CLAUDE.md.
 * Карты вне каскада не входят в контекст; повторный импорт и цикл считаются один раз,
 * включая символические ссылки. Вложенные пути разрешаются от физического документа.
 * Отсутствующий CLAUDE.local.md допустим в клоне, поэтому пропуски возвращаются отдельно.
 */
export async function measureKnowledgeContext(rootDir) {
  const root = path.resolve(rootDir);
  const visited = new Set();
  const imports = new Set();
  const missing = [];
  const queue = [
    {
      file: path.join(root, 'CLAUDE.md'),
      followImports: true,
    },
    {
      file: path.join(root, 'AGENTS.md'),
      followImports: false,
    },
  ];
  let totalBytes = 0;

  while (queue.length) {
    const { file, followImports } = queue.shift();
    const canonicalFile = await realpath(file).catch((error) => {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
      missing.push(path.relative(root, file));
      return null;
    });
    if (canonicalFile === null || visited.has(canonicalFile)) {
      continue;
    }
    visited.add(canonicalFile);

    const source = await readFile(canonicalFile, 'utf8');
    totalBytes += Buffer.byteLength(source, 'utf8');
    if (!followImports) {
      continue;
    }

    for (const match of source.matchAll(/^@([^\s]+)$/gm)) {
      const target = path.resolve(path.dirname(canonicalFile), match[1]);
      imports.add(path.relative(root, target));
      queue.push({
        file: target,
        followImports: true,
      });
    }
  }

  return {
    totalBytes,
    imports: [...imports],
    missing,
  };
}
