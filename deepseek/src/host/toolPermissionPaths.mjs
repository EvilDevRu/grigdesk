import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';

const PROTECTED = new Set(['.git', '.mcp.json', '.agents', '.claude', '.codex']);

/**
 * Чувствительный сегмент проверяется и в написанном, и в каноническом пути.
 * Сравнение по сегментам не путает соседний каталог с вложенным workspace.
 */
function sensitivePath(value) {
  return value.split(path.sep).some((part) => (
    PROTECTED.has(part) || part === '.env' || part.startsWith('.env.')
  ));
}

/**
 * Разрешает компоненты до обработки следующего '..', как realpath.native в Harness.
 * Ссылки, hardlink и недоступные компоненты требуют человека даже внутри workspace.
 */
export function toolPermissionPathFacts(root, value) {
  if (typeof value !== 'string' || !value || value.includes('\0')) {
    return {
      inside: false,
      sensitive: false,
      uncertain: true,
      fingerprint: 'invalid',
    };
  }

  const absolute = path.isAbsolute(value) ? value : `${root}${path.sep}${value}`;
  const parts = absolute.split(path.sep);
  const signatures = [];
  let current = path.parse(absolute).root;
  let uncertain = false;
  let missing = false;

  for (const part of parts) {
    if (!part || part === '.') {
      continue;
    }

    if (part === '..') {
      uncertain ||= missing;
      current = path.dirname(current);
      continue;
    }

    current = path.join(current, part);

    try {
      const stat = lstatSync(current);

      signatures.push([current, stat.dev, stat.ino, stat.mode, stat.nlink]);
      uncertain ||= stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1);
      current = realpathSync.native(current);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        uncertain = true;
      }

      missing = true;
      signatures.push([current, 'missing']);
    }
  }

  const relative = path.relative(root, current);
  const inside = relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);

  return {
    inside,
    sensitive: sensitivePath(absolute) || sensitivePath(current),
    uncertain,
    fingerprint: JSON.stringify([current, signatures]),
  };
}
