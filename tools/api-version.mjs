import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const defaultRoot = fileURLToPath(new URL('../', import.meta.url));
const versionPattern = /export const API_VERSION = \{\s*major:\s*(\d+),\s*minor:\s*(\d+),?\s*\};/;
const fingerprintPattern = /export const API_CONTRACT_FINGERPRINT = '[0-9a-f]*';/;

/**
 * Собирает только контракты, общий декодер и прямые исходники клиентской области.
 * Относительный путь входит в отпечаток, поэтому переименование также меняет контракт.
 */
function contractPaths(directory, prefix = 'shared') {
  const files = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relative = `${prefix}/${entry.name}`;

    if (entry.isDirectory()) {
      files.push(...contractPaths(path.join(directory, entry.name), relative));
    } else if (entry.isFile() && (relative.endsWith('Contracts.ts')
      || relative === 'shared/lib/contractDecoders.ts'
      || (prefix === 'shared/client' && entry.name.endsWith('.ts') && entry.name !== 'apiVersion.ts'))) {
      files.push(relative);
    }
  }

  return files;
}

/**
 * Различия CRLF и LF не означают изменения API между рабочими машинами.
 * Сортировка путей и явные разделители делают результат независимым от обхода файловой системы.
 */
function fingerprint(root) {
  const hash = createHash('sha256');

  for (const file of contractPaths(path.join(root, 'shared')).sort()) {
    const source = readFileSync(path.join(root, file), 'utf8').replace(/\r\n?/g, '\n');

    hash.update(`${file}\n${source}\n`);
  }

  return hash.digest('hex');
}

/**
 * Утилита читает номер из исходника, не исполняя проверяемое дерево.
 * До первого выпуска проверка намеренно не блокирует правки общих контрактов.
 */
function main() {
  const { values } = parseArgs({
    options: {
      root: { type: 'string' },
      check: { type: 'boolean' },
      bump: { type: 'string' },
    },
  });

  if (Boolean(values.check) === Boolean(values.bump)) {
    throw new Error('Укажите --check или --bump minor|major.');
  }

  if (values.bump && !['minor', 'major'].includes(values.bump)) {
    throw new Error('Допустимы --bump minor и --bump major.');
  }

  const root = path.resolve(values.root ?? defaultRoot);
  const versionFile = path.join(root, 'shared/client/apiVersion.ts');
  const source = readFileSync(versionFile, 'utf8');
  const version = source.match(versionPattern);

  if (!version || !fingerprintPattern.test(source)) {
    throw new Error('Не найдены константы API_VERSION и API_CONTRACT_FINGERPRINT.');
  }

  if (values.check && Number(version[1]) === 0) {
    process.stdout.write('до выпуска сторож выключен\n');

    return;
  }

  const hash = fingerprint(root);

  if (values.check) {
    if (!source.includes(`API_CONTRACT_FINGERPRINT = '${hash}'`)) {
      throw new Error('контракты изменились; выполните --bump minor или --bump major.');
    }

    process.stdout.write('Контракты API не изменились.\n');

    return;
  }

  const major = Number(version[1]) + (values.bump === 'major' ? 1 : 0);
  const minor = values.bump === 'major' ? 0 : Number(version[2]) + 1;
  const updated = source
    .replace(versionPattern, `export const API_VERSION = {\n  major: ${major},\n  minor: ${minor},\n};`)
    .replace(fingerprintPattern, `export const API_CONTRACT_FINGERPRINT = '${hash}';`);

  writeFileSync(versionFile, updated);
  process.stdout.write(`Версия контрактов API: ${major}.${minor}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
