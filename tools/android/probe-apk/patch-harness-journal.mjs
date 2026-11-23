import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const generation = process.argv[2];

if (!generation || !path.isAbsolute(generation)) {
  throw new Error('Нужен абсолютный каталог поколения Harness для Android');
}

const directory = path.join(generation, 'packages/session/session-persistence-jsonl/lib');
const journal = path.join(directory, 'index.js');
const source = await readFile(journal, 'utf8');
const helperImport = 'import { publishNewFileAndroid } from "./grigdeskAndroidPublish.mjs";\n';
const initialPublish = 'await link(tmp, finalPath);';
const migratedPublish = 'await internals.fs.link(staged, currentPath);';

// Проверяем места патча до записи. При изменении сборки Harness нельзя молча
// упаковать поколение, которое снова обращается к link() в sandbox Android.
if (!source.startsWith(helperImport)
  && (source.split(initialPublish).length !== 2 || source.split(migratedPublish).length !== 2)) {
  throw new Error('Изменились места публикации журнала Harness');
}

const helper = `import { getSystemErrorName } from 'node:util';

const AT_FDCWD = -100;
const RENAME_NOREPLACE = 1;
let bindings;

/**
 * Android запрещает link() в данных приложения. Bionic публикует уже
 * синхронизированный файл атомарно и возвращает EEXIST при занятом пути.
 * Вызывающая сторона по-прежнему синхронизирует каталог назначения.
 */
export async function publishNewFileAndroid(source, target) {
  if (!bindings) {
    const { default: koffi } = await import('koffi');
    const libc = koffi.load('libc.so');

    bindings = {
      libc,
      rename: libc.func('int renameat2(int, const char *, int, const char *, unsigned int)'),
      errno: koffi.errno,
    };
  }

  if (bindings.rename(AT_FDCWD, source, AT_FDCWD, target, RENAME_NOREPLACE) === 0) {
    return;
  }

  const errno = bindings.errno();
  const code = errno > 0 ? getSystemErrorName(-errno) : 'EIO';

  throw Object.assign(new Error('renameat2 ' + code + ': ' + source + ' -> ' + target), {
    code,
    errno: -errno,
    syscall: 'renameat2',
    path: source,
    dest: target,
  });
}
`;

await writeFile(path.join(directory, 'grigdeskAndroidPublish.mjs'), helper);

if (!source.startsWith(helperImport)) {
  const patched = source.replace(initialPublish, 'await publishNewFileAndroid(tmp, finalPath);')
    .replace(migratedPublish, 'await publishNewFileAndroid(staged, currentPath);');

  await writeFile(journal, helperImport + patched);
}
